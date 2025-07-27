use tracing::{info, error};
use pdf_extract::extract_text_from_mem;
use tesseract::Tesseract;
use std::path::Path;
use shared::error::Result;

pub fn extract_text(path: &str) -> Result<String> {
    info!(?path, "starting text extraction");
    if Path::new(path).extension().map(|e| e == "pdf").unwrap_or(false) {
        if let Ok(data) = std::fs::read(path) {
            match extract_text_from_mem(&data) {
                Ok(text) => { info!(len = text.len(), "pdf text extracted"); return Ok(text); }
                Err(e) => { error!(%e, "pdf extraction failed, falling back to ocr"); }
            }
        }
    }
    let mut tess = Tesseract::new(None, Some("eng")).map_err(|e| shared::error::AppError::Io(e.to_string()))?;
    tess = tess.set_image(path).map_err(|e| shared::error::AppError::Io(e.to_string()))?;
    let text = tess.get_text().map_err(|e| shared::error::AppError::Io(e.to_string()))?;
    info!(len = text.len(), "ocr finished");
    Ok(text)
}

pub async fn extract_text_layout(path: &str) -> anyhow::Result<String> {
    let txt = tokio::task::spawn_blocking(move || extract_text(path)).await??;
    let cleaned = txt
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(cleaned)
}
