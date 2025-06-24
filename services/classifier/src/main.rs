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
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(&self.api_key)
            .json(&serde_json::json!({
                "model": "gpt-3.5-turbo",
                "messages": [{"role": "user", "content": text}],
                "max_tokens": 1,
                "temperature": 0.0
            }))
            .send()
            .await
            .map_err(|e| shared::error::AppError::Io(e.to_string()))?;
        let value: serde_json::Value = resp.json().await.map_err(|e| shared::error::AppError::Io(e.to_string()))?;
        let result = value["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
        Ok(Classification { result, confidence: 1.0 })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let api_key = std::env::var("OPENAI_API_KEY").unwrap_or_else(|_| "KEY".into());
    let model = OpenAI { client: Client::new(), api_key };
    let c = model.classify("hello world").await?;
    info!(?c, "classification");
    Ok(())
}
