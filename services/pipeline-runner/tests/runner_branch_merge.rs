use std::collections::HashMap;
use shared::dto::{PipelineConfig, PipelineStep, PromptType};
#[path = "../src/runner.rs"]
mod runner;
#[path = "../src/builder.rs"]
mod builder;
use wiremock::{MockServer, Mock, ResponseTemplate};
use wiremock::matchers::{method, path};
use serde_json::json;

#[tokio::test]
async fn branch_merge() {
    let server = MockServer::start().await;
    std::env::set_var("OPENAI_API_BASE", server.uri());
    std::env::set_var("OPENAI_API_KEY", "k");
    std::env::set_var("PROMPT_MANAGER_URL", server.uri());

    // prompt texts
    for id in 1..=4 {
        Mock::given(method("GET")).and(path(format!("/prompts/{}", id)))
            .respond_with(ResponseTemplate::new(200).set_body_string("prompt"))
            .mount(&server).await;
    }

    // decision answer -> true
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{"message": {"content": "{\"answer\":true}" }}]
        })))
        .mount(&server)
        .await;

    let mut targets = HashMap::new();
    targets.insert("true".to_string(), "yes".to_string());
    targets.insert("false".to_string(), "no".to_string());

    let steps = vec![
        PipelineStep {
            id: "dec".into(),
            step_type: PromptType::DecisionPrompt,
            prompt_id: 1,
            label: None,
            alias: None,
            inputs: None,
            formula_override: None,
            input_source: None,
            route: None,
            condition: None,
            targets: Some(targets),
            merge_to: None,
            true_target: None,
            false_target: None,
            enum_targets: None,
            active: Some(true),
        },
        PipelineStep {
            id: "yes".into(),
            step_type: PromptType::ScoringPrompt,
            prompt_id: 2,
            label: None,
            alias: Some("a".into()),
            inputs: None,
            formula_override: Some("1".into()),
            input_source: None,
            route: None,
            condition: None,
            targets: None,
            merge_to: Some("merge".into()),
            true_target: None,
            false_target: None,
            enum_targets: None,
            active: Some(true),
        },
        PipelineStep {
            id: "no".into(),
            step_type: PromptType::ScoringPrompt,
            prompt_id: 3,
            label: None,
            alias: Some("b".into()),
            inputs: None,
            formula_override: Some("0".into()),
            input_source: None,
            route: None,
            condition: None,
            targets: None,
            merge_to: Some("merge".into()),
            true_target: None,
            false_target: None,
            enum_targets: None,
            active: Some(true),
        },
        PipelineStep {
            id: "merge".into(),
            step_type: PromptType::ScoringPrompt,
            prompt_id: 4,
            label: None,
            alias: Some("m".into()),
            inputs: None,
            formula_override: Some("2".into()),
            input_source: None,
            route: None,
            condition: None,
            targets: None,
            merge_to: None,
            true_target: None,
            false_target: None,
            enum_targets: None,
            active: Some(true),
        },
    ];
    let cfg = PipelineConfig { name: "t".into(), steps };
    let result = runner::execute(&cfg, "doc").await.unwrap();
    // should execute branch yes and then merge step
    assert_eq!(result.scoring.len(), 2);
}
