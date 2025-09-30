// services/pipeline-runner/src/json_relaxed.rs
use serde_json::Value;

/// Entfernt Code-Fences (```json ... ```), führende/folgende Texte
/// und extrahiert den ersten balancierten JSON-Block.
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

fn strip_code_fences(s: &str) -> &str {
    let s = s.strip_prefix("```json").unwrap_or(s);
    let s = s.strip_prefix("```").unwrap_or(s);
    let s = s.strip_suffix("```").unwrap_or(s);
    s
}

fn extract_first_balanced_json(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut start = None;
    let mut depth = 0_i32;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] as char {
            '{' => {
                depth += 1;
                if start.is_none() { start = Some(i); }
            }
            '}' => {
                if depth > 0 { depth -= 1; }
                if depth == 0 && start.is_some() {
                    let st = start.unwrap();
                    let end = i + 1;
                    return Some(s[st..end].to_string());
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}
