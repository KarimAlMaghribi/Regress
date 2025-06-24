use actix_web::{post, web, App, HttpResponse, HttpServer, Responder};
use serde::Deserialize;
use shared::{error::Result, config::Settings, dto::PdfUploaded};
use rdkafka::{consumer::{StreamConsumer, Consumer}, ClientConfig, Message};
use tokio_postgres::NoTls;
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
    let settings = Settings::new().unwrap();
    let (db_client, connection) = tokio_postgres::connect(&settings.database_url, NoTls).await.unwrap();
    tokio::spawn(async move { if let Err(e) = connection.await { eprintln!("db error: {e}") } });
    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "text-extraction")
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();
    consumer.subscribe(&["pdf-uploaded"]).unwrap();
    let db = web::Data::new(db_client);
    tokio::spawn(async move {
        let db = db.clone();
        let cons = consumer;
        loop {
            match cons.recv().await {
                Err(e) => eprintln!("kafka error: {e}"),
                Ok(m) => {
                    if let Some(payload) = m.payload_view::<str>().unwrap() {
                        if let Ok(event) = serde_json::from_str::<PdfUploaded>(payload) {
                            let stmt = db.prepare("SELECT data FROM pdfs WHERE id = $1").await.unwrap();
                            if let Ok(row) = db.query_one(&stmt, &[&event.id]).await {
                                let data: Vec<u8> = row.get(0);
                                let path = format!("/tmp/pdf_{}.pdf", event.id);
                                tokio::fs::write(&path, &data).await.unwrap();
                                if let Ok(text) = extract_text(&path) {
                                    info!("extracted text: {}", text);
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    HttpServer::new(|| App::new().service(extract))
        .bind(("0.0.0.0", 8083))?
        .run()
        .await
}
