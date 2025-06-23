use shared::error::Result;
use tesseract::Tesseract;
use tracing::info;

fn extract_text(path: &str) -> Result<String> {
    let mut tess = Tesseract::new(None, "eng").map_err(|e| shared::error::AppError::Io(e.to_string()))?;
    tess.set_image(path).map_err(|e| shared::error::AppError::Io(e.to_string()))?;
    tess.get_text().map_err(|e| shared::error::AppError::Io(e.to_string()))
}

fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let text = extract_text("sample.pdf")?;
    info!("extracted text: {}", text);
    Ok(())
}
