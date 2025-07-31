use std::collections::HashMap;
use serde_json::Value;
use shared::{
    dto::{PipelineConfig, PromptType, PromptResult, TextPosition},
    utils::{rhai_eval_bool, eval_formula},
    openai_client::{self, OpenAiAnswer},
};
use rhai;

fn to_dyn(v: &Value) -> rhai::Dynamic {
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() { (i as i64).into() }
            else if let Some(f) = n.as_f64() { f.into() }
            else { ().into() }
        }
        Value::Bool(b) => (*b).into(),
        Value::String(s) => s.clone().into(),
        _ => ().into(),
    }
}

pub type RunState = HashMap<String, Value>;

pub struct RunOutcome {
    pub extraction: Vec<PromptResult>,
    pub scoring: Vec<PromptResult>,
    pub decision: Vec<PromptResult>,
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
        if hops > exec.len() * 3 { return Err(anyhow::anyhow!("pipeline exceeded max steps")); }
        if step.step.active == Some(false) { idx = step.next_idx.unwrap_or(exec.len()); continue; }
        if let Some(r) = &step.step.route {
            let current = state.get("route").and_then(|v| v.as_str());
            if current != Some(r.as_str()) { idx = step.next_idx.unwrap_or(exec.len()); continue; }
        }
        if let Some(expr) = &step.step.condition {
            let mut ctx = HashMap::new();
            for (k,v) in &state { ctx.insert(k.clone(), to_dyn(v)); }
            if !rhai_eval_bool(expr, &ctx)? { idx = step.next_idx.unwrap_or(exec.len()); continue; }
        }
        match step.step.step_type {
            PromptType::ExtractionPrompt => {
                let prompt_text = openai_client::fetch_prompt_text(step.step.prompt_id).await.unwrap_or_default();
                let input = if let Some(src) = step.step.input_source.as_ref() {
                    if src == "document" { pdf_text.to_string() } else { state.get(src).cloned().unwrap_or(Value::Null).to_string() }
                } else { pdf_text.to_string() };
                match openai_client::extract(step.step.prompt_id, &input).await {
                    Ok(ans) => {
                        let val = json_repair::repair_json_string(&ans.raw).unwrap_or(Value::Null);
                        if let Some(alias) = &step.step.alias { state.insert(alias.clone(), val.clone()); }
                        let source = val.get("source").and_then(|s| {
                            let page = s.get("page")?.as_u64()? as u32;
                            let arr = s.get("bbox")?.as_array()?;
                            if arr.len() == 4 {
                                Some(TextPosition {
                                    page,
                                    bbox: [
                                        arr[0].as_f64()? as f32,
                                        arr[1].as_f64()? as f32,
                                        arr[2].as_f64()? as f32,
                                        arr[3].as_f64()? as f32,
                                    ],
                                })
                            } else { None }
                        });
                        extraction.push(PromptResult {
                            prompt_id: step.step.prompt_id,
                            prompt_type: PromptType::ExtractionPrompt,
                            prompt_text,
                            score: ans.score,
                            boolean: None,
                            route: None,
                            source,
                            openai_raw: ans.raw,
                        });
                    }
                    Err(e) => {
                        extraction.push(PromptResult {
                            prompt_id: step.step.prompt_id,
                            prompt_type: PromptType::ExtractionPrompt,
                            prompt_text,
                            score: None,
                            boolean: None,
                            route: None,
                            source: None,
                            openai_raw: e.to_string(),
                        });
                    }
                }
                idx = step.next_idx.unwrap_or(exec.len());
            }
            PromptType::ScoringPrompt => {
                let prompt_text = openai_client::fetch_prompt_text(step.step.prompt_id).await.unwrap_or_default();
                let mut args = Vec::new();
                if let Some(ins) = &step.step.inputs {
                    for a in ins {
                        if let Some(v) = state.get(a) { args.push((a.as_str(), v.clone())); }
                    }
                }
                let (value, answer): (Value, Option<OpenAiAnswer>) = if let Some(f) = &step.step.formula_override {
                    let mut ctx = HashMap::new();
                    for (k,v) in &state { ctx.insert(k.clone(), to_dyn(v)); }
                    let dynv = eval_formula(f, &ctx)?;
                    let val = serde_json::from_str(&dynv.to_string()).unwrap_or(Value::Null);
                    (val, None)
                } else {
                    match openai_client::score(step.step.prompt_id, &args).await {
                        Ok(ans) => {
                            let v = ans.score.map(|f| Value::from(f as f64)).unwrap_or(Value::Null);
                            (v, Some(ans))
                        }
                        Err(e) => {
                            scoring.push(PromptResult {
                                prompt_id: step.step.prompt_id,
                                prompt_type: PromptType::ScoringPrompt,
                                prompt_text,
                                score: None,
                                boolean: None,
                                route: None,
                                source: None,
                                openai_raw: e.to_string(),
                            });
                            idx = step.next_idx.unwrap_or(exec.len());
                            continue;
                        }
                    }
                };
                if let Some(alias) = &step.step.alias { state.insert(alias.clone(), value.clone()); }
                if let Some(ans) = answer {
                    scoring.push(PromptResult {
                        prompt_id: step.step.prompt_id,
                        prompt_type: PromptType::ScoringPrompt,
                        prompt_text,
                        score: ans.score,
                        boolean: None,
                        route: None,
                        source: None,
                        openai_raw: ans.raw,
                    });
                } else {
                    scoring.push(PromptResult {
                        prompt_id: step.step.prompt_id,
                        prompt_type: PromptType::ScoringPrompt,
                        prompt_text,
                        score: value.as_f64().map(|f| f as f32),
                        boolean: None,
                        route: None,
                        source: None,
                        openai_raw: value.to_string(),
                    });
                }
                idx = step.next_idx.unwrap_or(exec.len());
            }
            PromptType::DecisionPrompt => {
                let prompt_text = openai_client::fetch_prompt_text(step.step.prompt_id).await.unwrap_or_default();
                match openai_client::decide(step.step.prompt_id, &state).await {
                    Ok(ans) => {
                        let decision_val = json_repair::repair_json_string(&ans.raw).unwrap_or(Value::Null);
                        state.insert("result".into(), decision_val.clone());
                        state.insert("route".into(), decision_val.clone());
                        let cond = step.step.condition.as_deref().unwrap_or("result == true");
                        let mut ctx = HashMap::new();
                        for (k,v) in &state { ctx.insert(k.clone(), to_dyn(v)); }
                        let ok = rhai_eval_bool(cond, &ctx)?;
                        if let Some(map) = &step.step.enum_targets {
                            if let Some(key) = decision_val.as_str() {
                                if let Some(target_id) = map.get(key) {
                                    idx = exec.iter().position(|s| s.step.id == *target_id).unwrap_or(exec.len());
                                } else {
                                    idx = step.next_idx.unwrap_or(exec.len());
                                }
                            } else {
                                idx = step.next_idx.unwrap_or(exec.len());
                            }
                        } else {
                            idx = if ok { step.true_idx } else { step.false_idx }.unwrap_or(exec.len());
                        }
                        decision.push(PromptResult {
                            prompt_id: step.step.prompt_id,
                            prompt_type: PromptType::DecisionPrompt,
                            prompt_text,
                            score: None,
                            boolean: ans.boolean,
                            route: ans.route,
                            source: None,
                            openai_raw: ans.raw,
                        });
                    }
                    Err(e) => {
                        decision.push(PromptResult {
                            prompt_id: step.step.prompt_id,
                            prompt_type: PromptType::DecisionPrompt,
                            prompt_text,
                            score: None,
                            boolean: None,
                            route: None,
                            source: None,
                            openai_raw: e.to_string(),
                        });
                        idx = step.next_idx.unwrap_or(exec.len());
                    }
                }
            }
        }
        if idx >= exec.len() { break; }
    }
    Ok(RunOutcome { extraction, scoring, decision })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shared::dto::{PipelineStep, PromptType};

    #[tokio::test]
    async fn run_simple() {
        let steps = vec![
            PipelineStep{ id:"s1".into(), step_type:PromptType::ScoringPrompt, prompt_id:0,label:None,alias:Some("a".into()),inputs:None,formula_override:Some("1".into()),input_source:None,route:None,condition:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
            PipelineStep{ id:"s2".into(), step_type:PromptType::ScoringPrompt, prompt_id:0,label:None,alias:Some("b".into()),inputs:Some(vec!["a".into()]),formula_override:Some("1+1".into()),input_source:None,route:None,condition:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
        ];
        let cfg = PipelineConfig{ name:"t".into(), steps};
        let result = execute(&cfg, "doc").await.unwrap();
        assert_eq!(result.scoring.len(), 2);
    }

    #[tokio::test]
    async fn route_skip() {
        let steps = vec![
            PipelineStep{ id:"set".into(), step_type:PromptType::ScoringPrompt, prompt_id:0,label:None,alias:Some("route".into()),inputs:None,formula_override:Some("\"\\\"true\\\"\"".into()),input_source:None,route:None,condition:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
            PipelineStep{ id:"p1".into(), step_type:PromptType::ScoringPrompt, prompt_id:0,label:None,alias:Some("x".into()),inputs:None,formula_override:Some("1".into()),input_source:None,route:Some("true".into()),condition:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
            PipelineStep{ id:"p2".into(), step_type:PromptType::ScoringPrompt, prompt_id:0,label:None,alias:Some("y".into()),inputs:None,formula_override:Some("2".into()),input_source:None,route:Some("false".into()),condition:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
        ];
        let cfg = PipelineConfig{ name:"t".into(), steps};
        let result = execute(&cfg, "doc").await.unwrap();
        assert_eq!(result.scoring.len(), 2);
    }
}
