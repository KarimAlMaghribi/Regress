use actix::prelude::*;
use actix_cors::Cors;
use actix_web::web::Payload;
use actix_web::{web, App, Error, HttpRequest, HttpResponse, HttpServer, Responder};
use actix_web_actors::ws;
use chrono::{DateTime, Utc};
use rdkafka::{consumer::{Consumer, StreamConsumer}, ClientConfig, Message};
use serde::{Deserialize, Serialize};
use shared::config::Settings;
use shared::dto::PipelineRunResult;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_postgres::{Client, NoTls};
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tracing::{error, info, warn};
use uuid::Uuid;

/* ------------------------------ Robuster NoTLS-DB-Wrapper (Auto-Reconnect + Heartbeat) ------------------------------ */

struct DbPool {
    dsn: String,
    client: RwLock<Option<Client>>,
}

impl DbPool {
    async fn new(dsn: String) -> Arc<Self> {
        let this = Arc::new(Self {
            dsn,
            client: RwLock::new(None),
        });
        // erste Verbindung + Heartbeat
        this.reconnect().await.ok();
        let weak = Arc::downgrade(&this);
        tokio::spawn(async move {
            let secs: u64 = std::env::var("DB_PING_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30);
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
                let Some(db) = weak.upgrade() else { break };
                if let Err(e) = db.ping().await {
                    warn!(%e, "db ping failed; reconnecting");
                    let _ = db.reconnect().await;
                }
            }
        });
        this
    }

    async fn connect_once(&self) -> Result<Client, tokio_postgres::Error> {
        let (client, connection) = tokio_postgres::connect(&self.dsn, NoTls).await?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                error!(%e, "postgres connection task ended (NoTLS)");
            }
        });
        Ok(client)
    }

    async fn reconnect(&self) -> Result<(), tokio_postgres::Error> {
        let client = self.connect_once().await?;
        *self.client.write().await = Some(client);
        info!("postgres connected (NoTLS)");
        Ok(())
    }

    async fn current(&self) -> Result<Client, tokio_postgres::Error> {
        if let Some(c) = self.client.read().await.as_ref() {
            return Ok(c.clone());
        }
        self.reconnect().await?;
        Ok(self.client.read().await.as_ref().unwrap().clone())
    }

    async fn ping(&self) -> Result<(), tokio_postgres::Error> {
        let c = self.current().await?;
        let _ = c.simple_query("SELECT 1").await?;
        Ok(())
    }

    /// Führt `op` gegen den aktuellen Client aus; bei "closed/reset" wird **einmal** reconnectet und wiederholt.
    async fn with_client<F, Fut, T>(&self, op: F) -> Result<T, tokio_postgres::Error>
    where
        F: FnOnce(&Client) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<T, tokio_postgres::Error>> + Send,
        T: Send + 'static,
    {
        let c1 = self.current().await?;
        match op(&c1).await {
            Ok(v) => Ok(v),
            Err(e) if looks_like_closed(&e) => {
                warn!(%e, "db op on closed connection; reconnecting once");
                self.reconnect().await?;
                let c2 = self.current().await?;
                op(&c2).await
            }
            Err(e) => Err(e),
        }
    }
}

fn looks_like_closed(err: &tokio_postgres::Error) -> bool {
    let s = err.to_string().to_lowercase();
    s.contains("closed") || s.contains("broken pipe") || s.contains("connection reset")
}

/* ------------------------------------------------------ Types ------------------------------------------------------- */

#[derive(Debug, Serialize, Deserialize, Clone)]
struct HistoryEntry {
    id: i32,
    pdf_id: i32,
    pipeline_id: Uuid,
    prompt: Option<String>,
    result: Option<serde_json::Value>,
    pdf_url: String,
    timestamp: DateTime<Utc>,
    status: String,
    score: Option<f64>,
    result_label: Option<String>,
}

#[derive(Clone)]
struct AppState {
    db: Arc<DbPool>,
    tx: tokio::sync::broadcast::Sender<HistoryEntry>,
    pdf_base: String,
}

/* -------------------------------------------------- DB-Hilfsfunktionen --------------------------------------------- */

async fn ensure_schema(db: &Client) -> Result<(), tokio_postgres::Error> {
    // Basistabelle (idempotent)
    let _ = db.execute(
        "CREATE TABLE IF NOT EXISTS analysis_history ( \
            id SERIAL PRIMARY KEY, \
            pdf_id INTEGER NOT NULL, \
            pipeline_id UUID NOT NULL, \
            state JSONB, \
            pdf_url TEXT, \
            timestamp TIMESTAMPTZ, \
            status TEXT NOT NULL DEFAULT 'running', \
            score DOUBLE PRECISION, \
            label TEXT \
        )",
        &[],
    ).await;

    // Falls alte Deployments: status-Spalte nachziehen
    let _ = db.execute(
        "ALTER TABLE analysis_history \
         ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running'",
        &[]
    ).await;

    info!("database schema ensured");
    Ok(())
}

async fn mark_pending(
    db: &Client,
    pdf_id: i32,
    pipeline_id: Uuid,
    pdf_url: &str,
    timestamp: DateTime<Utc>,
) -> Result<i32, tokio_postgres::Error> {
    let row = db.query_one(
        "INSERT INTO analysis_history (pdf_id, pipeline_id, pdf_url, timestamp, status) \
         VALUES ($1,$2,$3,$4,'running') RETURNING id",
        &[&pdf_id, &pipeline_id, &pdf_url, &timestamp],
    ).await?;
    Ok(row.get::<_, i32>(0))
}

async fn insert_result(db: &Client, entry: &HistoryEntry) -> Result<i32, tokio_postgres::Error> {
    // Versuche das zuletzt angelegte 'running' zu schließen
    if let Some(row) = db.query_opt(
        "SELECT id FROM analysis_history WHERE pdf_id=$1 AND status='running' \
         ORDER BY timestamp DESC LIMIT 1",
        &[&entry.pdf_id],
    ).await? {
        let id: i32 = row.get(0);
        let _ = db.execute(
            "UPDATE analysis_history \
             SET state=$2, pdf_url=$3, timestamp=$4, status='completed', score=$5, label=$6 \
             WHERE id=$1",
            &[&id, &entry.result, &entry.pdf_url, &entry.timestamp, &entry.score, &entry.result_label],
        ).await?;
        return Ok(id);
    }

    // sonst neues 'completed' eintragen
    let row = db.query_one(
        "INSERT INTO analysis_history \
         (pdf_id, pipeline_id, state, pdf_url, timestamp, status, score, label) \
         VALUES ($1,$2,$3,$4,$5,'completed',$6,$7) RETURNING id",
        &[&entry.pdf_id, &entry.pipeline_id, &entry.result, &entry.pdf_url, &entry.timestamp, &entry.score, &entry.result_label],
    ).await?;
    Ok(row.get::<_, i32>(0))
}

fn row_to_entry(r: tokio_postgres::Row) -> HistoryEntry {
    HistoryEntry {
        id: r.get(0),
        pdf_id: r.get(1),
        pipeline_id: r.get(2),
        prompt: None,
        result: r.get(3),
        pdf_url: r.get(4),
        timestamp: r.get(5),
        status: r.get(6),
        score: r.get(7),
        result_label: r.get(8),
    }
}

async fn latest(db: &Client, limit: i64) -> Result<Vec<HistoryEntry>, tokio_postgres::Error> {
    let stmt = db.prepare(
        "SELECT id,pdf_id,pipeline_id,state AS result,pdf_url,timestamp,status,score,label AS result_label \
         FROM analysis_history ORDER BY timestamp DESC LIMIT $1"
    ).await?;
    let rows = db.query(&stmt, &[&limit]).await?;
    Ok(rows.into_iter().map(row_to_entry).collect())
}

async fn all_entries(db: &Client) -> Result<Vec<HistoryEntry>, tokio_postgres::Error> {
    let stmt = db.prepare(
        "SELECT id,pdf_id,pipeline_id,state AS result,pdf_url,timestamp,status,score,label AS result_label \
         FROM analysis_history ORDER BY timestamp DESC"
    ).await?;
    let rows = db.query(&stmt, &[]).await?;
    Ok(rows.into_iter().map(row_to_entry).collect())
}

async fn latest_by_status(db: &Client, status: Option<String>) -> Result<Vec<HistoryEntry>, tokio_postgres::Error> {
    if let Some(s) = status {
        let stmt = db.prepare(
            "SELECT * FROM ( \
               SELECT DISTINCT ON (pdf_id) id, pdf_id, pipeline_id, state AS result, \
                      pdf_url, timestamp, status, score, label AS result_label \
               FROM analysis_history WHERE status = $1 \
               ORDER BY pdf_id, timestamp DESC \
             ) AS t ORDER BY timestamp DESC"
        ).await?;
        let rows = db.query(&stmt, &[&s]).await?;
        Ok(rows.into_iter().map(row_to_entry).collect())
    } else {
        let stmt = db.prepare(
            "SELECT * FROM ( \
               SELECT DISTINCT ON (pdf_id) id, pdf_id, pipeline_id, state AS result, \
                      pdf_url, timestamp, status, score, label AS result_label \
               FROM analysis_history \
               ORDER BY pdf_id, timestamp DESC \
             ) AS t ORDER BY timestamp DESC"
        ).await?;
        let rows = db.query(&stmt, &[]).await?;
        Ok(rows.into_iter().map(row_to_entry).collect())
    }
}

/* ------------------------------------------------------ HTTP-Handler ------------------------------------------------ */

async fn classifications(
    state: web::Data<AppState>,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    let limit = query.get("limit").and_then(|v| v.parse::<i64>().ok()).unwrap_or(50);
    match state.db.with_client(|c| async move { latest(c, limit).await }).await {
        Ok(items) => HttpResponse::Ok().json(items),
        Err(e) => {
            error!(%e, "classifications: db error");
            HttpResponse::Ok().json(Vec::<HistoryEntry>::new()) // stabil für Frontend
        }
    }
}

async fn analyses(
    state: web::Data<AppState>,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    let status = query.get("status").cloned();
    match state.db.with_client(|c| async move { latest_by_status(c, status).await }).await {
        Ok(items) => HttpResponse::Ok().json(items),
        Err(e) => {
            error!(%e, "analyses: db error");
            HttpResponse::Ok().json(Vec::<HistoryEntry>::new())
        }
    }
}

async fn result(state: web::Data<AppState>, path: web::Path<i32>) -> impl Responder {
    let pdf_id = path.into_inner();
    let op = |c: &Client| async move {
        c.query_opt(
            "SELECT state FROM analysis_history \
             WHERE pdf_id=$1 AND status='completed' \
             ORDER BY timestamp DESC LIMIT 1",
            &[&pdf_id],
        ).await
    };
    match state.db.with_client(op).await {
        Ok(Some(r)) => {
            let value: serde_json::Value = r.get(0);
            HttpResponse::Ok().json(value)
        }
        Ok(None) => HttpResponse::NotFound().finish(),
        Err(e) => {
            error!(%e, "result: db error");
            HttpResponse::InternalServerError().finish()
        }
    }
}

async fn health(state: web::Data<AppState>) -> impl Responder {
    if let Err(e) = state.db.ping().await {
        return HttpResponse::ServiceUnavailable().body(format!("db not ok: {e}"));
    }
    "OK"
}

/* ------------------------------------------------------ WebSocket --------------------------------------------------- */

struct WsConn {
    db: Arc<DbPool>,
    rx: tokio::sync::broadcast::Receiver<HistoryEntry>,
}

impl actix::Actor for WsConn {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        let dbwrap = self.db.clone();
        async move {
            match dbwrap.with_client(|c| async move { all_entries(c).await }).await {
                Ok(v) => v,
                Err(e) => {
                    warn!(%e, "ws init load failed");
                    Vec::new()
                }
            }
        }
            .into_actor(self)
            .map(|entries, _act, ctx| {
                if let Ok(text) = serde_json::to_string(
                    &serde_json::json!({"type":"history","data":entries})
                ) {
                    ctx.text(text);
                }
            })
            .spawn(ctx);

        ctx.add_stream(tokio_stream::wrappers::BroadcastStream::new(self.rx.resubscribe()));
    }
}

impl actix::StreamHandler<Result<HistoryEntry, BroadcastStreamRecvError>> for WsConn {
    fn handle(&mut self, item: Result<HistoryEntry, BroadcastStreamRecvError>, ctx: &mut Self::Context) {
        if let Ok(entry) = item {
            if let Ok(text) = serde_json::to_string(
                &serde_json::json!({"type":"update","data":entry})
            ) {
                ctx.text(text);
            }
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

async fn ws_index(req: HttpRequest, stream: Payload, state: web::Data<AppState>) -> Result<HttpResponse, Error> {
    let ws = WsConn { db: state.db.clone(), rx: state.tx.subscribe() };
    ws::start(ws, &req, stream)
}

/* ------------------------------------------------------- Kafka ------------------------------------------------------ */

async fn start_kafka(
    db: Arc<DbPool>,
    tx: tokio::sync::broadcast::Sender<HistoryEntry>,
    message_broker_url: String,
    pdf_base: String,
) {
    if message_broker_url.trim().is_empty() {
        warn!("MESSAGE_BROKER_URL empty; Kafka consumer disabled");
        return;
    }

    let consumer: StreamConsumer = match ClientConfig::new()
        .set("group.id", "history-service")
        .set("bootstrap.servers", &message_broker_url)
        .create() {
        Ok(c) => c,
        Err(e) => {
            error!(%e, "failed to create kafka consumer");
            return;
        }
    };

    if let Err(e) = consumer.subscribe(&["pdf-merged", "pipeline-result"]) {
        error!(%e, "failed to subscribe to topics");
        return;
    }

    info!("kafka consumer running");
    loop {
        match consumer.recv().await {
            Err(e) => error!(%e, "kafka error"),
            Ok(m) => {
                if let Some(Ok(payload)) = m.payload_view::<str>() {
                    match m.topic() {
                        "pdf-merged" => {
                            match serde_json::from_str::<shared::dto::PdfUploaded>(payload) {
                                Ok(data) => {
                                    let ts = Utc::now();
                                    let pdf_url = format!("{}/pdf/{}", pdf_base, data.pdf_id);
                                    let id = match db.with_client(|c| async move {
                                        mark_pending(c, data.pdf_id, data.pipeline_id, &pdf_url, ts).await
                                    }).await {
                                        Ok(id) => id,
                                        Err(e) => {
                                            error!(%e, "failed to insert running row");
                                            0
                                        }
                                    };
                                    let entry = HistoryEntry {
                                        id,
                                        pdf_id: data.pdf_id,
                                        pipeline_id: data.pipeline_id,
                                        prompt: None,
                                        result: None,
                                        pdf_url,
                                        timestamp: ts,
                                        status: "running".into(),
                                        score: None,
                                        result_label: None,
                                    };
                                    let _ = tx.send(entry);
                                }
                                Err(e) => error!(%e, "failed to parse pdf-merged payload"),
                            }
                        }
                        "pipeline-result" => {
                            match serde_json::from_str::<PipelineRunResult>(payload) {
                                Ok(data) => {
                                    let value = serde_json::to_value(&data).unwrap_or_default();
                                    let entry = HistoryEntry {
                                        id: 0,
                                        pdf_id: data.pdf_id,
                                        pipeline_id: data.pipeline_id,
                                        prompt: None,
                                        result: Some(value.clone()),
                                        pdf_url: format!("{}/pdf/{}", pdf_base, data.pdf_id),
                                        timestamp: Utc::now(),
                                        status: "completed".into(),
                                        score: data.overall_score.map(|f| f as f64),
                                        result_label: None,
                                    };

                                    let id = match db.with_client(|c| async move {
                                        insert_result(c, &entry).await
                                    }).await {
                                        Ok(id) => id,
                                        Err(e) => {
                                            error!(%e, "failed to upsert completed row");
                                            0
                                        }
                                    };

                                    let mut entry = entry;
                                    entry.id = id;
                                    let _ = tx.send(entry);
                                }
                                Err(e) => error!(%e, "failed to parse pipeline-result payload"),
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

/* -------------------------------------------------------- main ------------------------------------------------------ */

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting history-service");

    let settings = match Settings::new() {
        Ok(s) => s,
        Err(e) => {
            error!(%e, "failed to load settings");
            std::process::exit(1);
        }
    };

    // NoTLS, Auto-Reconnect
    let db = DbPool::new(settings.database_url.clone()).await;

    // Schema sicherstellen (über Wrapper – tolerant bei Verbindungswechsel)
    let _ = db.with_client(|c| async move { ensure_schema(c).await }).await;

    let (tx, _) = tokio::sync::broadcast::channel(100);
    let pdf_base = std::env::var("PDF_INGEST_URL").unwrap_or_else(|_| "http://localhost:8081".into());
    let state = web::Data::new(AppState { db: db.clone(), tx: tx.clone(), pdf_base: pdf_base.clone() });

    // Kafka in separater Task
    {
        let db_for_kafka = db.clone();
        let tx_for_kafka = tx.clone();
        let pdf_base_for_kafka = pdf_base.clone();
        let broker_url = settings.message_broker_url.clone();
        actix_web::rt::spawn(start_kafka(db_for_kafka, tx_for_kafka, broker_url, pdf_base_for_kafka));
    }

    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(state.clone())
            .route("/classifications", web::get().to(classifications))
            .route("/analyses", web::get().to(analyses))
            .route("/results/{id}", web::get().to(result))
            .route("/", web::get().to(ws_index))
            .route("/health", web::get().to(health))
    })
        .bind(("0.0.0.0", 8090))?
        .run()
        .await
}
