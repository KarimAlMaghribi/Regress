use actix_web::{http::header, Error};
use awc::Client;
use openai::chat::{ChatCompletion, ChatCompletionMessage};
use serde::Serialize;
use tracing::error;

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatCompletionMessage],
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

    let mut res = client
        .post("https://api.openai.com/v1/chat/completions")
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
