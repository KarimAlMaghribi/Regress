// shared/src/evidence_resolver.rs
// Seitenauflösung ohne externe Crates (kompatibel mit --locked)

use std::collections::HashMap;

/// Einfache Normalisierung:
/// - Kleinbuchstaben
/// - weiche Trennzeichen entfernen
/// - Silbentrennung am Zeilenumbruch entfernen: "-\n" / "-\r\n" / "- " + Zeilenumbruch
/// - Whitespace zu Einzel-Leerzeichen kollabieren
pub fn normalize(s: &str) -> String {
    let lower = s.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut out = String::with_capacity(chars.len());
    let mut i = 0usize;
    let mut prev_space = false;
    while i < chars.len() {
        let c = chars[i];

        // weicher Trennstrich U+00AD überspringen
        if c == '\u{00AD}' {
            i += 1;
            continue;
        }

        // Silbentrennung: '-' + whitespace + alnum  => '-' und whitespace verwerfen
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

/// Sehr einfache Ähnlichkeitsmetrik:
/// 1) exakter Teilstring-Treffer => Score 1.0
/// 2) sonst Token-Overlap: Anteil der Tokens (len>=3), die im Seiteninhalt vorkommen
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

/// Liefert (Seite, Score), wenn eine Seite den Schwellwert erreicht.
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
