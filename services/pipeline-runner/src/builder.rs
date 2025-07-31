use shared::dto::{PipelineStep, PipelineConfig};

#[derive(Debug)]
pub struct ExecStep {
    pub step: PipelineStep,
    pub next_idx: Option<usize>,
    pub true_idx: Option<usize>,
    pub false_idx: Option<usize>,
}

pub fn build_exec_steps(cfg: &PipelineConfig) -> anyhow::Result<Vec<ExecStep>> {
    let mut id_map = std::collections::HashMap::new();
    for (idx, step) in cfg.steps.iter().enumerate() {
        id_map.insert(step.id.clone(), idx);
    }
    let mut execs = Vec::with_capacity(cfg.steps.len());
    for (idx, step) in cfg.steps.iter().enumerate() {
        let next_idx = if idx + 1 < cfg.steps.len() { Some(idx + 1) } else { None };
        let true_idx = step.true_target.as_ref().and_then(|t| id_map.get(t).copied());
        let false_idx = step.false_target.as_ref().and_then(|t| id_map.get(t).copied());
        if step.true_target.is_some() && true_idx.is_none() {
            anyhow::bail!("invalid true_target {}", step.true_target.as_ref().unwrap());
        }
        if step.false_target.is_some() && false_idx.is_none() {
            anyhow::bail!("invalid false_target {}", step.false_target.as_ref().unwrap());
        }
        let mut exec_step = ExecStep {
            step: step.clone(),
            next_idx,
            true_idx,
            false_idx,
        };
        exec_step.step.id = step.id.clone();
        exec_step.step.step_type = step.step_type.clone();
        execs.push(exec_step);
    }
    Ok(execs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use shared::dto::{PipelineStep, PromptType};

    #[test]
    fn build_ok() {
        let steps = vec![
            PipelineStep{ id:"s1".into(), step_type:PromptType::ExtractionPrompt, prompt_id:1,label:None,alias:Some("a".into()),inputs:None,formula_override:None,input_source:None,route:None,condition:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
            PipelineStep{ id:"s2".into(), step_type:PromptType::DecisionPrompt, prompt_id:2,label:None,alias:None,inputs:None,formula_override:None,input_source:None,route:None,condition:Some("true".into()),true_target:Some("s3".into()),false_target:Some("s4".into()),enum_targets:None,active:Some(true)},
            PipelineStep{ id:"s3".into(), step_type:PromptType::ScoringPrompt, prompt_id:3,label:None,alias:Some("b".into()),inputs:Some(vec!["a".into()]),formula_override:None,input_source:None,route:None,condition:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
            PipelineStep{ id:"s4".into(), step_type:PromptType::ScoringPrompt, prompt_id:4,label:None,alias:Some("c".into()),inputs:Some(vec!["a".into()]),formula_override:None,input_source:None,route:None,condition:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
        ];
        let cfg = PipelineConfig{ name:"t".into(), steps};
        let exec = build_exec_steps(&cfg).unwrap();
        assert_eq!(exec[1].true_idx, Some(2));
        assert_eq!(exec[1].false_idx, Some(3));
    }
}
