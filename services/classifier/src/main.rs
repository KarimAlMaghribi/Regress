use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use shared::error::Result;
use tracing::info;

#[async_trait]
trait LanguageModel {
    async fn classify(&self, text: &str) -> Result<Classification>;
}

#[derive(Debug, Serialize, Deserialize)]
struct Classification {
    result: String,
    confidence: f32,
}

struct OpenAI {
    client: Client,
    api_key: String,
}

#[async_trait]
impl LanguageModel for OpenAI {
    async fn classify(&self, text: &str) -> Result<Classification> {
        let resp = self
            .client
            .post("https://api.openai.com/v1/classify")
            .bearer_auth(&self.api_key)
            .json(&serde_json::json!({"text": text}))
            .send()
            .await
            .map_err(|e| shared::error::AppError::Io(e.to_string()))?;
        let data: Classification = resp.json().await.map_err(|e| shared::error::AppError::Io(e.to_string()))?;
        Ok(data)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let model = OpenAI { client: Client::new(), api_key: "KEY".into() };
    let c = model.classify("hello world").await?;
    info!(?c, "classification");
    Ok(())
}
