use std::collections::HashMap;
use std::time::Duration;

use futures::{stream, StreamExt};
use serde_json::{json, Value as JsonValue};
use tracing::{info, warn};

use shared::dto::{
    PipelineConfig, PromptResult, PromptType, RunStep, ScoringResult, TernaryLabel, TextPosition,
};
use shared::openai_client as ai;

#[derive(Clone, Debug)]
pub struct BatchCfg {
    pub page_batch_size: usize, // PIPELINE_PAGE_BATCH_SIZE
    pub max_parallel: usize,    // PIPELINE_MAX_PARALLEL
    pub max_chars: usize,       // PIPELINE_MAX_CHARS
    pub openai_timeout_ms: u64, // PIPELINE_OPENAI_TIMEOUT_MS
    pub openai_retries: usize,  // PIPELINE_OPENAI_RETRIES
}

#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub extraction: Vec<PromptResult>,
    pub scoring: Vec<ScoringResult>,
    pub decision: Vec<PromptResult>,
    pub log: Vec<RunStep>,
}

pub async fn execute_with_pages(
    cfg: &PipelineConfig,
    pages: &[(i32, String)],
    batch_cfg: &BatchCfg,
) -> anyhow::Result<RunOutcome> {
    info!(
        "run: pages={} (batch_size={}, max_parallel={}, max_chars={}, timeout={}ms, retries={})",
        pages.len(),
        batch_cfg.page_batch_size,
        batch_cfg.max_parallel,
        batch_cfg.max_chars,
        batch_cfg.openai_timeout_ms,
        batch_cfg.openai_retries
    );

    let mut extraction_all: Vec<PromptResult> = Vec::new();
    let mut scoring_all: Vec<ScoringResult> = Vec::new();
    let mut decision_all: Vec<PromptResult> = Vec::new();
    let mut run_log: Vec<RunStep> = Vec::new();

    let mut current_route = "ROOT".to_string();
    let mut seq_no: u32 = 1;

    for step in &cfg.steps {
        if !step.active {
            continue;
        }
        if let Some(ref r) = step.route {
            if r != &current_route && r != "ROOT" {
                continue;
            }
        }

        match step.step_type {
            PromptType::ExtractionPrompt => {
                let prompt_text = fetch_prompt_text_for_log(step.prompt_id as i32).await;

                // Extraction: strikt pro Seite (keine Überlappung; klare Zuordnung)
                let batches = make_batches_step(
                    pages,
                    1, // page_batch_size
                    batch_cfg.max_chars,
                    1, // min_pages_for_batching
                    0, // overlap_pages
                );

                let futs = batches.iter().map(|(_pnos, text, _cc)| {
                    let text = text.clone();
                    let prompt_id = step.prompt_id as i32;
                    let cfg_clone = batch_cfg.clone();
                    let prompt_text_for_log = prompt_text.clone();
                    async move {
                        call_extract_with_retries(
                            prompt_id,
                            &text,
                            &cfg_clone,
                            &prompt_text_for_log,
                        )
                            .await
                            .unwrap_or_else(|e| PromptResult {
                                prompt_id,
                                prompt_type: PromptType::ExtractionPrompt,
                                prompt_text: prompt_text_for_log.clone(),
                                value: None,
                                boolean: None,
                                route: None,
                                weight: None,
                                source: None,
                                openai_raw: String::new(),
                                json_key: None,
                                error: Some(format!("extract failed: {e}")),
                            })
                    }
                });

                let results: Vec<PromptResult> = stream::iter(futs)
                    .buffer_unordered(batch_cfg.max_parallel)
                    .collect()
                    .await;

                extraction_all.extend(results.clone());

                run_log.push(RunStep {
                    seq_no,
                    step_id: step.id.to_string(),          // FIX: Uuid -> String
                    prompt_id: step.prompt_id as i64,      // FIX: i32 -> i64
                    prompt_type: PromptType::ExtractionPrompt,
                    decision_key: None,
                    route: Some(current_route.clone()),
                    result: json!({
                        "prompt_text": prompt_text,
                        "batches": batches.iter().map(|(pnos, _t, cc)| json!({ "pages": pnos, "char_count": cc })).collect::<Vec<_>>(),
                        "results": results.iter().map(|r| json!({
                            "value": r.value,
                            "source": r.source,
                            "error": r.error,
                        })).collect::<Vec<_>>()
                    }),
                });
                seq_no += 1;
            }

            PromptType::ScoringPrompt => {
                let prompt_text = fetch_prompt_text_for_log(step.prompt_id as i32).await;

                // Scoring: kleine Batches + optionale Text-Überlappung, erst ab N Seiten
                let min_pages = env_usize("PIPELINE_MIN_PAGES_FOR_BATCHING", 4);
                let overlap = env_usize("PIPELINE_OVERLAP_PAGES", 1);
                let batches = make_batches_step(
                    pages,
                    batch_cfg.page_batch_size,
                    batch_cfg.max_chars,
                    min_pages,
                    overlap,
                );

                let futs = batches.iter().map(|(_pnos, text, _cc)| {
                    let text = text.clone();
                    let prompt_id_i32 = step.prompt_id as i32;
                    let cfg_clone = batch_cfg.clone();
                    async move {
                        call_score_with_retries(prompt_id_i32, &text, &cfg_clone)
                            .await
                            .unwrap_or_else(|e| ScoringResult {
                                prompt_id: prompt_id_i32,
                                result: false,
                                source: TextPosition {
                                    page: 0,
                                    bbox: [0.0, 0.0, 0.0, 0.0],
                                    quote: None,
                                },
                                explanation: format!("score failed: {e}"),
                                vote: Some(TernaryLabel::unsure),
                                strength: Some(0.0),
                                confidence: Some(0.0),
                                score: None,
                                label: None,
                            })
                    }
                });

                let batch_scores: Vec<ScoringResult> = stream::iter(futs)
                    .buffer_unordered(batch_cfg.max_parallel)
                    .collect()
                    .await;

                // Tri-State Konsolidierung über Batches (gewichtete Summe)
                let consolidated = consolidate_scoring(&batch_scores);
                scoring_all.push(consolidated.clone());

                run_log.push(RunStep {
                    seq_no,
                    step_id: step.id.to_string(),          // FIX: Uuid -> String
                    prompt_id: step.prompt_id as i64,      // FIX: i32 -> i64
                    prompt_type: PromptType::ScoringPrompt,
                    decision_key: None,
                    route: Some(current_route.clone()),
                    result: json!({
                        "prompt_text": prompt_text,
                        "batches": batches.iter().map(|(pnos, _t, cc)| json!({ "pages": pnos, "char_count": cc })).collect::<Vec<_>>(),
                        "scores": batch_scores,
                        "consolidated": consolidated
                    }),
                });
                seq_no += 1;
            }

            PromptType::DecisionPrompt => {
                let yes_key = step.yes_key.clone().unwrap_or_else(|| "YES".into());
                let no_key = step.no_key.clone().unwrap_or_else(|| "NO".into());
                let prompt_text = fetch_prompt_text_for_log(step.prompt_id as i32).await;

                // Decision: versuche EINEN Batch (gesamtes Dokument). Fallback: dynamisch.
                let single =
                    make_batches_step(pages, usize::MAX, batch_cfg.max_chars, usize::MAX, 0);
                let min_pages = env_usize("PIPELINE_MIN_PAGES_FOR_BATCHING", 4);
                let batches = if single.len() == 1 {
                    single
                } else {
                    make_batches_step(
                        pages,
                        batch_cfg.page_batch_size,
                        batch_cfg.max_chars,
                        min_pages,
                        0,
                    )
                };

                let futs = batches.iter().map(|(_pnos, text, _cc)| {
                    let text = text.clone();
                    let prompt_id = step.prompt_id as i32;
                    let cfg_clone = batch_cfg.clone();
                    let yes_key = yes_key.clone();
                    let no_key = no_key.clone();
                    let prompt_text_for_log = prompt_text.clone();
                    async move {
                        call_decide_with_retries(
                            prompt_id,
                            &text,
                            &cfg_clone,
                            &yes_key,
                            &no_key,
                            &prompt_text_for_log,
                        )
                            .await
                            .unwrap_or_else(|e| PromptResult {
                                prompt_id,
                                prompt_type: PromptType::DecisionPrompt,
                                prompt_text: prompt_text_for_log.clone(),
                                value: None,
                                boolean: None,
                                route: Some(no_key.clone()),
                                weight: None,
                                source: None,
                                openai_raw: String::new(),
                                json_key: None,
                                error: Some(format!("decision failed: {e}")),
                            })
                    }
                });

                let decisions: Vec<PromptResult> = stream::iter(futs)
                    .buffer_unordered(batch_cfg.max_parallel)
                    .collect()
                    .await;

                let consolidated =
                    consolidate_decision(&decisions, &yes_key, &no_key, &prompt_text);

                if let Some(ref r) = consolidated.route {
                    if r != &current_route {
                        current_route = r.clone();
                    }
                }

                decision_all.push(consolidated.clone());

                run_log.push(RunStep {
                    seq_no,
                    step_id: step.id.to_string(),          // FIX: Uuid -> String
                    prompt_id: step.prompt_id as i64,      // FIX: i32 -> i64
                    prompt_type: PromptType::DecisionPrompt,
                    decision_key: None,
                    route: Some(current_route.clone()),
                    result: json!({
                        "prompt_text": prompt_text,
                        "batches": batches.iter().map(|(pnos, _t, cc)| json!({ "pages": pnos, "char_count": cc })).collect::<Vec<_>>(),
                        "votes": decisions,
                        "consolidated": consolidated
                    }),
                });
                seq_no += 1;
            }
        }
    }

    Ok(RunOutcome {
        extraction: extraction_all,
        scoring: scoring_all,
        decision: decision_all,
        log: run_log,
    })
}

#[allow(dead_code)]
fn make_batches(
    pages: &[(i32, String)],
    page_batch_size: usize,
    max_chars: usize,
) -> Vec<(Vec<i32>, String)> {
    let mut out: Vec<(Vec<i32>, String)> = Vec::new();
    let mut cur_pages: Vec<i32> = Vec::new();
    let mut cur = String::new();

    for (pno, txt) in pages {
        let normalized = normalize_spaces(txt);

        let would_len = cur.len() + normalized.len() + 1;
        if !cur_pages.is_empty() && (cur_pages.len() >= page_batch_size || would_len > max_chars) {
            out.push((std::mem::take(&mut cur_pages), std::mem::take(&mut cur)));
        }

        cur_pages.push(*pno);
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(&normalized);
    }

    if !cur_pages.is_empty() {
        out.push((cur_pages, cur));
    }
    out
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(default)
}
fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(default)
}

fn make_batches_step(
    pages: &[(i32, String)],
    page_batch_size: usize,
    max_chars: usize,
    min_pages_for_batching: usize,
    overlap_pages: usize,
) -> Vec<(Vec<i32>, String, usize)> {
    if pages.is_empty() {
        return Vec::new();
    }
    let total_pages = pages.len();
    if total_pages <= min_pages_for_batching || page_batch_size == usize::MAX {
        let mut text = String::new();
        for (_pno, t) in pages {
            let normalized = normalize_spaces(t);
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&normalized);
        }
        let char_count = text.len();
        if char_count > max_chars && max_chars > 0 && page_batch_size == usize::MAX {
            return make_batches_step(pages, 6, max_chars, 4, 0);
        }
        let pnos: Vec<i32> = pages.iter().map(|(p, _)| *p).collect();
        return vec![(pnos, text, char_count)];
    }

    let mut out: Vec<(Vec<i32>, String, usize)> = Vec::new();
    let mut cur_pages: Vec<i32> = Vec::new();
    let mut cur = String::new();
    let mut cur_chars = 0usize;
    let mut last_overlap: Vec<String> = Vec::new();

    for (idx, (pno, txt)) in pages.iter().enumerate() {
        let normalized = normalize_spaces(txt);
        let needed = (if cur.is_empty() { 0 } else { 1 }) + normalized.len();
        let would_exceed_chars = max_chars > 0 && (cur_chars + needed) > max_chars;
        let would_exceed_pages = cur_pages.len() >= page_batch_size;

        if would_exceed_chars || would_exceed_pages {
            out.push((cur_pages.clone(), cur.clone(), cur_chars));
            if overlap_pages > 0 {
                last_overlap.clear();
                let mut k = overlap_pages;
                let mut i = idx;
                while k > 0 && i > 0 {
                    let (_pp, prev_txt) = &pages[i - 1];
                    last_overlap.push(normalize_spaces(prev_txt));
                    i -= 1;
                    k -= 1;
                }
                last_overlap.reverse();
            }
            cur_pages.clear();
            cur.clear();
            cur_chars = 0;
        }

        if !last_overlap.is_empty() && cur.is_empty() {
            for seg in &last_overlap {
                if !cur.is_empty() {
                    cur.push('\n');
                }
                cur.push_str(seg);
            }
            cur_chars = cur.len();
            last_overlap.clear();
        }

        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(&normalized);
        cur_pages.push(*pno);
        cur_chars += needed;
    }
    if !cur_pages.is_empty() {
        out.push((cur_pages, cur, cur_chars));
    }
    out
}

fn normalize_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_was_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            last_was_space = false;
            out.push(ch);
        }
    }
    out.trim().to_string()
}

async fn call_extract_with_retries(
    prompt_id: i32,
    text: &str,
    cfg: &BatchCfg,
    prompt_text_for_log: &str,
) -> anyhow::Result<PromptResult> {
    let mut last_err: Option<anyhow::Error> = None;

    for attempt in 0..=cfg.openai_retries {
        let res = tokio::time::timeout(
            Duration::from_millis(cfg.openai_timeout_ms),
            ai::extract(prompt_id, text),
        )
            .await;

        match res {
            Ok(Ok(ans)) => {
                return Ok(PromptResult {
                    prompt_id,
                    prompt_type: PromptType::ExtractionPrompt,
                    prompt_text: prompt_text_for_log.to_string(),
                    value: ans.value.clone(),
                    boolean: None,
                    route: None,
                    weight: None,
                    source: ans.source.clone(),
                    openai_raw: ans.raw.clone(),
                    json_key: None,
                    error: None,
                });
            }
            Ok(Err(e)) => {
                last_err = Some(anyhow::anyhow!(e));
                warn!(
                    "extract attempt {} failed: {}",
                    attempt + 1,
                    last_err.as_ref().unwrap()
                );
            }
            Err(e) => {
                last_err = Some(anyhow::anyhow!("timeout: {e}"));
                warn!("extract attempt {} timed out: {}", attempt + 1, e);
            }
        }

        if attempt < cfg.openai_retries {
            let base = env_u64("PIPELINE_RETRY_BACKOFF_MS", 500);
            let delay = (base.saturating_mul(1u64 << attempt)).min(5_000);
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
    }

    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("extract failed")))
}

async fn call_score_with_retries(
    prompt_id: i32,
    text: &str,
    cfg: &BatchCfg,
) -> anyhow::Result<ScoringResult> {
    let mut last_err: Option<anyhow::Error> = None;

    for attempt in 0..=cfg.openai_retries {
        let res = tokio::time::timeout(
            Duration::from_millis(cfg.openai_timeout_ms),
            ai::score(prompt_id, text),
        )
            .await;

        match res {
            Ok(Ok(ans)) => {
                return Ok(ans);
            }
            Ok(Err(e)) => {
                last_err = Some(anyhow::anyhow!(e));
                warn!(
                    "score attempt {} failed: {}",
                    attempt + 1,
                    last_err.as_ref().unwrap()
                );
            }
            Err(e) => {
                last_err = Some(anyhow::anyhow!("timeout: {e}"));
                warn!("score attempt {} timed out: {}", attempt + 1, e);
            }
        }

        if attempt < cfg.openai_retries {
            let base = env_u64("PIPELINE_RETRY_BACKOFF_MS", 500);
            let delay = (base.saturating_mul(1u64 << attempt)).min(5_000);
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
    }

    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("score failed")))
}

async fn call_decide_with_retries(
    prompt_id: i32,
    text: &str,
    cfg: &BatchCfg,
    yes_key: &str,
    no_key: &str,
    prompt_text_for_log: &str,
) -> anyhow::Result<PromptResult> {
    let mut last_err: Option<anyhow::Error> = None;
    let state: HashMap<String, JsonValue> = HashMap::new();

    for attempt in 0..=cfg.openai_retries {
        let res = tokio::time::timeout(
            Duration::from_millis(cfg.openai_timeout_ms),
            ai::decide(prompt_id, text, &state),
        )
            .await;

        match res {
            Ok(Ok(ans)) => {
                let (boolean, route_opt): (Option<bool>, Option<String>) =
                    match (ans.boolean, ans.route.clone(), ans.value.as_ref()) {
                        (Some(b), Some(r), _) => (Some(b), Some(r)),
                        (Some(b), None, _) => (
                            Some(b),
                            Some(if b {
                                yes_key.to_string()
                            } else {
                                no_key.to_string()
                            }),
                        ),
                        (None, Some(r), _) => (None, Some(r)),
                        (None, None, Some(v)) => {
                            if let Some(s) = v.as_str() {
                                if fuzzy_true(s) {
                                    (Some(true), Some(yes_key.to_string()))
                                } else if fuzzy_false(s) {
                                    (Some(false), Some(no_key.to_string()))
                                } else {
                                    (None, Some(no_key.to_string()))
                                }
                            } else {
                                (None, Some(no_key.to_string()))
                            }
                        }
                        _ => (None, Some(no_key.to_string())),
                    };

                return Ok(PromptResult {
                    prompt_id,
                    prompt_type: PromptType::DecisionPrompt,
                    prompt_text: prompt_text_for_log.to_string(),
                    value: ans.value.clone(),
                    boolean,
                    route: route_opt,
                    weight: None,
                    source: ans.source.clone(),
                    openai_raw: ans.raw.clone(),
                    json_key: None,
                    error: None,
                });
            }
            Ok(Err(e)) => {
                last_err = Some(anyhow::anyhow!(e));
                warn!(
                    "decision attempt {} failed: {}",
                    attempt + 1,
                    last_err.as_ref().unwrap()
                );
            }
            Err(e) => {
                last_err = Some(anyhow::anyhow!("timeout: {e}"));
                warn!("decision attempt {} timed out: {}", attempt + 1, e);
            }
        }

        if attempt < cfg.openai_retries {
            let base = env_u64("PIPELINE_RETRY_BACKOFF_MS", 500);
            let delay = (base.saturating_mul(1u64 << attempt)).min(5_000);
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
    }

    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("decision failed")))
}

/* --------------------- Tri-State Konsolidierung für Scoring --------------------- */

fn clamp01f(x: f32) -> f32 {
    if !x.is_finite() { return 0.0; }
    x.max(0.0).min(1.0)
}

/// Konsolidiert eine Liste von ScoringResult (Batches) zu einem gewichteten Tri-State Ergebnis.
/// - map vote yes->+w, no->-w, unsure->0
/// - w = 0.6*strength + 0.4*confidence (Fallbacks: strength=1.0 bei vorhandenem vote, confidence=0.5)
/// - finale Score s = (yesW - noW) / (yesW + noW) in [-1,1]
/// - Label: s>=+0.6 => yes, s<=-0.6 => no, sonst unsure
fn consolidate_scoring(v: &Vec<ScoringResult>) -> ScoringResult {
    if v.is_empty() {
        return ScoringResult {
            prompt_id: 0,
            result: false,
            source: TextPosition {
                page: 0,
                bbox: [0.0, 0.0, 0.0, 0.0],
                quote: None,
            },
            explanation: "no scores".into(),
            vote: Some(TernaryLabel::unsure),
            strength: Some(0.0),
            confidence: Some(0.0),
            score: Some(0.0),
            label: Some(TernaryLabel::unsure),
        };
    }

    let pid = v[0].prompt_id;

    let mut yes_w: f32 = 0.0;
    let mut no_w: f32 = 0.0;

    for s in v {
        let vote = s.vote.or_else(|| {
            // Fallback aus legacy-boolean
            if s.result { Some(TernaryLabel::yes) } else { Some(TernaryLabel::no) }
        }).unwrap_or(TernaryLabel::unsure);

        let strength = s.strength.unwrap_or_else(|| {
            match vote {
                TernaryLabel::yes | TernaryLabel::no => 1.0, // wenn Stimme da, standardmäßig "normal stark"
                TernaryLabel::unsure => 0.0,
            }
        });
        let confidence = s.confidence.unwrap_or(0.5);

        let w = 0.6 * clamp01f(strength) + 0.4 * clamp01f(confidence);

        match vote {
            TernaryLabel::yes => yes_w += w,
            TernaryLabel::no =>  no_w += w,
            TernaryLabel::unsure => {}
        }
    }

    let total = yes_w + no_w;
    let (score, label) = if total > 0.0 {
        let s = (yes_w - no_w) / total; // -1..+1
        let lbl = if s >= 0.60 {
            TernaryLabel::yes
        } else if s <= -0.60 {
            TernaryLabel::no
        } else {
            TernaryLabel::unsure
        };
        (s, lbl)
    } else {
        // Keine gewichteten Stimmen → Mehrheit rein numerisch
        let mut trues = 0usize;
        let mut falses = 0usize;
        for s in v {
            if s.result { trues += 1 } else { falses += 1 }
        }
        let majority_yes = trues >= falses;
        let s = if trues + falses > 0 { // normierter Ersatzscore
            let total_n = (trues + falses) as f32;
            (trues as f32 - falses as f32) / total_n
        } else { 0.0 };
        let lbl = if majority_yes { TernaryLabel::yes } else { TernaryLabel::no };
        (s, lbl)
    };

    // Quelle: nimm die erste Quelle, die zum finalen Label passt, sonst die erste
    let mut chosen_src: Option<TextPosition> = None;
    for s in v {
        if let Some(vv) = s.vote {
            if vv == label {
                chosen_src = Some(s.source.clone());
                break;
            }
        } else if (label == TernaryLabel::yes && s.result) || (label == TernaryLabel::no && !s.result) {
            chosen_src = Some(s.source.clone());
            break;
        }
    }
    let source = chosen_src.unwrap_or_else(|| v[0].source.clone());

    ScoringResult {
        prompt_id: pid,
        result: matches!(label, TernaryLabel::yes), // bool Kompatibilität
        source,
        explanation: format!(
            "weighted vote: yes_w={:.3} no_w={:.3} -> score={:.3} label={:?}",
            yes_w, no_w, score, label
        ),
        vote: Some(label),         // konsolidiertes Label
        strength: None,
        confidence: Some((yes_w.max(no_w) / (total.max(1e-6))).min(1.0)), // grobe Konfidenz
        score: Some(score),
        label: Some(label),
    }
}

fn consolidate_decision(
    v: &Vec<PromptResult>,
    yes: &str,
    no: &str,
    prompt_text_for_log: &str,
) -> PromptResult {
    let pid = v.get(0).map(|r| r.prompt_id).unwrap_or_default();

    let mut yes_cnt = 0usize;
    let mut no_cnt = 0usize;

    let mut any_source: Option<TextPosition> = None;
    let mut any_raw: Option<String> = None;

    for r in v {
        if any_source.is_none() {
            any_source = r.source.clone();
        }
        if any_raw.is_none() {
            any_raw = Some(r.openai_raw.clone());
        }

        if let Some(ref route) = r.route {
            let rnorm = route.trim().to_ascii_uppercase();
            if rnorm == yes.to_ascii_uppercase() {
                yes_cnt += 1;
            } else if rnorm == no.to_ascii_uppercase() {
                no_cnt += 1;
            }
        } else if let Some(b) = r.boolean {
            if b {
                yes_cnt += 1;
            } else {
                no_cnt += 1;
            }
        }
    }

    let route = if yes_cnt >= no_cnt {
        yes.to_string()
    } else {
        no.to_string()
    };
    let boolean = if yes_cnt == no_cnt {
        None
    } else {
        Some(yes_cnt > no_cnt)
    };

    PromptResult {
        prompt_id: pid,
        prompt_type: PromptType::DecisionPrompt,
        prompt_text: prompt_text_for_log.to_string(),
        value: None,
        boolean,
        route: Some(route),
        weight: None,
        source: any_source,
        openai_raw: any_raw.unwrap_or_default(),
        json_key: None,
        error: None,
    }
}

fn fuzzy_true(s: &str) -> bool {
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "true" | "yes" | "1" | "y" | "ja"
    )
}

fn fuzzy_false(s: &str) -> bool {
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "false" | "no" | "0" | "n" | "nein"
    )
}

async fn fetch_prompt_text_for_log(prompt_id: i32) -> String {
    match ai::fetch_prompt_text(prompt_id).await {
        Ok(s) => s,
        Err(e) => {
            warn!("fetch_prompt_text failed for {}: {}", prompt_id, e);
            String::new()
        }
    }
}

pub fn compute_overall_score(items: &[(bool, f32)]) -> Option<f32> {
    if items.is_empty() {
        return None;
    }

    let mut total_weight = 0.0f32;
    let mut weighted_true = 0.0f32;

    for (result, confidence) in items {
        let mut weight = confidence.clamp(0.0, 1.0);
        if !weight.is_finite() {
            weight = 0.0;
        }
        total_weight += weight;
        if *result {
            weighted_true += weight;
        }
    }

    if total_weight <= 0.0 {
        let len = items.len() as f32;
        if len <= 0.0 {
            return None;
        }
        let true_count = items.iter().filter(|(res, _)| *res).count() as f32;
        return Some((true_count / len).clamp(0.0, 1.0));
    }

    Some((weighted_true / total_weight).clamp(0.0, 1.0))
}
