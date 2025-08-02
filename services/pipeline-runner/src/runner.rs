use rhai;
use serde_json::Value;
use shared::{
    dto::{PipelineConfig, PromptResult, PromptType, ScoringResult, TextPosition},
    openai_client::{self, OpenAiAnswer},
    utils::{eval_formula, rhai_eval_bool},
};
use std::collections::HashMap;

fn to_dyn(v: &Value) -> rhai::Dynamic {
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                (i as i64).into()
            } else if let Some(f) = n.as_f64() {
                f.into()
            } else {
                ().into()
            }
        }
        Value::Bool(b) => (*b).into(),
        Value::String(s) => s.clone().into(),
        _ => ().into(),
    }
}

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
        if let Some(expr) = &step.step.condition {
            let mut ctx = HashMap::new();
            for (k, v) in &state {
                ctx.insert(k.clone(), to_dyn(v));
            }
            if !rhai_eval_bool(expr, &ctx)? {
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
                        if let Some(alias) = &step.step.alias {
                            if let Some(v) = &ans.value {
                                state.insert(alias.clone(), v.clone());
                            }
                        }
                        extraction.push(PromptResult {
                            prompt_id: step.step.prompt_id,
                            prompt_type: PromptType::ExtractionPrompt,
                            prompt_text,
                            boolean: None,
                            value: ans.value,
                            weight: None,
                            route: None,
                            json_key: step.step.alias.clone(),
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
                            json_key: step.step.alias.clone(),
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
                let mut args = HashMap::new();
                if let Some(ins) = &step.step.inputs {
                    for a in ins {
                        if let Some(v) = state.get(a) {
                            args.insert(a.clone(), v.clone());
                        }
                    }
                }
                let res: Result<ScoringResult, _> = if let Some(f) = &step.step.formula_override {
                    let mut ctx = HashMap::new();
                    for (k, v) in &state {
                        ctx.insert(k.clone(), to_dyn(v));
                    }
                    let dynv = eval_formula(f, &ctx)?;
                    Ok(ScoringResult {
                        prompt_id: step.step.prompt_id,
                        result: dynv.as_bool().unwrap_or(false),
                        source: TextPosition {
                            page: 0,
                            bbox: [0.0, 0.0, 0.0, 0.0],
                            quote: Some(String::new()),
                        },
                        explanation: String::new(),
                    })
                } else {
                    let doc = if args.is_empty() {
                        pdf_text.to_string()
                    } else {
                        format!(
                            "DOCUMENT:\n{}\n\nARGS:\n{}",
                            pdf_text,
                            serde_json::to_string(&args).unwrap_or_default()
                        )
                    };
                    openai_client::score(step.step.prompt_id, &doc).await
                };
                match res {
                    Ok(mut sr) => {
                        if sr.source.quote.as_ref().map_or(true, |q| q.is_empty()) {
                            sr.explanation = "missing quote".into();
                        }
                        if let Some(alias) = &step.step.alias {
                            state.insert(alias.clone(), Value::Bool(sr.result));
                        }
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
                        let decision_val =
                            json_repair::repair_json_string(&ans.raw).unwrap_or(Value::Null);
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

#[cfg(test)]
mod tests {
    use super::*;
    use shared::dto::{PipelineStep, PromptType};

    #[tokio::test]
    async fn run_simple() {
        let steps = vec![
            PipelineStep {
                id: "s1".into(),
                step_type: PromptType::ScoringPrompt,
                prompt_id: 0,
                label: None,
                alias: Some("a".into()),
                inputs: None,
                formula_override: Some("1".into()),
                input_source: None,
                route: None,
                condition: None,
                targets: None,
                merge_to: None,
                true_target: None,
                false_target: None,
                enum_targets: None,
                active: Some(true),
            },
            PipelineStep {
                id: "s2".into(),
                step_type: PromptType::ScoringPrompt,
                prompt_id: 0,
                label: None,
                alias: Some("b".into()),
                inputs: Some(vec!["a".into()]),
                formula_override: Some("1+1".into()),
                input_source: None,
                route: None,
                condition: None,
                targets: None,
                merge_to: None,
                true_target: None,
                false_target: None,
                enum_targets: None,
                active: Some(true),
            },
        ];
        let cfg = PipelineConfig {
            name: "t".into(),
            steps,
        };
        let result = execute(&cfg, "doc").await.unwrap();
        assert_eq!(result.scoring.len(), 2);
    }

    #[tokio::test]
    async fn route_skip() {
        let steps = vec![
            PipelineStep {
                id: "set".into(),
                step_type: PromptType::ScoringPrompt,
                prompt_id: 0,
                label: None,
                alias: Some("route".into()),
                inputs: None,
                formula_override: Some("\"\\\"true\\\"\"".into()),
                input_source: None,
                route: None,
                condition: None,
                targets: None,
                merge_to: None,
                true_target: None,
                false_target: None,
                enum_targets: None,
                active: Some(true),
            },
            PipelineStep {
                id: "p1".into(),
                step_type: PromptType::ScoringPrompt,
                prompt_id: 0,
                label: None,
                alias: Some("x".into()),
                inputs: None,
                formula_override: Some("1".into()),
                input_source: None,
                route: Some("true".into()),
                condition: None,
                targets: None,
                merge_to: None,
                true_target: None,
                false_target: None,
                enum_targets: None,
                active: Some(true),
            },
            PipelineStep {
                id: "p2".into(),
                step_type: PromptType::ScoringPrompt,
                prompt_id: 0,
                label: None,
                alias: Some("y".into()),
                inputs: None,
                formula_override: Some("2".into()),
                input_source: None,
                route: Some("false".into()),
                condition: None,
                targets: None,
                merge_to: None,
                true_target: None,
                false_target: None,
                enum_targets: None,
                active: Some(true),
            },
        ];
        let cfg = PipelineConfig {
            name: "t".into(),
            steps,
        };
        let result = execute(&cfg, "doc").await.unwrap();
        assert_eq!(result.scoring.len(), 2);
    }
}
