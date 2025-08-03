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

// tests removed as part of field cleanup
