//! Defines the shared data transfer objects exchanged between services and the
//! frontend so serialization stays consistent across the stack.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use strum_macros::{Display, EnumString};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, EnumString, Display, Serialize, Deserialize)]
#[strum(serialize_all = "PascalCase")]
pub enum PromptType {
    ExtractionPrompt,
    ScoringPrompt,
    DecisionPrompt,
}

/// Tri-state label used by scoring prompts to differentiate between positive,
/// negative, and inconclusive answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TernaryLabel {
    Yes,
    No,
    Unsure,
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

/// Representation of a single scoring result, either from a single attempt or
/// after consolidation, while remaining backward compatible with the legacy
/// boolean result flag.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ScoringResult {
    pub prompt_id: i32,

    /// Backwards-compatible boolean (true equals "yes"); defaults to `false`
    /// when the model could not decide.
    pub result: bool,

    pub source: TextPosition,
    pub explanation: String,

    /// Optional modern scoring attributes reported by the LLM.
    #[serde(default)]
    pub vote: Option<TernaryLabel>,

    #[serde(default)]
    pub strength: Option<f32>,

    #[serde(default)]
    pub confidence: Option<f32>,

    #[serde(default)]
    pub score: Option<f32>,

    #[serde(default)]
    pub label: Option<TernaryLabel>,
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
    pub result: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PipelineRunResult {
    pub run_id: Option<Uuid>,

    pub pdf_id: i32,
    pub pipeline_id: uuid::Uuid,
    pub overall_score: Option<f32>,

    pub extracted: std::collections::HashMap<String, serde_json::Value>,

    /// Consolidated scoring results, one entry per rule for convenience.
    pub scoring: Vec<ScoringResult>,

    pub extraction: Vec<PromptResult>,
    pub decision: Vec<PromptResult>,
    pub log: Vec<RunStep>,

    /// Optional final numeric scores per rule (−1..+1) with matching labels.
    #[serde(default)]
    pub final_scores: Option<std::collections::HashMap<String, f32>>,

    #[serde(default)]
    pub final_score_labels: Option<std::collections::HashMap<String, TernaryLabel>>,

    /// Optional metadata that the history service may append when available.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineStep {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub step_type: PromptType,
    #[serde(rename = "promptId")]
    pub prompt_id: i32,

    /// Optional routing information for decision prompts.
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default, rename = "yesKey")]
    pub yes_key: Option<String>,
    #[serde(default, rename = "noKey")]
    pub no_key: Option<String>,

    #[serde(default)]
    pub active: bool,

    pub config: Option<Value>,
}

#[derive(Serialize, Deserialize)]
pub struct PipelineConfig {
    pub name: String,
    pub steps: Vec<PipelineStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tenant {
    pub id: Uuid,
    pub name: String,
}

/// Request payload for creating a tenant record.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTenantRequest {
    pub name: String,
}

/// Optional upload request payload used when triggering uploads programmatically.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateUploadRequest {
    pub pipeline_id: Option<Uuid>,
    pub tenant_id: Uuid,
}

/// Response structure returned after creating or updating an upload record.
#[derive(Debug, Clone, Serialize)]
pub struct UploadDto {
    pub id: i64,
    pub pdf_id: Option<i32>,
    pub pipeline_id: Option<Uuid>,
    pub status: String,
    pub tenant_id: Uuid,
}

#[derive(Deserialize)]
struct ListQuery {
    tenant: Option<String>,
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

fn default_true() -> bool {
    true
}
