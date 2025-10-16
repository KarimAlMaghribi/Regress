// shared/src/openai_client.rs

use crate::dto::{ScoringResult, TernaryLabel, TextPosition};
use crate::openai_settings;
use actix_web::http::header;
use awc::Client;
use once_cell::sync::Lazy;
use openai::chat::{ChatCompletion, ChatCompletionMessage, ChatCompletionMessageRole};
use serde::de::Error as DeError;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;
use tokio::time;
use tracing::{debug, error, warn};
#[path = "evidence_resolver.rs"]
mod evidence_resolver;

static DEFAULT_MODEL: Lazy<RwLock<Option<String>>> = Lazy::new(|| {
    RwLock::new(Some(
        openai_settings::model_for(openai_settings::DEFAULT_OPENAI_VERSION).to_string(),
    ))
});
static CHAT_ENDPOINT: Lazy<RwLock<Option<String>>> = Lazy::new(|| {
    RwLock::new(Some(
        openai_settings::endpoint_for(openai_settings::DEFAULT_OPENAI_VERSION).to_string(),
    ))
});

pub fn configure_openai_defaults(model: impl Into<String>, endpoint: impl Into<String>) {
    let model = model.into();
    let trimmed_model = model.trim();
    if !trimmed_model.is_empty() {
        *DEFAULT_MODEL
            .write()
            .expect("DEFAULT_MODEL lock poisoned") = Some(trimmed_model.to_string());
    }

    let endpoint = endpoint.into();
    let trimmed_endpoint = endpoint.trim().trim_end_matches('/');
    if !trimmed_endpoint.is_empty() {
        *CHAT_ENDPOINT
            .write()
            .expect("CHAT_ENDPOINT lock poisoned") = Some(trimmed_endpoint.to_string());
    }
}

fn resolve_default_model() -> String {
    if let Ok(env) = std::env::var("OPENAI_DEFAULT_MODEL") {
        let trimmed = env.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    if let Some(model) = DEFAULT_MODEL
        .read()
        .expect("DEFAULT_MODEL lock poisoned")
        .clone()
    {
        if !model.is_empty() {
            return model;
        }
    }

    openai_settings::model_for(openai_settings::DEFAULT_OPENAI_VERSION).to_string()
}

fn resolve_chat_endpoint() -> Option<String> {
    if let Ok(env) = std::env::var("OPENAI_CHAT_COMPLETIONS_ENDPOINT") {
        let trimmed = env.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.trim_end_matches('/').to_string());
        }
    }

    let endpoint = CHAT_ENDPOINT
        .read()
        .expect("CHAT_ENDPOINT lock poisoned")
        .clone();
    if let Some(value) = endpoint.filter(|value| !value.is_empty()) {
        return Some(value);
    }

    if let Ok(base) = std::env::var("OPENAI_API_BASE") {
        let trimmed = base.trim();
        if !trimmed.is_empty() {
            let cleaned = trimmed.trim_end_matches('/');
            if cleaned.contains(".openai.azure.com") {
                return Some(cleaned.to_string());
            }
            return Some(format!("{}/v1/chat/completions", cleaned));
        }
    }

    Some(
        openai_settings::endpoint_for(openai_settings::DEFAULT_OPENAI_VERSION).to_string(),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthStyle {
    BearerToken,
    ApiKey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EndpointKind {
    ChatCompletions,
    Responses,
}

fn classify_endpoint(url: &str) -> EndpointKind {
    if url.to_ascii_lowercase().contains("/responses") {
        EndpointKind::Responses
    } else {
        EndpointKind::ChatCompletions
    }
}

fn requires_api_key_header(url: &str) -> bool {
    url.to_ascii_lowercase().contains(".openai.azure.com")
}

fn resolve_endpoint_details() -> (String, AuthStyle, EndpointKind) {
    let endpoint = resolve_chat_endpoint()
        .unwrap_or_else(|| {
            openai_settings::endpoint_for(openai_settings::DEFAULT_OPENAI_VERSION).to_string()
        });

    let kind = classify_endpoint(&endpoint);
    let auth = if requires_api_key_header(&endpoint) {
        AuthStyle::ApiKey
    } else {
        AuthStyle::BearerToken
    };

    (endpoint, auth, kind)
}

/* ======================= Deutsch-Guard (globale Vorgabe) ======================= */

const SYSTEM_GUARD_DE_ONLY: &str = r#"
Antworte ausschließlich auf Deutsch.
Wenn die Aufgabe strikt JSON verlangt, gib nur das JSON ohne zusätzlichen Text aus.
Keine englischen Sätze oder Erklärungen. Halte dich präzise an das geforderte Schema.
"#;

/* ======================= STRICT-JSON Guards (keine Füllwerte) ======================= */

const EXTRACTION_GUARD_SUFFIX: &str = r#"
IMPORTANT EXTRACTION CONTRACT (STRICT):

Return STRICT JSON ONLY:
{
  "value": string|null,   // exact substring copied from DOCUMENT (after trivial whitespace fixes) or null if not present/unsure
  "source": {
    "page":  integer|null,  // 1-based page where the substring occurs, or null
    "bbox":  [number,number,number,number], // use [0,0,0,0] if unknown
    "quote": string|null    // <=120 chars, exact snippet from DOCUMENT around the value, or null
  }
}

Rules:
- Use ONLY content that appears in DOCUMENT. Do NOT invent text, pages or coordinates.
- NO placeholders or generic labels (e.g. "Schadennummer", "Max Mustermann", "nicht angegeben").
- If you are unsure or the answer is not present in DOCUMENT -> {"value":null,"source":{"page":null,"bbox":[0,0,0,0],"quote":null}}.
- Output JSON only. No prose, no markdown.
"#;

/// Tri-State Scoring Guard (YES/NO/UNSURE) – striktes JSON
const SCORING_GUARD_PREFIX: &str = r#"
You are a tri-state classifier that decides a Yes/No/Unsure question based ONLY on DOCUMENT.
Do NOT invent content. Always return STRICT JSON that matches this single-object schema:

{
  "vote": "yes" | "no" | "unsure",
  "strength": number,      // 0..1, how strongly the evidence supports your vote
  "confidence": number,    // 0..1, how certain you are about your classification
  "source": {
    "page":  integer,      // 1-based page index with the most relevant quote
    "bbox":  [number,number,number,number], // use [0,0,0,0] if unknown
    "quote": string        // verbatim snippet from DOCUMENT supporting your vote
  },
  "explanation": string    // short reason (1-2 sentences)
}

Hard rules:
- "quote" MUST be a verbatim substring of DOCUMENT. Do not fabricate quotes.
- If evidence is inconclusive, use vote="unsure" with a neutral/closest quote.
- strength/confidence MUST be in [0,1]. Use your best judgement (they are not the same).
- JSON only. No markdown, no extra keys.
"#;

const DECISION_GUARD_PREFIX: &str = r#"
You route a decision based ONLY on the provided document. Do NOT invent content.

Return ONE JSON object:
{
  "answer":  true|false|null,  // null if undecided from DOCUMENT
  "route":   string|null,      // optional; if you provide it, it must be "true" or "false" consistent with "answer"
  "source": {
    "page":  integer|null,
    "bbox":  [number,number,number,number],
    "quote": string|null
  },
  "explanation": string        // short reason (1-2 sentences)
}

Rules:
- If unsure → answer=null (route may be null). Do not fabricate evidence.
- If you set "answer" to true/false, include a verbatim "quote" from DOCUMENT; page/bbox may be unknown → page=null, bbox=[0,0,0,0].
- JSON only. No markdown, no comments, no extra keys.
"#;

/* ======================= Chat request payload ======================= */

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatCompletionMessage],
    #[serde(skip_serializing_if = "Option::is_none")]
    functions: Option<&'a [serde_json::Value]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    function_call: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<serde_json::Value>,
}

fn msg(role: ChatCompletionMessageRole, txt: &str) -> ChatCompletionMessage {
    ChatCompletionMessage {
        role,
        content: Some(txt.to_string()),
        ..Default::default()
    }
}

/* --- JSON-Parser --- */

fn parse_json_block(s: &str) -> anyhow::Result<serde_json::Value> {
    // 1) direkt
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
        return Ok(v);
    }
    // 2) ```json ... ``` oder ``` ... ```
    let mut t = s.trim();
    if t.starts_with("```json") {
        t = &t[7..];
    }
    if t.starts_with("```") {
        t = &t[3..];
    }
    if t.ends_with("```") {
        t = &t[..t.len() - 3];
    }
    let t = t.trim();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
        return Ok(v);
    }
    // 3) ersten balancierten JSON-Block extrahieren (Ignorieren von Klammern in Strings)
    if let Some(json_str) = extract_first_balanced_json(t) {
        return Ok(serde_json::from_str::<serde_json::Value>(&json_str)?);
    }
    Err(anyhow::anyhow!("invalid JSON"))
}

fn role_to_str(role: &ChatCompletionMessageRole) -> &'static str {
    match role {
        ChatCompletionMessageRole::System => "system",
        ChatCompletionMessageRole::User => "user",
        ChatCompletionMessageRole::Assistant => "assistant",
        ChatCompletionMessageRole::Function => "function",
        ChatCompletionMessageRole::Tool => "tool",
        ChatCompletionMessageRole::Developer => "developer",
    }
}

fn convert_messages_for_responses(messages: &[ChatCompletionMessage]) -> Vec<JsonValue> {
    messages
        .iter()
        .map(|msg| {
            let mut content_items: Vec<JsonValue> = Vec::new();
            if let Some(text) = msg.content.as_ref() {
                if !text.is_empty() {
                    content_items.push(json!({
                        "type": "text",
                        "text": text
                    }));
                }
            }

            let mut obj = json!({
                "role": role_to_str(&msg.role),
                "content": content_items,
            });

            if let Some(name) = msg.name.as_ref() {
                obj.as_object_mut()
                    .unwrap()
                    .insert("name".to_string(), JsonValue::String(name.clone()));
            }

            if let Some(tool_call_id) = msg.tool_call_id.as_ref() {
                obj.as_object_mut().unwrap().insert(
                    "tool_call_id".to_string(),
                    JsonValue::String(tool_call_id.clone()),
                );
            }

            if let Some(tool_calls) = msg.tool_calls.as_ref() {
                if !tool_calls.is_empty() {
                    if let Ok(value) = serde_json::to_value(tool_calls) {
                        obj.as_object_mut()
                            .unwrap()
                            .insert("tool_calls".to_string(), value);
                    }
                }
            }

            obj
        })
        .collect()
}

fn map_function_call_to_tool_choice(function_call: &JsonValue) -> Option<JsonValue> {
    match function_call {
        JsonValue::String(s) => {
            let lowered = s.to_ascii_lowercase();
            if lowered == "auto" || lowered == "none" {
                Some(JsonValue::String(lowered))
            } else {
                None
            }
        }
        JsonValue::Object(map) => map
            .get("name")
            .and_then(|v| v.as_str())
            .map(|name| json!({
                "type": "function",
                "function": {"name": name}
            })),
        _ => None,
    }
}

fn build_responses_payload(
    model: &str,
    messages: &[ChatCompletionMessage],
    functions: Option<&[JsonValue]>,
    function_call: Option<&JsonValue>,
) -> JsonValue {
    let mut payload = json!({
        "model": model,
        "input": convert_messages_for_responses(messages),
    });

    if let Some(funcs) = functions {
        let tools: Vec<JsonValue> = funcs
            .iter()
            .cloned()
            .map(|f| json!({"type": "function", "function": f}))
            .collect();
        if !tools.is_empty() {
            payload
                .as_object_mut()
                .unwrap()
                .insert("tools".to_string(), JsonValue::Array(tools));
        }
    }

    if let Some(choice) = function_call.and_then(map_function_call_to_tool_choice) {
        payload
            .as_object_mut()
            .unwrap()
            .insert("tool_choice".to_string(), choice);
    }

    if functions.is_none() {
        payload
            .as_object_mut()
            .unwrap()
            .insert("response_format".to_string(), json!({"type": "json_object"}));
    }

    payload
}

fn parse_responses_output(raw: &JsonValue) -> Option<String> {
    if let Some(text) = raw.get("output_text").and_then(|v| v.as_str()) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(output) = raw.get("output").and_then(|v| v.as_array()) {
        for entry in output {
            if let Some(content) = entry.get("content").and_then(|v| v.as_array()) {
                for item in content {
                    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.to_string());
                        }
                    }
                    if let Some(arguments) =
                        item.get("arguments").and_then(|v| v.as_str())
                    {
                        let trimmed = arguments.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.to_string());
                        }
                    }
                }
            }
        }
    }

    if let Some(tool_calls) = raw.get("tool_calls").and_then(|v| v.as_array()) {
        for call in tool_calls {
            if let Some(arguments) = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|v| v.as_str())
            {
                let trimmed = arguments.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    None
}

fn extract_first_balanced_json(s: &str) -> Option<String> {
    let mut in_str = false;
    let mut esc = false;
    let mut stack: Vec<char> = Vec::new();
    let mut start: Option<usize> = None;

    for (i, ch) in s.char_indices() {
        if in_str {
            if esc {
                esc = false;
            } else if ch == '\\' {
                esc = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }

        match ch {
            '"' => in_str = true,
            '{' | '[' => {
                if start.is_none() {
                    start = Some(i);
                }
                stack.push(ch);
            }
            '}' | ']' => {
                if let Some(open) = stack.pop() {
                    let matches = (open == '{' && ch == '}') || (open == '[' && ch == ']');
                    if !matches {
                        stack.clear();
                        start = None;
                        continue;
                    }
                    if stack.is_empty() {
                        let st = start.unwrap_or(0);
                        return Some(s[st..=i].to_string());
                    }
                } else {
                    start = None;
                }
            }
            _ => {}
        }
    }
    None
}

/* ======================= Scoring-Prompt (Tri-State) ======================= */

fn build_scoring_prompt(document: &str, question: &str) -> Vec<ChatCompletionMessage> {
    let user = format!(
        "QUESTION:\n{}\n\nDOCUMENT:\n{}\n\n(STRICT JSON, follow the contract.)",
        question, document
    );
    vec![
        msg(ChatCompletionMessageRole::System, SYSTEM_GUARD_DE_ONLY),
        msg(ChatCompletionMessageRole::System, SCORING_GUARD_PREFIX),
        msg(ChatCompletionMessageRole::User, &user),
    ]
}

/* ======================= OpenAI Call ======================= */

/// Send chat messages to OpenAI and return the assistant's answer (as raw JSON string).
/// Erzwingt response_format=json_object und berücksichtigt function/tool arguments.
pub async fn call_openai_chat(
    client: &Client,
    model: &str,
    messages: Vec<ChatCompletionMessage>,
    functions: Option<Vec<serde_json::Value>>,
    function_call: Option<serde_json::Value>,
) -> Result<String, PromptError> {
    let key = std::env::var("OPENAI_API_KEY").map_err(|e| PromptError::Network(e.to_string()))?;
    let (endpoint, auth_style, endpoint_kind) = resolve_endpoint_details();
    let functions_clone = functions.clone();
    let function_call_clone = function_call.clone();

    let payload: JsonValue = match endpoint_kind {
        EndpointKind::ChatCompletions => {
            let req = ChatRequest {
                model,
                messages: &messages,
                functions: functions.as_deref(),
                function_call,
                response_format: if functions.is_some() {
                    None
                } else {
                    Some(json!({"type":"json_object"}))
                },
            };
            serde_json::to_value(&req).map_err(PromptError::Parse)?
        }
        EndpointKind::Responses => {
            let functions_ref = functions_clone
                .as_ref()
                .map(|vec| vec.as_slice());
            build_responses_payload(
                model,
                &messages,
                functions_ref,
                function_call_clone.as_ref(),
            )
        }
    };

    debug!(
        endpoint = %endpoint,
        kind = ?endpoint_kind,
        "→ OpenAI request: model = {}",
        model
    );

    let mut request = client.post(endpoint.clone());
    request = match auth_style {
        AuthStyle::ApiKey => request.insert_header(("api-key", key.clone())),
        AuthStyle::BearerToken => request.insert_header((header::AUTHORIZATION, format!("Bearer {}", key))),
    };

    let mut res = request
        .send_json(&payload)
        .await
        .map_err(|e| {
            error!("network error to OpenAI: {e}");
            PromptError::Network(e.to_string())
        })?;

    let status = res.status();
    debug!(status = %status, endpoint = %endpoint, kind = ?endpoint_kind, "← headers = {:?}", res.headers());
    let bytes = res
        .body()
        .await
        .map_err(|e| PromptError::Network(e.to_string()))?;
    let body_preview = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_string();
    debug!("← body[0..512] = {}", body_preview);

    if !status.is_success() {
        return Err(PromptError::Http(status.as_u16()));
    }

    let raw_value: Option<JsonValue> = serde_json::from_slice::<JsonValue>(&bytes).ok();

    match endpoint_kind {
        EndpointKind::Responses => {
            if let Some(raw) = raw_value.as_ref() {
                if let Some(ans) = parse_responses_output(raw) {
                    let trimmed = ans.trim();
                    if !trimmed.is_empty() {
                        return Ok(trimmed.to_string());
                    }
                }
            }
        }
        EndpointKind::ChatCompletions => {
            if let Some(raw) = raw_value.as_ref() {
                if let Some(ans) = extract_choice_content_from_raw_json(raw) {
                    let trimmed = ans.trim();
                    if !trimmed.is_empty() {
                        return Ok(trimmed.to_string());
                    }
                }
            }

            if let Ok(chat) = serde_json::from_slice::<ChatCompletion>(&bytes) {
                if let Some(primary) = chat.choices.get(0).and_then(|c| {
                    c.message.content.clone().or_else(|| {
                        c.message
                            .function_call
                            .as_ref()
                            .map(|fc| fc.arguments.clone())
                    })
                }) {
                    let trimmed = primary.trim();
                    if !trimmed.is_empty() {
                        return Ok(trimmed.to_string());
                    }
                }
            }
        }
    }

    Err(PromptError::Parse(DeError::custom(format!(
        "no content/function arguments in OpenAI response (first 200 chars): {}",
        &body_preview[..body_preview.len().min(200)]
    ))))
}

/* ======================= Fehler & DTOs ======================= */

#[derive(thiserror::Error, Debug)]
pub enum PromptError {
    #[error("extraction failed")]
    ExtractionFailed,
    #[error("scoring failed")]
    ScoringFailed,
    #[error("decision failed")]
    DecisionFailed,
    #[error("parse error: {0}")]
    Parse(serde_json::Error),
    #[error("net {0}")]
    Network(String),
    #[error("http error: {0}")]
    Http(u16),
}

#[derive(Debug, Clone)]
pub struct OpenAiAnswer {
    pub boolean: Option<bool>,
    pub route: Option<String>,
    pub value: Option<serde_json::Value>,
    pub source: Option<TextPosition>,
    pub raw: String,
}

/* ======================= Evidence-Fix (kanonische PDF-Seiten) ======================= */

/// Überschreibt `source.page` in `OpenAiAnswer` anhand Quote/Value mit korrekter 1-basierter PDF-Seite.
pub fn enrich_with_pdf_evidence_answer(answer: &mut OpenAiAnswer, page_map: &HashMap<u32, String>) {
    let quote = answer
        .source
        .as_ref()
        .and_then(|s| s.quote.as_ref())
        .map(|s| s.as_str())
        .unwrap_or_default();

    let value_str = answer
        .value
        .as_ref()
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    if let Some((page, _score)) = evidence_resolver::resolve_page(quote, value_str, page_map) {
        if let Some(src) = answer.source.as_mut() {
            src.page = page;
        }
    }
}

/// Überschreibt `source.page` in einer Liste von JSON-Extraction-Objekten.
pub fn enrich_with_pdf_evidence_list(items: &mut [JsonValue], page_map: &HashMap<u32, String>) {
    for it in items.iter_mut() {
        let quote = it
            .pointer("/source/quote")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let value_str = it.get("value").and_then(|v| v.as_str()).unwrap_or_default();

        if let Some((page, score)) = evidence_resolver::resolve_page(quote, value_str, page_map) {
            if let Some(src) = it.get_mut("source") {
                src["page"] = JsonValue::from(page);
                it["evidence_confidence"] = JsonValue::from(score);
            }
        }
    }
}

/// Öffentliche Hilfsfunktion für andere Crates: Quote/Value → (Seite, Score)
pub fn resolve_page_for_quote_value(
    quote: &str,
    value: &str,
    page_map: &HashMap<u32, String>,
) -> Option<(u32, f32)> {
    evidence_resolver::resolve_page(quote, value, page_map)
}

/* ======================= Extraction (STRICT, mit Guard) ======================= */

pub async fn extract(prompt_id: i32, input: &str) -> Result<OpenAiAnswer, PromptError> {
    let client = Client::builder().timeout(Duration::from_secs(120)).finish();
    let prompt = fetch_prompt(prompt_id).await?;

    let system_en = "You are an extraction engine. Follow the contract strictly.";
    let user = format!(
        "DOCUMENT:\n{}\n\nTASK:\n{}\n\n{}",
        input, prompt, EXTRACTION_GUARD_SUFFIX
    );

    let msgs = vec![
        msg(ChatCompletionMessageRole::System, SYSTEM_GUARD_DE_ONLY),
        msg(ChatCompletionMessageRole::System, system_en),
        msg(ChatCompletionMessageRole::User, &user),
    ];

    let model = resolve_default_model();
    if let Ok(ans) = call_openai_chat(&client, &model, msgs, None, None).await {
        match parse_json_block(&ans) {
            Ok(v) => {
                let value = v.get("value").cloned();
                let source = v
                    .get("source")
                    .and_then(|s| serde_json::from_value(s.clone()).ok())
                    .map(|mut s: TextPosition| {
                        if s.bbox.len() != 4 {
                            s.bbox = [0.0, 0.0, 0.0, 0.0];
                        }
                        s
                    });

                return Ok(OpenAiAnswer {
                    boolean: None,
                    route: None,
                    value,
                    source,
                    raw: v.to_string(),
                });
            }
            Err(e) => {
                warn!(
                    "extract parse_json_block failed: {e}; ans[0..200]={}",
                    ans.chars().take(200).collect::<String>()
                );
            }
        }
    }

    Err(PromptError::Parse(DeError::custom("invalid JSON")))
}

/* ======================= Scoring (Tri-State mit Function-Call) ======================= */

pub async fn score(prompt_id: i32, document: &str) -> Result<ScoringResult, PromptError> {
    let client = Client::builder().timeout(Duration::from_secs(120)).finish();
    let question = fetch_prompt(prompt_id).await?;
    let msgs = build_scoring_prompt(document, &question);

    let schema = serde_json::json!({
      "name": "ternary_answer",
      "description": "Return exactly one object with tri-state vote (yes/no/unsure), strength, confidence and a verbatim quote.",
      "parameters": {
        "type": "object",
        "properties": {
          "vote": {"type":"string","enum":["yes","no","unsure"]},
          "strength": {"type":"number","minimum":0,"maximum":1},
          "confidence": {"type":"number","minimum":0,"maximum":1},
          "source": {
            "type":"object",
            "properties": {
              "page":  {"type":"integer"},
              "bbox":  {"type":"array","items":{"type":"number"},"minItems":4,"maxItems":4},
              "quote": {"type":"string"}
            },
            "required": ["page","bbox","quote"]
          },
          "explanation": {"type":"string"}
        },
        "required": ["vote","strength","confidence","source","explanation"]
      }
    });

    let model = resolve_default_model();
    if let Ok(ans) = call_openai_chat(
        &client,
        &model,
        msgs,
        Some(vec![schema.clone()]),
        Some(serde_json::json!({"name":"ternary_answer"})),
    )
    .await
    {
        match parse_json_block(&ans) {
            Ok(v) => {
                let vote_str = v.get("vote").and_then(|s| s.as_str()).unwrap_or("");
                let vote_opt = match vote_str {
                    "yes" => Some(TernaryLabel::Yes),
                    "no" => Some(TernaryLabel::No),
                    "unsure" => Some(TernaryLabel::Unsure),
                    _ => None,
                };

                // legacy bool optional
                let legacy_bool = v.get("result").and_then(|b| b.as_bool());
                let result_bool = match vote_opt {
                    Some(TernaryLabel::Yes) => true,
                    Some(TernaryLabel::No) => false,
                    Some(TernaryLabel::Unsure) => legacy_bool.unwrap_or(false),
                    None => legacy_bool.unwrap_or(false),
                };

                let mut source: Option<TextPosition> = v
                    .get("source")
                    .and_then(|s| serde_json::from_value::<TextPosition>(s.clone()).ok());
                if let Some(s) = source.as_mut() {
                    if s.bbox.len() != 4 {
                        s.bbox = [0.0, 0.0, 0.0, 0.0];
                    }
                } else {
                    source = Some(TextPosition {
                        page: 0,
                        bbox: [0.0, 0.0, 0.0, 0.0],
                        quote: None,
                    });
                }

                let strength = v.get("strength").and_then(|x| x.as_f64()).map(|f| f as f32);
                let confidence = v
                    .get("confidence")
                    .and_then(|x| x.as_f64())
                    .map(|f| f as f32);
                let explanation = v
                    .get("explanation")
                    .and_then(|e| e.as_str())
                    .unwrap_or("")
                    .to_string();

                return Ok(ScoringResult {
                    prompt_id,
                    result: result_bool,
                    source: source.unwrap(),
                    explanation,
                    vote: vote_opt,
                    strength,
                    confidence,
                    score: None,
                    label: None,
                });
            }
            Err(e) => {
                warn!(
                    "score parse_json_block failed: {e}; ans[0..200]={}",
                    ans.chars().take(200).collect::<String>()
                );
            }
        }
    }

    Err(PromptError::Parse(DeError::custom("invalid JSON")))
}

/* ======================= Decision (STRICT, mit Guard) ======================= */

pub async fn decide(
    prompt_id: i32,
    document: &str,
    state: &HashMap<String, serde_json::Value>,
) -> Result<OpenAiAnswer, PromptError> {
    let client = Client::builder().timeout(Duration::from_secs(120)).finish();
    let prompt = fetch_prompt(prompt_id).await?;

    let system = DECISION_GUARD_PREFIX;
    let user = format!(
        "{}\n\nDOCUMENT:\n{}\n\nSTATE:\n{}\n\n(STRICT JSON, follow the contract.)",
        prompt,
        document,
        serde_json::to_string(state).unwrap_or_default()
    );

    let msgs = vec![
        msg(ChatCompletionMessageRole::System, SYSTEM_GUARD_DE_ONLY),
        msg(ChatCompletionMessageRole::System, system),
        msg(ChatCompletionMessageRole::User, &user),
    ];

    let model = resolve_default_model();
    if let Ok(ans) = call_openai_chat(&client, &model, msgs, None, None).await {
        match parse_json_block(&ans) {
            Ok(mut v) => {
                let answer_bool = v.get("answer").and_then(|val| val.as_bool());
                if v.get("route").is_none() {
                    if let Some(ansb) = answer_bool {
                        v["route"] = serde_json::Value::String(ansb.to_string());
                    }
                }
                let route = v
                    .get("route")
                    .and_then(|r| r.as_str())
                    .map(|s| s.to_string());

                let source = v
                    .get("source")
                    .and_then(|s| serde_json::from_value::<TextPosition>(s.clone()).ok())
                    .map(|mut s| {
                        if s.bbox.len() != 4 {
                            s.bbox = [0.0, 0.0, 0.0, 0.0];
                        }
                        s
                    });

                return Ok(OpenAiAnswer {
                    boolean: answer_bool,
                    route,
                    value: None,
                    source,
                    raw: v.to_string(),
                });
            }
            Err(e) => {
                warn!(
                    "decide parse_json_block failed: {e}; ans[0..200]={}",
                    ans.chars().take(200).collect::<String>()
                );
            }
        }
    }

    Err(PromptError::Parse(DeError::custom("invalid JSON")))
}

/* ======================= Sonstiges ======================= */

pub async fn dummy(_name: &str) -> Result<serde_json::Value, PromptError> {
    Ok(serde_json::json!(null))
}

async fn fetch_prompt(id: i32) -> Result<String, PromptError> {
    let client = Client::builder().timeout(Duration::from_secs(120)).finish();
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
                warn!(id, retry = i, "fetch_prompt network error: {e}");
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

/* ======================= Fallback-Hilfsfunktion (tool_calls, content-Arrays) ======================= */

fn extract_choice_content_from_raw_json(raw: &JsonValue) -> Option<String> {
    // 1) content als String
    if let Some(s) = raw
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
    {
        return Some(s.to_string());
    }

    // 1b) content als Array (neues Format)
    if let Some(arr) = raw
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_array())
    {
        let mut buf = String::new();
        let mut json_candidate: Option<String> = None;
        for part in arr {
            if let Some(txt) = part.get("text").and_then(|x| x.as_str()) {
                buf.push_str(txt);
                continue;
            }

            if let Some(json_val) = part.get("json") {
                if let Ok(json_txt) = serde_json::to_string(json_val) {
                    json_candidate.get_or_insert(json_txt);
                }
                continue;
            }

            if let Some(s) = part.as_str() {
                buf.push_str(s);
                continue;
            }

            if let Some(obj) = part.as_object() {
                if let Some(JsonValue::String(t)) = obj.get("text") {
                    buf.push_str(t);
                } else if let Some(json_val) = obj.get("json") {
                    if let Ok(json_txt) = serde_json::to_string(json_val) {
                        json_candidate.get_or_insert(json_txt);
                    }
                }
            }
        }
        if let Some(json) = json_candidate {
            return Some(json);
        }
        if !buf.is_empty() {
            return Some(buf);
        }
    }

    // 2) tool_calls (neues Schema) – akzeptiere String ODER Objekt
    if let Some(arg) = raw.pointer("/choices/0/message/tool_calls/0/function/arguments") {
        if let Some(s) = arg.as_str() {
            return Some(s.to_string());
        }
        if let Some(obj) = arg.as_object() {
            if let Ok(s) = serde_json::to_string(obj) {
                return Some(s);
            }
        }
    }

    // 3) altes function_call-Schema (zur Sicherheit)
    if let Some(s) = raw
        .pointer("/choices/0/message/function_call/arguments")
        .and_then(|v| v.as_str())
    {
        return Some(s.to_string());
    }

    None
}
