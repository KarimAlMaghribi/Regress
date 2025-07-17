use actix_web::http::header;
use anyhow::Result;
use awc::Client;
use openai::chat::{ChatCompletionMessage, ChatCompletionMessageRole};
use regex::Regex;
use tracing::debug;

use crate::{openai_client::call_openai_chat, pipeline_graph::PromptNode};

/// Execute the given prompt against OpenAI using the supplied text as user input.
///
/// Returns `(result, score, answer, source)` where `source` contains the
/// relevant excerpt or reasoning extracted from the LLM response.
pub async fn run_prompt(prompt: &PromptNode, text: &str) -> Result<(bool, f64, String, String)> {
    // Prepare HTTP client once for each call.
    let client = Client::builder()
        .add_default_header((header::ACCEPT_ENCODING, "br, gzip, deflate"))
        .finish();

    // Construct basic chat messages: the prompt text as system message and the
    // user supplied text as user message.
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
    debug!(prompt_id = %prompt.id, "received openai answer: {}", answer);

    // Very basic parsing: consider it a positive result if common affirmative
    // words occur in the response.
    let lower = answer.to_lowercase();
    let result = lower.contains("true") || lower.contains("yes") || lower.contains("ja");

    // Try to extract the first floating point number in the range 0..1 as score.
    let score_re = Regex::new(
        r"([01](?:\\.\\d+)?|
                                0?\\.\\d+)",
    )
    .unwrap();
    let score = score_re
        .captures(&answer)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<f64>().ok())
        .unwrap_or(0.0);

    // Provide the full answer as source for transparency.
    Ok((result, score, answer.clone(), answer))
}
