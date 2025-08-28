use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use shared::{
    config::Settings,
    dto::{PdfUploaded, TextExtracted},
    kafka,
};
use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use std::time::Duration;
use tokio_postgres::NoTls;
use tracing::{error, info, warn};
use text_extraction::{extract_text, extract_text_layout};

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

/// Hilfsfunktion: sslmode=disable anhängen, wenn nicht gesetzt.
fn ensure_sslmode_disable(url: &str) -> String {
    if url.contains("sslmode=") {
        url.to_string()
    } else if url.contains('?') {
        format!("{url}&sslmode=disable")
    } else {
        format!("{url}?sslmode=disable")
    }
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

/// Published `text-extracted` Events für vorhandene Texte (keine neue OCR).
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
            let evt = TextExtracted {
                pdf_id: id,
                pipeline_id: uuid::Uuid::nil(),
                text,
            };
            if let Ok(payload) = serde_json::to_string(&evt) {
                let _ = prod
                    .send(
                        FutureRecord::to("text-extracted").payload(&payload).key(&()),
                        Duration::from_secs(0),
                    )
                    .await;
            }
        }
    }
    Ok(HttpResponse::Ok().finish())
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting text-extraction service");

    // Settings laden
    let settings = match Settings::new() {
        Ok(s) => s,
        Err(e) => {
            error!(%e, "failed to load settings");
            std::process::exit(1);
        }
    };

    // Kafka Topics sicherstellen
    if let Err(e) =
        kafka::ensure_topics(&settings.message_broker_url, &["pdf-merged", "text-extracted"]).await
    {
        warn!(%e, "failed to ensure kafka topics");
    }

    // DB-Verbindung ohne TLS
    let db_url = ensure_sslmode_disable(&settings.database_url);
    let (db_client, connection) = match tokio_postgres::connect(&db_url, NoTls).await {
        Ok(c) => c,
        Err(e) => {
            error!(%e, db_url=%db_url, "failed to connect to Postgres (NoTLS)");
            std::process::exit(1);
        }
    };
    info!("connected to database (NoTLS)");
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            error!(%e, "postgres connection task error");
        }
    });

    // Tabellen sicherstellen (idempotent)
    if let Err(e) = db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS pdf_texts (
                pdf_id INTEGER PRIMARY KEY,
                text    TEXT NOT NULL
             )",
            &[],
        )
        .await
    {
        error!(%e, "failed to ensure table pdf_texts");
        std::process::exit(1);
    }

    if let Err(e) = db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS uploads (
                id SERIAL PRIMARY KEY,
                pdf_id INTEGER,
                pipeline_id UUID,
                status TEXT NOT NULL
             )",
            &[],
        )
        .await
    {
        error!(%e, "failed to ensure table uploads");
        std::process::exit(1);
    }

    // Optional (gelesen von pdfs.data) – nur erstellen, falls nicht vorhanden
    if let Err(e) = db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS pdfs (
                id SERIAL PRIMARY KEY,
                data BYTEA NOT NULL
             )",
            &[],
        )
        .await
    {
        error!(%e, "failed to ensure table pdfs");
        std::process::exit(1);
    }

    // Kafka Consumer/Producer
    let consumer: StreamConsumer = match ClientConfig::new()
        .set("group.id", "text-extraction")
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
    {
        Ok(c) => c,
        Err(e) => {
            error!(%e, "failed to create kafka consumer");
            std::process::exit(1);
        }
    };
    if let Err(e) = consumer.subscribe(&["pdf-merged"]) {
        error!(%e, "failed to subscribe to pdf-merged");
        std::process::exit(1);
    }
    info!("kafka consumer subscribed to pdf-merged");

    let producer: FutureProducer = match ClientConfig::new()
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
    {
        Ok(p) => p,
        Err(e) => {
            error!(%e, "failed to create kafka producer");
            std::process::exit(1);
        }
    };

    let db = web::Data::new(db_client);
    let db_consumer = db.clone();
    let producer_consumer = producer.clone();

    // Consume-Loop
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
                        match serde_json::from_str::<PdfUploaded>(payload) {
                            Ok(event) => {
                                info!(id = event.pdf_id, "received pdf-merged event");
                                let stmt = match db.prepare("SELECT data FROM pdfs WHERE id = $1").await {
                                    Ok(s) => s,
                                    Err(e) => {
                                        error!(%e, "failed to prepare pdf fetch");
                                        continue;
                                    }
                                };
                                match db.query_one(&stmt, &[&event.pdf_id]).await {
                                    Err(e) => error!(%e, id = event.pdf_id, "failed to load pdf data"),
                                    Ok(row) => {
                                        let data: Vec<u8> = row.get(0);
                                        let path = format!("/tmp/pdf_{}.pdf", event.pdf_id);
                                        if let Err(e) = tokio::fs::write(&path, &data).await {
                                            error!(%e, id = event.pdf_id, "failed to write temp pdf");
                                            continue;
                                        }
                                        // OCR / Text-Extraktion
                                        match extract_text_layout(&path).await
                                            .or_else(|_| extract_text(&path).await)
                                        {
                                            Ok(text_raw) => {
                                                let text = text_raw.to_lowercase();
                                                info!(id = event.pdf_id, "extracted text");
                                                let stmt = match db.prepare(
                                                    "INSERT INTO pdf_texts (pdf_id, text)
                                                     VALUES ($1, $2)
                                                     ON CONFLICT (pdf_id)
                                                     DO UPDATE SET text = EXCLUDED.text",
                                                ).await {
                                                    Ok(s) => s,
                                                    Err(e) => {
                                                        error!(%e, "failed to prepare insert pdf_texts");
                                                        let _ = tokio::fs::remove_file(&path).await;
                                                        continue;
                                                    }
                                                };
                                                if let Err(e) = db.execute(&stmt, &[&event.pdf_id, &text]).await {
                                                    error!(%e, id = event.pdf_id, "failed to store text");
                                                    let _ = tokio::fs::remove_file(&path).await;
                                                    continue;
                                                }
                                                info!(id = event.pdf_id, "stored ocr text");

                                                let _ = db
                                                    .execute(
                                                        "UPDATE uploads SET status='ready' WHERE pdf_id=$1",
                                                        &[&event.pdf_id],
                                                    )
                                                    .await;

                                                // Event veröffentlichen
                                                let evt = TextExtracted {
                                                    pdf_id: event.pdf_id,
                                                    pipeline_id: event.pipeline_id,
                                                    text,
                                                };
                                                if let Ok(payload) = serde_json::to_string(&evt) {
                                                    let _ = prod
                                                        .send(
                                                            FutureRecord::to("text-extracted")
                                                                .payload(&payload)
                                                                .key(&()),
                                                            Duration::from_secs(0),
                                                        )
                                                        .await;
                                                    info!(id = evt.pdf_id, "published text-extracted event");
                                                }
                                                let _ = tokio::fs::remove_file(&path).await;
                                            }
                                            Err(e) => {
                                                error!(%e, id = event.pdf_id, "text extraction failed");
                                                let _ = tokio::fs::remove_file(&path).await;
                                            }
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                warn!(%e, "failed to parse pdf-merged payload");
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
