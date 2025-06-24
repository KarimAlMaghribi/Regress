use actix_web::{post, web, App, HttpResponse, HttpServer, Responder};
use serde::Deserialize;
use shared::{error::Result, config::Settings, dto::PdfUploaded};
use rdkafka::{consumer::{StreamConsumer, Consumer}, ClientConfig, Message};
use tokio_postgres::NoTls;
use tesseract::Tesseract;
use tracing::{debug, info, error};

fn extract_text(path: &str) -> Result<String> {
    debug!(?path, "extracting text");
    // Specify the language as an `Option<&str>` as required by `Tesseract::new`
    // `Tesseract::set_image` takes ownership of `self` and returns it again, so
    // reassign the returned value to preserve the instance for subsequent calls.
    let mut tess = Tesseract::new(None, Some("eng"))
        .map_err(|e| shared::error::AppError::Io(e.to_string()))?;
    tess = tess
        .set_image(path)
        .map_err(|e| shared::error::AppError::Io(e.to_string()))?;
    let text = tess
        .get_text()
        .map_err(|e| shared::error::AppError::Io(e.to_string()))?;
    debug!("extracted text length: {}", text.len());
    Ok(text)
}

#[derive(Debug, Deserialize)]
struct ExtractRequest {
    path: String,
}

#[post("/extract")]
async fn extract(req: web::Json<ExtractRequest>) -> impl Responder {
    info!(?req, "extract endpoint called");
    match extract_text(&req.path) {
        Ok(text) => HttpResponse::Ok().body(text),
        Err(e) => {
            error!(%e, "text extraction failed");
            HttpResponse::InternalServerError().body(format!("error: {}", e))
        }
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting text-extraction service");
    let settings = Settings::new().unwrap();
    let (db_client, connection) = tokio_postgres::connect(&settings.database_url, NoTls).await.unwrap();
    info!("connected to database");
    tokio::spawn(async move { if let Err(e) = connection.await { error!(%e, "db error") } });
    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "text-extraction")
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();
    consumer.subscribe(&["pdf-uploaded"]).unwrap();
    info!("kafka consumer subscribed to pdf-uploaded");
    let db = web::Data::new(db_client);
    tokio::spawn(async move {
        let db = db.clone();
        let cons = consumer;
        info!("starting kafka consume loop");
        loop {
            match cons.recv().await {
                Err(e) => error!(%e, "kafka error"),
                Ok(m) => {
                    if let Some(Ok(payload)) = m.payload_view::<str>() {
                        if let Ok(event) = serde_json::from_str::<PdfUploaded>(payload) {
                            info!(id = event.id, "received pdf-uploaded event");
                            let stmt = db.prepare("SELECT data FROM pdfs WHERE id = $1").await.unwrap();
                            if let Ok(row) = db.query_one(&stmt, &[&event.id]).await {
                                let data: Vec<u8> = row.get(0);
                                let path = format!("/tmp/pdf_{}.pdf", event.id);
                                tokio::fs::write(&path, &data).await.unwrap();
                                if let Ok(text) = extract_text(&path) {
                                    info!(id = event.id, "extracted text");
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    info!("starting http server on port 8083");
    HttpServer::new(|| App::new().service(extract))
        .bind(("0.0.0.0", 8083))?
        .run()
        .await
}
