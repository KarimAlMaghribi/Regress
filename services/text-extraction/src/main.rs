use actix_web::{post, web, App, HttpResponse, HttpServer, Responder};
use serde::Deserialize;
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

#[derive(Deserialize)]
struct ExtractRequest {
    path: String,
}

#[post("/extract")]
async fn extract(req: web::Json<ExtractRequest>) -> impl Responder {
    match extract_text(&req.path) {
        Ok(text) => HttpResponse::Ok().body(text),
        Err(e) => {
            HttpResponse::InternalServerError().body(format!("error: {}", e))
        }
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    let args: Vec<String> = std::env::args().collect();
    if let Some(p) = args.get(1) {
        let text = extract_text(p).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        info!("extracted text: {}", text);
        return Ok(());
    }
    if let Ok(p) = std::env::var("PDF_PATH") {
        let text = extract_text(&p).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        info!("extracted text: {}", text);
        return Ok(());
    }

    HttpServer::new(|| App::new().service(extract))
        .bind(("0.0.0.0", 8083))?
        .run()
        .await
}
