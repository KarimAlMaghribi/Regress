use actix_web::{post, web, App, HttpResponse, HttpServer, Responder};
use serde::Deserialize;
use shared::{
    config::Settings,
    dto::{PdfUploaded, TextExtracted},
    error::Result,
};
use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use std::time::Duration;
use tokio_postgres::NoTls;
use tesseract::Tesseract;
use tracing::{debug, error, info};

fn extract_text(path: &str) -> Result<String> {
    info!(?path, "starting ocr");
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
    info!(len = text.len(), "ocr finished");
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

async fn health() -> impl Responder {
    "OK"
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting text-extraction service");
    let settings = Settings::new().unwrap();
    let (db_client, connection) = tokio_postgres::connect(&settings.database_url, NoTls).await.unwrap();
    info!("connected to database");
    tokio::spawn(async move { if let Err(e) = connection.await { error!(%e, "db error") } });
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS pdf_texts (pdf_id INTEGER PRIMARY KEY, text TEXT NOT NULL)",
            &[],
        )
        .await
        .unwrap();
    info!("ensured pdf_texts table exists");
    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "text-extraction")
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();
    consumer.subscribe(&["pdf-uploaded"]).unwrap();
    info!("kafka consumer subscribed to pdf-uploaded");
    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();
    let db = web::Data::new(db_client);
    tokio::spawn(async move {
        let db = db.clone();
        let cons = consumer;
        let prod = producer;
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
                                    let text = text.to_lowercase();
                                    info!(id = event.id, "extracted text");
                                    let stmt = db
                                        .prepare(
                                            "INSERT INTO pdf_texts (pdf_id, text) VALUES ($1, $2) \
         ON CONFLICT (pdf_id) DO UPDATE SET text = EXCLUDED.text",
                                        )
                                        .await
                                        .unwrap();
                                    if let Err(e) = db.execute(&stmt, &[&event.id, &text]).await {
                                        error!(%e, id = event.id, "failed to store text");
                                        continue;
                                    }
                                    info!(id = event.id, "stored ocr text");
                                    let evt = TextExtracted { id: event.id, text };
                                    let payload = serde_json::to_string(&evt).unwrap();
                                    let _ = prod
                                        .send(
                                            FutureRecord::to("text-extracted")
                                                .payload(&payload)
                                                .key(&()),
                                            Duration::from_secs(0),
                                        )
                                        .await;
                                    info!(id = evt.id, "published text-extracted event");
                                    let _ = tokio::fs::remove_file(&path).await;
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    info!("starting http server on port 8083");
    HttpServer::new(|| {
        App::new()
            .service(extract)
            .route("/health", web::get().to(health))
    })
        .bind(("0.0.0.0", 8083))?
        .run()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, App};

    #[actix_rt::test]
    async fn health_ok() {
        let app = test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }
}
