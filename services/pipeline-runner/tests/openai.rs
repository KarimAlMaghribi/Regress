use serde_json::json;
use shared::openai_client;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
#[ignore]
async fn openai_calls() {
    let server = MockServer::start().await;
    std::env::set_var("OPENAI_API_BASE", server.uri());
    std::env::set_var("OPENAI_API_KEY", "key");
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{
                "message": {
                    "content": "{\"value\":\"xrisk schweiz ag\",\"source\":{\"page\":1,\"bbox\":[0,140,200,160],\"quote\":\"xrisk schweiz ag\"}}"
                }
            }]
        })))
        .mount(&server)
        .await;
    let val = openai_client::extract(1, "doc").await.unwrap();
    assert_eq!(val.value, Some(json!("xrisk schweiz ag")));
    assert_eq!(
        val.source.as_ref().and_then(|s| s.quote.clone()),
        Some("xrisk schweiz ag".to_string())
    );
    let dec = openai_client::decide(1, "doc", &std::collections::HashMap::new())
        .await
        .unwrap();
    assert!(dec.boolean.is_some() || dec.route.is_some());
}
