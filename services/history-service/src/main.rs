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
use postgres_native_tls::MakeTlsConnector;
use native_tls::TlsConnector;
use tracing::{error, info};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct HistoryEntry {
    /// Unique identifier for this analysis run
    id: i32,
    /// ID of the processed PDF
    pdf_id: i32,
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
        "CREATE TABLE IF NOT EXISTS analysis_history (\
            id SERIAL PRIMARY KEY,\
            pdf_id INTEGER NOT NULL,\
            pipeline_id UUID NOT NULL,\
            state JSONB,\
            pdf_url TEXT,\
            timestamp TIMESTAMPTZ,\
            score DOUBLE PRECISION,\
            label TEXT\
        )",
        &[],
    )
    .await
    .unwrap();
    info!("database schema ensured");
}

async fn mark_pending(
    db: &tokio_postgres::Client,
    pdf_id: i32,
    pipeline_id: uuid::Uuid,
    pdf_url: &str,
    timestamp: DateTime<Utc>,
) -> i32 {
    let row = db
        .query_one(
            "INSERT INTO analysis_history (pdf_id, pipeline_id, pdf_url, timestamp) \
             VALUES ($1,$2,$3,$4) RETURNING id",
            &[&pdf_id, &pipeline_id, &pdf_url, &timestamp],
        )
        .await
        .unwrap();
    row.get(0)
}

async fn insert_result(db: &tokio_postgres::Client, entry: &HistoryEntry) -> i32 {
    if let Some(row) = db
        .query_opt(
            "SELECT id FROM analysis_history WHERE pdf_id=$1 AND status='running' ORDER BY timestamp DESC LIMIT 1",
            &[&entry.pdf_id],
        )
        .await
        .unwrap()
    {
        let id: i32 = row.get(0);
        let _ = db
            .execute(
            "UPDATE analysis_history SET state=$2, pdf_url=$3, timestamp=$4, status='completed', score=$5, label=$6 WHERE id=$1",
                &[
                    &id,
                    &entry.result,
                    &entry.pdf_url,
                    &entry.timestamp,
                    &entry.score,
                    &entry.result_label,
                ],
            )
            .await
            .unwrap();
        id
    } else {
        let row = db
            .query_one(
                "INSERT INTO analysis_history (pdf_id, pipeline_id, state, pdf_url, timestamp, score, label) \
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
                &[
                    &entry.pdf_id,
                    &uuid::Uuid::nil(),
                    &entry.result,
                    &entry.pdf_url,
                    &entry.timestamp,
                    &entry.score,
                    &entry.result_label,
                ],
            )
            .await
            .unwrap();
        row.get(0)
    }
}

async fn latest(db: &tokio_postgres::Client, limit: i64) -> Vec<HistoryEntry> {
    let stmt = db
        .prepare(
            "SELECT id,pdf_id,state AS result,pdf_url,timestamp,status,score,label AS result_label FROM analysis_history ORDER BY timestamp DESC LIMIT $1",
        )
        .await
        .unwrap();
    let rows = db.query(&stmt, &[&limit]).await.unwrap();
    rows.into_iter()
        .map(|r| HistoryEntry {
            id: r.get(0),
            pdf_id: r.get(1),
            prompt: None,
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
            "SELECT id,pdf_id,state AS result,pdf_url,timestamp,status,score,label AS result_label FROM analysis_history ORDER BY timestamp DESC",
        )
        .await
        .unwrap();
    let rows = db.query(&stmt, &[]).await.unwrap();
    rows.into_iter()
        .map(|r| HistoryEntry {
            id: r.get(0),
            pdf_id: r.get(1),
            prompt: None,
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
        (
            "SELECT id,pdf_id,state AS result,pdf_url,timestamp,status,score,label AS result_label FROM analysis_history WHERE status = $1 ORDER BY timestamp DESC",
            vec![s],
        )
    } else {
        (
            "SELECT id,pdf_id,state AS result,pdf_url,timestamp,status,score,label AS result_label FROM analysis_history ORDER BY timestamp DESC",
            vec![],
        )
    };
    let stmt = db.prepare(sql).await.unwrap();
    let rows = db.query(&stmt, &params).await.unwrap();
    rows.into_iter()
        .map(|r| HistoryEntry {
            id: r.get(0),
            pdf_id: r.get(1),
            prompt: None,
            result: r.get(2),
            pdf_url: r.get(3),
            timestamp: r.get(4),
            status: r.get(5),
            score: r.get(6),
            result_label: r.get(7),
        })
        .collect()
}

async fn latest_by_status(
    db: &tokio_postgres::Client,
    status: Option<String>,
) -> Vec<HistoryEntry> {
    let (sql, params): (&str, Vec<&(dyn tokio_postgres::types::ToSql + Sync)>) = if let Some(s) =
        &status
    {
        (
            "SELECT * FROM (\
                SELECT DISTINCT ON (pdf_id) id, pdf_id, state AS result, pdf_url, timestamp, status, score, label AS result_label \
                FROM analysis_history WHERE status = $1 ORDER BY pdf_id, timestamp DESC\
            ) AS t ORDER BY timestamp DESC",
            vec![s],
        )
    } else {
        (
            "SELECT * FROM (\
                SELECT DISTINCT ON (pdf_id) id, pdf_id, state AS result, pdf_url, timestamp, status, score, label AS result_label \
                FROM analysis_history ORDER BY pdf_id, timestamp DESC\
            ) AS t ORDER BY timestamp DESC",
            vec![],
        )
    };
    let stmt = db.prepare(sql).await.unwrap();
    let rows = db.query(&stmt, &params).await.unwrap();
    rows.into_iter()
        .map(|r| HistoryEntry {
            id: r.get(0),
            pdf_id: r.get(1),
            prompt: None,
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
    let items = latest_by_status(&state.db, status).await;
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
        .subscribe(&["pdf-merged", "pipeline-result"])
        .unwrap();
    info!("kafka consumer running");
    loop {
        match consumer.recv().await {
            Err(e) => error!(%e, "kafka error"),
            Ok(m) => {
                if let Some(Ok(payload)) = m.payload_view::<str>() {
                    match m.topic() {
                        "pdf-merged" => {
                            if let Ok(data) =
                                serde_json::from_str::<shared::dto::PdfUploaded>(payload)
                            {
                                let ts = Utc::now();
                                let pdf_url = format!("{}/pdf/{}", pdf_base, data.pdf_id);
                                let id = mark_pending(&db, data.pdf_id, data.pipeline_id, &pdf_url, ts).await;
                                let entry = HistoryEntry {
                                    id,
                                    pdf_id: data.pdf_id,
                                    prompt: None,
                                    result: None,
                                    pdf_url,
                                    timestamp: ts,
                                    status: "running".into(),
                                    score: None,
                                    result_label: None,
                                };
                                let _ = tx.send(entry.clone());
                            }
                        }
                        "pipeline-result" => {
                            if let Ok(data) = serde_json::from_str::<PipelineRunResult>(payload) {
                                let entry = HistoryEntry {
                                    id: 0,
                                    pdf_id: data.pdf_id,
                                    prompt: None,
                                    result: Some(data.state.clone()),
                                    pdf_url: format!("{}/pdf/{}", pdf_base, data.pdf_id),
                                    timestamp: Utc::now(),
                                    status: "completed".into(),
                                    score: data.score,
                                    result_label: data.label.clone(),
                                };
                                let _ = db.execute(
                                    "INSERT INTO analysis_history (pdf_id, pipeline_id, state, pdf_url, timestamp, score, label) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                                    &[&data.pdf_id, &data.pipeline_id, &data.state, &entry.pdf_url, &entry.timestamp, &data.score, &data.label],
                                ).await;
                                let _ = tx.send(entry);
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
    let tls_connector = TlsConnector::builder().build().unwrap();
    let connector = MakeTlsConnector::new(tls_connector);
    let (db_client, connection) =
        tokio_postgres::connect(&settings.database_url, connector)
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
