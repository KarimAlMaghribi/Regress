use anyhow::Result;
use futures::{stream::FuturesUnordered, StreamExt};
use serde_json::Value;
use shared::{
    dto::{PipelineConfig, PromptResult, PromptType, RunStep, ScoringResult, TextPosition},
    openai_client,
};
use std::{cmp::Ordering, collections::HashMap, sync::Arc, time::Duration};
use tokio::{sync::Semaphore, time::sleep};

#[derive(Default, Clone)]
pub struct RunState {
    pub route_stack: Vec<String>,
    pub route: Option<String>,
    pub result: Option<Value>,
}

pub struct RunOutcome {
    pub extraction: Vec<PromptResult>,
    pub scoring: Vec<ScoringResult>,
    pub decision: Vec<PromptResult>,
    pub log: Vec<RunStep>,
}

#[derive(Clone, Debug)]
struct BatchCfg {
    max_chars: usize,
    max_parallel: usize,
    retries: usize,
    timeout: Duration,
}

impl Default for BatchCfg {
    fn default() -> Self {
        // Defaults defensiv wählen; können im Stack via ENV gesetzt werden
        Self {
            max_chars: read_env_usize("PIPELINE_MAX_CHARS", 20_000),
            max_parallel: read_env_usize("PIPELINE_MAX_PARALLEL", 3),
            retries: read_env_usize("PIPELINE_OPENAI_RETRIES", 2),
            timeout: Duration::from_millis(
                read_env_usize("PIPELINE_OPENAI_TIMEOUT_MS", 25_000) as u64
            ),
        }
    }
}

fn read_env_usize(key: &str, default_: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(default_)
}

fn chunk_text_by_chars(s: &str, max_chars: usize) -> Vec<String> {
    if s.len() <= max_chars {
        return vec![s.to_string()];
    }
    let mut out = Vec::new();
    let mut start = 0;
    while start < s.len() {
        let end = (start + max_chars).min(s.len());
        out.push(s[start..end].to_string());
        start = end;
    }
    out
}

fn backoff(attempt: usize) -> Duration {
    Duration::from_millis(300u64.saturating_mul(1u64 << attempt.min(4)))
}

pub fn compute_overall_score(results: &[ScoringResult]) -> Option<f32> {
    if results.is_empty() {
        return None;
    }
    let sum: f32 = results
        .iter()
        .map(|r| if r.result { 1.0 } else { 0.0 })
        .sum();
    Some(sum / results.len() as f32)
}

fn normalize_decision(
    res_json: &Value,
    ans_route: Option<&str>,
    ans_bool: Option<bool>,
    yes: &str,
    no: &str,
) -> String {
    let map_str = |s: &str| -> Option<String> {
        if s == yes || s == no {
            Some(s.to_string())
        } else if s.eq_ignore_ascii_case("true") {
            Some(yes.to_string())
        } else if s.eq_ignore_ascii_case("false") {
            Some(no.to_string())
        } else {
            None
        }
    };

    if let Some(r) = res_json
        .get("route")
        .and_then(|v| v.as_str())
        .and_then(|r| map_str(r))
    {
        return r;
    }
    if let Some(b) = res_json
        .get("bool")
        .and_then(|v| v.as_bool())
        .or_else(|| res_json.get("boolean").and_then(|v| v.as_bool()))
        .or_else(|| res_json.as_bool())
    {
        return if b { yes.to_string() } else { no.to_string() };
    }
    if let Some(r) = ans_route.and_then(|r| map_str(r)) {
        return r;
    }
    if let Some(b) = ans_bool {
        return if b { yes.to_string() } else { no.to_string() };
    }
    yes.to_string()
}

async fn run_extract_batched(
    prompt_id: i32,
    full_text: &str,
    cfg: &BatchCfg,
    prompt_text_for_log: &str,
) -> Vec<PromptResult> {
    let chunks = chunk_text_by_chars(full_text, cfg.max_chars);
    let sem = Arc::new(Semaphore::new(cfg.max_parallel));
    let mut tasks = FuturesUnordered::new();

    for (idx, chunk) in chunks.into_iter().enumerate() {
        let permit = sem.clone().acquire_owned().await.expect("semaphore");
        let chunk_clone = chunk.clone();
        let cfg = cfg.clone();
        tasks.push(tokio::spawn(async move {
            let _guard = permit;

            let mut last_err: Option<String> = None;
            for attempt in 0..=cfg.retries {
                match openai_client::extract(prompt_id, &chunk_clone).await {
                    Ok(ans) => {
                        return PromptResult {
                            prompt_id,
                            prompt_type: PromptType::ExtractionPrompt,
                            prompt_text: prompt_text_for_log.to_string(),
                            boolean: None,
                            value: ans.value,
                            weight: None,
                            route: None,
                            json_key: None,
                            source: ans.source,
                            error: None,
                            openai_raw: ans.raw,
                        };
                    }
                    Err(e) => {
                        last_err = Some(e.to_string());
                        sleep(backoff(attempt)).await;
                    }
                }
            }
            PromptResult {
                prompt_id,
                prompt_type: PromptType::ExtractionPrompt,
                prompt_text: prompt_text_for_log.to_string(),
                boolean: None,
                value: None,
                weight: None,
                route: None,
                json_key: None,
                source: None,
                error: last_err.or(Some("extraction failed".to_string())),
                openai_raw: String::new(),
            }
        }));
        if idx + 1 >= cfg.max_parallel {
        }
    }

    let mut out = Vec::new();
    while let Some(joined) = tasks.next().await {
        match joined {
            Ok(pr) => out.push(pr),
            Err(e) => out.push(PromptResult {
                prompt_id,
                prompt_type: PromptType::ExtractionPrompt,
                prompt_text: prompt_text_for_log.to_string(),
                boolean: None,
                value: None,
                weight: None,
                route: None,
                json_key: None,
                source: None,
                error: Some(format!("join error: {e}")),
                openai_raw: String::new(),
            }),
        }
    }
    out
}

async fn run_scoring_batched(
    prompt_id: i32,
    full_text: &str,
    cfg: &BatchCfg,
) -> Vec<ScoringResult> {
    let chunks = chunk_text_by_chars(full_text, cfg.max_chars);
    let sem = Arc::new(Semaphore::new(cfg.max_parallel));
    let mut tasks = FuturesUnordered::new();

    for chunk in chunks {
        let permit = sem.clone().acquire_owned().await.expect("semaphore");
        let cfg = cfg.clone();
        tasks.push(tokio::spawn(async move {
            let _guard = permit;
            let mut last: Option<ScoringResult> = None;
            for attempt in 0..=cfg.retries {
                match openai_client::score(prompt_id, &chunk).await {
                    Ok(sr) => return sr,
                    Err(e) => {
                        last = Some(ScoringResult {
                            prompt_id,
                            result: false,
                            source: TextPosition {
                                page: 0,
                                bbox: [0.0, 0.0, 0.0, 0.0],
                                quote: Some(String::new()),
                            },
                            explanation: e.to_string(),
                        });
                        sleep(backoff(attempt)).await;
                    }
                }
            }
            last.unwrap_or(ScoringResult {
                prompt_id,
                result: false,
                source: TextPosition {
                    page: 0,
                    bbox: [0.0, 0.0, 0.0, 0.0],
                    quote: Some(String::new()),
                },
                explanation: "scoring failed".to_string(),
            })
        }));
    }

    let mut out = Vec::new();
    while let Some(joined) = tasks.next().await {
        match joined {
            Ok(sr) => out.push(sr),
            Err(e) => out.push(ScoringResult {
                prompt_id,
                result: false,
                source: TextPosition {
                    page: 0,
                    bbox: [0.0, 0.0, 0.0, 0.0],
                    quote: Some(String::new()),
                },
                explanation: format!("join error: {e}"),
            }),
        }
    }
    out
}

async fn run_decision_batched(
    prompt_id: i32,
    full_text: &str,
    cfg: &BatchCfg,
    state_map: &HashMap<String, Value>,
    prompt_text_for_log: &str,
) -> Vec<PromptResult> {
    let chunks = chunk_text_by_chars(full_text, cfg.max_chars);
    let sem = Arc::new(Semaphore::new(cfg.max_parallel));
    let mut tasks = FuturesUnordered::new();

    for chunk in chunks {
        let permit = sem.clone().acquire_owned().await.expect("semaphore");
        let cfg = cfg.clone();
        let state_map = state_map.clone();
        let chunk_clone = chunk.clone();

        tasks.push(tokio::spawn(async move {
            let _guard = permit;
            let mut last_err: Option<String> = None;
            for attempt in 0..=cfg.retries {
                match openai_client::decide(prompt_id, &chunk_clone, &state_map).await {
                    Ok(ans) => {
                        return PromptResult {
                            prompt_id,
                            prompt_type: PromptType::DecisionPrompt,
                            prompt_text: prompt_text_for_log.to_string(),
                            boolean: ans.boolean,
                            value: ans.value,
                            weight: None,
                            route: ans.route.clone(),
                            json_key: None,
                            source: ans.source,
                            error: None,
                            openai_raw: ans.raw,
                        }
                    }
                    Err(e) => {
                        last_err = Some(e.to_string());
                        sleep(backoff(attempt)).await;
                    }
                }
            }
            PromptResult {
                prompt_id,
                prompt_type: PromptType::DecisionPrompt,
                prompt_text: prompt_text_for_log.to_string(),
                boolean: None,
                value: None,
                weight: None,
                route: None,
                json_key: None,
                source: None,
                error: last_err.or(Some("decision failed".to_string())),
                openai_raw: String::new(),
            }
        }));
    }

    let mut out = Vec::new();
    while let Some(joined) = tasks.next().await {
        match joined {
            Ok(pr) => out.push(pr),
            Err(e) => out.push(PromptResult {
                prompt_id,
                prompt_type: PromptType::DecisionPrompt,
                prompt_text: prompt_text_for_log.to_string(),
                boolean: None,
                value: None,
                weight: None,
                route: None,
                json_key: None,
                source: None,
                error: Some(format!("join error: {e}")),
                openai_raw: String::new(),
            }),
        }
    }
    out
}

fn normalize_string_value(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Null => None,
        _ => Some(v.to_string()),
    }
}

fn consolidate_extraction(mut v: Vec<PromptResult>) -> PromptResult {
    // Mehrheitsentscheid über "value" (case-insensitive, trimmed); bei Gleichstand: längstes Quote bevorzugen
    let mut freq: HashMap<String, usize> = HashMap::new();
    for pr in &v {
        if let Some(val) = pr.value.as_ref().and_then(normalize_string_value) {
            *freq.entry(val.to_lowercase()).or_insert(0) += 1;
        }
    }

    v.sort_by(|a, b| {
        let fa = a
            .value
            .as_ref()
            .and_then(normalize_string_value)
            .map(|s| *freq.get(&s.to_lowercase()).unwrap_or(&0))
            .unwrap_or(0);
        let fb = b
            .value
            .as_ref()
            .and_then(normalize_string_value)
            .map(|s| *freq.get(&s.to_lowercase()).unwrap_or(&0))
            .unwrap_or(0);
        match fb.cmp(&fa) {
            Ordering::Equal => {
                // 2) längeres Quote bevorzugen
                let qa = a
                    .source
                    .as_ref()
                    .and_then(|p| p.quote.as_ref())
                    .map(|q| q.len())
                    .unwrap_or(0);
                let qb = b
                    .source
                    .as_ref()
                    .and_then(|p| p.quote.as_ref())
                    .map(|q| q.len())
                    .unwrap_or(0);
                qb.cmp(&qa)
            }
            other => other,
        }
    });

    v.into_iter().next().unwrap_or_else(|| PromptResult {
        prompt_id: 0,
        prompt_type: PromptType::ExtractionPrompt,
        prompt_text: String::new(),
        boolean: None,
        value: None,
        weight: None,
        route: None,
        json_key: None,
        source: None,
        error: Some("no results".to_string()),
        openai_raw: String::new(),
    })
}

fn consolidate_scoring(v: Vec<ScoringResult>) -> ScoringResult {
    if v.is_empty() {
        return ScoringResult {
            prompt_id: 0,
            result: false,
            source: TextPosition {
                page: 0,
                bbox: [0.0; 4],
                quote: Some(String::new()),
            },
            explanation: "no results".to_string(),
        };
    }
    let trues = v.iter().filter(|s| s.result).count();
    let falses = v.len() - trues;
    let majority_true = trues >= falses;
    v.into_iter()
        .filter(|s| s.result == majority_true)
        .max_by_key(|s| s.source.quote.as_ref().map(|q| q.len()).unwrap_or(0))
        .unwrap()
}

fn consolidate_decision(mut v: Vec<PromptResult>, _yes: &str, _no: &str) -> PromptResult {
    if v.is_empty() {
        return PromptResult {
            prompt_id: 0,
            prompt_type: PromptType::DecisionPrompt,
            prompt_text: String::new(),
            boolean: None,
            value: None,
            weight: None,
            route: None,
            json_key: None,
            source: None,
            error: Some("no decision results".to_string()),
            openai_raw: String::new(),
        };
    }
    let mut true_cnt = 0usize;
    let mut false_cnt = 0usize;
    let mut route_freq: HashMap<String, usize> = HashMap::new();

    for pr in &v {
        if let Some(b) = pr.boolean {
            if b {
                true_cnt += 1
            } else {
                false_cnt += 1
            }
        }
        if let Some(r) = &pr.route {
            *route_freq.entry(r.clone()).or_insert(0) += 1;
        }
    }

    v.sort_by(|a, b| {
        let fa = a
            .boolean
            .map(|x| if x { true_cnt } else { false_cnt })
            .unwrap_or(0);
        let fb = b
            .boolean
            .map(|x| if x { true_cnt } else { false_cnt })
            .unwrap_or(0);
        match fb.cmp(&fa) {
            Ordering::Equal => {
                // 2) Route-Mehrheit
                let ra = a
                    .route
                    .as_ref()
                    .map(|r| *route_freq.get(r).unwrap_or(&0))
                    .unwrap_or(0);
                let rb = b
                    .route
                    .as_ref()
                    .map(|r| *route_freq.get(r).unwrap_or(&0))
                    .unwrap_or(0);
                rb.cmp(&ra)
            }
            other => other,
        }
    });

    v.into_iter().next().unwrap()
}

pub async fn execute(cfg: &PipelineConfig, pdf_text: &str) -> Result<RunOutcome> {
    let batch_cfg = BatchCfg::default();

    let mut state = RunState {
        route_stack: vec!["ROOT".to_string()],
        route: Some("ROOT".to_string()),
        result: None,
    };

    let mut extraction = Vec::new();
    let mut scoring = Vec::new();
    let mut decision = Vec::new();
    let mut run_log: Vec<RunStep> = Vec::new();
    let mut seq: u32 = 1;

    for step in &cfg.steps {
        if step.route.is_none() || step.route.as_deref() == Some("ROOT") {
            while state.route_stack.len() > 1 {
                state.route_stack.pop();
            }
            state.route = Some("ROOT".to_string());
        } else if let Some(req) = &step.route {
            if state.route.as_deref() != Some(req.as_str()) {
                if let Some(pos) = state.route_stack.iter().rposition(|r| r == req) {
                    state.route_stack.truncate(pos + 1);
                    state.route = state.route_stack.last().cloned();
                } else {
                    continue;
                }
            }
        }

        // Gate
        if let Some(req) = &step.route {
            if state.route.as_deref() != Some(req.as_str()) {
                continue;
            }
        }

        // Inaktive Steps überspringen
        if !step.active {
            continue;
        }

        match step.step_type {
            PromptType::ExtractionPrompt => {
                let prompt_text = openai_client::fetch_prompt_text(step.prompt_id as i32)
                    .await
                    .unwrap_or_default();

                // Baches ausführen
                let parts =
                    run_extract_batched(step.prompt_id as i32, pdf_text, &batch_cfg, &prompt_text)
                        .await;

                let pr = consolidate_extraction(parts);
                let pr_log = pr.clone();

                extraction.push(pr);
                run_log.push(RunStep {
                    seq_no: seq,
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id,
                    prompt_type: step.step_type.clone(),
                    decision_key: None,
                    route: state.route.clone(),
                    result: serde_json::to_value(&pr_log)?,
                });
                seq += 1;
            }

            PromptType::ScoringPrompt => {
                // Mehrere Batches scoren & konsolidieren
                let scored = run_scoring_batched(step.prompt_id as i32, pdf_text, &batch_cfg).await;
                let sr = consolidate_scoring(scored);
                let sr_log = sr.clone();

                scoring.push(sr);
                run_log.push(RunStep {
                    seq_no: seq,
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id,
                    prompt_type: step.step_type.clone(),
                    decision_key: None,
                    route: state.route.clone(),
                    result: serde_json::to_value(&sr_log)?,
                });
                seq += 1;
            }

            PromptType::DecisionPrompt => {
                let prompt_text = openai_client::fetch_prompt_text(step.prompt_id as i32)
                    .await
                    .unwrap_or_default();

                let mut state_map = HashMap::new();
                if let Some(r) = &state.route {
                    state_map.insert("route".into(), Value::String(r.clone()));
                }
                if !state.route_stack.is_empty() {
                    state_map.insert(
                        "route_stack".into(),
                        Value::Array(
                            state
                                .route_stack
                                .iter()
                                .map(|s| Value::String(s.clone()))
                                .collect(),
                        ),
                    );
                }
                if let Some(res) = &state.result {
                    state_map.insert("result".into(), res.clone());
                }

                let parts = run_decision_batched(
                    step.prompt_id as i32,
                    pdf_text,
                    &batch_cfg,
                    &state_map,
                    &prompt_text,
                )
                .await;

                let yes = step.yes_key.as_deref().unwrap_or("yes");
                let no = step.no_key.as_deref().unwrap_or("no");

                let mut pr = consolidate_decision(parts, yes, no);

                let res_json = serde_json::from_str::<Value>(&pr.openai_raw).unwrap_or(Value::Null);
                let route_key =
                    normalize_decision(&res_json, pr.route.as_deref(), pr.boolean, yes, no);
                let exec_route = state.route.clone();
                state.result = Some(res_json);
                state.route_stack.push(route_key.clone());
                state.route = Some(route_key.clone());
                pr.route = Some(route_key.clone());

                let pr_log = pr.clone();
                decision.push(pr);
                run_log.push(RunStep {
                    seq_no: seq,
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id,
                    prompt_type: step.step_type.clone(),
                    decision_key: Some(route_key),
                    route: exec_route,
                    result: serde_json::to_value(&pr_log)?,
                });
                seq += 1;
            }
        }
    }

    Ok(RunOutcome {
        extraction,
        scoring,
        decision,
        log: run_log,
    })
}
