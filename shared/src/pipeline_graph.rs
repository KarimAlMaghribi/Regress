//! src/pipeline_graph.rs
//! -------------------------------------------------------------
//! Zentrale Daten‑ und Validierungs­struktur für Prompt‑Pipelines
//! – wird sowohl vom Runner (Rust) als auch vom Frontend (TS)
//!   genutzt.  Bei Änderungen **immer** `cargo test` + TS‑Export
//!   laufen lassen.
//!
//!   TS‑Export (Beispiel):
//!   $ ts-rs-cli src/pipeline_graph.rs --output ../frontend/src/types/pipeline.ts
//! -------------------------------------------------------------

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use ts_rs::TS;
use uuid::Uuid;

use schemars::JsonSchema;

/// Welche Art von Prompt ein Node repräsentiert – entspricht
/// genau den Typ‑Karten im Editor.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "PascalCase")]
pub enum PromptType {
    TriggerPrompt,
    AnalysisPrompt,
    FollowUpPrompt,
    DecisionPrompt,
    FinalPrompt,
    MetaPrompt,
}

/// Wann eine Kante (= Edge) feuert.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum EdgeType {
    Always,
    OnTrue,
    OnFalse,
    OnScore,
    OnError,
}

impl Default for EdgeType {
    fn default() -> Self {
        EdgeType::Always
    }
}

/// Ein einzelner Prompt‑Knoten im DAG
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptNode {
    pub id: Uuid,
    pub text: String,

    /// Enum in PascalCase – wird in TS als String‑Union exportiert.
    #[serde(rename = "type")]
    pub type_: PromptType,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence_threshold: Option<f32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Gerichtete Verbindung zwischen zwei Prompts
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: Uuid,
    pub source: Uuid,
    pub target: Uuid,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,

    #[serde(rename = "type", default)]
    pub type_: EdgeType,
}

/// Logische Gruppierung von Prompts; kann eine eigene Score‑Formel haben.
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: Uuid,
    pub name: String,
    pub prompt_ids: Vec<Uuid>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score_formula: Option<String>,
}

/// Wenn … dann Label
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LabelRule {
    #[serde(rename = "if")]
    pub if_condition: String,
    pub label: String,
}

/// End‑Aggregation + Labeling
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FinalScoring {
    pub score_formula: String,
    pub label_rules: Vec<LabelRule>,
}

/// Gesamter DAG
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PipelineGraph {
    pub nodes: Vec<PromptNode>,
    pub edges: Vec<Edge>,
    pub stages: Vec<Stage>,
    pub final_scoring: FinalScoring,
}

impl PipelineGraph {
    /// Domain‑Validierung: darf nie fehlschlagen, wenn wir speichern
    pub fn validate(&self) -> anyhow::Result<()> {
        use petgraph::{algo::toposort, graphmap::DiGraphMap};

        // -- Eindeutige IDs
        let mut set = HashSet::new();
        anyhow::ensure!(
            self.nodes.iter().all(|n| set.insert(n.id)),
            "duplicate node id"
        );

        // -- Trigger / Final genau 1×
        anyhow::ensure!(
            self.nodes
                .iter()
                .filter(|n| n.type_ == PromptType::TriggerPrompt)
                .count()
                == 1,
            "exactly one TriggerPrompt required"
        );
        anyhow::ensure!(
            self.nodes
                .iter()
                .filter(|n| n.type_ == PromptType::FinalPrompt)
                .count()
                == 1,
            "exactly one FinalPrompt required"
        );

        // -- Graph aufbauen & acyclic prüfen
        let mut g = DiGraphMap::<Uuid, ()>::new();
        for n in &self.nodes {
            g.add_node(n.id);
        }
        for e in &self.edges {
            anyhow::ensure!(
                g.contains_node(e.source) && g.contains_node(e.target),
                "edge refers to unknown node"
            );
            g.add_edge(e.source, e.target, ());
        }
        toposort(&g, None)
            .map_err(|_| anyhow::anyhow!("graph contains cycle(s)"))?;

        // -- Gewichte nur bei Analysis / Decision
        for n in &self.nodes {
            if n.weight.is_some()
                && !(matches!(n.type_, PromptType::AnalysisPrompt)
                || matches!(n.type_, PromptType::DecisionPrompt))
            {
                anyhow::bail!("weight only allowed on Analysis or Decision nodes");
            }
        }

        // -- Stage‑Prompt‑Referenzen gültig
        let node_ids: HashSet<_> = self.nodes.iter().map(|n| n.id).collect();
        for s in &self.stages {
            for pid in &s.prompt_ids {
                anyhow::ensure!(
                    node_ids.contains(pid),
                    "stage {} references unknown prompt {}",
                    s.name,
                    pid
                );
            }
        }

        Ok(())
    }
}

/// Pipeline‑Beispiel – wird von Tests + Docs benutzt
pub fn example_pipeline() -> PipelineGraph {
    // helper für kürzere Initialisierung
    let n = |t: PromptType, text: &str, weight| PromptNode {
        id: Uuid::new_v4(),
        text: text.into(),
        type_: t,
        weight,
        confidence_threshold: None,
        metadata: None,
    };

    // Nodes
    let trigger = n(PromptType::TriggerPrompt, "Ist ein neuer Bericht eingegangen?", None);
    let analysis1 =
        n(PromptType::AnalysisPrompt, "Analysiere das Verhalten des Patienten.", Some(1.2));
    let analysis2 =
        n(PromptType::AnalysisPrompt, "Erfasse medizinische Parameter.", Some(0.8));
    let decision = PromptNode {
        weight: None,
        confidence_threshold: Some(0.7),
        ..n(PromptType::DecisionPrompt, "Liegt ein Regress vor?", None)
    };
    let final_node = n(PromptType::FinalPrompt, "Endgültiger Ergebnisbericht.", None);

    // Edges
    let e = |source: Uuid, target: Uuid, et: EdgeType, cond: Option<&str>| Edge {
        id: Uuid::new_v4(),
        source,
        target,
        type_: et,
        condition: cond.map(|s| s.into()),
    };

    PipelineGraph {
        nodes: vec![
            trigger.clone(),
            analysis1.clone(),
            analysis2.clone(),
            decision.clone(),
            final_node.clone(),
        ],
        edges: vec![
            e(trigger.id, analysis1.id, EdgeType::Always, None),
            e(analysis1.id, analysis2.id, EdgeType::Always, None),
            e(analysis2.id, decision.id, EdgeType::Always, None),
            e(
                decision.id,
                final_node.id,
                EdgeType::OnTrue,
                Some("result == true"),
            ),
        ],
        stages: vec![Stage {
            id: Uuid::new_v4(),
            name: "Verhaltensanalyse".into(),
            prompt_ids: vec![analysis1.id, analysis2.id],
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
                    label: "MÖGLICHER_REGRESS".into(),
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
    fn example_is_valid_and_serializable() {
        let pipeline = example_pipeline();
        pipeline.validate().expect("example must be valid");

        let json = serde_json::to_string_pretty(&pipeline).unwrap();
        let de: PipelineGraph = serde_json::from_str(&json).unwrap();
        de.validate().unwrap(); // round‑trip bleibt valide
    }
}
