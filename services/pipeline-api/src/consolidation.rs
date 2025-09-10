use serde::Serialize;
use serde_json::Value as JsonValue;
use shared::dto::{PromptResult, ScoringResult, TextPosition};
use std::collections::HashMap;

/* -------------------- Konfiguration -------------------- */
#[derive(Clone)]
pub struct ConsCfg {
    pub header_y: f32,
    pub min_expl_len: usize,
    pub min_confidence: f32,
    // Extraction: vote/page/header/pattern
    pub w_extraction: (f32, f32, f32, f32),
    // Scoring/Decision: vote/near/header/expl
    pub w_scoring: (f32, f32, f32, f32),
}
impl Default for ConsCfg {
    fn default() -> Self {
        Self {
            header_y: env_f32("CONSOLIDATION_HEADER_Y", 120.0),
            min_expl_len: env_usize("CONSOLIDATION_MIN_EXPL_LEN", 20),
            min_confidence: env_f32("CONSOLIDATION_MIN_CONFIDENCE", 0.60),
            w_extraction: (
                env_f32("EXTRACTION_W_VOTE",   0.55),
                env_f32("EXTRACTION_W_PAGE",   0.20),
                env_f32("EXTRACTION_W_HEADER", 0.15),
                env_f32("EXTRACTION_W_PTRN",   0.10),
            ),
            w_scoring: (
                env_f32("SCORING_W_VOTE",   0.60),
                env_f32("SCORING_W_NEAR",   0.20),
                env_f32("SCORING_W_HEADER", 0.10),
                env_f32("SCORING_W_EXPL",   0.10),
            ),
        }
    }
}

/* -------------------- DTOs -------------------- */
#[derive(Copy, Clone)]
pub enum FieldType { Auto, String, Number, Boolean }

#[derive(Serialize, Clone)]
pub struct CanonicalField {
    pub value: JsonValue,
    pub confidence: f32,
    pub page: Option<u32>,
    pub quote: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ScoreOutcome {
    pub result: bool,
    pub confidence: f32,
    pub votes_true: usize,
    pub votes_false: usize,
    pub support: Vec<TextPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct DecisionOutcome {
    pub route: String,
    pub answer: Option<bool>,
    pub confidence: f32,
    pub votes_yes: usize,
    pub votes_no: usize,
    pub support: Vec<TextPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
}

/* -------------------- Extraction → 1 Wert -------------------- */
pub fn consolidate_field(
    results: &[PromptResult],
    prompt_id: i32,
    field_type: FieldType,
    cfg: &ConsCfg,
) -> Option<CanonicalField> {
    let mut cands: Vec<(&PromptResult, JsonValue)> = results
        .iter()
        .filter(|r| r.prompt_id == prompt_id)
        .filter(|r| r.error.is_none())
        .filter_map(|r| r.value.clone().map(|v| (r, v)))
        .collect();
    if cands.is_empty() { return None; }

    let eff = match field_type {
        FieldType::Auto => guess_type(&cands),
        other => other,
    };
    match eff {
        FieldType::String => consolidate_string(&cands, cfg),
        FieldType::Number => consolidate_number(&cands, cfg),
        FieldType::Boolean => consolidate_bool(&cands, cfg),
        FieldType::Auto => consolidate_string(&cands, cfg),
    }
}

fn guess_type(cands: &[(&PromptResult, JsonValue)]) -> FieldType {
    let total = cands.len().max(1) as f32;
    let n_num = cands.iter().filter(|(_,v)| parse_f64(v).is_some()).count() as f32;
    let n_bool = cands.iter().filter(|(_,v)| parse_bool(v).is_some()).count() as f32;
    if n_num/total >= 0.6 { FieldType::Number }
    else if n_bool/total >= 0.6 { FieldType::Boolean }
    else { FieldType::String }
}

fn consolidate_string(cands: &[(&PromptResult, JsonValue)], cfg: &ConsCfg) -> Option<CanonicalField> {
    use regex::Regex;
    let re_ws = Regex::new(r"\s+").unwrap();
    let re_digits = Regex::new(r"^\d{5,}$").unwrap();
    let re_ptrn  = Regex::new(r"(gmbh|ag|kg|gbr|iban|bic|rechnung|e\.?on)").unwrap();

    let mut buckets: HashMap<String, Bucket> = HashMap::new();
    for (r, v) in cands {
        let raw = match v {
            JsonValue::String(s) => s.as_str(),
            other => other.to_string().as_str(),
        };
        let mut s = raw.trim().to_lowercase();
        s = re_ws.replace_all(&s, " ").to_string();
        s = s.trim_matches(|c: char| matches!(c, '.' | ',' | ';')).to_string();
        if s.is_empty() { continue; }
        if re_digits.is_match(&s) { continue; }
        if let Some(q) = r.source.as_ref().and_then(|s| s.quote.as_ref()) {
            if q.to_lowercase().contains("kundennummer") { continue; }
        }
        let page   = r.source.as_ref().map(|s| s.page as u32).unwrap_or(9999);
        let header = r.source.as_ref().map(|s| s.bbox[1]).map(|y| if y <= cfg.header_y { 1.0 } else { 0.0 }).unwrap_or(0.0);
        let ptrn   = if re_ptrn.is_match(&s) { 1.0 } else { 0.0 };

        let e = buckets.entry(s.clone()).or_insert_with(|| Bucket {
            votes: 0, min_page: page, header, pattern: ptrn,
            sample: (r, JsonValue::String(raw.to_string())),
        });
        e.votes += 1;
        e.min_page = e.min_page.min(page);
        e.header = e.header.max(header);
        e.pattern = e.pattern.max(ptrn);
    }
    select_extraction_winner(buckets, cfg)
}

fn consolidate_number(cands: &[(&PromptResult, JsonValue)], cfg: &ConsCfg) -> Option<CanonicalField> {
    let mut buckets: HashMap<String, Bucket> = HashMap::new();
    let mut any_fraction = false;

    for (r, v) in cands {
        if let Some(num) = parse_f64(v) {
            if num.fract().abs() > 1e-6 { any_fraction = true; }
            let decimals = if any_fraction { 2 } else { 0 };
            let key = if decimals == 0 { format!("{}", num.round() as i128) } else { format!("{:.2}", num) };

            let page   = r.source.as_ref().map(|s| s.page as u32).unwrap_or(9999);
            let header = r.source.as_ref().map(|s| s.bbox[1]).map(|y| if y <= cfg.header_y { 1.0 } else { 0.0 }).unwrap_or(0.0);

            let e = buckets.entry(key.clone()).or_insert_with(|| Bucket {
                votes: 0, min_page: page, header, pattern: 0.0,
                sample: (r, JsonValue::Number(serde_json::Number::from_f64(num).unwrap())),
            });
            e.votes += 1;
            e.min_page = e.min_page.min(page);
            e.header = e.header.max(header);
        }
    }
    if buckets.is_empty() { return None; }
    select_extraction_winner(buckets, cfg)
}

fn consolidate_bool(cands: &[(&PromptResult, JsonValue)], cfg: &ConsCfg) -> Option<CanonicalField> {
    let mut buckets: HashMap<String, Bucket> = HashMap::new();
    for (r, v) in cands {
        if let Some(b) = parse_bool(v) {
            let key = if b { "true" } else { "false" }.to_string();
            let page   = r.source.as_ref().map(|s| s.page as u32).unwrap_or(9999);
            let header = r.source.as_ref().map(|s| s.bbox[1]).map(|y| if y <= cfg.header_y { 1.0 } else { 0.0 }).unwrap_or(0.0);

            let e = buckets.entry(key).or_insert_with(|| Bucket {
                votes: 0, min_page: page, header, pattern: 0.0,
                sample: (r, JsonValue::Bool(b)),
            });
            e.votes += 1;
            e.min_page = e.min_page.min(page);
            e.header = e.header.max(header);
        }
    }
    if buckets.is_empty() { return None; }
    select_extraction_winner(buckets, cfg)
}

struct Bucket<'a> {
    votes: usize,
    min_page: u32,
    header: f32,
    pattern: f32,
    sample: (&'a PromptResult, JsonValue),
}
fn select_extraction_winner<'a>(buckets: HashMap<String, Bucket<'a>>, cfg: &ConsCfg) -> Option<CanonicalField> {
    if buckets.is_empty() { return None; }
    let max_votes = buckets.values().map(|b| b.votes).max().unwrap_or(1) as f32;

    let (wv, wp, wh, wq) = cfg.w_extraction;
    let mut best: Option<&Bucket> = None;
    let mut best_score = -1.0f32;

    for b in buckets.values() {
        let vote_share   = b.votes as f32 / max_votes;
        let page_score   = 1.0 / (1.0 + b.min_page as f32);
        let header_score = b.header;
        let pattern_score= b.pattern;
        let score = wv*vote_share + wp*page_score + wh*header_score + wq*pattern_score;
        if score > best_score { best_score = score; best = Some(b); }
    }

    if let Some(b) = best {
        let (r, value) = (&b.sample.0, &b.sample.1);
        let (page, quote) = match r.source.as_ref() {
            Some(TextPosition { page, quote, .. }) => (Some(*page as u32), quote.clone()),
            _ => (None, None),
        };
        return Some(CanonicalField {
            value: value.clone(),
            confidence: best_score.clamp(0.0, 1.0),
            page, quote,
        });
    }
    None
}

/* -------------------- Scoring → 1 Ja/Nein -------------------- */
pub fn consolidate_scoring_weighted(
    results: &[ScoringResult],
    prompt_id: i32,
    anchor_page: Option<u32>,
    cfg: &ConsCfg,
) -> Option<ScoreOutcome> {
    let mut score_true = 0.0f32;
    let mut score_false = 0.0f32;
    let mut votes_true = 0usize;
    let mut votes_false = 0usize;

    #[derive(Clone)] struct Item { pos: TextPosition, strength: f32, expl: Option<String> }
    let mut items_true: Vec<Item> = Vec::new();
    let mut items_false: Vec<Item> = Vec::new();

    let (wv, wn, wh, we) = cfg.w_scoring;

    for r in results.iter().filter(|r| r.prompt_id == prompt_id) {
        let page  = r.source.page as u32;
        let y1    = r.source.bbox[1];
        let near  = anchor_page.map(|a| 1.0 / (1.0 + (page as f32 - a as f32).abs())).unwrap_or(0.5);
        let header= if y1 <= cfg.header_y { 1.0 } else { 0.0 };
        let explq = if r.explanation.trim().len() >= cfg.min_expl_len { 1.0 } else { 0.0 };

        let strength = wv*1.0 + wn*near + wh*header + we*explq;

        if r.result {
            votes_true += 1;
            score_true += strength;
            items_true.push(Item { pos: r.source.clone(), strength, expl: non_empty(&r.explanation) });
        } else {
            votes_false += 1;
            score_false += strength;
            items_false.push(Item { pos: r.source.clone(), strength, expl: non_empty(&r.explanation) });
        }
    }

    let total_votes = votes_true + votes_false;
    if total_votes == 0 { return None; }

    let (result, conf, support, explanation) = if score_true >= score_false {
        let sum = (score_true + score_false).max(1e-6);
        items_true.sort_by(|a,b| b.strength.total_cmp(&a.strength));
        (true, (score_true / sum).clamp(0.0, 1.0), items_true, None)
    } else {
        let sum = (score_true + score_false).max(1e-6);
        items_false.sort_by(|a,b| b.strength.total_cmp(&a.strength));
        (false, (score_false / sum).clamp(0.0, 1.0), items_false, None)
    };

    let best_expl = support.iter().find_map(|i| i.expl.clone());
    let support_positions = support.into_iter().take(3).map(|i| i.pos).collect();

    Some(ScoreOutcome {
        result,
        confidence: conf,
        votes_true,
        votes_false,
        support: support_positions,
        explanation: best_expl,
    })
}

/* -------------------- Decision → 1 Route -------------------- */
pub fn consolidate_decision_generic(
    decisions: &[PromptResult],
    prompt_id: i32,
    anchor_page: Option<u32>,
    cfg: &ConsCfg,
) -> Option<DecisionOutcome> {
    use std::collections::BTreeMap;
    let mut buckets: BTreeMap<String, (usize, f32, Vec<TextPosition>, Option<String>)> = BTreeMap::new();
    let (wv, wn, wh, we) = cfg.w_scoring;

    for r in decisions.iter().filter(|r| r.prompt_id == prompt_id).filter(|r| r.error.is_none()) {
        let route = r.route.clone().unwrap_or_else(|| "UNKNOWN".to_string()).trim().to_ascii_uppercase();
        let (page, y1) = match r.source.as_ref() {
            Some(s) => (s.page as u32, s.bbox[1]),
            None    => (9999u32, f32::MAX),
        };
        let near   = anchor_page.map(|a| 1.0 / (1.0 + (page as f32 - a as f32).abs())).unwrap_or(0.5);
        let header = if y1 <= cfg.header_y { 1.0 } else { 0.0 };
        let explq  = r.value.as_ref().and_then(|v| v.get("explanation")).and_then(|x| x.as_str())
            .map(|s| s.trim().len() >= cfg.min_expl_len).unwrap_or(false) as i32 as f32;

        let strength = wv*1.0 + wn*near + wh*header + we*explq;

        let entry = buckets.entry(route.clone()).or_insert((0usize, 0.0f32, Vec::new(), None));
        entry.0 += 1;
        entry.1 += strength;
        if let Some(src) = r.source.clone() { entry.2.push(src); }
        if entry.3.is_none() {
            let expl = r.value.as_ref().and_then(|v| v.get("explanation")).and_then(|x| x.as_str()).map(|s| s.to_string());
            entry.3 = expl;
        }
    }

    if buckets.is_empty() { return None; }

    let mut best_route = String::new();
    let mut best_score = -1.0f32;
    let mut winner: Option<(usize, f32, Vec<TextPosition>, Option<String>)> = None;
    let mut sum_all = 0.0f32;

    for (route, (_cnt, score, _sup, _expl)) in &buckets {
        sum_all += *score;
        if *score > best_score {
            best_score = *score;
            best_route = route.clone();
        }
    }
    if let Some(w) = buckets.remove(&best_route) { winner = Some(w); }

    let (votes_cnt, score_winner, support, explanation) = winner.unwrap();
    let confidence = if sum_all <= 1e-6 { 1.0 } else { (score_winner / sum_all).clamp(0.0, 1.0) };
    let answer = match best_route.as_str() {
        "YES" | "TRUE" | "JA" | "Y" | "1" => Some(true),
        "NO"  | "FALSE"| "NEIN"| "N" | "0" => Some(false),
        _ => None,
    };

    Some(DecisionOutcome {
        route: best_route,
        answer,
        confidence,
        votes_yes: if answer == Some(true)  { votes_cnt } else { 0 },
        votes_no:  if answer == Some(false) { votes_cnt } else { 0 },
        support,
        explanation,
    })
}

/* -------------------- Helpers -------------------- */
fn parse_bool(v: &JsonValue) -> Option<bool> {
    match v {
        JsonValue::Bool(b) => Some(*b),
        JsonValue::Number(n) => n.as_i64().map(|x| x != 0),
        JsonValue::String(s) => match normalize_str(s).as_str() {
            "true" | "yes" | "y" | "ja" | "1" => Some(true),
            "false"| "no"  | "n" | "nein"| "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}
fn parse_f64(v: &JsonValue) -> Option<f64> {
    match v {
        JsonValue::Number(n) => n.as_f64(),
        JsonValue::String(s) => parse_number_str(s),
        _ => None,
    }
}
fn parse_number_str(raw: &str) -> Option<f64> {
    let mut s = raw.trim().replace('\u{00A0}', "");
    for sym in ["€","$","£","CHF","EUR","USD"] { s = s.replace(sym, ""); }
    s = s.replace('\'', "").replace(' ', "");

    let has_comma = s.contains(',');
    let has_dot = s.contains('.');
    if has_comma && has_dot { s = s.replace('.', "").replace(',', "."); }
    else if has_comma { s = s.replace(',', "."); }
    else if has_dot {
        let last = s.rfind('.').unwrap_or(0);
        let mut cleaned = String::with_capacity(s.len());
        for (i,ch) in s.chars().enumerate() {
            if ch == '.' && i != last { continue; }
            cleaned.push(ch);
        }
        s = cleaned;
    }
    let mut clean2 = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_ascii_digit() || ch == '.' || ch == '-' { clean2.push(ch); }
    }
    if clean2.is_empty() { return None; }
    clean2.parse::<f64>().ok()
}
fn normalize_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = false;
    for ch in s.chars() {
        let ch = if ch == '\u{00A0}' { ' ' } else { ch };
        if ch.is_whitespace() {
            if !last_space { out.push(' '); last_space = true; }
        } else {
            last_space = false;
            out.push(ch.to_ascii_lowercase());
        }
    }
    out.trim().trim_matches(|c: char| matches!(c, '.' | ',' | ';')).to_string()
}
fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}
fn env_f32(key: &str, default: f32) -> f32 {
    std::env::var(key).ok().and_then(|s| s.parse::<f32>().ok()).unwrap_or(default)
}
fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|s| s.parse::<usize>().ok()).unwrap_or(default)
}
