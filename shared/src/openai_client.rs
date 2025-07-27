use actix_web::{http::header, Error};
use awc::Client;
use openai::chat::{ChatCompletion, ChatCompletionMessage, ChatCompletionMessageRole};
use serde::Serialize;
use tracing::error;
use std::time::Duration;

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatCompletionMessage],
}

fn msg(role: ChatCompletionMessageRole, txt: &str) -> ChatCompletionMessage {
    ChatCompletionMessage {
        role,
        content: Some(txt.to_string()),
        ..Default::default()
    }
}

/// Send chat messages to OpenAI and return the assistant's answer.
///
/// Logs status, headers and raw body on failure.
///
/// # Example
/// ```rust,no_run
/// use awc::Client;
/// use openai::chat::{ChatCompletionMessage, ChatCompletionMessageRole};
/// use shared::openai_client::call_openai_chat;
/// use actix_web::http::header;
///
/// #[actix_web::main]
/// async fn main() {
///     let client = Client::builder()
///         .add_default_header((header::ACCEPT_ENCODING, "br, gzip, deflate"))
///         .finish();
///
///     let messages = vec![ChatCompletionMessage {
///         role: ChatCompletionMessageRole::User,
///         content: Some("Hallo".to_string()),
///         ..Default::default()
///     }];
///
///     match call_openai_chat(&client, "gpt-4-turbo", messages).await {
///         Ok(answer) => println!("Antwort: {}", answer),
///         Err(e) => eprintln!("Fehler bei OpenAI: {}", e),
///     }
/// }
/// ```
pub async fn call_openai_chat(
    client: &Client,
    model: &str,
    messages: Vec<ChatCompletionMessage>,
) -> Result<String, Error> {
    let key = std::env::var("OPENAI_API_KEY")
        .map_err(|e| actix_web::error::ErrorInternalServerError(e.to_string()))?;

    let req = ChatRequest { model, messages: &messages };

    let base = std::env::var("OPENAI_API_BASE").unwrap_or_else(|_| "https://api.openai.com".into());
    let mut res = client
        .post(format!("{}/v1/chat/completions", base))
        .insert_header((header::AUTHORIZATION, format!("Bearer {}", key)))
        .send_json(&req)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    if res.status().is_success() {
        let chat: ChatCompletion = res
            .json()
            .await
            .map_err(actix_web::error::ErrorInternalServerError)?;
        let answer = chat
            .choices
            .get(0)
            .and_then(|c| c.message.content.clone())
            .unwrap_or_default();
        Ok(answer)
    } else {
        let status = res.status();
        let headers = format!("{:?}", res.headers());
        let body_bytes = res.body().await.unwrap_or_default();
        error!(
            status = %status,
            headers = %headers,
            body = %String::from_utf8_lossy(&body_bytes),
            "openai error",
        );
        Err(actix_web::error::ErrorInternalServerError("openai request failed"))
    }
}

#[derive(thiserror::Error, Debug)]
pub enum PromptError {
    #[error("extraction failed")]
    ExtractionFailed,
    #[error("scoring failed")]
    ScoringFailed,
    #[error("decision failed")]
    DecisionFailed,
    #[error("parse error")]
    Parse,
}

pub async fn extract(prompt_id: i32, input: &str) -> Result<serde_json::Value, PromptError> {
    let client = Client::default();
    let prompt = fetch_prompt(prompt_id).await?;
    let system = "You are an extraction engine. Extract exactly one JSON value";
    let user = format!("{}\n{}", prompt, input);
    for i in 0..=3 {
        let msgs = vec![msg(ChatCompletionMessageRole::System, system), msg(ChatCompletionMessageRole::User, &user)];
        if let Ok(ans) = call_openai_chat(&client, "gpt-4o", msgs).await {
            if let Ok(fixed) = jsonrepair::repair(&ans) {
                if let Ok(v) = serde_json::from_str(&fixed) { return Ok(v); }
            }
        }
        let wait = 100 * (1u64 << i).min(8);
        tokio::time::sleep(Duration::from_millis(wait)).await;
    }
    Err(PromptError::Parse)
}

pub async fn score(prompt_id: i32, args: &[(&str, serde_json::Value)]) -> Result<f64, PromptError> {
    let client = Client::default();
    let prompt = fetch_prompt(prompt_id).await?;
    let system = "You are a scoring engine. Return only a floating point number between 0 and 1";
    let user = format!("{}\n{}", prompt, serde_json::to_string(args).unwrap_or_default());
    for i in 0..=3 {
        let msgs = vec![msg(ChatCompletionMessageRole::System, system), msg(ChatCompletionMessageRole::User, &user)];
        if let Ok(ans) = call_openai_chat(&client, "gpt-4o", msgs).await {
            if let Ok(fixed) = jsonrepair::repair(&ans) {
                if let Ok(v) = serde_json::from_str::<f64>(&fixed) { return Ok(v); }
            }
        }
        let wait = 100 * (1u64 << i).min(8);
        tokio::time::sleep(Duration::from_millis(wait)).await;
    }
    Err(PromptError::Parse)
}

pub async fn decide(prompt_id: i32, state: &std::collections::HashMap<String, serde_json::Value>) -> Result<serde_json::Value, PromptError> {
    let client = Client::default();
    let prompt = fetch_prompt(prompt_id).await?;
    let system = "Return only the word TRUE or FALSE";
    let user = format!("{}\n{}", prompt, serde_json::to_string(state).unwrap_or_default());
    for i in 0..=3 {
        let msgs = vec![msg(ChatCompletionMessageRole::System, system), msg(ChatCompletionMessageRole::User, &user)];
        if let Ok(ans) = call_openai_chat(&client, "gpt-4o", msgs).await {
            if let Ok(fixed) = jsonrepair::repair(&ans) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&fixed) { return Ok(v); }
                if let Ok(b) = serde_json::from_str::<bool>(&fixed) { return Ok(serde_json::json!(b)); }
            }
        }
        let wait = 100 * (1u64 << i).min(8);
        tokio::time::sleep(Duration::from_millis(wait)).await;
    }
    Err(PromptError::Parse)
}

pub async fn dummy(_name: &str) -> Result<serde_json::Value, PromptError> { Ok(serde_json::json!(null)) }

async fn fetch_prompt(id: i32) -> Result<String, PromptError> {
    let client = Client::default();
    let url = format!("http://localhost:8082/prompts/{}", id);
    for i in 0..=3 {
        match client.get(url.clone()).send().await {
            Ok(mut resp) if resp.status().is_success() => {
                if let Ok(text) = resp.body().await {
                    return Ok(String::from_utf8_lossy(&text).to_string());
                }
            }
            _ => {
                let wait = 100 * (1u64 << i).min(8);
                tokio::time::sleep(Duration::from_millis(wait)).await;
            }
        }
    }
    Err(PromptError::Parse)
}
