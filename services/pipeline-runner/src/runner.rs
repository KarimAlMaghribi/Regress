use rhai;
use serde_json::Value;
use shared::{
    dto::{PipelineConfig, PromptResult, PromptType, ScoringResult, TextPosition},
    openai_client::{self, OpenAiAnswer},
};
use std::collections::HashMap;

pub type RunState = HashMap<String, Value>;

pub struct RunOutcome {
    pub extraction: Vec<PromptResult>,
    pub scoring: Vec<ScoringResult>,
    pub decision: Vec<PromptResult>,
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
    let exec = crate::builder::build_exec_steps(cfg)?;
    let mut state: RunState = HashMap::new();
    let mut extraction = Vec::new();
    let mut scoring = Vec::new();
    let mut decision = Vec::new();
    let mut hops = 0usize;
    let mut idx = 0usize;
    while let Some(step) = exec.get(idx) {
        hops += 1;
        if hops > exec.len() * 3 {
            return Err(anyhow::anyhow!("pipeline exceeded max steps"));
        }
        if step.step.active == Some(false) {
            idx = step.next_idx.unwrap_or(exec.len());
            continue;
        }
        if let Some(r) = &step.step.route {
            let current = state.get("route").and_then(|v| v.as_str());
            if current != Some(r.as_str()) {
                idx = step.next_idx.unwrap_or(exec.len());
                continue;
            }
        }
        match step.step.step_type {
            PromptType::ExtractionPrompt => {
                let prompt_text = openai_client::fetch_prompt_text(step.step.prompt_id)
                    .await
                    .unwrap_or_default();
                let input = pdf_text.to_string();
                match openai_client::extract(step.step.prompt_id, &input).await {
                    Ok(ans) => {
                        extraction.push(PromptResult {
                            prompt_id: step.step.prompt_id,
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
                        });
                    }
                    Err(e) => {
                        extraction.push(PromptResult {
                            prompt_id: step.step.prompt_id,
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
                        });
                    }
                }
                idx = step.next_idx.unwrap_or(exec.len());
            }
            PromptType::ScoringPrompt => {
                let _prompt_text = openai_client::fetch_prompt_text(step.step.prompt_id)
                    .await
                    .unwrap_or_default();
                let res = openai_client::score(step.step.prompt_id, pdf_text).await;
                match res {
                    Ok(mut sr) => {
                        scoring.push(sr);
                    }
                    Err(e) => {
                        scoring.push(ScoringResult {
                            prompt_id: step.step.prompt_id,
                            result: false,
                            source: TextPosition {
                                page: 0,
                                bbox: [0.0, 0.0, 0.0, 0.0],
                                quote: Some(String::new()),
                            },
                            explanation: e.to_string(),
                        });
                    }
                }
                idx = step.next_idx.unwrap_or(exec.len());
            }
            PromptType::DecisionPrompt => {
                let prompt_text = openai_client::fetch_prompt_text(step.step.prompt_id)
                    .await
                    .unwrap_or_default();
                match openai_client::decide(step.step.prompt_id, pdf_text, &state).await {
                    Ok(ans) => {
                        let decision_val = serde_json::from_str(&ans.raw).unwrap_or(Value::Null);
                        state.insert("result".into(), decision_val.clone());
                        if let Some(r) = &ans.route {
                            state.insert("route".into(), Value::String(r.clone()));
                        }
                        let decision_key = ans.route.clone().or_else(|| ans.boolean.map(|b| b.to_string()))
                            .or_else(|| decision_val.as_str().map(|s| s.to_string()));
                        if let (Some(key), Some(map)) = (decision_key.clone(), &step.targets_idx) {
                            if let Some(&jump) = map.get(&key) {
                                idx = jump;
                                continue;
                            }
                        }
                        idx = step.next_idx.unwrap_or(exec.len());
                        decision.push(PromptResult {
                            prompt_id: step.step.prompt_id,
                            prompt_type: PromptType::DecisionPrompt,
                            prompt_text,
                            boolean: ans.boolean,
                            value: ans.value,
                            weight: None,
                            route: ans.route,
                            json_key: None,
                            source: ans.source,
                            error: None,
                            openai_raw: ans.raw,
                        });
                    }
                    Err(e) => {
                        decision.push(PromptResult {
                            prompt_id: step.step.prompt_id,
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
                        });
                        idx = step.next_idx.unwrap_or(exec.len());
                    }
                }
            }
        }
        if idx >= exec.len() {
            break;
        }
    }
    Ok(RunOutcome {
        extraction,
        scoring,
        decision,
    })
}

// tests removed as part of field cleanup
