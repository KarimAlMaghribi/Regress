//! Shared data transfer objects used across services and the frontend.
//!
//! These types codify the JSON payloads exchanged between components so that
//! each service and consumer can rely on a consistent schema.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use strum_macros::{Display, EnumString};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, EnumString, Display, Serialize, Deserialize)]
#[strum(serialize_all = "PascalCase")]
/// Describes the purpose of a prompt executed within a pipeline.
pub enum PromptType {
    ExtractionPrompt,
    ScoringPrompt,
    DecisionPrompt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// Describes a tri-state label for scoring prompts.
pub enum TernaryLabel {
    Yes,
    No,
    Unsure,
}

#[derive(Debug, Serialize, Deserialize)]
/// Request payload used when uploading a PDF via the upload API.
pub struct UploadRequest {
    pub file_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
/// Response returned after a successful upload request.
pub struct UploadResponse {
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize)]
/// Event emitted once a PDF has been stored.
pub struct PdfUploaded {
    pub pdf_id: i32,
    pub pipeline_id: uuid::Uuid,
}

#[derive(Debug, Serialize, Deserialize)]
/// Event emitted after text extraction completed for a PDF.
pub struct TextExtracted {
    pub pdf_id: i32,
    pub pipeline_id: uuid::Uuid,
    pub text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
/// Location of a highlighted text passage within a PDF.
pub struct TextPosition {
    pub page: u32,
    pub bbox: [f32; 4],
    pub quote: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
/// Single scoring result produced either by an attempt or via consolidation.
pub struct ScoringResult {
    pub prompt_id: i32,

    /// Backwards compatible boolean (true == yes). Often `false` for
    /// `TernaryLabel::Unsure` values.
    pub result: bool,

    pub source: TextPosition,
    pub explanation: String,

    #[serde(default)]
    /// Vote cast by an individual scoring attempt.
    pub vote: Option<TernaryLabel>,

    #[serde(default)]
    /// Evidence strength of the vote on a scale from 0.0 to 1.0.
    pub strength: Option<f32>,

    #[serde(default)]
    /// Confidence of the model in the scoring decision.
    pub confidence: Option<f32>,

    #[serde(default)]
    /// Normalised score mapped to the -1.0..=1.0 range.
    pub score: Option<f32>,

    #[serde(default)]
    /// Final tri-state label used in consolidated results.
    pub label: Option<TernaryLabel>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
/// Result produced by a prompt execution.
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
/// Execution log entry capturing intermediate pipeline state.
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
/// Comprehensive result object returned by the pipeline runner.
pub struct PipelineRunResult {
    pub run_id: Option<Uuid>,

    pub pdf_id: i32,
    pub pipeline_id: uuid::Uuid,
    pub overall_score: Option<f32>,

    pub extracted: std::collections::HashMap<String, serde_json::Value>,

    /// Consolidated scoring results (one entry per rule).
    pub scoring: Vec<ScoringResult>,

    pub extraction: Vec<PromptResult>,
    pub decision: Vec<PromptResult>,
    pub log: Vec<RunStep>,

    #[serde(default)]
    /// Final numeric scores per rule mapped to the -1.0..=1.0 range.
    pub final_scores: Option<std::collections::HashMap<String, f32>>,

    #[serde(default)]
    /// Tri-state labels associated with the final scores.
    pub final_score_labels: Option<std::collections::HashMap<String, TernaryLabel>>,

    #[serde(default)]
    /// Optional metadata, often populated by the history service.
    pub status: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Configuration for a single pipeline step.
pub struct PipelineStep {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub step_type: PromptType,
    #[serde(rename = "promptId")]
    pub prompt_id: i32,

    #[serde(default)]
    /// Optional route identifier used for branching.
    pub route: Option<String>,
    #[serde(default, rename = "yesKey")]
    /// Optional key emitted when the step evaluates to "yes".
    pub yes_key: Option<String>,
    #[serde(default, rename = "noKey")]
    /// Optional key emitted when the step evaluates to "no".
    pub no_key: Option<String>,

    #[serde(default)]
    /// Whether the step is active in the current pipeline configuration.
    pub active: bool,

    /// Additional configuration passed to the step implementation.
    pub config: Option<Value>,
}

#[derive(Serialize, Deserialize)]
/// High level pipeline configuration comprising multiple steps.
pub struct PipelineConfig {
    pub name: String,
    pub steps: Vec<PipelineStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Represents a tenant that owns uploads and pipeline runs.
pub struct Tenant {
    pub id: Uuid,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
/// Request payload for creating a tenant.
pub struct CreateTenantRequest {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
/// Request payload for creating an upload entry.
pub struct CreateUploadRequest {
    pub pipeline_id: Option<Uuid>,
    pub tenant_id: Uuid,
}

#[derive(Debug, Clone, Serialize)]
/// Upload response returned by the upload API.
pub struct UploadDto {
    pub id: i64,
    pub pdf_id: Option<i32>,
    pub pipeline_id: Option<Uuid>,
    pub status: String,
    pub tenant_id: Uuid,
}

