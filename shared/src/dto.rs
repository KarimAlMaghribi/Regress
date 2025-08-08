use serde::de::Deserializer;
use serde::{Deserialize, Serialize};
use strum_macros::{Display, EnumString};

#[derive(Debug, Clone, PartialEq, Eq, EnumString, Display, Serialize, Deserialize)]
#[strum(serialize_all = "PascalCase")]
pub enum PromptType {
    ExtractionPrompt,
    ScoringPrompt,
    DecisionPrompt,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UploadRequest {
    pub file_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UploadResponse {
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PdfUploaded {
    pub pdf_id: i32,
    pub pipeline_id: uuid::Uuid,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextExtracted {
    pub pdf_id: i32,
    pub pipeline_id: uuid::Uuid,
    pub text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TextPosition {
    pub page: u32,
    pub bbox: [f32; 4],
    pub quote: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ScoringResult {
    pub prompt_id: i32,
    pub result: bool,
    pub source: TextPosition,
    pub explanation: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PromptResult {
    pub prompt_id: i32,
    pub prompt_type: PromptType,
    pub prompt_text: String,
    pub boolean: Option<bool>,
    pub value: Option<serde_json::Value>,
    pub weight: Option<f32>,
    pub route: Option<String>,
    pub json_key: Option<String>,
    pub error: Option<String>,
    pub source: Option<TextPosition>,
    pub openai_raw: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RunStep {
    pub seq_no: u32,
    pub step_id: String,
    pub prompt_id: i32,
    pub prompt_type: PromptType,
    pub decision_key: Option<String>,
    pub route: Option<String>,
    pub merge_to: Option<String>,
    pub result: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PipelineRunResult {
    pub pdf_id: i32,
    pub pipeline_id: uuid::Uuid,
    pub overall_score: Option<f32>,
    pub extracted: std::collections::HashMap<String, serde_json::Value>,
    pub extraction: Vec<PromptResult>,
    pub scoring: Vec<ScoringResult>,
    pub decision: Vec<PromptResult>,
    pub log: Vec<RunStep>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStep {
    pub id: String,
    #[serde(rename = "type")]
    pub step_type: PromptType,
    pub prompt_id: i32,
    pub route: Option<String>,
    /// generic branching: route-value → next-step-id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub targets: Option<std::collections::HashMap<String, String>>,
    /// first step after the branch rejoins (optional)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yes_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_key: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de_merge_key"
    )]
    pub merge_key: Option<bool>,
    /* legacy fields kept for migration only */
    #[serde(default, skip)]
    pub true_target: Option<String>,
    #[serde(default, skip)]
    pub false_target: Option<String>,
    #[serde(default, skip)]
    pub enum_targets: Option<std::collections::HashMap<String, String>>,
    pub active: Option<bool>,
}

#[derive(Serialize, Deserialize)]
pub struct PipelineConfig {
    pub name: String,
    pub steps: Vec<PipelineStep>,
}

fn de_merge_key<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    let v: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    Ok(match v {
        Some(serde_json::Value::Bool(b)) => Some(b),
        Some(serde_json::Value::String(_)) => Some(true),
        Some(serde_json::Value::Number(n)) => n.as_u64().map(|x| x > 0),
        Some(_) => None,
        None => None,
    })
}
