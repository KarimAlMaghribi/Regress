use actix::prelude::*;
use actix_cors::Cors;
use actix_web::web::Payload;
use actix_web::{web, App, Error, HttpRequest, HttpResponse, HttpServer, Responder};
use actix_web_actors::ws;
use chrono::{DateTime, Utc};
use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    ClientConfig, Message,
};
use serde::{Deserialize, Serialize};
use shared::config::Settings;
use std::collections::HashMap;
use tokio::sync::broadcast;
use tokio_postgres::NoTls;
use tracing::{error, info};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct HistoryEntry {
    id: String,
    prompt: Option<String>,
    result: Option<serde_json::Value>,
    pdf_url: String,
    timestamp: DateTime<Utc>,
    status: String,
    score: Option<f64>,
    result_label: Option<String>,
}

use std::sync::Arc;

struct AppState {
    db: Arc<tokio_postgres::Client>,
    tx: broadcast::Sender<HistoryEntry>,
    pdf_base: String,
}

async fn init_db(db: &tokio_postgres::Client) {
    db.execute(
        "CREATE TABLE IF NOT EXISTS classification_history (\
            id TEXT PRIMARY KEY,\
            prompt TEXT,\
            result JSONB,\
            pdf_url TEXT,\
            timestamp TIMESTAMPTZ,\
            status TEXT DEFAULT 'running',\
            score DOUBLE PRECISION,\
            result_label TEXT\
        )",
        &[],
    )
    .await
    .unwrap();
    db.execute(
        "ALTER TABLE classification_history ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'running'",
        &[],
    )
    .await
    .unwrap();
    db.execute(
        "ALTER TABLE classification_history ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION",
        &[],
    )
    .await
    .unwrap();
    db.execute(
        "ALTER TABLE classification_history ADD COLUMN IF NOT EXISTS result_label TEXT",
        &[],
    )
    .await
    .unwrap();
    info!("database schema ensured");
}

async fn mark_pending(db: &tokio_postgres::Client, entry: &HistoryEntry) {
    let _ = db
        .execute(
            "INSERT INTO classification_history (id, prompt, pdf_url, timestamp, status) \
             VALUES ($1,$2,$3,$4,'running') \
             ON CONFLICT (id) DO UPDATE SET \
               prompt=EXCLUDED.prompt, pdf_url=EXCLUDED.pdf_url, timestamp=EXCLUDED.timestamp, status='running'",
            &[&entry.id, &entry.prompt, &entry.pdf_url, &entry.timestamp],
        )
        .await;
}

async fn insert_result(db: &tokio_postgres::Client, entry: &HistoryEntry) {
    let _ = db
        .execute(
            "INSERT INTO classification_history (id, prompt, result, pdf_url, timestamp, status, score, result_label) \
             VALUES ($1,$2,$3,$4,$5,'completed',$6,$7) \
             ON CONFLICT (id) DO UPDATE SET \
               prompt=EXCLUDED.prompt, result=EXCLUDED.result, pdf_url=EXCLUDED.pdf_url, timestamp=EXCLUDED.timestamp, status='completed', score=EXCLUDED.score, result_label=EXCLUDED.result_label",
            &[
                &entry.id,
                &entry.prompt,
                &entry.result,
                &entry.pdf_url,
                &entry.timestamp,
                &entry.score,
                &entry.result_label,
            ],
        )
        .await;
}

async fn latest(db: &tokio_postgres::Client, limit: i64) -> Vec<HistoryEntry> {
    let stmt = db
        .prepare(
            "SELECT id, prompt, result, pdf_url, timestamp, status, score, result_label FROM classification_history ORDER BY timestamp DESC LIMIT $1",
        )
        .await
        .unwrap();
    let rows = db.query(&stmt, &[&limit]).await.unwrap();
    rows.into_iter()
        .map(|r| HistoryEntry {
            id: r.get(0),
            prompt: r.get(1),
            result: r.get(2),
            pdf_url: r.get(3),
            timestamp: r.get(4),
            status: r.get(5),
            score: r.get(6),
            result_label: r.get(7),
        })
        .collect()
}

async fn all_entries(db: &tokio_postgres::Client) -> Vec<HistoryEntry> {
    let stmt = db
        .prepare(
            "SELECT id, prompt, result, pdf_url, timestamp, status, score, result_label FROM classification_history ORDER BY timestamp DESC",
        )
        .await
        .unwrap();
    let rows = db.query(&stmt, &[]).await.unwrap();
    rows.into_iter()
        .map(|r| HistoryEntry {
            id: r.get(0),
            prompt: r.get(1),
            result: r.get(2),
            pdf_url: r.get(3),
            timestamp: r.get(4),
            status: r.get(5),
            score: r.get(6),
            result_label: r.get(7),
        })
        .collect()
}

async fn list_by_status(db: &tokio_postgres::Client, status: Option<String>) -> Vec<HistoryEntry> {
    let (sql, params): (&str, Vec<&(dyn tokio_postgres::types::ToSql + Sync)>) = if let Some(s) =
        &status
    {
        ("SELECT id, prompt, result, pdf_url, timestamp, status, score, result_label FROM classification_history WHERE status = $1 ORDER BY timestamp DESC", vec![s])
    } else {
        ("SELECT id, prompt, result, pdf_url, timestamp, status, score, result_label FROM classification_history ORDER BY timestamp DESC", vec![])
    };
    let stmt = db.prepare(sql).await.unwrap();
    let rows = db.query(&stmt, &params).await.unwrap();
    rows.into_iter()
        .map(|r| HistoryEntry {
            id: r.get(0),
            prompt: r.get(1),
            result: r.get(2),
            pdf_url: r.get(3),
            timestamp: r.get(4),
            status: r.get(5),
            score: r.get(6),
            result_label: r.get(7),
        })
        .collect()
}

async fn classifications(
    state: web::Data<AppState>,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    let limit = query
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(50);
    let items = latest(&state.db, limit).await;
    HttpResponse::Ok().json(items)
}

async fn analyses(
    state: web::Data<AppState>,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    let status = query.get("status").cloned();
    let items = list_by_status(&state.db, status).await;
    HttpResponse::Ok().json(items)
}

async fn health() -> impl Responder {
    "OK"
}

struct WsConn {
    db: Arc<tokio_postgres::Client>,
    rx: broadcast::Receiver<HistoryEntry>,
}

impl actix::Actor for WsConn {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        let db = self.db.clone();
        async move { all_entries(&db).await }
            .into_actor(self)
            .map(|entries, _act, ctx| {
                if let Ok(text) =
                    serde_json::to_string(&serde_json::json!({"type": "history", "data": entries}))
                {
                    ctx.text(text);
                }
            })
            .spawn(ctx);
        ctx.add_stream(tokio_stream::wrappers::BroadcastStream::new(
            self.rx.resubscribe(),
        ));
    }
}

use tokio_stream::wrappers::errors::BroadcastStreamRecvError;

impl actix::StreamHandler<Result<HistoryEntry, BroadcastStreamRecvError>> for WsConn {
    fn handle(
        &mut self,
        item: Result<HistoryEntry, BroadcastStreamRecvError>,
        ctx: &mut Self::Context,
    ) {
        match item {
            Ok(entry) => {
                if let Ok(text) =
                    serde_json::to_string(&serde_json::json!({"type": "update", "data": entry}))
                {
                    ctx.text(text);
                }
            }
            Err(BroadcastStreamRecvError::Lagged(_)) => {}
        }
    }
}

impl actix::StreamHandler<Result<ws::Message, ws::ProtocolError>> for WsConn {
    fn handle(&mut self, item: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match item {
            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            Ok(ws::Message::Close(_)) => ctx.stop(),
            _ => {}
        }
    }
}

async fn ws_index(
    req: HttpRequest,
    stream: Payload,
    state: web::Data<AppState>,
) -> Result<HttpResponse, Error> {
    let rx = state.tx.subscribe();
    let ws = WsConn {
        db: state.db.clone(),
        rx,
    };
    ws::start(ws, &req, stream)
}

async fn start_kafka(
    db: Arc<tokio_postgres::Client>,
    tx: broadcast::Sender<HistoryEntry>,
    settings: Settings,
    pdf_base: String,
) {
    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "history-service")
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();
    consumer
        .subscribe(&["pdf-uploaded", "classification-result"])
        .unwrap();
    info!("kafka consumer running");
    loop {
        match consumer.recv().await {
            Err(e) => error!(%e, "kafka error"),
            Ok(m) => {
                if let Some(Ok(payload)) = m.payload_view::<str>() {
                    match m.topic() {
                        "pdf-uploaded" => {
                            if let Ok(data) =
                                serde_json::from_str::<shared::dto::PdfUploaded>(payload)
                            {
                                let entry = HistoryEntry {
                                    id: data.id.to_string(),
                                    prompt: Some(data.prompt),
                                    result: None,
                                    pdf_url: format!("{}/pdf/{}", pdf_base, data.id),
                                    timestamp: Utc::now(),
                                    status: "running".into(),
                                    score: None,
                                    result_label: None,
                                };
                                mark_pending(&db, &entry).await;
                                let _ = tx.send(entry.clone());
                            }
                        }
                        "classification-result" => {
                            if let Ok(data) =
                                serde_json::from_str::<shared::dto::ClassificationResult>(payload)
                            {
                                let parsed = serde_json::from_str(&data.answer).unwrap_or_else(|_| serde_json::json!(data.answer));
                                let entry = HistoryEntry {
                                    id: data.id.to_string(),
                                    prompt: Some(data.prompt.clone()),
                                    result: Some(
                                        serde_json::json!({"regress": data.regress, "answers": parsed }),
                                    ),
                                    pdf_url: format!("{}/pdf/{}", pdf_base, data.id),
                                    timestamp: Utc::now(),
                                    status: "completed".into(),
                                    score: Some(data.score),
                                    result_label: Some(data.result_label),
                                };
                                insert_result(&db, &entry).await;
                                let _ = tx.send(entry.clone());
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting history-service");
    let settings = Settings::new().unwrap();
    let pdf_base =
        std::env::var("PDF_INGEST_URL").unwrap_or_else(|_| "http://localhost:8081".into());
    let (db_client, connection) = tokio_postgres::connect(&settings.database_url, NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    init_db(&db_client).await;
    let (tx, _) = broadcast::channel(100);
    let db = Arc::new(db_client);
    let state = web::Data::new(AppState {
        db: db.clone(),
        tx: tx.clone(),
        pdf_base: pdf_base.clone(),
    });
    let db_for_kafka = db.clone();
    let tx_for_kafka = tx.clone();
    actix_web::rt::spawn(start_kafka(db_for_kafka, tx_for_kafka, settings, pdf_base));
    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(state.clone())
            .route("/classifications", web::get().to(classifications))
            .route("/analyses", web::get().to(analyses))
            .route("/", web::get().to(ws_index))
            .route("/health", web::get().to(health))
    })
    .bind(("0.0.0.0", 8090))?
    .run()
    .await
}
