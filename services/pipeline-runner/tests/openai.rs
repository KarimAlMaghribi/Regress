use wiremock::{MockServer, Mock, ResponseTemplate};
use wiremock::matchers::{method, path};
use shared::openai_client;
use serde_json::json;

#[tokio::test]
async fn openai_calls() {
    let server = MockServer::start().await;
    std::env::set_var("OPENAI_API_BASE", server.uri());
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"choices":[{"message":{"content":"42.0"}}]})))
        .mount(&server)
        .await;
    let val = openai_client::extract(1, "doc").await.unwrap();
    assert_eq!(val, json!(42));
    let score = openai_client::score(1, &[]).await.unwrap();
    assert_eq!(score, 42.0_f64);
    let dec = openai_client::decide(1, &std::collections::HashMap::new()).await.unwrap();
    assert!(dec.is_number());
}
