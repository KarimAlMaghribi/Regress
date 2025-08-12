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
    pub prompt_id: i64,
    pub prompt_type: PromptType,
    pub decision_key: Option<String>,
    pub route: Option<String>,
    pub merge_key: bool,
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
    pub prompt_id: i64,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub yes_key: Option<String>,
    #[serde(default)]
    pub no_key: Option<String>,
    #[serde(default, deserialize_with = "de_merge_key")]
    pub merge_key: bool,
    #[serde(default = "default_true")]
    pub active: bool,
}

#[derive(Serialize, Deserialize)]
pub struct PipelineConfig {
    pub name: String,
    pub steps: Vec<PipelineStep>,
}

fn default_true() -> bool {
    true
}

fn de_merge_key<'de, D>(d: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    use serde_json::Value;
    let v: Option<Value> = Option::deserialize(d)?;
    Ok(match v {
        Some(Value::Bool(b)) => b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0) > 0,
        _ => false,
    })
}
