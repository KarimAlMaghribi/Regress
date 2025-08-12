use serde_json::Value;
use shared::{
    dto::{PipelineConfig, PromptResult, PromptType, RunStep, ScoringResult, TextPosition},
    openai_client::{self},
};
use std::collections::HashMap;

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
    // helper to map string/bool-like values onto yes/no keys
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

pub async fn execute(cfg: &PipelineConfig, pdf_text: &str) -> anyhow::Result<RunOutcome> {
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
        // Align route stack before gating
        if step.route.is_none() || step.route.as_deref() == Some("ROOT") {
            while state.route_stack.len() > 1 {
                state.route_stack.pop();
            }
            state.route = Some("ROOT".to_string());
        } else if let Some(req) = &step.route {
            if state.route.as_deref() != Some(req.as_str()) {
                if let Some(pos) =
                    state.route_stack.iter().rposition(|r| r == req)
                {
                    state.route_stack.truncate(pos + 1);
                    state.route = state.route_stack.last().cloned();
                } else {
                    continue;
                }
            }
        }

        // Gate: Step läuft nur im passenden Branch
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
                let input = pdf_text.to_string();
                let pr = match openai_client::extract(step.prompt_id as i32, &input).await {
                    Ok(ans) => PromptResult {
                        prompt_id: step.prompt_id as i32,
                        prompt_type: PromptType::ExtractionPrompt,
                        prompt_text,
                        boolean: None,
                        value: ans.value,
                        weight: None,
                        route: None,
                        json_key: None,
                        source: ans.source,
                        error: None,
                        openai_raw: ans.raw,
                    },
                    Err(e) => PromptResult {
                        prompt_id: step.prompt_id as i32,
                        prompt_type: PromptType::ExtractionPrompt,
                        prompt_text,
                        boolean: None,
                        value: None,
                        weight: None,
                        route: None,
                        json_key: None,
                        source: None,
                        error: Some(e.to_string()),
                        openai_raw: String::new(),
                    },
                };
                extraction.push(pr.clone());
                run_log.push(RunStep {
                    seq_no: seq,
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id,
                    prompt_type: step.step_type.clone(),
                    decision_key: None,
                    route: state.route.clone(),
                    result: serde_json::to_value(&pr)?,
                });
                seq += 1;
            }
            PromptType::ScoringPrompt => {
                let _prompt_text = openai_client::fetch_prompt_text(step.prompt_id as i32)
                    .await
                    .unwrap_or_default();
                let res = openai_client::score(step.prompt_id as i32, pdf_text).await;
                let sr = match res {
                    Ok(sr) => sr,
                    Err(e) => ScoringResult {
                        prompt_id: step.prompt_id as i32,
                        result: false,
                        source: TextPosition {
                            page: 0,
                            bbox: [0.0, 0.0, 0.0, 0.0],
                            quote: Some(String::new()),
                        },
                        explanation: e.to_string(),
                    },
                };
                scoring.push(sr.clone());
                run_log.push(RunStep {
                    seq_no: seq,
                    step_id: step.id.clone(),
                    prompt_id: step.prompt_id,
                    prompt_type: step.step_type.clone(),
                    decision_key: None,
                    route: state.route.clone(),
                    result: serde_json::to_value(&sr)?,
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

                match openai_client::decide(step.prompt_id as i32, pdf_text, &state_map).await {
                    Ok(ans) => {
                        let res_json =
                            serde_json::from_str::<Value>(&ans.raw).unwrap_or(Value::Null);
                        let yes = step.yes_key.as_deref().unwrap_or("yes");
                        let no = step.no_key.as_deref().unwrap_or("no");
                        let route_key = normalize_decision(
                            &res_json,
                            ans.route.as_deref(),
                            ans.boolean,
                            yes,
                            no,
                        );

                        let exec_route = state.route.clone();
                        state.result = Some(res_json.clone());
                        state.route_stack.push(route_key.clone());
                        state.route = Some(route_key.clone());

                        let pr = PromptResult {
                            prompt_id: step.prompt_id as i32,
                            prompt_type: PromptType::DecisionPrompt,
                            prompt_text,
                            boolean: ans.boolean,
                            value: ans.value,
                            weight: None,
                            route: Some(route_key.clone()),
                            json_key: None,
                            source: ans.source,
                            error: None,
                            openai_raw: ans.raw.clone(),
                        };
                        decision.push(pr.clone());
                        run_log.push(RunStep {
                            seq_no: seq,
                            step_id: step.id.clone(),
                            prompt_id: step.prompt_id,
                            prompt_type: step.step_type.clone(),
                            decision_key: Some(route_key),
                            route: exec_route,
                            result: serde_json::to_value(&pr)?,
                        });
                        seq += 1;
                    }
                    Err(e) => {
                        let pr = PromptResult {
                            prompt_id: step.prompt_id as i32,
                            prompt_type: PromptType::DecisionPrompt,
                            prompt_text,
                            boolean: None,
                            value: None,
                            weight: None,
                            route: None,
                            json_key: None,
                            source: None,
                            error: Some(e.to_string()),
                            openai_raw: String::new(),
                        };
                        decision.push(pr.clone());
                        run_log.push(RunStep {
                            seq_no: seq,
                            step_id: step.id.clone(),
                            prompt_id: step.prompt_id,
                            prompt_type: step.step_type.clone(),
                            decision_key: None,
                            route: state.route.clone(),
                            result: serde_json::to_value(&pr)?,
                        });
                        seq += 1;
                    }
                }
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

// tests removed as part of field cleanup
