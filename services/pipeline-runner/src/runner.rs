use serde_json::Value;
use shared::{
    dto::{PipelineConfig, PromptResult, PromptType, RunStep, ScoringResult, TextPosition},
    openai_client, // wir nutzen die vorhandenen shared-Aufrufe
};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{sync::Semaphore, time::timeout};
use tracing::{error, info, warn};

#[derive(Clone, Debug)]
pub struct BatchCfg {
    pub page_batch_size: usize,
    pub max_parallel: usize,
    pub max_chars: usize,
    pub openai_timeout_ms: u64,
    pub openai_retries: usize,
}

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

pub fn compute_overall_score(results: &[ScoringResult]) -> Option<f32> {
    if results.is_empty() {
        return None;
    }
    let sum: f32 = results.iter().map(|r| if r.result { 1.0 } else { 0.0 }).sum();
    Some(sum / results.len() as f32)
}

fn normalize_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
                prev_ws = true;
            }
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out.trim().to_lowercase()
}

fn make_batches(
    pages: &[(i32, String)],
    page_batch_size: usize,
    max_chars: usize,
) -> Vec<(Vec<i32>, String)> {
    let mut out = Vec::new();
    let mut cur_pages = Vec::new();
    let mut cur_text = String::new();

    for (pno, ptxt) in pages {
        let will_len = cur_text.len() + ptxt.len() + 2;
        if !cur_pages.is_empty()
            && (cur_pages.len() >= page_batch_size || will_len > max_chars)
        {
            out.push((cur_pages, cur_text));
            cur_pages = Vec::new();
            cur_text = String::new();
        }
        cur_pages.push(*pno);
        if !cur_text.is_empty() {
            cur_text.push_str("\n\n");
        }
        cur_text.push_str(ptxt);
    }
    if !cur_pages.is_empty() {
        out.push((cur_pages, cur_text));
    }
    out
}

async fn call_extract_once(
    prompt_id: i32,
    batch_text: &str,
    timeout_ms: u64,
) -> anyhow::Result<(Option<Value>, Option<TextPosition>, String)> {
    // shared::openai_client::extract(prompt_id, input: &str)
    let fut = openai_client::extract(prompt_id, batch_text);
    match timeout(Duration::from_millis(timeout_ms), fut).await {
        Err(_) => anyhow::bail!("openai timeout after {}ms", timeout_ms),
        Ok(res) => match res {
            Ok(ans) => Ok((ans.value, ans.source, ans.raw)),
            Err(e) => Err(anyhow::anyhow!(e)),
        },
    }
}

async fn call_extract_retry_or_split(
    prompt_id: i32,
    pages: &[i32],
    text: &str,
    cfg: &BatchCfg,
    depth: usize,
    acc: &mut Vec<PromptResult>,
    prompt_text_for_log: &str,
) {
    // Basis: mehrfach retryen
    let mut attempt = 0usize;
    loop {
        match call_extract_once(prompt_id, text, cfg.openai_timeout_ms).await {
            Ok((value, source, raw)) => {
                // Erfolg
                let pr = PromptResult {
                    prompt_id,
                    prompt_type: PromptType::ExtractionPrompt,
                    prompt_text: prompt_text_for_log.to_string(),
                    boolean: None,
                    value,
                    weight: None,
                    route: None,
                    json_key: None,
                    source,
                    error: None,
                    openai_raw: raw,
                };
                acc.push(pr);
                return;
            }
            Err(e) => {
                // Fehlversuch
                if attempt < cfg.openai_retries {
                    let backoff = 600 * (attempt + 1);
                    warn!(%e, attempt, backoff_ms=backoff, "extract failed; retrying");
                    tokio::time::sleep(Duration::from_millis(backoff as u64)).await;
                    attempt += 1;
                    continue;
                }

                // Nach Retries: splitten, wenn sinnvoll
                if pages.len() > 1 && depth < 4 {
                    let mid = pages.len() / 2;
                    let (left_pages, right_pages) = ( &pages[..mid], &pages[mid..] );

                    // Text für linker/rechter Teil rekonstruieren (Heuristik: wir nehmen den vorhandenen Text und splitten grob halb)
                    // Für Robustheit: lieber nach Seiten neu aufbauen (Anrufer hat die Volltexte der Seiten nicht hier vorliegen),
                    // daher splitten wir anhand der Länge:
                    let split_at = text.len() / 2;
                    let (left_text, right_text) = text.split_at(split_at);

                    call_extract_retry_or_split(prompt_id, left_pages, left_text, cfg, depth + 1, acc, prompt_text_for_log).await;
                    call_extract_retry_or_split(prompt_id, right_pages, right_text, cfg, depth + 1, acc, prompt_text_for_log).await;
                    return;
                } else {
                    // Finaler Fehler
                    warn!(%e, depth, "extract failed; giving up for this batch");
                    let pr = PromptResult {
                        prompt_id,
                        prompt_type: PromptType::ExtractionPrompt,
                        prompt_text: prompt_text_for_log.to_string(),
                        boolean: None,
                        value: None,
                        weight: None,
                        route: None,
                        json_key: None,
                        source: None,
                        error: Some(e.to_string()),
                        openai_raw: String::new(),
                    };
                    acc.push(pr);
                    return;
                }
            }
        }
    }
}

async fn call_score_once(
    prompt_id: i32,
    batch_text: &str,
    timeout_ms: u64,
) -> anyhow::Result<ScoringResult> {
    let fut = openai_client::score(prompt_id, batch_text);
    match timeout(Duration::from_millis(timeout_ms), fut).await {
        Err(_) => anyhow::bail!("openai timeout after {}ms", timeout_ms),
        Ok(res) => res.map_err(|e| anyhow::anyhow!(e)),
    }
}

async fn call_decide_once(
    prompt_id: i32,
    batch_text: &str,
    timeout_ms: u64,
    state_map: &HashMap<String, Value>,
) -> anyhow::Result<PromptResult> {
    let fut = openai_client::decide(prompt_id, batch_text, state_map);
    match timeout(Duration::from_millis(timeout_ms), fut).await {
        Err(_) => anyhow::bail!("openai timeout after {}ms", timeout_ms),
        Ok(res) => match res {
            Ok(ans) => Ok(PromptResult {
                prompt_id,
                prompt_type: PromptType::DecisionPrompt,
                prompt_text: openai_client::fetch_prompt_text(prompt_id).await.unwrap_or_default(),
                boolean: ans.boolean,
                value: ans.value,
                weight: None,
                route: ans.route.clone(),
                json_key: None,
                source: ans.source,
                error: None,
                openai_raw: ans.raw,
            }),
            Err(e) => Err(anyhow::anyhow!(e)),
        },
    }
}

fn consolidate_extractions(mut v: Vec<PromptResult>) -> PromptResult {
    // Mehrheit auf dem stringifizierten "value"
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut first_source_for: HashMap<String, TextPosition> = HashMap::new();

    for pr in v.iter() {
        if let Some(val) = pr.value.as_ref() {
            let vs = if let Some(s) = val.as_str() {
                normalize_spaces(s)
            } else {
                normalize_spaces(&val.to_string())
            };
            *counts.entry(vs.clone()).or_default() += 1;
            if pr.source.is_some() && !first_source_for.contains_key(&vs) {
                first_source_for.insert(vs, pr.source.clone().unwrap());
            }
        }
    }

    // Fallback, wenn alles fehlschlug
    if counts.is_empty() {
        // nimm den ersten (oder den mit längster openai_raw) als "repräsentativ"
        v.sort_by_key(|p| std::cmp::Reverse(p.openai_raw.len()));
        return v
            .into_iter()
            .next()
            .unwrap_or(PromptResult {
                prompt_id: 0,
                prompt_type: PromptType::ExtractionPrompt,
                prompt_text: String::new(),
                boolean: None,
                value: None,
                weight: None,
                route: None,
                json_key: None,
                source: None,
                error: Some("no successful extraction batch".into()),
                openai_raw: String::new(),
            });
    }

    let (best_norm, _) = counts
        .into_iter()
        .max_by_key(|(_, c)| *c)
        .unwrap();

    // Nehme das erste PromptResult, überschreibe aber value/source auf "konsolidiert"
    let mut base = v.into_iter().find(|p| p.value.is_some()).unwrap();
    base.value = Some(Value::String(best_norm.clone()));
    if let Some(src) = first_source_for.get(&best_norm) {
        base.source = Some(src.clone());
    }
    base
}

fn consolidate_scoring(v: Vec<ScoringResult>) -> ScoringResult {
    if v.is_empty() {
        return ScoringResult {
            prompt_id: 0,
            result: false,
            source: TextPosition { page: 0, bbox: [0.0, 0.0, 0.0, 0.0], quote: Some(String::new()) },
            explanation: "no scoring batches".to_string(),
        };
    }
    let true_cnt = v.iter().filter(|r| r.result).count();
    let false_cnt = v.len() - true_cnt;
    let majority = true_cnt > false_cnt;

    // Nehme den ersten als Basis, setze result auf Mehrheit
    let mut base = v.into_iter().next().unwrap();
    base.result = majority;
    base
}

fn consolidate_decision(mut v: Vec<PromptResult>, yes: &str, no: &str) -> PromptResult {
    if v.is_empty() {
        return PromptResult {
            prompt_id: 0,
            prompt_type: PromptType::DecisionPrompt,
            prompt_text: String::new(),
            boolean: None,
            value: None,
            weight: None,
            route: Some(no.to_string()), // konservativ
            json_key: None,
            source: None,
            error: Some("no decision batches".into()),
            openai_raw: String::new(),
        };
    }

    let mut counts: HashMap<String, usize> = HashMap::new();
    for pr in v.iter() {
        if let Some(r) = pr.route.as_ref() {
            let rr = normalize_spaces(r);
            *counts.entry(rr).or_default() += 1;
        }
    }

    let chosen = if counts.is_empty() {
        no.to_string()
    } else {
        let (best, _) = counts.into_iter().max_by_key(|(_, c)| *c).unwrap();
        best
    };

    // nimm den ersten als Basis, setze aber route auf die Mehrheit
    let mut base = v.remove(0);
    base.route = Some(chosen);
    base
}

pub async fn execute_with_pages(
    cfg: &PipelineConfig,
    pages: &[(i32, String)],
    batch_cfg: &BatchCfg,
) -> anyhow::Result<RunOutcome> {
    let mut state = RunState {
        route_stack: vec!["ROOT".to_string()],
        route: Some("ROOT".to_string()),
        result: None,
    };

    let mut extraction = Vec::new();
    let mut scoring = Vec::new();
    let mut decision = Vec::new();
    let mut run_log: Vec<RunStep> = Vec::new();

    // Batches vorbereiten (einmal, alle Steps nutzen dieselben Textbatches)
    let batches = make_batches(pages, batch_cfg.page_batch_size, batch_cfg.max_chars);
    info!(batches = batches.len(), "prepared text batches");

    for step in &cfg.steps {
        // Route-Gate & Stack-Verhalten wie zuvor
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
                    // anderer Branch
                    continue;
                }
            }
        }

        if let Some(req) = &step.route {
            if state.route.as_deref() != Some(req.as_str()) {
                continue;
            }
        }
        if !step.active {
            continue;
        }

        match step.step_type {
            PromptType::ExtractionPrompt => {
                let prompt_text = openai_client::fetch_prompt_text(step.prompt_id as i32)
                    .await
                    .unwrap_or_default();

                // Parallel begrenzen
                let sem = Arc::new(Semaphore::new(batch_cfg.max_parallel));
                let mut tasks = futures::stream::FuturesUnordered::new();

                for (idx, (pnos, btxt)) in batches.iter().enumerate() {
                    let permit = sem.clone().acquire_owned().await.unwrap();
                    let prompt_text_cl = prompt_text.clone();
                    let text_cl = btxt.clone();
                    let pnos_cl = pnos.clone();
                    let cfg_cl = batch_cfg.clone();
                    tasks.push(tokio::spawn(async move {
                        let _p = permit;
                        let mut acc = Vec::new();
                        call_extract_retry_or_split(
                            step.prompt_id as i32,
                            &pnos_cl,
                            &text_cl,
                            &cfg_cl,
                            0,
                            &mut acc,
                            &prompt_text_cl,
                        )
                            .await;
                        acc
                    }));
                    info!(step_id = %step.id, batch_index = idx, "spawned extract batch task");
                }

                let mut all_results: Vec<PromptResult> = Vec::new();
                while let Some(res) = tasks.next().await {
                    match res {
                        Ok(mut prs) => all_results.append(&mut prs),
                        Err(e) => warn!(%e, "extract batch join error"),
                    }
                }

                let final_pr = consolidate_extractions(all_results.clone());
                extraction.push(final_pr.clone());

                // Log konsolidierten Schritt
                run_log.push(RunStep {
                    seq_no: 0, // wird oben beim Insert sequenziert
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id,
                    prompt_type: step.step_type.clone(),
                    decision_key: None,
                    route: state.route.clone(),
                    result: serde_json::to_value(&final_pr)?,
                });
            }

            PromptType::ScoringPrompt => {
                let _prompt_text = openai_client::fetch_prompt_text(step.prompt_id as i32)
                    .await
                    .unwrap_or_default();

                let sem = Arc::new(Semaphore::new(batch_cfg.max_parallel));
                let mut tasks = futures::stream::FuturesUnordered::new();

                for (idx, (_pnos, btxt)) in batches.iter().enumerate() {
                    let permit = sem.clone().acquire_owned().await.unwrap();
                    let text_cl = btxt.clone();
                    let cfg_cl = batch_cfg.clone();
                    tasks.push(tokio::spawn(async move {
                        let _p = permit;
                        let mut attempt = 0usize;
                        loop {
                            match call_score_once(step.prompt_id as i32, &text_cl, cfg_cl.openai_timeout_ms).await {
                                Ok(sr) => return sr,
                                Err(e) => {
                                    if attempt < cfg_cl.openai_retries {
                                        let backoff = 600 * (attempt + 1);
                                        warn!(%e, attempt, backoff_ms=backoff, "score failed; retrying");
                                        tokio::time::sleep(Duration::from_millis(backoff as u64)).await;
                                        attempt += 1;
                                        continue;
                                    } else {
                                        warn!(%e, "score failed; marking false");
                                        return ScoringResult {
                                            prompt_id: step.prompt_id as i32,
                                            result: false,
                                            source: TextPosition { page: 0, bbox: [0.0,0.0,0.0,0.0], quote: Some(String::new()) },
                                            explanation: e.to_string(),
                                        };
                                    }
                                }
                            }
                        }
                    }));
                    info!(step_id = %step.id, batch_index = idx, "spawned score batch task");
                }

                let mut all_srs: Vec<ScoringResult> = Vec::new();
                while let Some(sr) = tasks.next().await {
                    match sr {
                        Ok(s) => all_srs.push(s),
                        Err(e) => warn!(%e, "score batch join error"),
                    }
                }

                let final_sr = consolidate_scoring(all_srs.clone());
                scoring.push(final_sr.clone());

                run_log.push(RunStep {
                    seq_no: 0,
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id,
                    prompt_type: step.step_type.clone(),
                    decision_key: None,
                    route: state.route.clone(),
                    result: serde_json::to_value(&final_sr)?,
                });
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

                let sem = Arc::new(Semaphore::new(batch_cfg.max_parallel));
                let mut tasks = futures::stream::FuturesUnordered::new();

                for (idx, (_pnos, btxt)) in batches.iter().enumerate() {
                    let permit = sem.clone().acquire_owned().await.unwrap();
                    let text_cl = btxt.clone();
                    let cfg_cl = batch_cfg.clone();
                    let state_map_cl = state_map.clone();
                    tasks.push(tokio::spawn(async move {
                        let _p = permit;
                        let mut attempt = 0usize;
                        loop {
                            match call_decide_once(step.prompt_id as i32, &text_cl, cfg_cl.openai_timeout_ms, &state_map_cl).await {
                                Ok(pr) => return pr,
                                Err(e) => {
                                    if attempt < cfg_cl.openai_retries {
                                        let backoff = 600 * (attempt + 1);
                                        warn!(%e, attempt, backoff_ms=backoff, "decide failed; retrying");
                                        tokio::time::sleep(Duration::from_millis(backoff as u64)).await;
                                        attempt += 1;
                                        continue;
                                    } else {
                                        warn!(%e, "decide failed; returning empty");
                                        return PromptResult {
                                            prompt_id: step.prompt_id as i32,
                                            prompt_type: PromptType::DecisionPrompt,
                                            prompt_text: prompt_text.clone(),
                                            boolean: None,
                                            value: None,
                                            weight: None,
                                            route: None,
                                            json_key: None,
                                            source: None,
                                            error: Some(e.to_string()),
                                            openai_raw: String::new(),
                                        };
                                    }
                                }
                            }
                        }
                    }));
                    info!(step_id = %step.id, batch_index = idx, "spawned decision batch task");
                }

                let mut all_prs: Vec<PromptResult> = Vec::new();
                while let Some(res) = tasks.next().await {
                    match res {
                        Ok(p) => all_prs.push(p),
                        Err(e) => warn!(%e, "decision batch join error"),
                    }
                }

                let yes = step.yes_key.as_deref().unwrap_or("yes");
                let no  = step.no_key.as_deref().unwrap_or("no");

                let final_pr = consolidate_decision(all_prs.clone(), yes, no);
                let chosen_route = final_pr.route.clone();

                // Route-Stack aktualisieren
                let exec_route = state.route.clone();
                if let Some(r) = chosen_route.as_ref() {
                    state.result = Some(serde_json::json!({ "route": r }));
                    state.route_stack.push(r.clone());
                    state.route = Some(r.clone());
                }

                decision.push(final_pr.clone());

                run_log.push(RunStep {
                    seq_no: 0,
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id,
                    prompt_type: step.step_type.clone(),
                    decision_key: chosen_route.clone(),
                    route: exec_route,
                    result: serde_json::to_value(&final_pr)?,
                });
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
