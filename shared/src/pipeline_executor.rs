use std::collections::{HashMap, VecDeque};

use evalexpr::eval_float;
use evalexpr::{
    eval_boolean_with_context, ContextWithMutableVariables, DefaultNumericTypes, HashMapContext,
    Value,
};

use crate::dto::{PromptResult, StageScore};
use crate::openai_executor::OpenAIExecutor;
use crate::pipeline_graph::Status;
use crate::pipeline_graph::{Edge, EdgeType, PipelineGraph, PromptNode, PromptType};
use chrono::Utc;
use regex::Regex;
use tracing::debug;

#[derive(Debug, Clone)]
pub struct ResultData {
    pub result: bool,
    pub score: f64,
    pub answer: Option<String>,
    pub source: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
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
    stage_scores: Vec<StageScore>,
    history: Vec<(String, ResultData, u8, PromptType)>,
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
            stage_scores: Vec::new(),
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
        for stage in &self.stage_scores {
            let key = format!("stage.{}.score", stage.stage_id);
            ctx.set_value(key.into(), Value::from_float(stage.score))
                .ok();
        }
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
        let mut queue: VecDeque<(String, u8)> = self
            .graph
            .nodes
            .iter()
            .filter(|n| matches!(n.type_, PromptType::TriggerPrompt))
            .map(|n| (n.id.clone(), 1))
            .collect();

        while let Some((id, attempt)) = queue.pop_front() {
            if !matches!(self.status.get(&id), Some(PromptStatus::Pending)) {
                continue;
            }
            self.status.insert(id.clone(), PromptStatus::Running);
            let started = Utc::now();
            debug!(prompt_id = %id, started_at = %started.to_rfc3339(), "prompt started");
            let node = match self.get_node(&id) {
                Some(n) => n.clone(),
                None => continue,
            };

            let res = match node.type_ {
                PromptType::TriggerPrompt => ResultData {
                    result: true,
                    score: 1.0,
                    answer: Some("trigger".into()),
                    source: Some("trigger".into()),
                    started_at: Some(started.to_rfc3339()),
                    finished_at: None,
                },
                PromptType::AnalysisPrompt => ResultData {
                    result: true,
                    score: 1.0,
                    answer: Some("analysis".into()),
                    source: Some("analysis".into()),
                    started_at: Some(started.to_rfc3339()),
                    finished_at: None,
                },
                PromptType::DecisionPrompt => ResultData {
                    result: true,
                    score: 1.0,
                    answer: Some("decision".into()),
                    source: Some("decision".into()),
                    started_at: Some(started.to_rfc3339()),
                    finished_at: None,
                },
                PromptType::MetaPrompt => {
                    #[derive(serde::Deserialize)]
                    struct MetaAction {
                        action: String,
                        target: String,
                    }
                    if let Ok(meta) = serde_json::from_str::<MetaAction>(&node.text) {
                        match meta.action.as_str() {
                            "enable" => {
                                self.status
                                    .insert(meta.target.clone(), PromptStatus::Pending);
                            }
                            "disable" => {
                                self.status
                                    .insert(meta.target.clone(), PromptStatus::Skipped);
                            }
                            _ => {}
                        }
                    }
                    ResultData {
                        result: true,
                        score: 0.0,
                        answer: Some(node.text.clone()),
                        source: Some(node.text.clone()),
                        started_at: Some(started.to_rfc3339()),
                        finished_at: None,
                    }
                }
                _ => ResultData {
                    result: true,
                    score: 1.0,
                    answer: Some("answer".into()),
                    source: Some("answer".into()),
                    started_at: Some(started.to_rfc3339()),
                    finished_at: None,
                },
            };
            let finished = Utc::now();
            let mut res = res;
            res.finished_at = Some(finished.to_rfc3339());
            debug!(prompt_id = %id, finished_at = %finished.to_rfc3339(), "prompt finished");

            self.history
                .push((id.clone(), res.clone(), attempt, node.type_.clone()));

            if let Some(th) = node.confidence_threshold {
                if res.score < th && attempt < 3 {
                    self.status.insert(id.clone(), PromptStatus::Pending);
                    queue.push_back((id.clone(), attempt + 1));
                    continue;
                }
            }

            self.status
                .insert(id.clone(), PromptStatus::Done(res.clone()));
            self.compute_stage_scores();

            for edge in self.graph.edges.iter().filter(|e| e.source == id) {
                if self.evaluate_edge(edge, &res) {
                    if let Some(PromptStatus::Pending) = self.status.get(&edge.target) {
                        queue.push_back((edge.target.clone(), 1));
                    }
                }
            }
        }

        self.compute_stage_scores();
        self.compute_final();
    }

    pub async fn run_with_openai(&mut self, openai: &OpenAIExecutor, blocks: &serde_json::Value) {
        let mut queue: VecDeque<(String, u8)> = self
            .graph
            .nodes
            .iter()
            .filter(|n| matches!(n.type_, PromptType::TriggerPrompt))
            .map(|n| (n.id.clone(), 1))
            .collect();

        while let Some((id, attempt)) = queue.pop_front() {
            if !matches!(self.status.get(&id), Some(PromptStatus::Pending)) {
                continue;
            }
            self.status.insert(id.clone(), PromptStatus::Running);
            let started = Utc::now();
            let node = match self.get_node(&id) {
                Some(n) => n.clone(),
                None => continue,
            };

            let mut res = match node.type_ {
                PromptType::AnalysisPrompt => {
                    let mut r = openai
                        .run_batch(&[node.clone()], blocks)
                        .await
                        .pop()
                        .unwrap_or(PromptResult {
                            prompt_id: node.id.clone(),
                            prompt_type: node.type_.as_str().into(),
                            status: Status::Done,
                            result: Some(false),
                            score: Some(0.0),
                            answer: None,
                            source: None,
                            attempt: Some(attempt),
                            started_at: Some(started.to_rfc3339()),
                            finished_at: Some(Utc::now().to_rfc3339()),
                        });
                    ResultData {
                        result: r.result.unwrap_or(false),
                        score: r.score.unwrap_or(0.0),
                        answer: r.answer.take(),
                        source: r.source.take(),
                        started_at: r.started_at.take(),
                        finished_at: r.finished_at.take(),
                    }
                }
                PromptType::TriggerPrompt => ResultData {
                    result: true,
                    score: 1.0,
                    answer: Some("trigger".into()),
                    source: Some("trigger".into()),
                    started_at: Some(started.to_rfc3339()),
                    finished_at: None,
                },
                PromptType::DecisionPrompt => ResultData {
                    result: true,
                    score: 1.0,
                    answer: Some("decision".into()),
                    source: Some("decision".into()),
                    started_at: Some(started.to_rfc3339()),
                    finished_at: None,
                },
                PromptType::MetaPrompt => {
                    #[derive(serde::Deserialize)]
                    struct MetaAction {
                        action: String,
                        target: String,
                    }
                    if let Ok(meta) = serde_json::from_str::<MetaAction>(&node.text) {
                        match meta.action.as_str() {
                            "enable" => {
                                self.status
                                    .insert(meta.target.clone(), PromptStatus::Pending);
                            }
                            "disable" => {
                                self.status
                                    .insert(meta.target.clone(), PromptStatus::Skipped);
                            }
                            _ => {}
                        }
                    }
                    ResultData {
                        result: true,
                        score: 0.0,
                        answer: Some(node.text.clone()),
                        source: Some(node.text.clone()),
                        started_at: Some(started.to_rfc3339()),
                        finished_at: None,
                    }
                }
                _ => ResultData {
                    result: true,
                    score: 1.0,
                    answer: Some("answer".into()),
                    source: Some("answer".into()),
                    started_at: Some(started.to_rfc3339()),
                    finished_at: None,
                },
            };

            if res.finished_at.is_none() {
                res.finished_at = Some(Utc::now().to_rfc3339());
            }

            self.history
                .push((id.clone(), res.clone(), attempt, node.type_.clone()));

            if let Some(th) = node.confidence_threshold {
                if res.score < th && attempt < 3 {
                    self.status.insert(id.clone(), PromptStatus::Pending);
                    queue.push_back((id.clone(), attempt + 1));
                    continue;
                }
            }

            self.status
                .insert(id.clone(), PromptStatus::Done(res.clone()));
            self.compute_stage_scores();

            for edge in self.graph.edges.iter().filter(|e| e.source == id) {
                if self.evaluate_edge(edge, &res) {
                    if let Some(PromptStatus::Pending) = self.status.get(&edge.target) {
                        queue.push_back((edge.target.clone(), 1));
                    }
                }
            }
        }

        self.compute_stage_scores();
        self.compute_final();
    }

    fn compute_stage_scores(&mut self) {
        self.stage_scores.clear();
        for stage in &self.graph.stages {
            let mut total_w = 0.0;
            let mut sum = 0.0;
            let mut prompts = Vec::new();
            let mut prompt_scores: HashMap<String, f64> = HashMap::new();
            for pid in &stage.prompt_ids {
                if let Some(PromptStatus::Done(res)) = self.status.get(pid) {
                    let weight = self.get_node(pid).and_then(|n| n.weight).unwrap_or(1.0);
                    total_w += weight;
                    sum += weight * res.score;
                    prompts.push(pid.clone());
                    prompt_scores.insert(pid.clone(), res.score);
                }
            }

            if total_w > 0.0 {
                let score = if let Some(formula) = &stage.score_formula {
                    let mut f = formula.clone();
                    for (pid, sc) in &prompt_scores {
                        let re = Regex::new(&format!(r"\b{}\b", regex::escape(pid))).unwrap();
                        f = re.replace_all(&f, sc.to_string()).into_owned();
                    }
                    match eval_float(&f) {
                        Ok(v) => v,
                        Err(_) => sum / total_w,
                    }
                } else {
                    sum / total_w
                };

                self.stage_scores.push(StageScore {
                    stage_id: stage.id.clone(),
                    score,
                    prompts,
                });
            }
        }
    }

    fn compute_final(&mut self) {
        let mut formula = self.graph.final_scoring.score_formula.clone();
        let re = Regex::new(r"([A-Za-z0-9_]+)\.score").unwrap();
        formula = re
            .replace_all(&formula, |caps: &regex::Captures| {
                let key = &caps[1];
                if let Some(stage) = self.stage_scores.iter().find(|s| s.stage_id == key) {
                    stage.score.to_string()
                } else {
                    "0.0".to_string()
                }
            })
            .into_owned();
        let score = eval_float(&formula).unwrap_or(0.0);
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

    pub fn get_result(&self) -> (f64, String) {
        (
            self.final_score,
            self.final_label.clone().unwrap_or_default(),
        )
    }

    pub fn history(&self) -> &Vec<(String, ResultData, u8, PromptType)> {
        &self.history
    }

    pub fn stage_scores(&self) -> &Vec<StageScore> {
        &self.stage_scores
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline_graph::example_pipeline;
    use crate::pipeline_graph::{
        Edge, EdgeType, FinalScoring, LabelRule, PipelineGraph, PromptNode, PromptType, Stage,
    };

    fn simple_graph(cond: &str) -> PipelineGraph {
        PipelineGraph {
            nodes: vec![
                PromptNode {
                    id: "t".into(),
                    text: "t".into(),
                    type_: PromptType::TriggerPrompt,
                    weight: None,
                    confidence_threshold: None,
                    metadata: None,
                },
                PromptNode {
                    id: "a".into(),
                    text: "a".into(),
                    type_: PromptType::AnalysisPrompt,
                    weight: None,
                    confidence_threshold: None,
                    metadata: None,
                },
                PromptNode {
                    id: "d".into(),
                    text: "d".into(),
                    type_: PromptType::DecisionPrompt,
                    weight: None,
                    confidence_threshold: None,
                    metadata: None,
                },
            ],
            edges: vec![
                Edge {
                    source: "t".into(),
                    target: "a".into(),
                    condition: None,
                    type_: Some(EdgeType::Always),
                },
                Edge {
                    source: "a".into(),
                    target: "d".into(),
                    condition: Some(cond.into()),
                    type_: Some(EdgeType::OnScore),
                },
            ],
            stages: vec![Stage {
                id: "s1".into(),
                name: "s1".into(),
                prompt_ids: vec!["a".into()],
                score_formula: None,
            }],
            final_scoring: FinalScoring {
                score_formula: "s1.score".into(),
                label_rules: vec![LabelRule {
                    if_condition: "score > 0".into(),
                    label: "ok".into(),
                }],
            },
        }
    }

    #[test]
    fn run_example_pipeline() {
        let graph = example_pipeline();
        let mut exec = PipelineExecutor::new(graph);
        exec.run();
        let (_score, label) = exec.get_result();
        assert_eq!(label, "M\u{00d6}GLICHER_REGRESS");
    }

    #[test]
    fn onscore_edge() {
        let graph = simple_graph("score >= 0.5");
        let mut exec = PipelineExecutor::new(graph);
        exec.run();
        let analysis = exec
            .history
            .iter()
            .find(|(_, _, _, t)| matches!(t, PromptType::AnalysisPrompt))
            .unwrap();
        assert!(analysis.1.source.is_some());
        assert_eq!(exec.history.len(), 3);
    }

    #[test]
    fn onscore_stage_condition() {
        let graph = simple_graph("stage.s1.score > 0.5");
        let mut exec = PipelineExecutor::new(graph);
        exec.run();
        assert_eq!(exec.history.len(), 3);
    }

    #[test]
    fn meta_prompt_disable() {
        let mut graph = simple_graph("score >= 0.5");
        graph.nodes.push(PromptNode {
            id: "m1".into(),
            text: "{\"action\": \"disable\", \"target\": \"a\"}".into(),
            type_: PromptType::MetaPrompt,
            weight: None,
            confidence_threshold: None,
            metadata: None,
        });
        graph.edges = vec![
            Edge {
                source: "t".into(),
                target: "m1".into(),
                condition: None,
                type_: Some(EdgeType::Always),
            },
            Edge {
                source: "m1".into(),
                target: "a".into(),
                condition: None,
                type_: Some(EdgeType::Always),
            },
            Edge {
                source: "a".into(),
                target: "d".into(),
                condition: Some("score >= 0.5".into()),
                type_: Some(EdgeType::OnScore),
            },
        ];
        let mut exec = PipelineExecutor::new(graph);
        exec.run();
        assert!(matches!(exec.status.get("a"), Some(PromptStatus::Skipped)));
        assert_eq!(exec.history.len(), 2);
    }

    #[test]
    fn stage_default_scoring() {
        let graph = simple_graph("score >= 0.5");
        let mut exec = PipelineExecutor::new(graph);
        exec.run();
        let stage = exec
            .stage_scores()
            .iter()
            .find(|s| s.stage_id == "s1")
            .unwrap();
        assert_eq!(stage.score, 1.0);
    }

    #[test]
    fn stage_formula_scoring() {
        let mut graph = simple_graph("score >= 0.5");
        graph.stages[0].score_formula = Some("0.5 * a".into());
        let mut exec = PipelineExecutor::new(graph);
        exec.run();
        let stage = exec
            .stage_scores()
            .iter()
            .find(|s| s.stage_id == "s1")
            .unwrap();
        assert!((stage.score - 0.5).abs() < f64::EPSILON);
    }
}
