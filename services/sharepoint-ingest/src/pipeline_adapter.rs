//! Adapter to trigger pipeline runs for completed SharePoint uploads.

use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;
use uuid::Uuid;

#[derive(Clone)]
pub struct PipelineAdapter {
    client: Client,
    base_url: String,
    token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PipelineTriggerResponse {
    pub status: String,
    pub pdf_id: i32,
    pub pipeline_id: Uuid,
}

impl PipelineAdapter {
    pub fn new(base_url: String, token: Option<String>, timeout: Duration) -> Result<Self> {
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .context("building pipeline client")?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
        })
    }

    pub async fn start_run(
        &self,
        pipeline_id: Uuid,
        upload_id: i32,
    ) -> Result<PipelineTriggerResponse> {
        let url = format!("{}/pipelines/{pipeline_id}/run", self.base_url);
        let mut req = self
            .client
            .post(url)
            .json(&serde_json::json!({ "file_id": upload_id }));
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await?.error_for_status()?;
        let body = resp.json::<PipelineTriggerResponse>().await?;
        Ok(body)
    }
}
