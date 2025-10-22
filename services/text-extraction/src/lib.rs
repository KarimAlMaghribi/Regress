//! Text extraction helpers combining `pdftotext` and optional OCR.

use std::{env, sync::Arc, time::Duration};

use anyhow::{anyhow, Context, Result};
use html_escape::decode_html_entities;
use once_cell::sync::Lazy;
use quick_xml::events::Event;
use quick_xml::Reader;
use regex::Regex;
use serde::Serialize;
use tokio::{process::Command, sync::Semaphore, task::JoinSet, time::timeout};
use tracing::{info, warn};
use uuid::Uuid;

const PROCESS_TIMEOUT: Duration = Duration::from_secs(60);

/// Complete extract via `pdftotext` for the whole PDF.
/// Uses `-layout` when `PDFTEXT_LAYOUT` is not set to "0".
pub async fn extract_text(path: &str) -> Result<String> {
    info!(
        step = "extract.start",
        ?path,
        "starting text extraction via pdftotext"
    );

    let output = run_pdftotext_full(path).await?;
    let text = String::from_utf8(output.stdout).context("invalid utf8 from pdftotext")?;

    info!(
        step = "extract.finish",
        ?path,
        len = text.len(),
        "text extracted"
    );
    Ok(text)
}

#[derive(Clone, Debug)]
/// Holds the extracted text and metadata for a single page.
pub struct PageExtraction {
    pub page_no: i32,
    pub text: String,
    pub ocr_used: bool,
    pub layout: Option<PageLayout>,
}

#[derive(Clone, Debug, Serialize)]
/// Layout information describing bounding boxes for extracted words.
pub struct PageLayout {
    pub page_no: i32,
    pub page_width: i32,
    pub page_height: i32,
    pub words: Vec<Word>,
}

#[derive(Clone, Debug, Serialize)]
/// Single OCR word alongside its bounding box.
pub struct Word {
    pub bbox: [i32; 4],
    pub text: String,
}

#[derive(Clone, Debug)]
/// Configuration derived from environment variables controlling extraction.
struct ExtractionOptions {
    pdftext_layout: bool,
    ocr_enabled: bool,
    ocr_lang: String,
    ocr_psm: String,
    ocr_dpi: u32,
    ocr_min_nonws: usize,
    layout_enabled: bool,
    layout_backend: LayoutBackend,
    max_parallel_ocr: usize,
}

#[derive(Clone, Debug, Copy, PartialEq, Eq)]
/// Available layout extraction strategies.
enum LayoutBackend {
    BBox,
    PdfToHtml,
}

impl ExtractionOptions {
    fn from_env() -> Self {
        let pdftext_layout = env::var("PDFTEXT_LAYOUT").map(|v| v != "0").unwrap_or(true);
        let ocr_enabled = env::var("OCR_ENABLED").map(|v| v != "0").unwrap_or(true);
        let ocr_lang = env::var("OCR_LANG").unwrap_or_else(|_| "deu+eng".to_string());
        let ocr_psm = env::var("OCR_PSM").unwrap_or_else(|_| "6".to_string());
        let ocr_dpi = env::var("OCR_DPI")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(300);
        let ocr_min_nonws = env::var("OCR_MIN_NONWS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(24);
        let layout_enabled = env::var("LAYOUT_ENABLED").map(|v| v != "0").unwrap_or(true);
        let layout_backend = match env::var("LAYOUT_BACKEND")
            .unwrap_or_else(|_| "bbox".to_string())
            .to_ascii_lowercase()
            .as_str()
        {
            "pdftohtml" => LayoutBackend::PdfToHtml,
            _ => LayoutBackend::BBox,
        };
        let max_parallel_ocr = env::var("MAX_PARALLEL_OCR")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(2);

        Self {
            pdftext_layout,
            ocr_enabled,
            ocr_lang,
            ocr_psm,
            ocr_dpi,
            ocr_min_nonws,
            layout_enabled,
            layout_backend,
            max_parallel_ocr,
        }
    }
}

/// Determines if OCR should be executed for the provided text.
pub fn should_ocr(txt: &str) -> bool {
    let min_nonws = env::var("OCR_MIN_NONWS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(24);
    let count = txt.chars().filter(|c| !c.is_whitespace()).count();
    count < min_nonws
}

struct OcrResult {
    text: String,
    hocr: Option<String>,
}

struct TempImageGuard {
    path: String,
}

impl Drop for TempImageGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Perform OCR on a page rendered via pdftoppm.
pub async fn ocr_page(path: &str, page: i32) -> Result<String> {
    let options = ExtractionOptions::from_env();
    let res = perform_ocr(path, page, &options, false).await?;
    Ok(res.text)
}

async fn perform_ocr(
    path: &str,
    page: i32,
    options: &ExtractionOptions,
    capture_layout: bool,
) -> Result<OcrResult> {
    let prefix = std::env::temp_dir().join(format!("ocr_page_{}_{}", page, Uuid::new_v4()));
    let prefix_str = prefix
        .to_str()
        .ok_or_else(|| anyhow!("prefix path invalid utf8"))?
        .to_string();
    let png_path = format!("{prefix_str}.png");
    let _guard = TempImageGuard {
        path: png_path.clone(),
    };

    let mut render_cmd = Command::new("pdftoppm");
    render_cmd
        .arg("-r")
        .arg(options.ocr_dpi.to_string())
        .arg("-f")
        .arg(page.to_string())
        .arg("-l")
        .arg(page.to_string())
        .arg("-png")
        .arg("-singlefile")
        .arg(path)
        .arg(&prefix_str);

    let render_output = timeout(PROCESS_TIMEOUT, render_cmd.output())
        .await
        .context("timeout running pdftoppm")??;
    if !render_output.status.success() {
        return Err(anyhow!(
            "pdftoppm exit status on page {page}: {}",
            render_output.status
        ));
    }

    let mut text_cmd = Command::new("tesseract");
    text_cmd
        .arg(&png_path)
        .arg("stdout")
        .arg("-l")
        .arg(&options.ocr_lang)
        .arg("--psm")
        .arg(&options.ocr_psm);

    let text_output = timeout(PROCESS_TIMEOUT, text_cmd.output())
        .await
        .context("timeout running tesseract")??;
    if !text_output.status.success() {
        return Err(anyhow!(
            "tesseract exit status on page {page}: {}",
            text_output.status
        ));
    }
    let text = String::from_utf8(text_output.stdout).context("invalid utf8 from tesseract")?;

    let hocr = if capture_layout {
        let mut hocr_cmd = Command::new("tesseract");
        hocr_cmd
            .arg(&png_path)
            .arg("stdout")
            .arg("-l")
            .arg(&options.ocr_lang)
            .arg("--psm")
            .arg(&options.ocr_psm)
            .arg("hocr");
        let hocr_output = timeout(PROCESS_TIMEOUT, hocr_cmd.output())
            .await
            .context("timeout running tesseract hocr")??;
        if hocr_output.status.success() {
            Some(
                String::from_utf8(hocr_output.stdout)
                    .context("invalid utf8 from tesseract hocr")?,
            )
        } else {
            warn!(page = page - 1, "tesseract hocr failed");
            None
        }
    } else {
        None
    };

    Ok(OcrResult { text, hocr })
}

/// Extract per-page text (0-indexed page numbers) including OCR fallback and layout metadata.
pub async fn extract_text_pages(path: &str) -> Result<Vec<PageExtraction>> {
    let options = ExtractionOptions::from_env();
    let pages = detect_pages(path).await?;
    info!(pages, "detected pages");

    if pages <= 0 {
        return Ok(vec![]);
    }

    let semaphore = Arc::new(Semaphore::new(options.max_parallel_ocr));
    let mut join_set = JoinSet::new();

    for p in 1..=pages {
        let path = path.to_string();
        let semaphore = semaphore.clone();
        let options = options.clone();
        join_set.spawn(async move {
            let permit = semaphore
                .acquire_owned()
                .await
                .context("acquire semaphore")?;
            let res = process_page(&path, p, &options).await;
            drop(permit);
            res
        });
    }

    let mut collected = Vec::with_capacity(pages as usize);
    while let Some(joined) = join_set.join_next().await {
        match joined {
            Ok(Ok(page)) => collected.push(page),
            Ok(Err(err)) => return Err(err),
            Err(err) => return Err(anyhow!("page task join error: {err}")),
        }
    }

    collected.sort_by_key(|p| p.page_no);

    if collected.is_empty() {
        let fallback = extract_text(path).await?;
        return Ok(vec![PageExtraction {
            page_no: 0,
            text: fallback,
            ocr_used: false,
            layout: None,
        }]);
    }

    Ok(collected)
}

async fn process_page(
    path: &str,
    page: i32,
    options: &ExtractionOptions,
) -> Result<PageExtraction> {
    let pdftotext = run_pdftotext_page(path, page, options.pdftext_layout).await?;
    let text = String::from_utf8(pdftotext.stdout).context("invalid utf8 from pdftotext")?;
    info!(page = page - 1, "pdftotext ok");

    let non_ws = text.chars().filter(|c| !c.is_whitespace()).count();
    let mut final_text = text.clone();
    let mut ocr_used = false;
    let mut hocr_content = None;

    if options.ocr_enabled && (non_ws < options.ocr_min_nonws || should_ocr(&text)) {
        match perform_ocr(path, page, options, options.layout_enabled).await {
            Ok(result) => {
                let ocr_non_ws = result.text.chars().filter(|c| !c.is_whitespace()).count();
                if ocr_non_ws > non_ws {
                    final_text = result.text;
                    ocr_used = true;
                    hocr_content = result.hocr;
                    info!(page = page - 1, "ocr fallback used");
                }
            }
            Err(err) => {
                warn!(page = page - 1, error = %err, "ocr fallback failed");
            }
        }
    }

    let layout = if options.layout_enabled {
        if ocr_used {
            match hocr_content {
                Some(ref hocr) => match parse_hocr_layout(page - 1, hocr) {
                    Ok(layout) => {
                        info!(page = page - 1, words = layout.words.len(), "layout parsed");
                        Some(layout)
                    }
                    Err(err) => {
                        warn!(page = page - 1, error = %err, "layout parse failed");
                        None
                    }
                },
                None => None,
            }
        } else {
            match extract_vector_layout(path, page, options).await {
                Ok(Some(layout)) => {
                    info!(page = page - 1, words = layout.words.len(), "layout parsed");
                    Some(layout)
                }
                Ok(None) => None,
                Err(err) => {
                    warn!(page = page - 1, error = %err, "layout parse failed");
                    None
                }
            }
        }
    } else {
        None
    };

    Ok(PageExtraction {
        page_no: page - 1,
        text: final_text,
        ocr_used,
        layout,
    })
}

async fn detect_pages(path: &str) -> Result<i32> {
    let output = Command::new("pdfinfo")
        .arg(path)
        .output()
        .await
        .context("spawn pdfinfo")?;
    if !output.status.success() {
        return Ok(1);
    }
    let s = String::from_utf8_lossy(&output.stdout);
    let pages = s
        .lines()
        .find(|l| l.trim_start().starts_with("Pages:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|n| n.parse::<i32>().ok())
        .unwrap_or(1);
    Ok(pages)
}

async fn run_pdftotext_full(path: &str) -> Result<std::process::Output> {
    let mut cmd = Command::new("pdftotext");
    let use_layout = env::var("PDFTEXT_LAYOUT").map(|v| v != "0").unwrap_or(true);
    if use_layout {
        cmd.arg("-layout");
    }
    cmd.arg("-q").arg(path).arg("-");
    let output = timeout(PROCESS_TIMEOUT, cmd.output())
        .await
        .context("timeout running pdftotext")??;
    if !output.status.success() {
        return Err(anyhow!("pdftotext exit status: {}", output.status));
    }
    Ok(output)
}

async fn run_pdftotext_page(
    path: &str,
    page: i32,
    use_layout: bool,
) -> Result<std::process::Output> {
    let mut cmd = Command::new("pdftotext");
    if use_layout {
        cmd.arg("-layout");
    }
    cmd.arg("-q")
        .arg("-enc")
        .arg("UTF-8")
        .arg("-eol")
        .arg("unix")
        .arg("-f")
        .arg(page.to_string())
        .arg("-l")
        .arg(page.to_string())
        .arg(path)
        .arg("-");
    let output = timeout(PROCESS_TIMEOUT, cmd.output())
        .await
        .context("timeout running pdftotext page")??;
    if !output.status.success() {
        return Err(anyhow!(
            "pdftotext exit status on page {page}: {}",
            output.status
        ));
    }
    Ok(output)
}

async fn extract_vector_layout(
    path: &str,
    page: i32,
    options: &ExtractionOptions,
) -> Result<Option<PageLayout>> {
    match options.layout_backend {
        LayoutBackend::BBox => {
            let xml = run_pdftotext_bbox(path, page).await?;
            parse_bbox_layout(page - 1, &xml).map(Some)
        }
        LayoutBackend::PdfToHtml => {
            let xml = run_pdftohtml_xml(path, page).await?;
            parse_pdftohtml_layout(page - 1, &xml).map(Some)
        }
    }
}

async fn run_pdftotext_bbox(path: &str, page: i32) -> Result<String> {
    let mut cmd = Command::new("pdftotext");
    cmd.arg("-bbox")
        .arg("-enc")
        .arg("UTF-8")
        .arg("-q")
        .arg("-f")
        .arg(page.to_string())
        .arg("-l")
        .arg(page.to_string())
        .arg(path)
        .arg("-");
    let output = timeout(PROCESS_TIMEOUT, cmd.output())
        .await
        .context("timeout running pdftotext bbox")??;
    if !output.status.success() {
        return Err(anyhow!(
            "pdftotext -bbox exit status on page {page}: {}",
            output.status
        ));
    }
    let xml = String::from_utf8(output.stdout).context("invalid utf8 from pdftotext -bbox")?;
    Ok(xml)
}

async fn run_pdftohtml_xml(path: &str, page: i32) -> Result<String> {
    let mut cmd = Command::new("pdftohtml");
    cmd.arg("-xml")
        .arg("-i")
        .arg("-stdout")
        .arg("-f")
        .arg(page.to_string())
        .arg("-l")
        .arg(page.to_string())
        .arg(path);
    let output = timeout(PROCESS_TIMEOUT, cmd.output())
        .await
        .context("timeout running pdftohtml -xml")??;
    if !output.status.success() {
        return Err(anyhow!(
            "pdftohtml -xml exit status on page {page}: {}",
            output.status
        ));
    }
    let xml = String::from_utf8(output.stdout).context("invalid utf8 from pdftohtml -xml")?;
    Ok(xml)
}

// pdftotext -bbox verwendet xMin/yMin/xMax/yMax → gleiche Logik wie der xMin-Parser.
fn parse_bbox_layout(page_no: i32, xml: &str) -> Result<PageLayout> {
    parse_pdftohtml_layout(page_no, xml)
}

fn parse_pdftohtml_layout(page_no: i32, xml: &str) -> Result<PageLayout> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut buf = Vec::new();
    let mut words = Vec::new();
    let mut page_width = 0;
    let mut page_height = 0;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match e.name().as_ref() {
                b"page" => {
                    for attr in e.attributes() {
                        let attr = attr?;
                        let key = attr.key.as_ref();
                        if key == b"width" {
                            page_width = attr.unescape_value()?.parse().unwrap_or(0);
                        }
                        if key == b"height" {
                            page_height = attr.unescape_value()?.parse().unwrap_or(0);
                        }
                    }
                }
                b"word" => {
                    let mut coords = [0; 4];
                    let mut seen = [false; 4];
                    for attr in e.attributes() {
                        let attr = attr?;
                        let key = attr.key.as_ref();
                        let val = attr.unescape_value()?;
                        match key {
                            b"xMin" => {
                                coords[0] = val.parse().unwrap_or(0);
                                seen[0] = true;
                            }
                            b"yMin" => {
                                coords[1] = val.parse().unwrap_or(0);
                                seen[1] = true;
                            }
                            b"xMax" => {
                                coords[2] = val.parse().unwrap_or(0);
                                seen[2] = true;
                            }
                            b"yMax" => {
                                coords[3] = val.parse().unwrap_or(0);
                                seen[3] = true;
                            }
                            _ => {}
                        }
                    }
                    let text = reader.read_text(e.name())?;
                    if seen.iter().all(|v| *v) {
                        words.push(Word {
                            bbox: coords,
                            text: text.trim().to_string(),
                        });
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow!("pdftohtml xml parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(PageLayout {
        page_no,
        page_width,
        page_height,
        words,
    })
}

fn parse_hocr_layout(page_no: i32, hocr: &str) -> Result<PageLayout> {
    static WORD_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(
            r#"<span[^>]*class=['\"]ocrx_word['\"][^>]*title=['\"][^'\"]*bbox (?P<bbox>\d+ \d+ \d+ \d+)[^'\"]*['\"][^>]*>(?P<text>.*?)</span>"#,
        )
        .expect("valid regex")
    });
    static PAGE_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(
            r#"<div[^>]*class=['\"]ocr_page['\"][^>]*title=['\"][^'\"]*bbox (?P<bbox>\d+ \d+ \d+ \d+)[^'\"]*['\"]"#,
        )
        .expect("valid regex")
    });

    let mut page_width = 0;
    let mut page_height = 0;
    if let Some(cap) = PAGE_RE.captures(hocr) {
        if let Some(bbox) = cap.name("bbox") {
            let coords = parse_bbox_values(bbox.as_str());
            if coords.len() == 4 {
                page_width = *coords.get(2).unwrap_or(&0);
                page_height = *coords.get(3).unwrap_or(&0);
            }
        }
    }

    let mut words = Vec::new();
    for cap in WORD_RE.captures_iter(hocr) {
        if let (Some(bbox), Some(text_match)) = (cap.name("bbox"), cap.name("text")) {
            if let Some(word) = build_word(bbox.as_str(), text_match.as_str()) {
                words.push(word);
            }
        }
    }

    Ok(PageLayout {
        page_no,
        page_width,
        page_height,
        words,
    })
}

fn build_word(bbox: &str, text: &str) -> Option<Word> {
    let coords = parse_bbox_values(bbox);
    if coords.len() != 4 {
        return None;
    }
    let decoded = decode_html_entities(text).trim().to_string();
    if decoded.is_empty() {
        return None;
    }
    Some(Word {
        bbox: [coords[0], coords[1], coords[2], coords[3]],
        text: decoded,
    })
}

fn parse_bbox_values(raw: &str) -> Vec<i32> {
    raw.split_whitespace()
        .filter_map(|p| p.parse::<i32>().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hocr_layout_extracts_words() {
        let hocr = "<!DOCTYPE html><html><body><div class='ocr_page' id='page_1' title='bbox 0 0 200 300; ppageno 0'>\
            <span class='ocrx_word' id='word_1' title='bbox 10 20 60 50; x_wconf 95'>Hello</span>\
            <span class='ocrx_word' id='word_2' title='bbox 70 20 120 50; x_wconf 95'>World</span>\
            </div></body></html>";

        let layout = parse_hocr_layout(0, hocr).expect("parse hocr");
        assert_eq!(layout.page_no, 0);
        assert_eq!(layout.page_width, 200);
        assert_eq!(layout.page_height, 300);
        assert_eq!(layout.words.len(), 2);
        assert_eq!(layout.words[0].bbox, [10, 20, 60, 50]);
        assert_eq!(layout.words[0].text, "Hello");
        assert_eq!(layout.words[1].text, "World");
    }
}
