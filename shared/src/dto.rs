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
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextExtracted {
    pub id: i32,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClassificationResult {
    pub id: i32,
    pub regress: bool,
}
