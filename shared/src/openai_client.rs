// shared/src/openai_client.rs

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

/* ======================= STRICT-JSON Guards (keine Füllwerte) ======================= */

const EXTRACTION_GUARD_SUFFIX: &str = r#"
IMPORTANT EXTRACTION CONTRACT (STRICT):

Return a SINGLE, STRICTLY VALID JSON object.
Do not include markdown, code fences, comments, or extra keys.
If unsure or the answer is not present in DOCUMENT, use:
{"value":null,"source":{"page":null,"bbox":[0,0,0,0],"quote":null}}

Schema:
{
  "value": null | string,
  "source": {
    "page":  null | integer,
    "bbox":  [number,number,number,number],
    "quote": null | string
  }
}

Rules:
- Use ONLY content that appears in DOCUMENT. Do NOT invent text, pages or coordinates.
- The "quote" should be a short verbatim snippet (<=120 chars) around the value when possible.
- JSON only. No markdown, no comments, no extra keys.
"#;

/// Tri-State Scoring Guard (YES/NO/UNSURE) – striktes JSON
const SCORING_GUARD_PREFIX: &str = r#"
You are a tri-state classifier that decides a Yes/No/Unsure question based ONLY on DOCUMENT.
Do NOT invent content. Always return STRICT JSON that matches this single-object schema:

{
  "vote": "yes" | "no" | "unsure",
  "strength": number,
  "confidence": number,
  "source": {
    "page":  integer,
    "bbox":  [number,number,number,number],
    "quote": string
  },
  "explanation": string
}

Hard rules:
- "quote" MUST be a verbatim substring of DOCUMENT.
- If evidence is inconclusive, use vote="unsure".
- strength/confidence MUST be in [0,1].
- JSON only. No markdown, no comments, no extra keys.
"#;

const DECISION_GUARD_PREFIX: &str = r#"
You route a decision based ONLY on the provided document. Do NOT invent content.

Return ONE STRICT JSON object with this schema:
{
  "answer":  true | false | null,
  "route":   null | "true" | "false",
  "source": {
    "page":  integer | null,
    "bbox":  [number,number,number,number],
    "quote": string | null
  },
  "explanation": string
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

/* --- robuster JSON-Parser: direkt, Code-Fence, Kommentar-Strip, dann balancierte Klammern --- */

fn strip_json_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_str = false;
    let mut esc = false;
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
            continue;
        }
        // line comment //
        if c == '/' && i + 1 < bytes.len() && bytes[i + 1] as char == '/' {
            i += 2;
            while i < bytes.len() {
                let cc = bytes[i] as char;
                if cc == '\n' || cc == '\r' {
                    out.push(cc);
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        // block comment /* ... */
        if c == '/' && i + 1 < bytes.len() && bytes[i + 1] as char == '*' {
            i += 2;
            while i + 1 < bytes.len() {
                if bytes[i] as char == '*' && bytes[i + 1] as char == '/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

fn parse_json_block(s: &str) -> anyhow::Result<serde_json::Value> {
    // 1) try direct
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
        return Ok(v);
    }
    // strip code fences
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

    // 2) fenced
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
        return Ok(v);
    }
    // 3) fenced + comment strip
    let t_stripped = strip_json_comments(t);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t_stripped) {
        return Ok(v);
    }
    // 4) first balanced object
    if let Some(json_str) = extract_first_balanced_json(&t_stripped) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json_str) {
            return Ok(v);
        }
        let cleaned = strip_json_comments(&json_str);
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&cleaned) {
            return Ok(v);
        }
    }
    Err(anyhow::anyhow!("invalid JSON"))
}

fn extract_first_balanced_json(s: &str) -> Option<String> {
    let mut in_str = false;
    let mut esc = false;
    let mut depth: i32 = 0;
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
        } else {
            match ch {
                '"' => in_str = true,
                '{' => {
                    depth += 1;
                    if start.is_none() {
                        start = Some(i);
                    }
                }
                '}' => {
                    if depth > 0 {
                        depth -= 1;
                        if depth == 0 {
                            let st = start.unwrap_or(0);
                            return Some(s[st..=i].to_string());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/* ======================= Scoring-Prompt (Tri-State) ======================= */

#[derive(Debug, Clone)]
pub struct PromptState {
    pub variables: HashMap<String, String>,
}

#[derive(thiserror::Error, Debug)]
pub enum PromptError {
    #[error("http {0}")]
    Http(u16),
    #[error("net {0}")]
    Network(String),
    #[error("parse {0}")]
    Parse(serde_json::Error),
    #[error("prompt not found")]
    NotFound,
}

pub async fn fetch_prompt(id: i32) -> Result<String, PromptError> {
    // Dummy: in echter Implementierung aus DB/FS lesen
    let prompts = HashMap::from([
        (1, "Finde die Versicherungsnummer."),
        (2, "Ist ein Totalschaden dokumentiert?"),
        (3, "Route Entscheidung basierend auf Deckungslücke."),
    ]);
    prompts.get(&id).map(|s| s.to_string()).ok_or(PromptError::NotFound)
}

/* ======================= OpenAI Call ======================= */

/// Send chat messages to OpenAI and return the assistant's answer (as raw JSON string).
/// **Robust**: Kein früher Abbruch bei Schemaabweichungen; immer erst Roh-JSON auswerten.
pub async fn call_openai_chat(
    client: &Client,
    model: &str,
    messages: Vec<ChatCompletionMessage>,
    functions: Option<Vec<serde_json::Value>>,
    function_call: Option<serde_json::Value>,
) -> Result<String, PromptError> {
    let key = std::env::var("OPENAI_API_KEY").map_err(|e| PromptError::Network(e.to_string()))?;

    // Use response_format=json_object ONLY when NOT using functions/tool calls
    let resp_fmt = if functions.is_some() { None } else { Some(serde_json::json!({"type":"json_object"})) };

    let req = ChatRequest {
        model,
        messages: &messages,
        functions: functions.as_deref(),
        function_call,
        response_format: resp_fmt,
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
    let bytes = res.body().await.map_err(|e| PromptError::Network(e.to_string()))?;
    let body_preview = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_string();
    debug!("← body[0..512] = {}", body_preview);

    if !status.is_success() {
        return Err(PromptError::Http(status.as_u16()));
    }

    // === 1) Roh-JSON parsen und robust Inhalt extrahieren (behandelt content-Arrays & tool_calls) ===
    if let Ok(raw) = serde_json::from_slice::<serde_json::Value>(&bytes) {
        if let Some(ans) = extract_choice_content_from_raw_json(&raw) {
            let trimmed = ans.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }

    // === 2) Als Rückfallebene OPTIONAL den alten typed-Struct versuchen – aber NICHT mit '?' ===
    if let Ok(chat) = serde_json::from_slice::<ChatCompletion>(&bytes) {
        if let Some(primary) = chat.choices.get(0).and_then(|c| {
            c.message.content.clone().or_else(|| {
                c.message.function_call.as_ref().map(|fc| fc.arguments.clone())
            })
        }) {
            let trimmed = primary.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }

    // === 3) Kein verwertbarer Inhalt ===
    Err(PromptError::Parse(DeError::custom(format!(
        "no content/function arguments in OpenAI response (first 200 chars): {}",
        &body_preview[..body_preview.len().min(200)]
    ))))
}

#[derive(Debug, Clone)]
pub struct OpenAiAnswer {
    pub boolean: Option<bool>,
    pub route: Option<String>,
    pub value: Option<serde_json::Value>,
    pub source: Option<TextPosition>,
    pub raw: String,
}

/* ======================= Extraction (STRICT, mit Guard) ======================= */

pub async fn extract(prompt_id: i32, input: &str) -> Result<OpenAiAnswer, PromptError> {
    let client = Client::default();

    let prompt = fetch_prompt(prompt_id).await?;

    let system = "You are an extraction engine. Follow the contract strictly.";
    let user = format!(
        "DOCUMENT:\n{}\n\nTASK:\n{}\n\n{}",
        input, prompt, EXTRACTION_GUARD_SUFFIX
    );

    let msgs = vec![
        msg(ChatCompletionMessageRole::System, system),
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

/* ======================= Scoring (Tri-State) ======================= */

pub async fn score(question: &str, document: &str) -> Result<ScoringResult, PromptError> {
    let client = Client::default();

    let system = "You are a careful verifier. Output STRICT JSON only.";
    let user = format!(
        "DOCUMENT:\n{}\n\nQUESTION:\n{}\n\n{}",
        document, question, SCORING_GUARD_PREFIX
    );

    // JSON-Schema als Function (erzwingt Tool-Call-Format)
    let schema = serde_json::json!({
      "name": "ternary_answer",
      "parameters": {
        "type": "object",
        "properties": {
          "vote": {"type":"string","enum":["yes","no","unsure"]},
          "strength": {"type":"number"},
          "confidence": {"type":"number"},
          "source": {
            "type":"object",
            "properties":{
              "page":{"type":"integer"},
              "bbox":{"type":"array","items":{"type":"number"},"minItems":4,"maxItems":4},
              "quote":{"type":"string"}
            },
            "required":["bbox","quote"]
          },
          "explanation":{"type":"string"}
        },
        "required": ["vote","strength","confidence","source","explanation"]
      }
    });

    let msgs = vec![
        msg(ChatCompletionMessageRole::System, system),
        msg(ChatCompletionMessageRole::User, &user),
    ];

    if let Ok(ans) = call_openai_chat(
        &client,
        "gpt-4o",
        msgs,
        Some(vec![schema.clone()]),
        Some(serde_json::json!({"name":"ternary_answer"})),
    ).await {
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

                let mut source: Option<TextPosition> =
                    v.get("source").and_then(|s| serde_json::from_value::<TextPosition>(s.clone()).ok());
                if let Some(s) = source.as_mut() {
                    if s.bbox.len() != 4 {
                        s.bbox = [0.0, 0.0, 0.0, 0.0];
                    }
                } else {
                    source = Some(TextPosition {
                        page: None,
                        bbox: [0.0, 0.0, 0.0, 0.0],
                        quote: None,
                    });
                }

                let strength = v.get("strength").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let confidence = v.get("confidence").and_then(|x| x.as_f64()).unwrap_or(0.0);

                return Ok(ScoringResult {
                    result: result_bool,
                    label: vote_opt,
                    source,
                    strength,
                    confidence,
                    raw: v.to_string(),
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

/* ======================= Decision Routing ======================= */

pub async fn decide(prompt_id: i32, document: &str, state: &PromptState) -> Result<OpenAiAnswer, PromptError> {
    let client = Client::default();

    let system = "You are a decision router. Output STRICT JSON only.";
    let user = format!(
        "DOCUMENT:\n{}\n\nSTATE:\n{}\n\n{}\n\nRULES:\n- Output JSON only.",
        document,
        serde_json::to_string(state).unwrap_or_default()
        , DECISION_GUARD_PREFIX);

    let msgs = vec![
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
                let route = v.get("route").and_then(|r| r.as_str()).map(|s| s.to_string());

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
                    value: v.get("value").cloned(),
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

pub async fn fetch_prompt_text(id: i32) -> Result<String, PromptError> {
    fetch_prompt(id).await
}

/* ======================= Fallback-Hilfsfunktion (tool_calls, content-Arrays) ======================= */

fn extract_choice_content_from_raw_json(raw: &JsonValue) -> Option<String> {
    if let Some(s) = raw.pointer("/choices/0/message/content").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }

    if let Some(arr) = raw.pointer("/choices/0/message/content").and_then(|v| v.as_array()) {
        let mut buf = String::new();
        for part in arr {
            if let Some(txt) = part.get("text").and_then(|x| x.as_str()) {
                buf.push_str(txt);
            } else if let Some(s) = part.as_str() {
                buf.push_str(s);
            } else if let Some(obj) = part.as_object() {
                if let Some(JsonValue::String(t)) = obj.get("text") {
                    buf.push_str(t);
                }
            }
        }
        if !buf.is_empty() {
            return Some(buf);
        }
    }

    if let Some(calls) = raw.pointer("/choices/0/message/tool_calls").and_then(|v| v.as_array()) {
        for call in calls {
            if let Some(func) = call.get("function") {
                if let Some(s) = func.get("arguments").and_then(|v| v.as_str()) {
                    return Some(s.to_string());
                }
                if let Some(obj) = func.get("arguments").and_then(|v| v.as_object()) {
                    if let Ok(s) = serde_json::to_string(obj) {
                        return Some(s);
                    }
                }
            }
        }
    }

    // 3) legacy function_call.arguments (string)
    if let Some(s) = raw
        .pointer("/choices/0/message/function_call/arguments")
        .and_then(|v| v.as_str())
    {
        return Some(s.to_string());
    }

    None
}
