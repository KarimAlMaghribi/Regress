use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use actix_cors::Cors;
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
use postgres_native_tls::MakeTlsConnector;
use native_tls::TlsConnector;
use tesseract::Tesseract;
use tracing::{error, info};
use std::path::Path;
use pdf_extract::extract_text_from_mem;

fn extract_text(path: &str) -> Result<String> {
    info!(?path, "starting text extraction");
    if Path::new(path).extension().map(|e| e == "pdf").unwrap_or(false) {
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

#[derive(serde::Serialize)]
struct TextEntry {
    id: i32,
}

#[derive(serde::Deserialize)]
struct AnalysisReq {
    ids: Vec<i32>,
    prompt: String,
}

async fn list_texts(db: web::Data<tokio_postgres::Client>) -> actix_web::Result<HttpResponse> {
    let stmt = db
        .prepare("SELECT pdf_id FROM pdf_texts ORDER BY pdf_id DESC")
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let rows = db
        .query(&stmt, &[])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let items: Vec<TextEntry> = rows.into_iter().map(|r| TextEntry { id: r.get(0) }).collect();
    Ok(HttpResponse::Ok().json(items))
}

/// Publish `text-extracted` events for existing texts.
///
/// The endpoint does not run OCR again. It simply forwards the stored text so
/// classification can be repeated with a different prompt.
async fn start_analysis(
    db: web::Data<tokio_postgres::Client>,
    prod: web::Data<FutureProducer>,
    web::Json(req): web::Json<AnalysisReq>,
) -> actix_web::Result<HttpResponse> {
    for id in req.ids {
        let stmt = db
            .prepare("SELECT text FROM pdf_texts WHERE pdf_id = $1")
            .await
            .map_err(actix_web::error::ErrorInternalServerError)?;
        if let Ok(row) = db.query_one(&stmt, &[&id]).await {
            let text: String = row.get(0);
            let evt = TextExtracted { id, text, prompt: req.prompt.clone() };
            let payload = serde_json::to_string(&evt).unwrap();
            let _ = prod
                .send(
                    FutureRecord::to("text-extracted").payload(&payload).key(&()),
                    Duration::from_secs(0),
                )
                .await;
        }
    }
    Ok(HttpResponse::Ok().finish())
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting text-extraction service");
    let settings = Settings::new().unwrap();
    let tls_connector = TlsConnector::builder().build().unwrap();
    let connector = MakeTlsConnector::new(tls_connector);
    let (db_client, connection) =
        tokio_postgres::connect(&settings.database_url, connector)
            .await
            .unwrap();
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
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS uploads (id SERIAL PRIMARY KEY, pdf_id INTEGER, status TEXT NOT NULL)",
            &[],
        )
        .await
        .unwrap();
    info!("ensured uploads table exists");
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
    let db_consumer = db.clone();
    let producer_consumer = producer.clone();
    tokio::spawn(async move {
        let db = db_consumer;
        let cons = consumer;
        let prod = producer_consumer;
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
                                    let _ = db
                                        .execute(
                                            "UPDATE uploads SET status='ready' WHERE pdf_id=$1",
                                            &[&event.id],
                                        )
                                        .await;
                                    let evt = TextExtracted { id: event.id, text, prompt: event.prompt.clone() };
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
    let producer_data = web::Data::new(producer.clone());
    let db_data = db.clone();
    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(db_data.clone())
            .app_data(producer_data.clone())
            .route("/health", web::get().to(health))
            .route("/texts", web::get().to(list_texts))
            .route("/analyze", web::post().to(start_analysis))
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
}
