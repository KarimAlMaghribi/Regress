use serde::{Deserialize, Serialize};

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
    pub id: i32,
    pub prompt: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextExtracted {
    pub id: i32,
    pub text: String,
    pub prompt: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClassificationResult {
    pub id: i32,
    pub regress: bool,
    pub prompt: String,
    /// Raw answer returned by the OpenAI API
    pub answer: String,
    pub score: f64,
    pub result_label: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PromptResult {
    pub prompt_id: String,
    pub prompt_type: String,
    pub status: String,
    pub result: Option<bool>,
    pub score: Option<f64>,
    pub answer: Option<String>,
    pub source: Option<String>,
    pub attempt: Option<u8>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}
