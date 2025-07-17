use crate::pipeline::{EdgeType, PipelineGraph, PromptNode, PromptType};
use evalexpr::*;
use std::collections::{HashMap, VecDeque};

#[derive(Debug, Clone)]
pub struct ResultData {
    pub result: bool,
    pub score: f64,
    pub answer: Option<String>,
}

#[derive(Debug, Clone)]
pub enum PromptStatus {
    Pending,
    Running,
    Done(ResultData),
    Skipped,
}

pub struct PipelineExecutor {
    graph: PipelineGraph,
    status: HashMap<String, PromptStatus>,
    history: Vec<(String, ResultData)>,
    stage_scores: HashMap<String, f64>,
    final_label: Option<String>,
}

impl PipelineExecutor {
    pub fn new(graph: PipelineGraph) -> Self {
        let mut status = HashMap::new();
        for node in &graph.nodes {
            status.insert(node.id.clone(), PromptStatus::Pending);
        }
        Self {
            graph,
            status,
            history: Vec::new(),
            stage_scores: HashMap::new(),
            final_label: None,
        }
    }

    pub fn run(&mut self) {
        let mut queue: VecDeque<String> = self
            .graph
            .nodes
            .iter()
            .filter(|n| n.node_type == PromptType::TriggerPrompt)
            .map(|n| n.id.clone())
            .collect();

        while let Some(id) = queue.pop_front() {
            if !matches!(self.status.get(&id), Some(PromptStatus::Pending)) {
                continue;
            }
            self.status.insert(id.clone(), PromptStatus::Running);
            let result = self.execute_prompt(&id);
            self.status.insert(id.clone(), PromptStatus::Done(result.clone()));
            self.history.push((id.clone(), result.clone()));

            for edge in self.graph.edges.iter().filter(|e| e.source == id) {
                if let Some(target_status) = self.status.get(&edge.target) {
                    if !matches!(target_status, PromptStatus::Pending) {
                        continue;
                    }
                }
                let execute = match edge.edge_type.as_ref().unwrap_or(&EdgeType::Always) {
                    EdgeType::Always => true,
                    EdgeType::OnTrue => result.result,
                    EdgeType::OnFalse => !result.result,
                    EdgeType::OnScore => {
                        if let Some(cond) = &edge.condition {
                            let mut ctx = HashMapContext::new();
                            ctx.set_value("score".into(), result.score.into())
                                .unwrap();
                            eval_boolean_with_context(cond, &ctx).unwrap_or(false)
                        } else {
                            false
                        }
                    }
                    EdgeType::OnError => false,
                };
                if execute {
                    queue.push_back(edge.target.clone());
                }
            }
        }

        self.compute_stage_scores();
        self.compute_final_label();
    }

    fn execute_prompt(&self, id: &str) -> ResultData {
        let node = self.graph.nodes.iter().find(|n| n.id == id).unwrap();
        match node.node_type {
            PromptType::TriggerPrompt => ResultData {
                result: true,
                score: 1.0,
                answer: Some("triggered".into()),
            },
            PromptType::AnalysisPrompt => {
                let val = id.ends_with('1');
                ResultData {
                    result: val,
                    score: if val { 1.0 } else { 0.0 },
                    answer: None,
                }
            }
            PromptType::DecisionPrompt => {
                // simple: true if majority of analysis prompts in stage verhalten were true
                let true_count = self
                    .history
                    .iter()
                    .filter(|(nid, _)| {
                        self.graph
                            .stages
                            .iter()
                            .any(|s| s.prompt_ids.contains(nid) && s.id == "verhalten")
                    })
                    .filter(|(_, res)| res.result)
                    .count();
                let total = self
                    .history
                    .iter()
                    .filter(|(nid, _)| {
                        self.graph
                            .stages
                            .iter()
                            .any(|s| s.prompt_ids.contains(nid) && s.id == "verhalten")
                    })
                    .count();
                let score = if total > 0 {
                    true_count as f64 / total as f64
                } else {
                    0.0
                };
                ResultData {
                    result: score >= node.confidence_threshold.unwrap_or(0.5),
                    score,
                    answer: None,
                }
            }
            _ => ResultData {
                result: true,
                score: 1.0,
                answer: None,
            },
        }
    }

    fn compute_stage_scores(&mut self) {
        for stage in &self.graph.stages {
            let mut total_weight = 0.0;
            let mut sum = 0.0;
            for pid in &stage.prompt_ids {
                let node = self.graph.nodes.iter().find(|n| &n.id == pid).unwrap();
                let weight = node.weight.unwrap_or(1.0);
                if let Some(PromptStatus::Done(res)) = self.status.get(pid) {
                    total_weight += weight;
                    sum += weight * if res.result { 1.0 } else { 0.0 };
                }
            }
            let score = if total_weight > 0.0 { sum / total_weight } else { 0.0 };
            self.stage_scores.insert(stage.id.clone(), score);
        }
    }

    fn compute_final_label(&mut self) {
        let mut formula = self.graph.final_scoring.score_formula.clone();
        for (stage_id, score) in &self.stage_scores {
            formula = formula.replace(&format!("{stage_id}.score"), &score.to_string());
        }
        let final_score = eval_number(&formula).unwrap_or(0.0);
        for rule in &self.graph.final_scoring.label_rules {
            let mut ctx = HashMapContext::new();
            ctx.set_value("score".into(), final_score.into()).unwrap();
            if eval_boolean_with_context(&rule.r#if, &ctx).unwrap_or(false) {
                self.final_label = Some(rule.label.clone());
                break;
            }
        }
        if self.final_label.is_none() {
            self.final_label = Some("UNDECIDED".into());
        }
    }

    pub fn get_result(&self) -> Option<&str> {
        self.final_label.as_deref()
    }

    pub fn get_history(&self) -> &[(String, ResultData)] {
        &self.history
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::example_pipeline;

    #[test]
    fn run_example_pipeline() {
        let graph = example_pipeline();
        let mut exec = PipelineExecutor::new(graph);
        exec.run();
        let label = exec.get_result().unwrap();
        assert_eq!(label, "M\u{00d6}GLICHER_REGRESS");
        assert!(!exec.get_history().is_empty());
    }
}
