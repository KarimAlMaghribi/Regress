use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use rdkafka::{
    consumer::{CommitMode, Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use shared::{
    config::Settings,
    db,
    dto::{PdfUploaded, TextExtracted},
    kafka,
};
use std::time::Duration;
use text_extraction::extract_text;
use tokio_postgres::NoTls;
use tracing::{error, info, warn};

fn ensure_sslmode_disable(url: &str) -> String {
    let lower = url.to_lowercase();
    if lower.contains("sslmode=") {
        url.to_string()
    } else if url.contains('?') {
        format!("{url}&sslmode=disable")
    } else {
        format!("{url}?sslmode=disable")
    }
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
        .prepare("SELECT DISTINCT merged_pdf_id FROM pdf_texts ORDER BY merged_pdf_id DESC")
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let rows = db
        .query(&stmt, &[])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let items: Vec<TextEntry> = rows
        .into_iter()
        .map(|r| TextEntry { id: r.get(0) })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}

/// Re-emit stored texts as `text-extracted` events (kein erneutes OCR).
async fn start_analysis(
    db: web::Data<tokio_postgres::Client>,
    prod: web::Data<FutureProducer>,
    web::Json(req): web::Json<AnalysisReq>,
) -> actix_web::Result<HttpResponse> {
    for id in req.ids {
        let stmt = db
            .prepare("SELECT COALESCE(string_agg(text, E'\n' ORDER BY page_no), '') FROM pdf_texts WHERE merged_pdf_id = $1")
            .await
            .map_err(actix_web::error::ErrorInternalServerError)?;
        if let Ok(row) = db.query_one(&stmt, &[&id]).await {
            let text: String = row.get(0);
            let evt = TextExtracted {
                pdf_id: id,
                pipeline_id: uuid::Uuid::nil(),
                text,
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
        }
    }
    Ok(HttpResponse::Ok().finish())
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting text-extraction service");
    let settings = Settings::new().unwrap();
    if let Err(e) = kafka::ensure_topics(
        &settings.message_broker_url,
        &["pdf-merged", "text-extracted"],
    )
    .await
    {
        warn!(%e, "failed to ensure kafka topics");
    }

    let db_url = ensure_sslmode_disable(&settings.database_url);
    let (db_client, connection) = tokio_postgres::connect(&db_url, NoTls).await.map_err(|e| {
        error!(%e, "db connect failed");
        std::io::Error::new(std::io::ErrorKind::Other, "db")
    })?;
    info!("connected to database (NoTLS)");

    tokio::spawn(async move {
        if let Err(e) = connection.await {
            error!(%e, "db connection task error");
        }
    });

    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS pdf_texts (
                merged_pdf_id INTEGER NOT NULL,
                page_no INTEGER NOT NULL,
                text TEXT NOT NULL,
                UNIQUE (merged_pdf_id, page_no)
            )",
            &[],
        )
        .await
        .ok();
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS uploads (id SERIAL PRIMARY KEY, pdf_id INTEGER, status TEXT NOT NULL)",
            &[],
        )
        .await
        .ok();
    db_client
        .execute(
            "ALTER TABLE uploads ADD COLUMN IF NOT EXISTS pipeline_id UUID",
            &[],
        )
        .await
        .ok();

    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "text-extraction")
        .set("bootstrap.servers", &settings.message_broker_url)
        .set("enable.auto.commit", "false")
        .create()
        .map_err(|e| {
            error!(%e, "consumer");
            std::io::Error::new(std::io::ErrorKind::Other, "kafka")
        })?;
    consumer.subscribe(&["pdf-merged"]).map_err(|e| {
        error!(%e, "subscribe");
        std::io::Error::new(std::io::ErrorKind::Other, "kafka")
    })?;
    info!("kafka consumer subscribed to pdf-merged");

    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .map_err(|e| {
            error!(%e, "producer");
            std::io::Error::new(std::io::ErrorKind::Other, "kafka")
        })?;

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
                        match serde_json::from_str::<PdfUploaded>(payload) {
                            Ok(event) => {
                                info!(
                                    step = "consume.received",
                                    id = event.pdf_id,
                                    "received pdf-merged event"
                                );
                                let data = match db::fetch_pdf(&db, event.pdf_id).await {
                                    Ok(d) => d,
                                    Err(e) => {
                                        error!(%e, id = event.pdf_id, "no pdf data");
                                        continue;
                                    }
                                };
                                let path = format!("/tmp/pdf_{}.pdf", event.pdf_id);
                                if let Err(e) = tokio::fs::write(&path, &data).await {
                                    error!(%e, id = event.pdf_id, "write temp pdf failed");
                                    continue;
                                }
                                info!(step = "tempfile.write.ok", id = event.pdf_id, path = %path, bytes = data.len(), "temp pdf written");
                                let text_raw = match extract_text(&path).await {
                                    Ok(t) => {
                                        info!(
                                            step = "extract.ok",
                                            id = event.pdf_id,
                                            "extracted text"
                                        );
                                        t
                                    }
                                    Err(e) => {
                                        let reason = format!("EXTRACT_FAILED:{e}");
                                        error!(%e, id = event.pdf_id, "text extraction failed");
                                        reason
                                    }
                                };
                                let text = text_raw.to_lowercase();
                                let stmt_up = match db
                                    .prepare(
                                        "INSERT INTO pdf_texts (merged_pdf_id, page_no, text) VALUES ($1,$2,$3) ON CONFLICT (merged_pdf_id, page_no) DO UPDATE SET text = EXCLUDED.text",
                                    )
                                    .await
                                {
                                    Ok(s) => s,
                                    Err(e) => {
                                        error!(%e, "prepare upsert");
                                        continue;
                                    }
                                };
                                if let Err(e) =
                                    db.execute(&stmt_up, &[&event.pdf_id, &0, &text]).await
                                {
                                    error!(%e, id = event.pdf_id, "store text failed");
                                    continue;
                                }
                                info!(id = event.pdf_id, "stored ocr text");
                                info!(
                                    step = "db.upsert.ok",
                                    id = event.pdf_id,
                                    table = "pdf_texts",
                                    "text upserted"
                                );
                                let _ = db
                                    .execute(
                                        "UPDATE uploads SET status='ready' WHERE pdf_id=$1",
                                        &[&event.pdf_id],
                                    )
                                    .await;
                                let evt = TextExtracted {
                                    pdf_id: event.pdf_id,
                                    pipeline_id: event.pipeline_id,
                                    text: text.clone(),
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
                                info!(id = evt.pdf_id, "published text-extracted event");
                                info!(
                                    step = "kafka.produce.ok",
                                    topic = "text-extracted",
                                    id = evt.pdf_id
                                );
                                if let Err(e) = cons.commit_message(&m, CommitMode::Async) {
                                    error!(%e, "commit failed");
                                } else {
                                    info!(
                                        step = "kafka.commit.ok",
                                        id = event.pdf_id,
                                        "offset committed"
                                    );
                                }
                                let _ = tokio::fs::remove_file(&path).await;
                                info!(step = "tempfile.cleanup.ok", path = %path, "temp pdf removed");
                            }
                            Err(e) => error!(%e, "failed to parse pdf-merged payload"),
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
