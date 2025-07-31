use serde::{Deserialize, Serialize};
use strum_macros::{EnumString, Display};

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
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PromptResult {
    pub prompt_id: i32,
    pub prompt_type: PromptType,
    pub prompt_text: String,
    pub score: Option<f32>,
    pub boolean: Option<bool>,
    pub route: Option<String>,
    pub source: Option<TextPosition>,
    pub openai_raw: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PipelineRunResult {
    pub pdf_id: i32,
    pub pipeline_id: uuid::Uuid,
    pub summary: String,
    pub extraction: Vec<PromptResult>,
    pub scoring: Vec<PromptResult>,
    pub decision: Vec<PromptResult>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStep {
    pub id: String,
    #[serde(rename = "type")]
    pub step_type: PromptType,
    pub prompt_id: i32,
    pub label: Option<String>,
    pub alias: Option<String>,
    pub inputs: Option<Vec<String>>,
    pub formula_override: Option<String>,
    pub input_source: Option<String>,
    pub route: Option<String>,
    pub condition: Option<String>,
    pub true_target: Option<String>,
    pub false_target: Option<String>,
    pub enum_targets: Option<std::collections::HashMap<String, String>>,
    pub active: Option<bool>,
}

#[derive(Serialize, Deserialize)]
pub struct PipelineConfig {
    pub name: String,
    pub steps: Vec<PipelineStep>,
}
