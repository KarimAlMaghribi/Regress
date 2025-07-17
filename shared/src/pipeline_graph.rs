use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum PromptType {
    #[serde(rename = "TriggerPrompt")]
    TriggerPrompt,
    #[serde(rename = "AnalysisPrompt")]
    AnalysisPrompt,
    #[serde(rename = "FollowUpPrompt")]
    FollowUpPrompt,
    #[serde(rename = "DecisionPrompt")]
    DecisionPrompt,
    #[serde(rename = "FinalPrompt")]
    FinalPrompt,
    #[serde(rename = "MetaPrompt")]
    MetaPrompt,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PromptNode {
    pub id: String,
    pub text: String,
    #[serde(rename = "type")]
    pub type_: PromptType,
    pub weight: Option<f64>,
    pub confidence_threshold: Option<f64>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub source: String,
    pub target: String,
    pub condition: Option<String>,
    #[serde(rename = "type")]
    pub type_: Option<EdgeType>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub name: String,
    pub prompt_ids: Vec<String>,
    pub score_formula: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LabelRule {
    #[serde(rename = "if")]
    pub if_condition: String,
    pub label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FinalScoring {
    pub score_formula: String,
    pub label_rules: Vec<LabelRule>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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
                type_: PromptType::TriggerPrompt,
                weight: None,
                confidence_threshold: None,
                metadata: None,
            },
            PromptNode {
                id: "analysis_1".into(),
                text: "Analysiere das Verhalten des Patienten.".into(),
                type_: PromptType::AnalysisPrompt,
                weight: Some(1.2),
                confidence_threshold: None,
                metadata: None,
            },
            PromptNode {
                id: "analysis_2".into(),
                text: "Erfasse medizinische Parameter.".into(),
                type_: PromptType::AnalysisPrompt,
                weight: Some(0.8),
                confidence_threshold: None,
                metadata: None,
            },
            PromptNode {
                id: "decision_1".into(),
                text: "Liegt ein Regress vor?".into(),
                type_: PromptType::DecisionPrompt,
                weight: None,
                confidence_threshold: Some(0.7),
                metadata: None,
            },
            PromptNode {
                id: "final_1".into(),
                text: "Endgültiger Ergebnisbericht.".into(),
                type_: PromptType::FinalPrompt,
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
                type_: Some(EdgeType::Always),
            },
            Edge {
                source: "analysis_1".into(),
                target: "analysis_2".into(),
                condition: None,
                type_: Some(EdgeType::Always),
            },
            Edge {
                source: "analysis_2".into(),
                target: "decision_1".into(),
                condition: None,
                type_: Some(EdgeType::Always),
            },
            Edge {
                source: "decision_1".into(),
                target: "final_1".into(),
                condition: Some("result == true".into()),
                type_: Some(EdgeType::OnTrue),
            },
        ],
        stages: vec![Stage {
            id: "verhalten".into(),
            name: "Verhaltensanalyse".into(),
            prompt_ids: vec!["analysis_1".into(), "analysis_2".into()],
            score_formula: Some("sum(weightedResults) / totalWeight".into()),
        }],
        final_scoring: FinalScoring {
            score_formula: "0.4 * medizin.score + 0.6 * verhalten.score".into(),
            label_rules: vec![
                LabelRule {
                    if_condition: "score >= 0.8".into(),
                    label: "KEIN_REGRESS".into(),
                },
                LabelRule {
                    if_condition: "score >= 0.5 && score < 0.8".into(),
                    label: "M\u{00d6}GLICHER_REGRESS".into(),
                },
                LabelRule {
                    if_condition: "score < 0.5".into(),
                    label: "SICHER_REGRESS".into(),
                },
            ],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_example_pipeline() {
        let pipeline = example_pipeline();
        let json = serde_json::to_string_pretty(&pipeline).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value["nodes"].is_array());
        assert!(value["edges"].is_array());
        assert!(value["stages"].is_array());
    }
}
