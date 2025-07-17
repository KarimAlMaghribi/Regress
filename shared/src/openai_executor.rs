use crate::{openai_client::call_openai_chat, pipeline_graph::PromptNode};
use actix_web::http::header;
use awc::Client;
use openai::chat::{ChatCompletionMessage, ChatCompletionMessageRole};
use serde_json::Value;
use anyhow::Result;

/// Execute a single prompt against the given text using OpenAI.
///
/// Returns `(result, score, answer, source)` where `source` is the
/// relevant text snippet or reasoning extracted from the model output.
pub async fn run_prompt(prompt: &PromptNode, text: &str) -> Result<(bool, f64, String, String)> {
    // use mock result if no API key is configured
    if std::env::var("OPENAI_API_KEY").is_err() {
        return Ok((true, 1.0, prompt.text.clone(), prompt.text.clone()));
    }

    let client = Client::builder()
        .add_default_header((header::ACCEPT_ENCODING, "br, gzip, deflate"))
        .finish();

    let messages = vec![
        ChatCompletionMessage {
            role: ChatCompletionMessageRole::System,
            content: Some(prompt.text.clone()),
            ..Default::default()
        },
        ChatCompletionMessage {
            role: ChatCompletionMessageRole::User,
            content: Some(text.to_string()),
            ..Default::default()
        },
    ];

    let answer = call_openai_chat(&client, "gpt-4-turbo", messages)
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;

    // try to parse JSON fields from the answer
    if let Ok(val) = serde_json::from_str::<Value>(&answer) {
        let result = val.get("result").and_then(|v| v.as_bool()).unwrap_or(false);
        let score = val.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let source = val
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        return Ok((result, score, answer, source));
    }

    Ok((false, 0.0, answer.clone(), answer))
}

