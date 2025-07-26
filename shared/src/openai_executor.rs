use actix_web::http::header;
use anyhow::Result;
use awc::Client;
use chrono::Utc;
use openai::chat::{ChatCompletion, ChatCompletionMessage, ChatCompletionMessageRole};
use openai::Credentials;
use regex::Regex;
use tracing::debug;

use crate::dto::PromptResult;
use crate::pipeline_graph::{PromptNode, PromptType, Status};

pub struct OpenAIExecutor {
    client: Client,
    api_key: String,
}

impl OpenAIExecutor {
    pub fn new(api_key: String) -> Self {
        let client = Client::builder()
            .add_default_header((header::ACCEPT_ENCODING, "br, gzip, deflate"))
            .finish();
        Self { client, api_key }
    }

    async fn run_prompt(&self, prompt: &PromptNode, text: &str) -> Result<(bool, f64, String, String)> {
        // short circuit during tests
        if self.api_key == "test" {
            let answer = format!("answer {}", prompt.id);
            return Ok((true, 1.0, answer.clone(), answer));
        }
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
        let creds = Credentials::new(self.api_key.clone(), "");
        let chat: ChatCompletion = ChatCompletion::builder("gpt-4-turbo", messages)
            .credentials(creds)
            .create()
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let answer = chat
            .choices
            .get(0)
            .and_then(|c| c.message.content.clone())
            .unwrap_or_default();
        debug!(prompt_id = %prompt.id, "received openai answer: {}", answer);
        parse_answer(&answer)
    }

    pub async fn run_batch(&self, prompts: &[PromptNode], blocks: &serde_json::Value) -> Vec<PromptResult> {
        let text = blocks.to_string();
        let mut res = Vec::new();
        for p in prompts.iter().filter(|p| matches!(p.type_, PromptType::AnalysisPrompt)) {
            let started = Utc::now();
            match self.run_prompt(p, &text).await {
                Ok((result, score, answer, source)) => {
                    let finished = Utc::now();
                    res.push(PromptResult {
                        prompt_id: p.id.clone(),
                        prompt_type: p.type_.as_str().into(),
                        status: Status::Done,
                        result: Some(result),
                        score: Some(score),
                        answer: Some(answer),
                        source: Some(source),
                        attempt: Some(1),
                        started_at: Some(started.to_rfc3339()),
                        finished_at: Some(finished.to_rfc3339()),
                    });
                }
                Err(e) => {
                    res.push(PromptResult {
                        prompt_id: p.id.clone(),
                        prompt_type: p.type_.as_str().into(),
                        status: Status::Done,
                        result: None,
                        score: None,
                        answer: Some(format!("error: {e}")),
                        source: None,
                        attempt: Some(1),
                        started_at: Some(started.to_rfc3339()),
                        finished_at: Some(Utc::now().to_rfc3339()),
                    });
                }
            }
        }
        res
    }
}

fn parse_answer(answer: &str) -> Result<(bool, f64, String, String)> {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(answer) {
        let res = json.get("result").and_then(|v| v.as_bool()).unwrap_or(false);
        let score = json.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let ans = json
            .get("answer")
            .and_then(|v| v.as_str())
            .unwrap_or(answer)
            .to_string();
        let src = json
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or(answer)
            .to_string();
        return Ok((res, score, ans, src));
    }
    let lower = answer.to_lowercase();
    let result = lower.contains("true") || lower.contains("yes") || lower.contains("ja");
    let score_re = Regex::new(r"([01](?:\.\d+)?|0?\.\d+)").unwrap();
    let score = score_re
        .captures(answer)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<f64>().ok())
        .unwrap_or(0.0);
    Ok((result, score, answer.to_string(), answer.to_string()))
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn batch_returns_sources() {
        let prompts = vec![
            PromptNode {
                id: "p1".into(),
                text: "Prompt 1".into(),
                type_: PromptType::AnalysisPrompt,
                weight: None,
                confidence_threshold: None,
                metadata: None,
            },
            PromptNode {
                id: "p2".into(),
                text: "Prompt 2".into(),
                type_: PromptType::AnalysisPrompt,
                weight: None,
                confidence_threshold: None,
                metadata: None,
            },
        ];
        let exec = OpenAIExecutor::new("test".into());
        let results = exec.run_batch(&prompts, &json!({"blocks": []})).await;
        assert_eq!(results.len(), 2);
        for r in results {
            assert!(r.source.is_some());
            assert!(!r.source.as_ref().unwrap().is_empty());
        }
    }
}
