//! Helpers for parsing loosely formatted JSON responses returned by LLMs,
//! stripping code fences and extracting the first balanced object.

use serde_json::Value;

/// Attempt to parse JSON even when the response contains code fences or extra text.
pub fn parse_json_relaxed(input: &str) -> Result<Value, String> {
    let t = strip_code_fences(input.trim());
    // 1) direkter Versuch
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Ok(v);
    }
    // 2) ersten balancierten {..}-Block extrahieren
    if let Some(s) = extract_first_balanced_json(t) {
        serde_json::from_str::<Value>(&s).map_err(|e| format!("invalid JSON after balance: {e}"))
    } else {
        Err("no balanced JSON object found".into())
    }
}

/// Remove common Markdown code fences around JSON snippets.
fn strip_code_fences(s: &str) -> &str {
    let s = s.strip_prefix("```json").unwrap_or(s);
    let s = s.strip_prefix("```").unwrap_or(s);
    let s = s.strip_suffix("```").unwrap_or(s);
    s
}

/// Extract the first balanced JSON object or array from the input string.
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
