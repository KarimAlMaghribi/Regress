//! Implements the shared OpenAI client helpers used across services to build
//! guarded prompts, parse responses, and surface structured scoring results.

use crate::dto::{ScoringResult, TernaryLabel, TextPosition};
use actix_web::http::header;
use awc::Client;
use openai::chat::{ChatCompletion, ChatCompletionMessage, ChatCompletionMessageRole};
use serde::de::Error as DeError;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::time::Duration;
use tokio::time;
use tracing::{debug, error, warn};
#[path = "evidence_resolver.rs"]
mod evidence_resolver;

// Guardrails that keep the assistant responses in German and constrained to
// strict JSON structures expected by downstream services.

const SYSTEM_GUARD_DE_ONLY: &str = r#"
Antworte ausschließlich auf Deutsch.
Wenn die Aufgabe strikt JSON verlangt, gib nur das JSON ohne zusätzlichen Text aus.
Keine englischen Sätze oder Erklärungen. Halte dich präzise an das geforderte Schema.
"#;

// Strict JSON guard definitions for the different prompt types we support.

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

/// Guard instructions used for tri-state scoring prompts.
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

/// Guard instructions that control how decision prompts respond.
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

/// Structures used to build chat completion requests with optional function
/// metadata or JSON schema guidance for the response payload.
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

/// Convenience constructor for chat messages to keep request assembly concise.
fn msg(role: ChatCompletionMessageRole, txt: &str) -> ChatCompletionMessage {
    ChatCompletionMessage {
        role,
        content: Some(txt.to_string()),
        ..Default::default()
    }
}

/// Attempt to interpret `s` as JSON by trying the raw string, stripping code
/// fences and, if necessary, scanning for the first balanced JSON block. This
/// mirrors the variety of formats produced by LLM responses.
fn parse_json_block(s: &str) -> anyhow::Result<serde_json::Value> {
    // Direct parse without any preprocessing.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
        return Ok(v);
    }
    // Strip Markdown code fences in case the model wrapped the payload.
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
    // As a fallback scan for the first balanced JSON object or array.
    if let Some(json_str) = extract_first_balanced_json(t) {
        return Ok(serde_json::from_str::<serde_json::Value>(&json_str)?);
    }
    Err(anyhow::anyhow!("invalid JSON"))
}

/// Find the first syntactically valid JSON object or array in `s` while
/// respecting quoted strings, returning it as an owned string when present.
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

/// Create the ordered chat messages required for scoring prompts so that the
/// assistant receives the guard rails before the user payload.
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

// OpenAI call handling

/// Send chat messages to OpenAI and return the assistant's answer as a raw JSON
/// string, enforcing `response_format=json_object` and handling function/tool
/// arguments when present.
pub async fn call_openai_chat(
    client: &Client,
    model: &str,
    messages: Vec<ChatCompletionMessage>,
    functions: Option<Vec<serde_json::Value>>,
    function_call: Option<serde_json::Value>,
) -> Result<String, PromptError> {
    let key = std::env::var("OPENAI_API_KEY").map_err(|e| PromptError::Network(e.to_string()))?;

    let req = ChatRequest {
        model,
        messages: &messages,
        functions: functions.as_deref(),
        function_call,
        response_format: if functions.is_some() {
            None
        } else {
            Some(serde_json::json!({"type":"json_object"}))
        },
    };

    let base = std::env::var("OPENAI_API_BASE").unwrap_or_else(|_| "https://api.openai.com".into());
    let url = format!("{}/v1/chat/completions", base);
    debug!("→ OpenAI request: model = {}", req.model);
    let mut res = client
        .post(url)
        .insert_header((header::AUTHORIZATION, format!("Bearer {}", key)))
        .send_json(&req)
        .await
        .map_err(|e| {
            error!("network error to OpenAI: {e}");
            PromptError::Network(e.to_string())
        })?;

    let status = res.status();
    debug!(status = %status, "← headers = {:?}", res.headers());
    let bytes = res
        .body()
        .await
        .map_err(|e| PromptError::Network(e.to_string()))?;
    let body_preview = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_string();
    debug!("← body[0..512] = {}", body_preview);

    if !status.is_success() {
        return Err(PromptError::Http(status.as_u16()));
    }

    // 1) Roh-JSON auswerten (unterstützt content-Arrays & tool_calls)
    if let Ok(raw) = serde_json::from_slice::<serde_json::Value>(&bytes) {
        if let Some(ans) = extract_choice_content_from_raw_json(&raw) {
            let trimmed = ans.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }

    // 2) Rückfall: typed Struct
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

    // 3) Kein verwertbarer Inhalt – aussagekräftiger Fehler
    Err(PromptError::Parse(DeError::custom(format!(
        "no content/function arguments in OpenAI response (first 200 chars): {}",
        &body_preview[..body_preview.len().min(200)]
    ))))
}

// Error helpers and DTO conversions

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

// Evidence fixing utilities to canonicalize PDF page metadata

/// Update `source.page` in an `OpenAiAnswer` by using the quote/value to look up
/// the canonical 1-based PDF page number.
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

/// Update `source.page` within a list of JSON extraction objects.
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

/// Public helper exposed for other crates to map quotes/values to `(page, score)`.
pub fn resolve_page_for_quote_value(
    quote: &str,
    value: &str,
    page_map: &HashMap<u32, String>,
) -> Option<(u32, f32)> {
    evidence_resolver::resolve_page(quote, value, page_map)
}

// Strict extraction prompt handling

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

    if let Ok(ans) = call_openai_chat(&client, "gpt-4o", msgs, None, None).await {
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

// Tri-state scoring with function-call support

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

    if let Ok(ans) = call_openai_chat(
        &client,
        "gpt-4o",
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

// Strict decision prompt orchestration

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

    if let Ok(ans) = call_openai_chat(&client, "gpt-4o", msgs, None, None).await {
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

// Miscellaneous helper functions

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

// Fallback helper for parsing tool calls and content arrays

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
