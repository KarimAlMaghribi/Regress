use reqwest::Client;
use serial_test::serial;
use tokio::runtime::Builder;
use httpmock::prelude::*;
use openai::chat::{ChatCompletionMessage, ChatCompletionMessageRole};
use serde_json::json;
use shared::openai_client;

fn base_messages() -> Vec<ChatCompletionMessage> {
    vec![
        ChatCompletionMessage {
            role: ChatCompletionMessageRole::System,
            content: Some("System".to_string()),
            ..Default::default()
        },
        ChatCompletionMessage {
            role: ChatCompletionMessageRole::User,
            content: Some("Hallo".to_string()),
            ..Default::default()
        },
    ]
}

#[serial]
#[test]
fn responses_endpoint_parses_output_text() -> anyhow::Result<()> {
    let rt = Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(anyhow::Error::new)?;
    rt.block_on(async {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path("/v1/responses");
                then.status(200)
                .header("content-type", "application/json")
                .body(
                    r#"{"output":[{"content":[{"type":"output_text","text":"{\"ok\":true}"}]}]}"#,
                );
        })
        .await;

    let endpoint = format!(
        "{}/v1/responses?api-version=2025-04-01-preview",
        server.base_url()
    );
    std::env::set_var("OPENAI_API_KEY", "test-key");
    std::env::set_var("OPENAI_RESPONSES_ENDPOINT", &endpoint);
    std::env::remove_var("OPENAI_CHAT_COMPLETIONS_ENDPOINT");
    std::env::remove_var("OPENAI_API_BASE");

    openai_client::configure_openai_defaults("gpt-test", &endpoint);
    openai_client::prefer_responses_endpoint();

    let client = Client::new();
    let response =
        openai_client::call_openai_chat(&client, "gpt-test", base_messages(), None, None).await?;
    let parsed: serde_json::Value = serde_json::from_str(&response)?;
    assert_eq!(parsed, json!({"ok": true}));

    mock.assert_async().await;
        Ok(())
    })
}

#[serial]
#[test]
fn chat_endpoint_returns_json_content() -> anyhow::Result<()> {
    let rt = Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(anyhow::Error::new)?;
    rt.block_on(async {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path("/v1/chat/completions");
                then.status(200)
                .header("content-type", "application/json")
                .body(
                    r#"{"choices":[{"message":{"role":"assistant","content":"{\"score\":1}"}}]}"#,
                );
        })
        .await;

    let endpoint = format!("{}/v1/chat/completions", server.base_url());
    std::env::set_var("OPENAI_API_KEY", "test-key");
    std::env::set_var("OPENAI_CHAT_COMPLETIONS_ENDPOINT", &endpoint);
    std::env::remove_var("OPENAI_RESPONSES_ENDPOINT");
    std::env::remove_var("OPENAI_API_BASE");

    openai_client::configure_openai_defaults("gpt-chat", &endpoint);
    openai_client::prefer_chat_endpoint();

    let client = Client::new();
    let response =
        openai_client::call_openai_chat(&client, "gpt-chat", base_messages(), None, None).await?;
    let parsed: serde_json::Value = serde_json::from_str(&response)?;
    assert_eq!(parsed, json!({"score": 1}));

    mock.assert_async().await;
        Ok(())
    })
}

#[serial]
#[test]
fn chat_endpoint_extracts_json_from_prefixed_text() -> anyhow::Result<()> {
    let rt = Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(anyhow::Error::new)?;
    rt.block_on(async {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path("/v1/chat/completions");
                then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"choices":[{"message":{"role":"assistant","content":"Here is JSON:\n{\"foo\":1}"}}]}"#);
        })
        .await;

    let endpoint = format!("{}/v1/chat/completions", server.base_url());
    std::env::set_var("OPENAI_API_KEY", "test-key");
    std::env::set_var("OPENAI_CHAT_COMPLETIONS_ENDPOINT", &endpoint);
    std::env::remove_var("OPENAI_RESPONSES_ENDPOINT");
    std::env::remove_var("OPENAI_API_BASE");

    openai_client::configure_openai_defaults("gpt-chat", &endpoint);
    openai_client::prefer_chat_endpoint();

    let client = Client::new();
    let response =
        openai_client::call_openai_chat(&client, "gpt-chat", base_messages(), None, None).await?;
    let parsed: serde_json::Value = serde_json::from_str(&response)?;
    assert_eq!(parsed, json!({"foo": 1}));

    mock.assert_async().await;
        Ok(())
    })
}
