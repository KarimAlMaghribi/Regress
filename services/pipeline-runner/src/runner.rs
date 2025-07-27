use std::collections::HashMap;
use serde_json::Value;
use shared::{dto::PipelineConfig, utils::{rhai_eval_bool, eval_formula}, openai_client};
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
    pub state: HashMap<String, Value>,
    pub last_score: Option<f64>,
    pub final_label: Option<String>,
}

pub async fn execute(cfg: &PipelineConfig, pdf_text: &str) -> anyhow::Result<RunOutcome> {
    let exec = crate::builder::build_exec_steps(cfg)?;
    let mut state: RunState = HashMap::new();
    let mut last_score: Option<f64> = None;
    let mut final_label: Option<String> = None;
    let mut hops = 0usize;
    let mut idx = 0usize;
    while let Some(step) = exec.get(idx) {
        hops += 1;
        if hops > exec.len() * 3 { return Err(anyhow::anyhow!("pipeline exceeded max steps")); }
        if step.step.active == Some(false) { idx = step.next_idx.unwrap_or(exec.len()); continue; }
        match step.step.step_type.as_str() {
            "ExtractionPrompt" => {
                let input = if let Some(src) = step.step.input_source.as_ref() {
                    if src == "document" { pdf_text.to_string() } else { state.get(src).cloned().unwrap_or(Value::Null).to_string() }
                } else { pdf_text.to_string() };
                let val = openai_client::extract(step.step.prompt_id, &input).await?;
                if let Some(alias) = &step.step.alias { state.insert(alias.clone(), val); }
                idx = step.next_idx.unwrap_or(exec.len());
            }
            "ScoringPrompt" => {
                let mut args = Vec::new();
                if let Some(ins) = &step.step.inputs {
                    for a in ins {
                        if let Some(v) = state.get(a) { args.push((a.as_str(), v.clone())); }
                    }
                }
                let value = if let Some(f) = &step.step.formula_override {
                    let mut ctx = HashMap::new();
                    for (k,v) in &state { ctx.insert(k.clone(), to_dyn(v)); }
                    let dynv = eval_formula(f, &ctx)?;
                    serde_json::from_str(&dynv.to_string()).unwrap_or(Value::Null)
                } else {
                    let s = openai_client::score(step.step.prompt_id, &args).await?;
                    serde_json::json!(s)
                };
                if last_score.is_none() {
                    if let Some(f) = value.as_f64() { last_score = Some(f); }
                }
                if let Some(alias) = &step.step.alias { state.insert(alias.clone(), value); }
                idx = step.next_idx.unwrap_or(exec.len());
            }
            "DecisionPrompt" => {
                let decision = openai_client::decide(step.step.prompt_id, &state).await?;
                state.insert("result".into(), decision.clone());
                let cond = step.step.condition.as_deref().unwrap_or("result == true");
                let mut ctx = HashMap::new();
                for (k,v) in &state { ctx.insert(k.clone(), to_dyn(v)); }
                let ok = rhai_eval_bool(cond, &ctx)?;
                if let Some(map) = &step.step.enum_targets {
                    if let Some(key) = decision.as_str() {
                        if let Some(target_id) = map.get(key) {
                            final_label = Some(key.to_string());
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
            }
            _ => { idx = step.next_idx.unwrap_or(exec.len()); }
        }
        if idx >= exec.len() { break; }
    }
    if last_score.is_none() {
        if let Some(val) = state.get("score") {
            last_score = val.as_f64();
        }
    }
    Ok(RunOutcome { state, last_score, final_label })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shared::dto::PipelineStep;

    #[tokio::test]
    async fn run_simple() {
        let steps = vec![
            PipelineStep{ id:"s1".into(), step_type:"ExtractionPrompt".into(), prompt_id:0,label:None,alias:Some("a".into()),inputs:None,formula_override:None,input_source:None,condition:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
            PipelineStep{ id:"s2".into(), step_type:"ScoringPrompt".into(), prompt_id:0,label:None,alias:Some("b".into()),inputs:Some(vec!["a".into()]),formula_override:Some("1+1".into()),input_source:None,condition:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
        ];
        let cfg = PipelineConfig{ name:"t".into(), steps};
        let state = execute(&cfg, "doc").await.unwrap();
        assert!(state.contains_key("b"));
    }
}
