use serde_json::Value;
use shared::{
    dto::{PipelineConfig, PromptResult, PromptType, RunStep, ScoringResult, TextPosition},
    openai_client::{self},
};
use std::collections::HashMap;

pub type RunState = HashMap<String, Value>;

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

pub async fn execute(cfg: &PipelineConfig, pdf_text: &str) -> anyhow::Result<RunOutcome> {
    let mut state: RunState = HashMap::new();

    // route_stack laden oder initialisieren
    let mut route_stack: Vec<String> = state
        .get("route_stack")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut set_top = |stack: &Vec<String>, state: &mut RunState| {
        if let Some(top) = stack.last() {
            state.insert("route".into(), Value::String(top.clone()));
        } else {
            state.remove("route");
        }
        state.insert(
            "route_stack".into(),
            Value::Array(stack.iter().map(|s| Value::String(s.clone())).collect()),
        );
    };
    set_top(&route_stack, &mut state);

    let mut extraction = Vec::new();
    let mut scoring = Vec::new();
    let mut decision = Vec::new();
    let mut run_log: Vec<RunStep> = Vec::new();
    let mut seq: u32 = 1;

    for step in &cfg.steps {
        if step.active == Some(false) {
            continue;
        }

        // Impliziter Merge vor gemeinsamen Steps
        if step.route.is_none() && !route_stack.is_empty() {
            route_stack.pop();
            set_top(&route_stack, &mut state);
        }

        // Gate: Step läuft nur im passenden Branch
        if let Some(req) = &step.route {
            if route_stack.last().map(|s| s != req).unwrap_or(true) {
                continue;
            }
        }

        match step.step_type {
            PromptType::ExtractionPrompt => {
                let prompt_text = openai_client::fetch_prompt_text(step.prompt_id)
                    .await
                    .unwrap_or_default();
                let input = pdf_text.to_string();
                let pr = match openai_client::extract(step.prompt_id, &input).await {
                    Ok(ans) => PromptResult {
                        prompt_id: step.prompt_id,
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
                        prompt_id: step.prompt_id,
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
                    route: step.route.clone(),
                    merge_to: step.merge_to.clone(),
                    result: serde_json::to_value(&pr)?,
                });
                seq += 1;
            }
            PromptType::ScoringPrompt => {
                let _prompt_text = openai_client::fetch_prompt_text(step.prompt_id)
                    .await
                    .unwrap_or_default();
                let res = openai_client::score(step.prompt_id, pdf_text).await;
                let sr = match res {
                    Ok(sr) => sr,
                    Err(e) => ScoringResult {
                        prompt_id: step.prompt_id,
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
                    route: step.route.clone(),
                    merge_to: step.merge_to.clone(),
                    result: serde_json::to_value(&sr)?,
                });
                seq += 1;
            }
            PromptType::DecisionPrompt => {
                let prompt_text = openai_client::fetch_prompt_text(step.prompt_id)
                    .await
                    .unwrap_or_default();
                match openai_client::decide(step.prompt_id, pdf_text, &state).await {
                    Ok(ans) => {
                        // Map "true"/"false" -> yes_key/no_key
                        let choose = |ans_route: Option<&str>,
                                      ans_bool: Option<bool>,
                                      yes: &Option<String>,
                                      no: &Option<String>|
                         -> String {
                            match (ans_route, ans_bool, yes, no) {
                                (Some("true"), _, Some(yk), _) => yk.clone(),
                                (Some("false"), _, _, Some(nk)) => nk.clone(),
                                (Some(r), _, _, _) => r.to_string(),
                                (None, Some(true), Some(yk), _) => yk.clone(),
                                (None, Some(false), _, Some(nk)) => nk.clone(),
                                (None, Some(true), _, _) => "true".into(),
                                (None, Some(false), _, _) => "false".into(),
                                _ => "true".into(),
                            }
                        };

                        let route_key = choose(
                            ans.route.as_deref(),
                            ans.boolean,
                            &step.yes_key,
                            &step.no_key,
                        );

                        if let Ok(decision_val) = serde_json::from_str::<Value>(&ans.raw) {
                            state.insert("result".into(), decision_val);
                        }

                        route_stack.push(route_key.clone());
                        set_top(&route_stack, &mut state);

                        let mut pr = PromptResult {
                            prompt_id: step.prompt_id,
                            prompt_type: PromptType::DecisionPrompt,
                            prompt_text,
                            boolean: ans.boolean,
                            value: ans.value,
                            weight: None,
                            route: ans.route,
                            json_key: None,
                            source: ans.source,
                            error: None,
                            openai_raw: ans.raw.clone(),
                        };

                        pr.route = Some(route_key.clone());
                        decision.push(pr.clone());
                        run_log.push(RunStep {
                            seq_no: seq,
                            step_id: step.id.clone(),
                            prompt_id: step.prompt_id,
                            prompt_type: step.step_type.clone(),
                            decision_key: Some(route_key),
                            route: step.route.clone(),
                            merge_to: step.merge_to.clone(),
                            result: serde_json::to_value(&pr)?,
                        });
                        seq += 1;
                    }
                    Err(e) => {
                        let pr = PromptResult {
                            prompt_id: step.prompt_id,
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
                            route: step.route.clone(),
                            merge_to: step.merge_to.clone(),
                            result: serde_json::to_value(&pr)?,
                        });
                        seq += 1;
                    }
                }
            }
        }

        // Expliziter Merge nach dem Step
        if step.merge_key == Some(true) && !route_stack.is_empty() {
            route_stack.pop();
            set_top(&route_stack, &mut state);
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
