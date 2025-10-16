//! Adapter that re-uploads processed files back into the ingestion pipeline.

use std::path::Path;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone)]
pub struct UploadAdapter {
    client: Client,
    url: String,
    token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadResult {
    pub status: String,
    pub response: Value,
    pub uploaded_at: DateTime<Utc>,
}

impl UploadAdapter {
    /// Creates a new adapter that posts processed PDFs back to the upload API.
    pub fn new(url: String, token: Option<String>, timeout: std::time::Duration) -> Result<Self> {
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .context("building upload client")?;
        Ok(Self { client, url, token })
    }

    /// Uploads the file to the configured endpoint and returns the API response
    /// metadata.
    pub async fn upload(&self, file_path: &Path, file_name: &str) -> Result<UploadResult> {
        let mut form = Form::new().text("defer_pipeline", "true".to_string());
        let part = Part::file(file_path)
            .await?
            .file_name(file_name.to_string())
            .mime_str("application/pdf")?;
        form = form.part("file", part);
        let mut req = self.client.post(&self.url).multipart(form);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await?.error_for_status()?;
        let body = resp.json::<Value>().await.unwrap_or(Value::Null);
        Ok(UploadResult {
            status: "uploaded".to_string(),
            response: body,
            uploaded_at: Utc::now(),
        })
    }
}
