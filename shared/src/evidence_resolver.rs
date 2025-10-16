//! Lightweight heuristics to resolve evidence snippets back to PDF pages.

use std::collections::HashMap;

/// Normalises user provided text so that simple similarity metrics behave
/// consistently.
///
/// The normalisation performs lower-casing, removes soft hyphen characters,
/// merges hyphenated line breaks, and collapses repeated whitespace.
pub fn normalize(s: &str) -> String {
    let lower = s.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut out = String::with_capacity(chars.len());
    let mut i = 0usize;
    let mut prev_space = false;
    while i < chars.len() {
        let c = chars[i];

        // Skip soft hyphen (U+00AD) characters.
        if c == '\u{00AD}' {
            i += 1;
            continue;
        }

        // Remove hyphenation across line breaks so the underlying words remain
        // searchable.
        if c == '-' && i + 2 < chars.len() && chars[i + 1].is_whitespace() && chars[i + 2].is_alphanumeric() {
            // überspringe '-' und alle folgenden Whitespaces
            i += 1;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            prev_space = false;
            continue;
        }

        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = false;
        }
        i += 1;
    }
    out.trim().to_string()
}

/// Calculates a lightweight similarity score between a normalised needle and
/// haystack.
///
/// Exact substring matches score 1.0. Otherwise we compute the overlap of
/// tokens (minimum length 3) found in the haystack.
fn similarity(needle_norm: &str, hay_norm: &str) -> f32 {
    if needle_norm.is_empty() || hay_norm.is_empty() {
        return 0.0;
    }
    if hay_norm.contains(needle_norm) {
        return 1.0;
    }
    let tokens: Vec<&str> = needle_norm
        .split_whitespace()
        .filter(|t| t.len() >= 3)
        .collect();
    if tokens.is_empty() {
        return 0.0;
    }
    let mut hit = 0usize;
    for t in tokens.iter() {
        if hay_norm.contains(t) {
            hit += 1;
        }
    }
    (hit as f32) / (tokens.len() as f32)
}

/// Attempts to resolve the page number for a given quote or value.
///
/// Returns the page together with a similarity score when the best match
/// reaches the configured threshold.
pub fn resolve_page(
    quote: &str,
    value: &str,
    page_map: &HashMap<u32, String>,
) -> Option<(u32, f32)> {
    let cand = {
        let q = normalize(quote);
        if !q.is_empty() { q } else { normalize(value) }
    };
    if cand.len() < 4 {
        return None;
    }

    let mut best: Option<(u32, f32)> = None;
    for (page, content) in page_map {
        let hay = normalize(content);
        let score = similarity(&cand, &hay);
        match best {
            Some((_, best_score)) if score > best_score => best = Some((*page, score)),
            None => best = Some((*page, score)),
            _ => {}
        }
    }

    if let Some((p, s)) = best {
        if s >= 0.80 {
            return Some((p, s));
        }
    }
    None
}
