use shared::error::Result;
use tesseract::Tesseract;
use tracing::info;

fn extract_text(path: &str) -> Result<String> {
    // Specify the language as an `Option<&str>` as required by `Tesseract::new`
    // `Tesseract::set_image` takes ownership of `self` and returns it again, so
    // reassign the returned value to preserve the instance for subsequent calls.
    let mut tess = Tesseract::new(None, Some("eng"))
        .map_err(|e| shared::error::AppError::Io(e.to_string()))?;
    tess = tess
        .set_image(path)
        .map_err(|e| shared::error::AppError::Io(e.to_string()))?;
    tess.get_text()
        .map_err(|e| shared::error::AppError::Io(e.to_string()))
}

fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let args: Vec<String> = std::env::args().collect();
    let path = if let Some(p) = args.get(1) {
        p.to_owned()
    } else if let Ok(p) = std::env::var("PDF_PATH") {
        p
    } else {
        return Err(shared::error::AppError::Io(
            "missing PDF path argument or PDF_PATH env var".into(),
        ));
    };
    let text = extract_text(&path)?;
    info!("extracted text: {}", text);
    Ok(())
}
