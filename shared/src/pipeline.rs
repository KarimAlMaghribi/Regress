use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PromptType {
    TriggerPrompt,
    AnalysisPrompt,
    FollowUpPrompt,
    DecisionPrompt,
    FinalPrompt,
    MetaPrompt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptNode {
    pub id: String,
    pub text: String,
    #[serde(rename = "type")]
    pub node_type: PromptType,
    #[serde(default)]
    pub weight: Option<f64>,
    #[serde(default)]
    pub confidence_threshold: Option<f64>,
    #[serde(default)]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum EdgeType {
    #[serde(rename = "always")]
    Always,
    #[serde(rename = "onTrue")]
    OnTrue,
    #[serde(rename = "onFalse")]
    OnFalse,
    #[serde(rename = "onScore")]
    OnScore,
    #[serde(rename = "onError")]
    OnError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default, rename = "type")]
    pub edge_type: Option<EdgeType>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub name: String,
    pub prompt_ids: Vec<String>,
    #[serde(default)]
    pub score_formula: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelRule {
    #[serde(rename = "if")]
    pub r#if: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalScoring {
    pub score_formula: String,
    pub label_rules: Vec<LabelRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineGraph {
    pub nodes: Vec<PromptNode>,
    pub edges: Vec<Edge>,
    pub stages: Vec<Stage>,
    pub final_scoring: FinalScoring,
}

pub fn example_pipeline() -> PipelineGraph {
    PipelineGraph {
        nodes: vec![
            PromptNode {
                id: "trigger_1".into(),
                text: "Ist ein neuer Bericht eingegangen?".into(),
                node_type: PromptType::TriggerPrompt,
                weight: None,
                confidence_threshold: None,
                metadata: None,
            },
            PromptNode {
                id: "analysis_1".into(),
                text: "Analysiere das Verhalten des Patienten.".into(),
                node_type: PromptType::AnalysisPrompt,
                weight: Some(1.2),
                confidence_threshold: None,
                metadata: None,
            },
            PromptNode {
                id: "analysis_2".into(),
                text: "Erfasse medizinische Parameter.".into(),
                node_type: PromptType::AnalysisPrompt,
                weight: Some(0.8),
                confidence_threshold: None,
                metadata: None,
            },
            PromptNode {
                id: "decision_1".into(),
                text: "Liegt ein Regress vor?".into(),
                node_type: PromptType::DecisionPrompt,
                weight: None,
                confidence_threshold: Some(0.7),
                metadata: None,
            },
            PromptNode {
                id: "final_1".into(),
                text: "Endg\u{00fc}ltiger Ergebnisbericht.".into(),
                node_type: PromptType::FinalPrompt,
                weight: None,
                confidence_threshold: None,
                metadata: None,
            },
        ],
        edges: vec![
            Edge {
                source: "trigger_1".into(),
                target: "analysis_1".into(),
                condition: None,
                edge_type: Some(EdgeType::Always),
            },
            Edge {
                source: "analysis_1".into(),
                target: "analysis_2".into(),
                condition: None,
                edge_type: Some(EdgeType::Always),
            },
            Edge {
                source: "analysis_2".into(),
                target: "decision_1".into(),
                condition: None,
                edge_type: Some(EdgeType::Always),
            },
            Edge {
                source: "decision_1".into(),
                target: "final_1".into(),
                condition: Some("result == true".into()),
                edge_type: Some(EdgeType::OnTrue),
            },
        ],
        stages: vec![Stage {
            id: "verhalten".into(),
            name: "Verhaltensanalyse".into(),
            prompt_ids: vec!["analysis_1".into(), "analysis_2".into()],
            score_formula: Some("sum(weightedResults) / totalWeight".into()),
        }],
        final_scoring: FinalScoring {
            score_formula: "verhalten.score".into(),
            label_rules: vec![
                LabelRule { r#if: "score >= 0.8".into(), label: "KEIN_REGRESS".into() },
                LabelRule { r#if: "score >= 0.5 && score < 0.8".into(), label: "M\u{00d6}GLICHER_REGRESS".into() },
                LabelRule { r#if: "score < 0.5".into(), label: "SICHER_REGRESS".into() },
            ],
        },
    }
}
