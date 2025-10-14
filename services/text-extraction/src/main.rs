use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use rdkafka::{
    consumer::{CommitMode, Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use serde::Deserialize;
use shared::{
    config::Settings,
    dto::{PdfUploaded, TextExtracted},
    kafka,
};
use std::{str::FromStr, time::Duration};
use tokio_postgres::NoTls;
use tracing::{error, info, warn};
use uuid::Uuid;

use text_extraction::{extract_text_pages};

fn ensure_sslmode_disable(url: &str) -> String {
    if url.to_ascii_lowercase().contains("sslmode=") {
        return url.to_string();
    }

    let disable_for_local = url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_ascii_lowercase()))
        .map(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1"))
        .unwrap_or(false);

    if !disable_for_local {
        return url.to_string();
    }

    if url.contains('?') {
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

#[derive(Deserialize)]
struct AnalysisReq {
    ids: Vec<i32>,
    // prompt: String, // optional, falls du später was damit tust
}

async fn list_texts(db: web::Data<Pool>) -> actix_web::Result<HttpResponse> {
    let client = db
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let stmt = client
        .prepare("SELECT DISTINCT merged_pdf_id FROM pdf_texts ORDER BY merged_pdf_id DESC")
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let rows = client
        .query(&stmt, &[])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let items: Vec<TextEntry> = rows.into_iter().map(|r| TextEntry { id: r.get(0) }).collect();
    Ok(HttpResponse::Ok().json(items))
}

/// Bereits gespeicherten (seitenweise) Text erneut als `text-extracted` publizieren.
/// Kein erneutes OCR, nur Re-Emit.
async fn start_analysis(
    db: web::Data<Pool>,
    prod: web::Data<FutureProducer>,
    web::Json(req): web::Json<AnalysisReq>,
) -> actix_web::Result<HttpResponse> {
    let client = db
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let agg_stmt = client
        .prepare(
            "SELECT COALESCE(string_agg(text, E'\n' ORDER BY page_no), '')
             FROM pdf_texts WHERE merged_pdf_id = $1",
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    for id in req.ids {
        if let Ok(row) = client.query_one(&agg_stmt, &[&id]).await {
            let text: String = row.get(0);
            let evt = TextExtracted {
                pdf_id: id,
                pipeline_id: Uuid::nil(),
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
            info!(id, "re-published text-extracted event");
        }
    }
    Ok(HttpResponse::Ok().finish())
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting text-extraction service");

    let settings = Settings::new().unwrap();
    if let Err(e) =
        kafka::ensure_topics(&settings.message_broker_url, &["pdf-merged", "text-extracted"]).await
    {
        warn!(%e, "failed to ensure kafka topics");
    }

    // Deadpool-Pool (robuste Verbindungen, Recycle bei Fehlern)
    let db_url = ensure_sslmode_disable(&settings.database_url);
    let pg_cfg = tokio_postgres::Config::from_str(&db_url).map_err(|e| {
        error!(%e, "db parse failed");
        std::io::Error::new(std::io::ErrorKind::Other, "db-parse")
    })?;
    let mgr = Manager::from_config(
        pg_cfg,
        NoTls,
        ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        },
    );
    let pool = Pool::builder(mgr)
        .max_size(16)
        .build()
        .map_err(|e| {
            error!(%e, "db pool build failed");
            std::io::Error::new(std::io::ErrorKind::Other, "db-pool")
        })?;
    info!("created postgres pool");

    // Schema sicherstellen (idempotent)
    {
        let client = pool.get().await.map_err(|e| {
            error!(%e, "db get from pool failed");
            std::io::Error::new(std::io::ErrorKind::Other, "db-pool-get")
        })?;

        // Seitenweise Texte
        let _ = client
            .execute(
                "CREATE TABLE IF NOT EXISTS pdf_texts (
                    merged_pdf_id INTEGER NOT NULL,
                    page_no INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    UNIQUE (merged_pdf_id, page_no)
                 )",
                &[],
            )
            .await;

        // uploads (für Status-Update)
        let _ = client
            .execute(
                "CREATE TABLE IF NOT EXISTS uploads (
                    id SERIAL PRIMARY KEY,
                    pdf_id INTEGER,
                    pipeline_id UUID,
                    status TEXT NOT NULL
                 )",
                &[],
            )
            .await;
    }

    // Kafka Consumer/Producer
    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "text-extraction")
        .set("bootstrap.servers", &settings.message_broker_url)
        .set("enable.auto.commit", "false")
        .create()
        .map_err(|e| {
            error!(%e, "consumer");
            std::io::Error::new(std::io::ErrorKind::Other, "kafka")
        })?;
    consumer
        .subscribe(&["pdf-merged"])
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    info!("kafka consumer subscribed to pdf-merged");

    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .map_err(|e| {
            error!(%e, "producer");
            std::io::Error::new(std::io::ErrorKind::Other, "kafka")
        })?;

    // HTTP Server + DB/Producer Handles
    let db_pool = web::Data::new(pool.clone());
    let producer_http = web::Data::new(producer.clone());

    // Kafka-Loop
    {
        let pool_consume = pool.clone();
        let producer_consume = producer.clone();
        tokio::spawn(async move {
            info!("starting kafka consume loop");
            loop {
                match consumer.recv().await {
                    Err(e) => error!(%e, "kafka error"),
                    Ok(m) => {
                        if let Some(Ok(payload)) = m.payload_view::<str>() {
                            match serde_json::from_str::<PdfUploaded>(payload) {
                                Ok(evt) => {
                                    info!(id = evt.pdf_id, "received pdf-merged event");

                                    let mut client = match pool_consume.get().await {
                                        Ok(c) => c,
                                        Err(e) => {
                                            error!(%e, "db pool get failed");
                                            continue;
                                        }
                                    };

                                    let row = match client
                                        .query_opt(
                                            "SELECT data FROM merged_pdfs WHERE id = $1",
                                            &[&evt.pdf_id],
                                        )
                                        .await
                                    {
                                        Ok(Some(r)) => r,
                                        Ok(None) => {
                                            error!(id = evt.pdf_id, "pdf row not found");
                                            continue;
                                        }
                                        Err(e) => {
                                            error!(%e, "query pdf row failed");
                                            continue;
                                        }
                                    };
                                    let data: Vec<u8> = row.get(0);

                                    // temporäre Datei
                                    let path = format!("/tmp/pdf_{}.pdf", evt.pdf_id);
                                    if let Err(e) = tokio::fs::write(&path, &data).await {
                                        error!(%e, id = evt.pdf_id, "write temp pdf failed");
                                        continue;
                                    }
                                    info!(
                                        step = "tempfile.write.ok",
                                        id = evt.pdf_id,
                                        path = %path,
                                        bytes = data.len(),
                                        "temp pdf written"
                                    );

                                    // Seiten extrahieren
                                    let pages = match extract_text_pages(&path).await {
                                        Ok(v) => v,
                                        Err(e) => {
                                            error!(%e, id = evt.pdf_id, "text extraction failed");
                                            let _ = tokio::fs::remove_file(&path).await;
                                            continue;
                                        }
                                    };
                                    let concat = pages
                                        .iter()
                                        .map(|(_, t)| t.as_str())
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                        .to_lowercase();

                                    // Transaktion: alte Seiten löschen, neue speichern
                                    let tx = match client.transaction().await {
                                        Ok(t) => t,
                                        Err(e) => {
                                            error!(%e, "begin tx failed");
                                            let _ = tokio::fs::remove_file(&path).await;
                                            continue;
                                        }
                                    };
                                    if let Err(e) = tx
                                        .execute(
                                            "DELETE FROM pdf_texts WHERE merged_pdf_id=$1",
                                            &[&evt.pdf_id],
                                        )
                                        .await
                                    {
                                        error!(%e, "delete old pages failed");
                                        let _ = tx.rollback().await;
                                        let _ = tokio::fs::remove_file(&path).await;
                                        continue;
                                    }
                                    let ins = match tx
                                        .prepare("INSERT INTO pdf_texts (merged_pdf_id, page_no, text)
                                                  VALUES ($1,$2,$3)
                                                  ON CONFLICT (merged_pdf_id, page_no)
                                                  DO UPDATE SET text=EXCLUDED.text")
                                        .await
                                    {
                                        Ok(s) => s,
                                        Err(e) => {
                                            error!(%e, "prepare insert failed");
                                            let _ = tx.rollback().await;
                                            let _ = tokio::fs::remove_file(&path).await;
                                            continue;
                                        }
                                    };
                                    let mut ok = true;
                                    for (page_no, txt) in pages {
                                        if let Err(e) = tx
                                            .execute(
                                                &ins,
                                                &[&evt.pdf_id, &page_no, &txt.to_lowercase()],
                                            )
                                            .await
                                        {
                                            error!(%e, page_no, "insert page failed");
                                            ok = false;
                                            break;
                                        }
                                    }
                                    if ok {
                                        if let Err(e) = tx.commit().await {
                                            error!(%e, "commit failed");
                                            ok = false;
                                        }
                                    } else {
                                        let _ = tx.rollback().await;
                                    }
                                    if !ok {
                                        let _ = tokio::fs::remove_file(&path).await;
                                        continue;
                                    }
                                    info!(id = evt.pdf_id, "stored per-page text");

                                    // Upload-Status aktualisieren (best effort)
                                    let _ = client
                                        .execute(
                                            "UPDATE uploads SET status='ready' WHERE pdf_id=$1",
                                            &[&evt.pdf_id],
                                        )
                                        .await;

                                    // Event publizieren
                                    let out = TextExtracted {
                                        pdf_id: evt.pdf_id,
                                        pipeline_id: evt.pipeline_id,
                                        text: concat,
                                    };
                                    if let Ok(payload) = serde_json::to_string(&out) {
                                        let _ = producer_consume
                                            .send(
                                                FutureRecord::to("text-extracted")
                                                    .payload(&payload)
                                                    .key(&()),
                                                Duration::from_secs(0),
                                            )
                                            .await;
                                        info!(
                                            step = "kafka.produce.ok",
                                            topic = "text-extracted",
                                            id = out.pdf_id
                                        );
                                    }

                                    // Commit Kafka offset
                                    if let Err(e) = consumer.commit_message(&m, CommitMode::Async) {
                                        error!(%e, "commit failed");
                                    } else {
                                        info!(step = "kafka.commit.ok", id = evt.pdf_id);
                                    }

                                    // Cleanup
                                    let _ = tokio::fs::remove_file(&path).await;
                                    info!(step = "tempfile.cleanup.ok", path = %path);
                                }
                                Err(e) => error!(%e, "failed to parse pdf-merged payload"),
                            }
                        }
                    }
                }
            }
        });
    }

    // HTTP-Server
    info!("starting http server on port 8083");
    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(db_pool.clone())
            .app_data(producer_http.clone())
            .route("/health", web::get().to(health))
            .route("/texts", web::get().to(list_texts))
            .route("/analyze", web::post().to(start_analysis))
    })
        .bind(("0.0.0.0", 8083))?
        .run()
        .await
}
