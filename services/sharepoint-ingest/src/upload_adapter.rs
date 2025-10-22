//! Adapter that re-uploads processed files back into the ingestion pipeline.

use std::path::Path;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

#[derive(Clone)]
pub struct UploadAdapter {
    client: Client,
    base_url: String,
    token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadResult {
    pub status: String,
    pub response: Value,
    pub uploaded_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_id: Option<i32>,
}

impl UploadAdapter {
    /// Creates a new adapter that posts processed PDFs back to the upload API.
    pub fn new(
        base_url: String,
        token: Option<String>,
        timeout: std::time::Duration,
    ) -> Result<Self> {
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .context("building upload client")?;
        Ok(Self {
            client,
            base_url,
            token,
        })
    }

    /// Uploads the file to the configured endpoint and returns the API response
    /// metadata.
    pub async fn upload(
        &self,
        file_path: &Path,
        file_name: &str,
        override_url: Option<&str>,
        tenant_id: Option<Uuid>,
        pipeline_id: Option<Uuid>,
    ) -> Result<UploadResult> {
        let tenant_value = tenant_id.map(|id| id.to_string());
        let pipeline_value = pipeline_id.map(|id| id.to_string());
        let mut form = Form::new().text("defer_pipeline", "true".to_string());
        if let Some(tenant) = &tenant_value {
            form = form.text("tenant_id", tenant.clone());
        }
        if let Some(pipeline) = &pipeline_value {
            form = form.text("pipeline_id", pipeline.clone());
        }
        let part = Part::file(file_path)
            .await?
            .file_name(file_name.to_string())
            .mime_str("application/pdf")?;
        form = form.part("file", part);
        let mut target_url = match override_url {
            Some(url) => url.trim().to_string(),
            None => self.base_url.clone(),
        };
        if let Some(tenant) = &tenant_value {
            if !target_url.contains("tenant_id=") {
                let separator = if target_url.contains('?') { '&' } else { '?' };
                target_url.push(separator);
                target_url.push_str("tenant_id=");
                target_url.push_str(tenant);
            }
        }
        if let Some(pipeline) = &pipeline_value {
            if !target_url.contains("pipeline_id=") {
                let separator = if target_url.contains('?') { '&' } else { '?' };
                target_url.push(separator);
                target_url.push_str("pipeline_id=");
                target_url.push_str(pipeline);
            }
        }
        let mut req = self.client.post(&target_url).multipart(form);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        if let Some(tenant) = &tenant_value {
            req = req.header("X-Tenant-ID", tenant.as_str());
        }
        let resp = req.send().await?.error_for_status()?;
        let body = resp.json::<Value>().await.unwrap_or(Value::Null);

        let parse_numeric_id = |value: Option<&Value>| -> Option<i32> {
            let Some(raw) = value else { return None };
            match raw {
                Value::Number(num) => num.as_i64().and_then(|n| {
                    if (i32::MIN as i64..=i32::MAX as i64).contains(&n) {
                        Some(n as i32)
                    } else {
                        None
                    }
                }),
                Value::String(text) => text.trim().parse::<i64>().ok().and_then(|n| {
                    if (i32::MIN as i64..=i32::MAX as i64).contains(&n) {
                        Some(n as i32)
                    } else {
                        None
                    }
                }),
                _ => None,
            }
        };

        let upload_id = parse_numeric_id(body.get("upload_id"))
            .or_else(|| parse_numeric_id(body.get("uploadId")));
        let pdf_id = parse_numeric_id(body.get("pdf_id"))
            .or_else(|| parse_numeric_id(body.get("pdfId")))
            .or_else(|| parse_numeric_id(body.get("id")));

        Ok(UploadResult {
            status: "uploaded".to_string(),
            response: body,
            uploaded_at: Utc::now(),
            upload_id,
            pdf_id,
        })
    }
}
