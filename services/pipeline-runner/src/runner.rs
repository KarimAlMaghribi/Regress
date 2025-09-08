use std::collections::HashMap;
use std::time::Duration;

use futures::{stream, StreamExt};
use serde_json::{json, Value as JsonValue};
use tracing::{info, warn};

use shared::dto::{PipelineConfig, PromptResult, PromptType, RunStep, ScoringResult, TextPosition};
use shared::openai_client as ai;

#[derive(Clone, Debug)]
pub struct BatchCfg {
    pub page_batch_size: usize, // z.B. PIPELINE_PAGE_BATCH_SIZE
    pub max_parallel: usize,    // z.B. PIPELINE_MAX_PARALLEL
    pub max_chars: usize,       // z.B. PIPELINE_MAX_CHARS
    pub openai_timeout_ms: u64, // z.B. PIPELINE_OPENAI_TIMEOUT_MS
    pub openai_retries: usize,  // z.B. PIPELINE_OPENAI_RETRIES
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

    let batches = make_batches(pages, batch_cfg.page_batch_size, batch_cfg.max_chars);

    let mut extraction_all: Vec<PromptResult> = Vec::new();
    let mut scoring_all: Vec<ScoringResult> = Vec::new();
    let mut decision_all: Vec<PromptResult> = Vec::new();
    let mut run_log: Vec<RunStep> = Vec::new();

    let mut current_route = "ROOT".to_string();
    let mut _route_stack: Vec<String> = vec!["ROOT".to_string()];
    let mut seq_no: i32 = 0;

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

                let futs = batches.iter().map(|(_pnos, text)| {
                    let text = text.clone();
                    let prompt_id = step.prompt_id as i32;
                    let cfg_clone = batch_cfg.clone();
                    let pt = prompt_text.clone();
                    async move {
                        call_extract_with_retries(prompt_id, &text, &cfg_clone, pt)
                            .await
                            .unwrap_or_else(|e| {
                                warn!("extract failed: {}", e);
                                PromptResult {
                                    prompt_id,
                                    prompt_type: PromptType::ExtractionPrompt,
                                    prompt_text: String::new(),
                                    value: None,
                                    boolean: None,
                                    route: None,
                                    weight: None,
                                    source: None,
                                    openai_raw: String::new(),
                                    json_key: None,
                                    error: Some(format!("extract failed: {e}")),
                                }
                            })
                    }
                });

                let results: Vec<PromptResult> = stream::iter(futs)
                    .buffer_unordered(batch_cfg.max_parallel)
                    .collect()
                    .await;

                seq_no += 1;
                run_log.push(RunStep {
                    seq_no,
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id,
                    prompt_type: PromptType::ExtractionPrompt,
                    decision_key: None,
                    route: Some(current_route.clone()),
                    result: json!({
                        "prompt_text": prompt_text,
                        "batch_count": batches.len(),
                        "results": results.iter().map(|r| json!({
                            "value": r.value,
                            "source": r.source,
                            "error": r.error,
                        })).collect::<Vec<_>>()
                    }),
                });

                extraction_all.extend(results);
            }

            PromptType::ScoringPrompt => {
                let prompt_text = fetch_prompt_text_for_log(step.prompt_id as i32).await;

                let futs = batches.iter().map(|(_pnos, text)| {
                    let text = text.clone();
                    let prompt_id = step.prompt_id as i32;
                    let cfg_clone = batch_cfg.clone();
                    async move {
                        match call_score_with_retries(prompt_id, &text, &cfg_clone).await {
                            Ok(sr) => Some(sr),
                            Err(e) => {
                                warn!("score failed: {}", e);
                                None
                            }
                        }
                    }
                });

                let batch_scores_opt: Vec<Option<ScoringResult>> = stream::iter(futs)
                    .buffer_unordered(batch_cfg.max_parallel)
                    .collect()
                    .await;

                let batch_scores: Vec<ScoringResult> =
                    batch_scores_opt.into_iter().flatten().collect();

                let consolidated = consolidate_scoring(&batch_scores);

                // Log pro Step
                seq_no += 1;
                run_log.push(RunStep {
                    seq_no,
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id, // i64
                    prompt_type: PromptType::ScoringPrompt,
                    decision_key: None,
                    route: Some(current_route.clone()),
                    result: json!({
                        "prompt_text": prompt_text,
                        "batch_count": batches.len(),
                        "scores": batch_scores.iter().map(|s| json!({
                            "prompt_id": s.prompt_id,
                            "result": s.result,
                            "source": s.source,
                            "explanation": s.explanation
                        })).collect::<Vec<_>>(),
                        "consolidated": consolidated.as_ref().map(|s| json!({
                            "prompt_id": s.prompt_id,
                            "result": s.result,
                            "source": s.source,
                            "explanation": s.explanation
                        }))
                    }),
                });

                if let Some(s) = consolidated {
                    scoring_all.push(s);
                }
            }

            PromptType::DecisionPrompt => {
                let yes_key = step.yes_key.clone().unwrap_or_else(|| String::from("YES"));
                let no_key = step.no_key.clone().unwrap_or_else(|| String::from("NO"));
                let prompt_text = fetch_prompt_text_for_log(step.prompt_id as i32).await;

                let futs = batches.iter().map(|(_pnos, text)| {
                    let text = text.clone();
                    let prompt_id = step.prompt_id as i32;
                    let cfg_clone = batch_cfg.clone();
                    let yk = yes_key.clone();
                    let nk = no_key.clone();
                    let pt = prompt_text.clone();
                    async move {
                        call_decide_with_retries(prompt_id, &text, &cfg_clone, &yk, &nk, pt)
                            .await
                            .unwrap_or_else(|e| {
                                warn!("decision failed: {}", e);
                                PromptResult {
                                    prompt_id,
                                    prompt_type: PromptType::DecisionPrompt,
                                    prompt_text: String::new(),
                                    value: None,
                                    boolean: None,
                                    route: Some(nk.clone()),
                                    weight: None,
                                    source: None,
                                    openai_raw: String::new(),
                                    json_key: None,
                                    error: Some(format!("decision failed: {e}")),
                                }
                            })
                    }
                });

                let mut decisions: Vec<PromptResult> = stream::iter(futs)
                    .buffer_unordered(batch_cfg.max_parallel)
                    .collect()
                    .await;

                let consolidated =
                    consolidate_decision(std::mem::take(&mut decisions), &yes_key, &no_key);

                if let Some(ref r) = consolidated.route {
                    if r != &current_route {
                        _route_stack.push(r.clone());
                        current_route = r.clone();
                    }
                }

                seq_no += 1;
                run_log.push(RunStep {
                    seq_no,
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id,
                    prompt_type: PromptType::DecisionPrompt,
                    decision_key: None,
                    route: Some(current_route.clone()),
                    result: json!({
                        "prompt_text": prompt_text,
                        "votes": decisions.iter().map(|r| json!({
                            "boolean": r.boolean,
                            "route": r.route,
                            "source": r.source,
                            "error": r.error
                        })).collect::<Vec<_>>(),
                        "consolidated": {
                            "boolean": consolidated.boolean,
                            "route": consolidated.route,
                            "source": consolidated.source,
                        }
                    }),
                });

                decision_all.push(consolidated);
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
    prompt_text: String,
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
                    prompt_text,
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
                warn!(
                    "extract attempt {} timed out: {}",
                    attempt + 1,
                    last_err.as_ref().unwrap()
                );
            }
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
            Ok(Ok(sr)) => {
                return Ok(sr);
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
                warn!(
                    "score attempt {} timed out: {}",
                    attempt + 1,
                    last_err.as_ref().unwrap()
                );
            }
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
    prompt_text: String,
) -> anyhow::Result<PromptResult> {
    let mut last_err: Option<anyhow::Error> = None;

    for attempt in 0..=cfg.openai_retries {
        let ctx: HashMap<String, JsonValue> = HashMap::new();

        let res = tokio::time::timeout(
            Duration::from_millis(cfg.openai_timeout_ms),
            ai::decide(prompt_id, text, &ctx),
        )
        .await;

        match res {
            Ok(Ok(ans)) => {
                let (boolean, route) = if let Some(b) = ans.boolean {
                    (
                        Some(b),
                        if b {
                            yes_key.to_string()
                        } else {
                            no_key.to_string()
                        },
                    )
                } else if let Some(v) = ans.value.clone() {
                    if let Some(b) = v.as_bool() {
                        (
                            Some(b),
                            if b {
                                yes_key.to_string()
                            } else {
                                no_key.to_string()
                            },
                        )
                    } else if let Some(s) = v.as_str() {
                        if fuzzy_true(s) {
                            (Some(true), yes_key.to_string())
                        } else if fuzzy_false(s) {
                            (Some(false), no_key.to_string())
                        } else {
                            (None, no_key.to_string())
                        }
                    } else {
                        (None, no_key.to_string())
                    }
                } else {
                    let raw_lc = ans.raw.to_ascii_lowercase();
                    if raw_lc.contains("\"answer\": true") {
                        (Some(true), yes_key.to_string())
                    } else if raw_lc.contains("\"answer\": false") {
                        (Some(false), no_key.to_string())
                    } else {
                        (None, no_key.to_string())
                    }
                };

                return Ok(PromptResult {
                    prompt_id,
                    prompt_type: PromptType::DecisionPrompt,
                    prompt_text,
                    value: None,
                    boolean,
                    route: Some(route),
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
                warn!(
                    "decision attempt {} timed out: {}",
                    attempt + 1,
                    last_err.as_ref().unwrap()
                );
            }
        }
    }

    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("decision failed")))
}

fn consolidate_scoring(v: &Vec<ScoringResult>) -> Option<ScoringResult> {
    if v.is_empty() {
        return None;
    }
    let sum: f32 = v.iter().map(|s| s.result).sum();
    let avg = sum / (v.len() as f32);
    let base = &v[0];

    Some(ScoringResult {
        prompt_id: base.prompt_id,
        result: avg,
        source: base.source.clone(),
        explanation: base.explanation.clone(),
    })
}

fn consolidate_decision(mut v: Vec<PromptResult>, yes: &str, no: &str) -> PromptResult {
    let pid = v.get(0).map(|r| r.prompt_id).unwrap_or_default();

    let mut yes_cnt = 0usize;
    let mut no_cnt = 0usize;

    let mut any_source: Option<TextPosition> = None;
    let mut any_raw: Option<String> = None;

    for r in &v {
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
        prompt_text: String::new(),
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

pub fn compute_overall_score(scoring: &Vec<ScoringResult>) -> Option<f32> {
    if scoring.is_empty() {
        return None;
    }
    let sum: f32 = scoring.iter().map(|s| s.result).sum();
    Some(sum / (scoring.len() as f32))
}
