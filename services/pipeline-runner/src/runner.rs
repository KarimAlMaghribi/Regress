use std::time::Duration;

use futures::{stream, StreamExt};
use serde_json::json;
use tracing::{info, warn, error};

use shared::dto::{
    PipelineConfig, PromptType, PromptResult, ScoringResult, RunStep, TextPosition,
};
use shared::openai_client as ai;

/// Steuerung der Seitensplittung und der OpenAI-Parameter.
/// Diese Felder werden in `main.rs` aus ENV gebaut – Namen und Sichtbarkeit
/// sind exakt so gewählt, dass dein aktuelles `main.rs` ohne Änderungen kompiliert.
#[derive(Clone, Debug)]
pub struct BatchCfg {
    pub page_batch_size: usize,      // z.B. PIPELINE_PAGE_BATCH_SIZE
    pub max_parallel: usize,         // z.B. PIPELINE_MAX_PARALLEL
    pub max_chars: usize,            // z.B. PIPELINE_MAX_CHARS
    pub openai_timeout_ms: u64,      // z.B. PIPELINE_OPENAI_TIMEOUT_MS
    pub openai_retries: usize,       // z.B. PIPELINE_OPENAI_RETRIES
}

/// Ergebnis eines kompletten Pipeline-Laufs – wird an `main.rs` zurückgegeben.
#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub extraction: Vec<PromptResult>,
    pub scoring: Vec<ScoringResult>,
    pub decision: Vec<PromptResult>,
    pub log: Vec<RunStep>,
}

/// Haupt-Einstieg: verarbeitet die übergebenen `pages` (Tupel aus (page_no, text))
/// mit der gegebenen Pipeline-Konfiguration.
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

    // Vorab Batchbildung über alle Seiten –
    // Erzeugt (Vec<PageNo>, CombinedText) mit Grenzen für Seitenanzahl und Zeichenzahl.
    let batches = make_batches(pages, batch_cfg.page_batch_size, batch_cfg.max_chars);

    let mut extraction_all: Vec<PromptResult> = Vec::new();
    let mut scoring_all: Vec<ScoringResult> = Vec::new();
    let mut decision_all: Vec<PromptResult> = Vec::new();
    let mut run_log: Vec<RunStep> = Vec::new();

    // Routen-Stack: einfache Logik wie in deinem bisherigen Code
    let mut route_stack: Vec<String> = vec!["ROOT".to_string()];
    let mut current_route = "ROOT".to_string();

    for step in &cfg.steps {
        if !step.active {
            continue;
        }

        // einfache Routenlogik: wenn Step eine Route hat, nur ausführen wenn sie zur aktuellen passt
        if let Some(ref r) = step.route {
            if r != &current_route && r != "ROOT" {
                // Step gehört zu einer anderen Route – überspringen
                continue;
            }
        }

        match step.step_type {
            PromptType::ExtractionPrompt => {
                let prompt_text = fetch_prompt_text_for_log(step.prompt_id as i32).await;
                // pro Batch ein Call; parallelisiert per buffer_unordered (kein tokio::spawn!)
                let futs = batches.iter().map(|(pnos, text)| {
                    let text = text.clone();
                    let prompt_id = step.prompt_id as i32;
                    let cfg_clone = batch_cfg.clone();
                    let prompt_text_for_log = prompt_text.clone();
                    async move {
                        call_extract_with_retries(prompt_id, &text, &cfg_clone).await
                            .unwrap_or_else(|e| PromptResult {
                                prompt_id,
                                prompt_type: PromptType::ExtractionPrompt,
                                value: None,
                                boolean: None,
                                route: None,
                                weight: None,
                                source: None,
                                openai_raw: None,
                                json_key: None,
                                error: Some(format!("extract failed: {e}")),
                            })
                    }
                });

                let results: Vec<PromptResult> = stream::iter(futs)
                    .buffer_unordered(batch_cfg.max_parallel)
                    .collect()
                    .await;

                // json_key vom Step auf die Ergebnisse mappen (falls vorhanden)
                let results_mapped = results
                    .into_iter()
                    .map(|mut r| {
                        r.json_key = step.json_key.clone();
                        r
                    })
                    .collect::<Vec<_>>();

                extraction_all.extend(results_mapped.clone());

                // Log pro Step
                run_log.push(RunStep {
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id as i32,
                    prompt_type: PromptType::ExtractionPrompt,
                    decision_key: None,
                    route: Some(current_route.clone()),
                    result: json!({
                        "prompt_text": prompt_text,
                        "batches": batches.iter().map(|(pnos, _)| json!({ "pages": pnos })).collect::<Vec<_>>(),
                        "results": results_mapped.iter().map(|r| json!({
                            "value": r.value,
                            "source": r.source,
                            "error": r.error,
                        })).collect::<Vec<_>>()
                    }),
                });
            }

            PromptType::ScoringPrompt => {
                let prompt_text = fetch_prompt_text_for_log(step.prompt_id as i32).await;

                let futs = batches.iter().map(|(_pnos, text)| {
                    let text = text.clone();
                    let prompt_id = step.prompt_id as i32;
                    let cfg_clone = batch_cfg.clone();
                    async move {
                        call_score_with_retries(prompt_id, &text, &cfg_clone).await
                            .unwrap_or_else(|e| ScoringResult {
                                prompt_id,
                                score: 0.0,
                                min: 0.0,
                                max: 1.0,
                                weight: 1.0,
                                source: None,
                                openai_raw: None,
                                error: Some(format!("score failed: {e}")),
                            })
                    }
                });

                let mut batch_scores: Vec<ScoringResult> = stream::iter(futs)
                    .buffer_unordered(batch_cfg.max_parallel)
                    .collect()
                    .await;

                let consolidated = consolidate_scoring(std::mem::take(&mut batch_scores));

                scoring_all.push(consolidated.clone());

                run_log.push(RunStep {
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id as i32,
                    prompt_type: PromptType::ScoringPrompt,
                    decision_key: None,
                    route: Some(current_route.clone()),
                    result: json!({
                        "prompt_text": prompt_text,
                        "batches": batches.len(),
                        "scores": batch_scores, // leer, da wir übernommen und geleert haben (nur zur Vollständigkeit)
                        "consolidated": consolidated
                    }),
                });
            }

            PromptType::DecisionPrompt => {
                // Für Decision benötigen wir die Zuordnung der Keys (yes/no) aus dem Step:
                let yes_key = step.yes_key.clone().unwrap_or_else(|| "YES".into());
                let no_key  = step.no_key.clone().unwrap_or_else(|| "NO".into());
                let prompt_text = fetch_prompt_text_for_log(step.prompt_id as i32).await;

                let futs = batches.iter().map(|(_pnos, text)| {
                    let text = text.clone();
                    let prompt_id = step.prompt_id as i32;
                    let cfg_clone = batch_cfg.clone();
                    let yes_key = yes_key.clone();
                    let no_key  = no_key.clone();
                    async move {
                        call_decide_with_retries(prompt_id, &text, &cfg_clone, &yes_key, &no_key).await
                            .unwrap_or_else(|e| PromptResult {
                                prompt_id,
                                prompt_type: PromptType::DecisionPrompt,
                                value: None,
                                boolean: None,
                                route: Some(no_key.clone()),
                                weight: None,
                                source: None,
                                openai_raw: None,
                                json_key: None,
                                error: Some(format!("decision failed: {e}")),
                            })
                    }
                });

                let mut decisions: Vec<PromptResult> = stream::iter(futs)
                    .buffer_unordered(batch_cfg.max_parallel)
                    .collect()
                    .await;

                let consolidated = consolidate_decision(std::mem::take(&mut decisions), &yes_key, &no_key);

                // Routenwechsel nach Decision
                if let Some(ref r) = consolidated.route {
                    if r != &current_route {
                        route_stack.push(r.clone());
                        current_route = r.clone();
                    }
                }

                decision_all.push(consolidated.clone());

                run_log.push(RunStep {
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id as i32,
                    prompt_type: PromptType::DecisionPrompt,
                    decision_key: step.decision_key.clone(),
                    route: Some(current_route.clone()),
                    result: json!({
                        "prompt_text": prompt_text,
                        "votes": decisions,
                        "consolidated": consolidated
                    }),
                });
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

/// -------- Helpers

/// Batching über Seiten: bündelt bis `page_batch_size` Seiten und höchstens `max_chars` Zeichen.
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
        if !cur_pages.is_empty()
            && (cur_pages.len() >= page_batch_size || would_len > max_chars)
        {
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

/// Extraktion mit Timeout + Retries (nicht rekursiv, keine Splits — Splits übernimmt bereits das Batching).
async fn call_extract_with_retries(
    prompt_id: i32,
    text: &str,
    cfg: &BatchCfg,
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
                warn!("extract attempt {} failed: {}", attempt + 1, last_err.as_ref().unwrap());
            }
            Err(e) => {
                last_err = Some(anyhow::anyhow!("timeout: {e}"));
                warn!("extract attempt {} timed out: {}", attempt + 1, last_err.as_ref().unwrap());
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
                warn!("score attempt {} failed: {}", attempt + 1, last_err.as_ref().unwrap());
            }
            Err(e) => {
                last_err = Some(anyhow::anyhow!("timeout: {e}"));
                warn!("score attempt {} timed out: {}", attempt + 1, last_err.as_ref().unwrap());
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
) -> anyhow::Result<PromptResult> {
    let mut last_err: Option<anyhow::Error> = None;

    for attempt in 0..=cfg.openai_retries {
        let res = tokio::time::timeout(
            Duration::from_millis(cfg.openai_timeout_ms),
            ai::decide(prompt_id, text),
        )
            .await;

        match res {
            Ok(Ok(ans)) => {
                // robustes Parsing: boolean aus raw/value ableiten; fallback = NO
                let (boolean, route) = match (
                    ans.boolean,
                    ans.value.as_deref(),
                    ans.raw.as_deref(),
                ) {
                    (Some(b), _, _) => (Some(b), if b { yes_key.to_string() } else { no_key.to_string() }),
                    (None, Some(vs), _) => {
                        if fuzzy_true(vs) { (Some(true), yes_key.to_string()) }
                        else if fuzzy_false(vs) { (Some(false), no_key.to_string()) }
                        else { (None, no_key.to_string()) }
                    }
                    (None, None, Some(raw)) => {
                        if raw.to_ascii_lowercase().contains("\"answer\": true") {
                            (Some(true), yes_key.to_string())
                        } else if raw.to_ascii_lowercase().contains("\"answer\": false") {
                            (Some(false), no_key.to_string())
                        } else {
                            (None, no_key.to_string())
                        }
                    }
                    _ => (None, no_key.to_string()),
                };

                return Ok(PromptResult {
                    prompt_id,
                    prompt_type: PromptType::DecisionPrompt,
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
                warn!("decision attempt {} failed: {}", attempt + 1, last_err.as_ref().unwrap());
            }
            Err(e) => {
                last_err = Some(anyhow::anyhow!("timeout: {e}"));
                warn!("decision attempt {} timed out: {}", attempt + 1, last_err.as_ref().unwrap());
            }
        }
    }

    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("decision failed")))
}

/// Einfache Mehrheits-/Heuristik-Konsolidierung für Scoring:
/// - Ignoriere Einträge mit error
/// - Mittelwert aus gültigen Scores; Quelle vom Score mit größter Quelle (oder erster)
fn consolidate_scoring(v: Vec<ScoringResult>) -> ScoringResult {
    let mut good: Vec<&ScoringResult> = v.iter().filter(|s| s.error.is_none()).collect();
    if good.is_empty() {
        return ScoringResult {
            prompt_id: v.get(0).map(|s| s.prompt_id).unwrap_or_default(),
            score: 0.0,
            min: 0.0,
            max: 1.0,
            weight: 1.0,
            source: None,
            openai_raw: None,
            error: Some("no valid scores".into()),
        };
    }

    let sum: f32 = good.iter().map(|s| s.score).sum();
    let avg = sum / (good.len() as f32);
    let base = good[0];

    ScoringResult {
        prompt_id: base.prompt_id,
        score: avg,
        min: base.min,
        max: base.max,
        weight: base.weight,
        source: base.source.clone(),
        openai_raw: base.openai_raw.clone(),
        error: None,
    }
}

/// Konsolidierung für Decision (Mehrheit der Routen).
fn consolidate_decision(mut v: Vec<PromptResult>, yes: &str, no: &str) -> PromptResult {
    let pid = v.get(0).map(|r| r.prompt_id).unwrap_or_default();

    let mut yes_cnt = 0usize;
    let mut no_cnt  = 0usize;

    let mut any_source: Option<TextPosition> = None;
    let mut any_raw: Option<String> = None;

    for r in &v {
        if any_source.is_none() { any_source = r.source.clone(); }
        if any_raw.is_none()    { any_raw = r.openai_raw.clone(); }

        if let Some(ref route) = r.route {
            let rnorm = route.trim().to_ascii_uppercase();
            if rnorm == yes.to_ascii_uppercase() { yes_cnt += 1; }
            else if rnorm == no.to_ascii_uppercase() { no_cnt += 1; }
        } else if let Some(b) = r.boolean {
            if b { yes_cnt += 1; } else { no_cnt += 1; }
        }
    }

    let route = if yes_cnt >= no_cnt { yes.to_string() } else { no.to_string() };
    let boolean = if yes_cnt == no_cnt { None } else { Some(yes_cnt > no_cnt) };

    PromptResult {
        prompt_id: pid,
        prompt_type: PromptType::DecisionPrompt,
        value: None,
        boolean,
        route: Some(route),
        weight: None,
        source: any_source,
        openai_raw: any_raw,
        json_key: None,
        error: None,
    }
}

fn fuzzy_true(s: &str) -> bool {
    matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "yes" | "1" | "y" | "ja")
}

fn fuzzy_false(s: &str) -> bool {
    matches!(s.trim().to_ascii_lowercase().as_str(), "false" | "no" | "0" | "n" | "nein")
}

/// Kleiner Helper: Prompt-Text nur fürs Log holen; Fehler sind für die Pipeline nicht kritisch.
async fn fetch_prompt_text_for_log(prompt_id: i32) -> String {
    match ai::fetch_prompt_text(prompt_id).await {
        Ok(s) => s,
        Err(e) => {
            warn!("fetch_prompt_text failed for {}: {}", prompt_id, e);
            String::new()
        }
    }
}

/// Optionaler Convenience-Helper, falls `main.rs` eine Gesamtnote berechnen will.
pub fn compute_overall_score(out: &RunOutcome) -> Option<f32> {
    if out.scoring.is_empty() { return None; }
    let sum: f32 = out.scoring.iter().filter_map(|s| if s.error.is_none() { Some(s.score) } else { None }).sum();
    let n = out.scoring.iter().filter(|s| s.error.is_none()).count();
    if n == 0 { None } else { Some(sum / (n as f32)) }
}
