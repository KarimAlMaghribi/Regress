// shared/src/evidence_resolver.rs

use serde_json::Value;
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;
use regex::Regex;

/// Normalisiere Text für robusten Vergleich
pub fn normalize(text: &str) -> String {
    let soft_hyphen = '\u{00AD}';
    let re_hyphen_line = Regex::new(r"(\w)-\s+(\w)").unwrap();
    let re_spaces = Regex::new(r"\s+").unwrap();

    let no_soft = text.replace(soft_hyphen, "");
    let joined = re_hyphen_line.replace_all(&no_soft, "$1$2");
    let collapsed = re_spaces.replace_all(&joined, " ");
    collapsed.nfkc().collect::<String>().to_lowercase().trim().to_string()
}

/// Belege mit Quote zu Seiten zuordnen
pub fn resolve_page<'a>(
    quote: &str,
    value: &str,
    page_map: &'a HashMap<u32, String>,
) -> Option<(u32, f32)> {
    let needle = if !quote.trim().is_empty() {
        normalize(quote)
    } else {
        normalize(value)
    };

    if needle.len() < 4 {
        return None;
    }

    let mut best: Option<(u32, f32)> = None;
    for (page, content) in page_map {
        let norm_content = normalize(content);
        let score = normalized_score(&needle, &norm_content);
        if score > 0.8 {
            match best {
                Some((_, best_score)) if score > best_score => best = Some((*page, score)),
                None => best = Some((*page, score)),
                _ => {}
            }
        }
    }
    best
}

fn normalized_score(needle: &str, haystack: &str) -> f32 {
    if haystack.contains(needle) {
        1.0
    } else if haystack.len() < 100 || needle.len() < 3 {
        0.0
    } else {
        let dist = strsim::levenshtein(needle, haystack);
        1.0 - (dist as f32 / needle.len().max(1) as f32)
    }
}
