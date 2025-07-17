use std::collections::{HashMap, VecDeque};

use evalexpr::{
    eval_boolean_with_context, ContextWithMutableVariables, DefaultNumericTypes, HashMapContext,
    Value,
};
use meval::eval_str;

use crate::pipeline_graph::{Edge, EdgeType, PipelineGraph, PromptNode, PromptType};
use regex::Regex;

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

#[derive(Debug)]
pub struct PipelineExecutor {
    graph: PipelineGraph,
    status: HashMap<String, PromptStatus>,
    stage_scores: HashMap<String, f64>,
    history: Vec<(String, ResultData)>,
    final_score: f64,
    final_label: Option<String>,
}

impl PipelineExecutor {
    pub fn new(graph: PipelineGraph) -> Self {
        let mut status = HashMap::new();
        for n in &graph.nodes {
            status.insert(n.id.clone(), PromptStatus::Pending);
        }
        Self {
            graph,
            status,
            stage_scores: HashMap::new(),
            history: Vec::new(),
            final_score: 0.0,
            final_label: None,
        }
    }

    fn get_node(&self, id: &str) -> Option<&PromptNode> {
        self.graph.nodes.iter().find(|n| n.id == id)
    }

    fn eval_bool_expr(&self, expr: &str, result: bool, score: f64) -> bool {
        let mut ctx = HashMapContext::<DefaultNumericTypes>::new();
        ctx.set_value("result".into(), Value::from(result)).unwrap();
        ctx.set_value("score".into(), Value::from_float(score))
            .unwrap();
        eval_boolean_with_context(expr, &ctx).unwrap_or(false)
    }

    fn evaluate_edge(&self, edge: &Edge, data: &ResultData) -> bool {
        match edge.type_ {
            Some(EdgeType::Always) | None => true,
            Some(EdgeType::OnTrue) => {
                if let Some(cond) = &edge.condition {
                    self.eval_bool_expr(cond, data.result, data.score)
                } else {
                    data.result
                }
            }
            Some(EdgeType::OnFalse) => {
                if let Some(cond) = &edge.condition {
                    self.eval_bool_expr(cond, data.result, data.score)
                } else {
                    !data.result
                }
            }
            Some(EdgeType::OnScore) => {
                if let Some(cond) = &edge.condition {
                    self.eval_bool_expr(cond, data.result, data.score)
                } else {
                    false
                }
            }
            Some(EdgeType::OnError) => false,
        }
    }

    pub fn run(&mut self) {
        let mut queue: VecDeque<String> = self
            .graph
            .nodes
            .iter()
            .filter(|n| matches!(n.type_, PromptType::TriggerPrompt))
            .map(|n| n.id.clone())
            .collect();

        while let Some(id) = queue.pop_front() {
            if !matches!(self.status.get(&id), Some(PromptStatus::Pending)) {
                continue;
            }
            self.status.insert(id.clone(), PromptStatus::Running);
            let node = match self.get_node(&id) {
                Some(n) => n.clone(),
                None => continue,
            };

            let res = match node.type_ {
                PromptType::TriggerPrompt => ResultData {
                    result: true,
                    score: 1.0,
                    answer: Some("trigger".into()),
                },
                PromptType::AnalysisPrompt => ResultData {
                    result: true,
                    score: 1.0,
                    answer: Some("analysis".into()),
                },
                PromptType::DecisionPrompt => ResultData {
                    result: true,
                    score: 1.0,
                    answer: Some("decision".into()),
                },
                _ => ResultData {
                    result: true,
                    score: 1.0,
                    answer: Some("answer".into()),
                },
            };

            self.status
                .insert(id.clone(), PromptStatus::Done(res.clone()));
            self.history.push((id.clone(), res.clone()));

            for edge in self.graph.edges.iter().filter(|e| e.source == id) {
                if self.evaluate_edge(edge, &res) {
                    if let Some(PromptStatus::Pending) = self.status.get(&edge.target) {
                        queue.push_back(edge.target.clone());
                    }
                }
            }
        }

        self.compute_stage_scores();
        self.compute_final();
    }

    fn compute_stage_scores(&mut self) {
        for stage in &self.graph.stages {
            let mut total_w = 0.0;
            let mut sum = 0.0;
            for pid in &stage.prompt_ids {
                if let Some(PromptStatus::Done(res)) = self.status.get(pid) {
                    let weight = self.get_node(pid).and_then(|n| n.weight).unwrap_or(1.0);
                    total_w += weight;
                    sum += weight * res.score;
                }
            }
            if total_w > 0.0 {
                self.stage_scores.insert(stage.id.clone(), sum / total_w);
            }
        }
    }

    fn compute_final(&mut self) {
        let mut formula = self.graph.final_scoring.score_formula.clone();
        let re = Regex::new(r"([A-Za-z0-9_]+)\.score").unwrap();
        formula = re
            .replace_all(&formula, |caps: &regex::Captures| {
                let key = &caps[1];
                if let Some(score) = self.stage_scores.get(key) {
                    score.to_string()
                } else {
                    "0.0".to_string()
                }
            })
            .into_owned();
        let score = eval_str(&formula).unwrap_or(0.0);
        self.final_score = score;
        for rule in &self.graph.final_scoring.label_rules {
            let mut ctx = HashMapContext::<DefaultNumericTypes>::new();
            ctx.set_value("score".into(), Value::from_float(score))
                .unwrap();
            if eval_boolean_with_context(&rule.if_condition, &ctx).unwrap_or(false) {
                self.final_label = Some(rule.label.clone());
                break;
            }
        }
    }

    pub fn get_result(&self) -> Option<(f64, String)> {
        self.final_label
            .as_ref()
            .map(|l| (self.final_score, l.clone()))
    }

    pub fn history(&self) -> &Vec<(String, ResultData)> {
        &self.history
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline_graph::example_pipeline;

    #[test]
    fn run_example_pipeline() {
        let graph = example_pipeline();
        let mut exec = PipelineExecutor::new(graph);
        exec.run();
        let (_score, label) = exec.get_result().unwrap();
        assert_eq!(label, "M\u{00d6}GLICHER_REGRESS");
    }
}
