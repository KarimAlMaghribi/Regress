use shared::dto::{PipelineStep, PipelineConfig};

#[derive(Debug)]
pub struct ExecStep {
    pub step: PipelineStep,
    pub next_idx: Option<usize>,
    pub targets_idx: Option<std::collections::HashMap<String, usize>>,
}

pub fn build_exec_steps(cfg: &PipelineConfig) -> anyhow::Result<Vec<ExecStep>> {
    let mut id_map = std::collections::HashMap::new();
    for (idx, step) in cfg.steps.iter().enumerate() {
        id_map.insert(step.id.clone(), idx);
    }
    let mut execs = Vec::with_capacity(cfg.steps.len());
    for (idx, step) in cfg.steps.iter().enumerate() {
        // ▸ MIGRATE legacy bool / enum maps to `targets`
        let mut targets: std::collections::HashMap<String, String> = step.targets.clone().unwrap_or_default();
        if targets.is_empty() {
            if let (Some(t), Some(f)) = (&step.true_target, &step.false_target) {
                targets.insert("true".into(), t.clone());
                targets.insert("false".into(), f.clone());
            }
            if let Some(map) = &step.enum_targets {
                targets.extend(map.clone());
            }
        }

        // ▸ Translate step-ids → indices
        let targets_idx = if targets.is_empty() {
            None
        } else {
            Some(
                targets
                    .iter()
                    .filter_map(|(k, v)| id_map.get(v).copied().map(|idx| (k.clone(), idx)))
                    .collect(),
            )
        };

        // ▸ Optional merge-jump (else linear)
        let linear_next = if idx + 1 < cfg.steps.len() { Some(idx + 1) } else { None };
        let next_idx = if step.targets.is_some() {
            // branching step ignores merge_to
            linear_next
        } else {
            step
                .merge_to
                .as_ref()
                .and_then(|m| id_map.get(m).copied())
                .or(linear_next)
        };

        let mut exec_step = ExecStep {
            step: step.clone(),
            next_idx,
            targets_idx,
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
        let mut tgt = std::collections::HashMap::new();
        tgt.insert("true".to_string(), "s3".to_string());
        tgt.insert("false".to_string(), "s4".to_string());
        let steps = vec![
            PipelineStep{ id:"s1".into(), step_type:PromptType::ExtractionPrompt, prompt_id:1,label:None,alias:Some("a".into()),inputs:None,formula_override:None,input_source:None,route:None,condition:None,targets:None,merge_to:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
            PipelineStep{ id:"s2".into(), step_type:PromptType::DecisionPrompt, prompt_id:2,label:None,alias:None,inputs:None,formula_override:None,input_source:None,route:None,condition:Some("true".into()),targets:Some(tgt),merge_to:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
            PipelineStep{ id:"s3".into(), step_type:PromptType::ScoringPrompt, prompt_id:3,label:None,alias:Some("b".into()),inputs:Some(vec!["a".into()]),formula_override:None,input_source:None,route:None,condition:None,targets:None,merge_to:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
            PipelineStep{ id:"s4".into(), step_type:PromptType::ScoringPrompt, prompt_id:4,label:None,alias:Some("c".into()),inputs:Some(vec!["a".into()]),formula_override:None,input_source:None,route:None,condition:None,targets:None,merge_to:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
        ];
        let cfg = PipelineConfig{ name:"t".into(), steps};
        let exec = build_exec_steps(&cfg).unwrap();
        let map = exec[1].targets_idx.as_ref().unwrap();
        assert_eq!(map.get("true"), Some(&2usize));
        assert_eq!(map.get("false"), Some(&3usize));
    }

    #[test]
    fn merge_after_branch() {
        let mut tgt = std::collections::HashMap::new();
        tgt.insert("t".into(), "b1".into());
        let steps = vec![
            PipelineStep { id:"dec".into(), step_type:PromptType::DecisionPrompt, prompt_id:1,label:None,alias:None,inputs:None,formula_override:None,input_source:None,route:None,condition:None,targets:Some(tgt),merge_to:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
            PipelineStep { id:"b1".into(), step_type:PromptType::ScoringPrompt, prompt_id:2,label:None,alias:None,inputs:None,formula_override:None,input_source:None,route:None,condition:None,targets:None,merge_to:Some("m".into()),true_target:None,false_target:None,enum_targets:None,active:Some(true)},
            PipelineStep { id:"m".into(), step_type:PromptType::ScoringPrompt, prompt_id:3,label:None,alias:None,inputs:None,formula_override:None,input_source:None,route:None,condition:None,targets:None,merge_to:None,true_target:None,false_target:None,enum_targets:None,active:Some(true)},
        ];
        let cfg = PipelineConfig{ name:"t".into(), steps};
        let exec = build_exec_steps(&cfg).unwrap();
        assert_eq!(exec[0].next_idx, Some(1)); // decision -> first branch step
        assert_eq!(exec[1].next_idx, Some(2)); // branch step -> merge target
    }
}
