//! Thin wrapper around the upload API that submits PDF documents captured from
//! SharePoint and records the resulting metadata for audit purposes.

use std::path::Path;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

/// Client responsible for talking to the upload microservice.
#[derive(Clone)]
pub struct UploadAdapter {
    client: Client,
    url: String,
    token: Option<String>,
}

/// Response returned by the upload service after submitting a document.
#[derive(Debug, Clone, Serialize)]
pub struct UploadResult {
    pub status: String,
    pub response: Value,
    pub uploaded_at: DateTime<Utc>,
}

impl UploadAdapter {
    /// Construct the HTTP client with the configured timeout and optional auth.
    pub fn new(url: String, token: Option<String>, timeout: std::time::Duration) -> Result<Self> {
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .context("building upload client")?;
        Ok(Self { client, url, token })
    }

    /// Upload the provided file path and attach context required by the API.
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
