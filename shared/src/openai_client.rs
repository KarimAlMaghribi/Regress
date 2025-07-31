use actix_web::http::header;
use awc::Client;
use openai::chat::{ChatCompletion, ChatCompletionMessage, ChatCompletionMessageRole};
use serde::Serialize;
use serde::de::Error as DeError;
use std::time::Duration;
use tokio::time;
use tracing::{debug, error, warn};

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
) -> Result<String, PromptError> {
    let key = std::env::var("OPENAI_API_KEY")
        .map_err(|e| PromptError::Network(e.to_string()))?;

    let req = ChatRequest {
        model,
        messages: &messages,
    };

    let base = std::env::var("OPENAI_API_BASE").unwrap_or_else(|_| "https://api.openai.com".into());
    let url = format!("{}/v1/chat/completions", base);
    debug!("\u{2192} OpenAI request: model = {}", req.model);
    let mut res = client
        .post(url)
        .insert_header((header::AUTHORIZATION, format!("Bearer {}", key)))
        .send_json(&req)
        .await
        .map_err(|e| {
            error!("network error to OpenAI: {e}");
            PromptError::Network(e.to_string())
        })?;

    debug!(status = %res.status(), "\u{2190} headers = {:?}", res.headers());
    let bytes = res
        .body()
        .await
        .map_err(|e| PromptError::Network(e.to_string()))?;
    debug!(
        "\u{2190} body = {}",
        String::from_utf8_lossy(&bytes[..bytes.len().min(1024)])
    );

    if !res.status().is_success() {
        return Err(PromptError::Http(res.status().as_u16()));
    }

    let chat: ChatCompletion = serde_json::from_slice(&bytes).map_err(PromptError::Parse)?;
    let answer = chat
        .choices
        .get(0)
        .and_then(|c| c.message.content.clone())
        .unwrap_or_default();
    Ok(answer)
}

#[derive(thiserror::Error, Debug)]
pub enum PromptError {
    #[error("extraction failed")]
    ExtractionFailed,
    #[error("scoring failed")]
    ScoringFailed,
    #[error("decision failed")]
    DecisionFailed,
    #[error("network error: {0}")]
    Network(String),
    #[error("parse error: {0}")]
    Parse(serde_json::Error),
    #[error("http error: {0}")]
    Http(u16),
}

#[derive(Debug, Clone)]
pub struct OpenAiAnswer {
    pub score: Option<f32>,
    pub boolean: Option<bool>,
    pub route: Option<String>,
    pub raw: String,
}

pub async fn extract(prompt_id: i32, input: &str) -> Result<OpenAiAnswer, PromptError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .finish();
    let prompt = fetch_prompt(prompt_id).await?;
    let system = "You are an extraction engine. Extract exactly one JSON value";
    let user = format!("{}\n{}", prompt, input);
    for i in 0..=3 {
        let msgs = vec![
            msg(ChatCompletionMessageRole::System, system),
            msg(ChatCompletionMessageRole::User, &user),
        ];
        if let Ok(ans) = call_openai_chat(&client, "gpt-4o", msgs).await {
            if let Ok(v) = jsonrepair::repair_json_string(&ans) {
                let score = v
                    .get("confidence")
                    .and_then(|c| c.as_f64())
                    .or_else(|| v.get("score").and_then(|c| c.as_f64()))
                    .map(|f| f as f32);
                return Ok(OpenAiAnswer {
                    score,
                    boolean: None,
                    route: None,
                    raw: ans,
                });
            }
        }
        let wait = 100 * (1u64 << i).min(8);
        time::sleep(Duration::from_millis(wait)).await;
    }
    Err(PromptError::Parse(DeError::custom("invalid JSON")))
}

pub async fn score(prompt_id: i32, args: &[(&str, serde_json::Value)]) -> Result<OpenAiAnswer, PromptError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .finish();
    let prompt = fetch_prompt(prompt_id).await?;
    let system = "You are a scoring engine. Return only a floating point number between 0 and 1";
    let user = format!(
        "{}\n{}",
        prompt,
        serde_json::to_string(args).unwrap_or_default()
    );
    for i in 0..=3 {
        let msgs = vec![
            msg(ChatCompletionMessageRole::System, system),
            msg(ChatCompletionMessageRole::User, &user),
        ];
        if let Ok(ans) = call_openai_chat(&client, "gpt-4o", msgs).await {
            if let Ok(val) = jsonrepair::repair_json_string(&ans) {
                let score = if let Some(v) = val.as_f64() {
                    Some(v as f32)
                } else if let Some(s) = val.as_str() {
                    s.parse::<f32>().ok()
                } else {
                    val.get("score").and_then(|s| s.as_f64()).map(|v| v as f32)
                };
                if score.is_some() {
                    return Ok(OpenAiAnswer {
                        score,
                        boolean: None,
                        route: None,
                        raw: ans,
                    });
                }
            }
        }
        let wait = 100 * (1u64 << i).min(8);
        time::sleep(Duration::from_millis(wait)).await;
    }
    Err(PromptError::Parse(DeError::custom("invalid JSON")))
}

pub async fn decide(
    prompt_id: i32,
    state: &std::collections::HashMap<String, serde_json::Value>,
) -> Result<OpenAiAnswer, PromptError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .finish();
    let prompt = fetch_prompt(prompt_id).await?;
    let system = "Return only the word TRUE or FALSE";
    let user = format!(
        "{}\n{}",
        prompt,
        serde_json::to_string(state).unwrap_or_default()
    );
    for i in 0..=3 {
        let msgs = vec![
            msg(ChatCompletionMessageRole::System, system),
            msg(ChatCompletionMessageRole::User, &user),
        ];
        if let Ok(ans) = call_openai_chat(&client, "gpt-4o", msgs).await {
            if let Ok(val) = jsonrepair::repair_json_string(&ans) {
                let boolean = if val.is_boolean() {
                    val.as_bool()
                } else if let Some(s) = val.as_str() {
                    s.parse::<bool>().ok()
                } else {
                    val.get("fraud")
                        .or_else(|| val.get("bool"))
                        .and_then(|b| b.as_bool())
                };
                let route = val
                    .get("route")
                    .and_then(|r| r.as_str())
                    .map(|s| s.to_string());
                if boolean.is_some() || route.is_some() {
                    return Ok(OpenAiAnswer {
                        score: None,
                        boolean,
                        route,
                        raw: ans,
                    });
                }
            }
        }
        let wait = 100 * (1u64 << i).min(8);
        time::sleep(Duration::from_millis(wait)).await;
    }
    Err(PromptError::Parse(DeError::custom("invalid JSON")))
}

pub async fn dummy(_name: &str) -> Result<serde_json::Value, PromptError> {
    Ok(serde_json::json!(null))
}

async fn fetch_prompt(id: i32) -> Result<String, PromptError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .finish();
    let base =
        std::env::var("PROMPT_MANAGER_URL").unwrap_or_else(|_| "http://prompt-manager:8082".into());
    let url = format!("{}/prompts/{}", base, id);
    for i in 0..=3 {
        match client.get(url.clone()).send().await {
            Ok(mut resp) if resp.status().is_success() => {
                if let Ok(text) = resp.body().await {
                    debug!(id, %url, "prompt fetched ({} bytes)", text.len());
                    return Ok(String::from_utf8_lossy(&text).to_string());
                }
            }
            Ok(resp) => {
                warn!(
                    id,
                    %url,
                    status = %resp.status(),
                    retry = i,
                    "fetch_prompt HTTP error"
                );
            }
            Err(e) => {
                warn!(id, %url, retry = i, "fetch_prompt network error: {e}");
            }
        }
        let wait = 100 * (1u64 << i).min(8);
        time::sleep(Duration::from_millis(wait)).await;
    }
    Err(PromptError::Parse(DeError::custom("invalid JSON")))
}

pub async fn fetch_prompt_text(id: i32) -> Result<String, PromptError> {
    fetch_prompt(id).await
}
