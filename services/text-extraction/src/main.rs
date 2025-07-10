use actix_cors::Cors;
use actix_web::{web, App, HttpServer, Responder};
use pdf_extract::extract_text_from_mem;
use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use serde::Serialize;
use shared::{
    config::Settings,
    dto::{PdfUploaded, TextExtracted},
    error::Result,
};
use std::path::Path;
use std::time::Duration;
use tesseract::Tesseract;
use tokio_postgres::NoTls;
use tracing::{error, info};

fn extract_text(path: &str) -> Result<String> {
    info!(?path, "starting text extraction");
    if Path::new(path)
        .extension()
        .map(|e| e == "pdf")
        .unwrap_or(false)
    {
        if let Ok(data) = std::fs::read(path) {
            match extract_text_from_mem(&data) {
                Ok(text) => {
                    info!(len = text.len(), "pdf text extracted");
                    return Ok(text);
                }
                Err(e) => {
                    error!(%e, "pdf extraction failed, falling back to ocr");
                }
            }
        }
    }

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

async fn health() -> impl Responder {
    "OK"
}

#[derive(Serialize)]
struct TextInfo {
    id: i32,
}

async fn texts(db: web::Data<tokio_postgres::Client>) -> actix_web::Result<impl Responder> {
    let rows = db
        .query("SELECT pdf_id FROM pdf_texts ORDER BY pdf_id", &[])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let items: Vec<TextInfo> = rows
        .into_iter()
        .map(|r| TextInfo { id: r.get(0) })
        .collect();
    Ok(web::Json(items))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting text-extraction service");
    let settings = Settings::new().unwrap();
    let (db_client, connection) = tokio_postgres::connect(&settings.database_url, NoTls)
        .await
        .unwrap();
    info!("connected to database");
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            error!(%e, "db error")
        }
    });
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
                            let stmt = db
                                .prepare("SELECT data FROM pdfs WHERE id = $1")
                                .await
                                .unwrap();
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
                                    let evt = TextExtracted {
                                        id: event.id,
                                        text,
                                        prompt: event.prompt.clone(),
                                    };
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
    HttpServer::new(move || {
        let db = db.clone();
        App::new()
            .wrap(Cors::permissive())
            .route("/health", web::get().to(health))
            .app_data(db.clone())
            .route("/texts", web::get().to(texts))
    })
    .bind(("0.0.0.0", 8083))?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, App};

    #[actix_web::test]
    async fn health_ok() {
        let app = test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }

    #[actix_web::test]
    async fn texts_empty() {
        let db_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres:postgres@localhost/postgres".into());
        if let Ok((client, connection)) = tokio_postgres::connect(&db_url, NoTls).await {
            tokio::spawn(async move {
                let _ = connection.await;
            });
            client.execute("CREATE TABLE IF NOT EXISTS pdf_texts (pdf_id INTEGER PRIMARY KEY, text TEXT NOT NULL)", &[]).await.unwrap();
            let app = test::init_service(
                App::new()
                    .app_data(web::Data::new(client))
                    .route("/texts", web::get().to(texts)),
            )
            .await;
            let req = test::TestRequest::get().uri("/texts").to_request();
            let resp = test::call_and_read_body(&app, req).await;
            assert_eq!(resp, b"[]");
        }
    }
}
