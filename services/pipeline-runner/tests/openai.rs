use wiremock::{MockServer, Mock, ResponseTemplate};
use wiremock::matchers::{method, path};
use shared::openai_client;
use serde_json::json;

#[tokio::test]
#[ignore]
async fn openai_calls() {
    let server = MockServer::start().await;
    std::env::set_var("OPENAI_API_BASE", server.uri());
    std::env::set_var("OPENAI_API_KEY", "key");
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"choices":[{"message":{"content":"42.0"}}]})))
        .mount(&server)
        .await;
    let val = openai_client::extract(1, "doc").await.unwrap();
    assert!(val.value.is_some());
    let dec = openai_client::decide(1, &std::collections::HashMap::new()).await.unwrap();
    assert!(dec.boolean.is_some() || dec.route.is_some());
}
