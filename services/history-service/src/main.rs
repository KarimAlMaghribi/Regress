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
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tracing::{error, info, warn};
use uuid::Uuid;

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

struct AppState {
    db: Arc<tokio_postgres::Client>,
    tx: tokio::sync::broadcast::Sender<HistoryEntry>,
    pdf_base: String,
}

async fn ensure_schema(db: &tokio_postgres::Client) {
    if let Err(e) = db.execute(
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
        &[]
    ).await {
        error!(%e, "failed to create table analysis_history");
    }

    if let Err(e) = db.execute(
        "ALTER TABLE analysis_history \
         ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running'",
        &[]
    ).await {
        error!(%e, "failed to ensure column status");
    }

    info!("database schema ensured");
}

async fn mark_pending(
    db: &tokio_postgres::Client,
    pdf_id: i32,
    pipeline_id: Uuid,
    pdf_url: &str,
    timestamp: DateTime<Utc>,
) -> i32 {
    match db.query_one(
        "INSERT INTO analysis_history (pdf_id, pipeline_id, pdf_url, timestamp, status) \
         VALUES ($1,$2,$3,$4,'running') RETURNING id",
        &[&pdf_id, &pipeline_id, &pdf_url, &timestamp],
    ).await {
        Ok(row) => row.get(0),
        Err(e) => {
            error!(%e, pdf_id, "failed to insert running row");
            0
        }
    }
}

async fn insert_result(db: &tokio_postgres::Client, entry: &HistoryEntry) -> i32 {
    match db.query_opt(
        "SELECT id FROM analysis_history WHERE pdf_id=$1 AND status='running' \
         ORDER BY timestamp DESC LIMIT 1",
        &[&entry.pdf_id],
    ).await {
        Ok(Some(row)) => {
            let id: i32 = row.get(0);
            if let Err(e) = db.execute(
                "UPDATE analysis_history \
                 SET state=$2, pdf_url=$3, timestamp=$4, status='completed', score=$5, label=$6 \
                 WHERE id=$1",
                &[&id, &entry.result, &entry.pdf_url, &entry.timestamp, &entry.score, &entry.result_label],
            ).await {
                error!(%e, id, "failed to update running row to completed");
            }
            id
        }
        Ok(None) => {
            match db.query_one(
                "INSERT INTO analysis_history \
                 (pdf_id, pipeline_id, state, pdf_url, timestamp, status, score, label) \
                 VALUES ($1,$2,$3,$4,$5,'completed',$6,$7) RETURNING id",
                &[&entry.pdf_id, &Uuid::nil(), &entry.result, &entry.pdf_url, &entry.timestamp, &entry.score, &entry.result_label],
            ).await {
                Ok(row) => row.get(0),
                Err(e) => {
                    error!(%e, pdf_id = entry.pdf_id, "failed to insert completed row");
                    0
                }
            }
        }
        Err(e) => {
            error!(%e, pdf_id = entry.pdf_id, "failed to lookup running row");
            0
        }
    }
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

async fn latest(db: &tokio_postgres::Client, limit: i64) -> Vec<HistoryEntry> {
    let sql = "SELECT id,pdf_id,pipeline_id,state AS result,pdf_url,timestamp,status,score,label AS result_label \
               FROM analysis_history ORDER BY timestamp DESC LIMIT $1";
    let stmt = match db.prepare(sql).await {
        Ok(s) => s,
        Err(e) => {
            error!(%e, "prepare failed (latest)");
            return vec![];
        }
    };
    let rows = match db.query(&stmt, &[&limit]).await {
        Ok(r) => r,
        Err(e) => {
            error!(%e, "query failed (latest)");
            return vec![];
        }
    };
    rows.into_iter().map(row_to_entry).collect()
}

async fn all_entries(db: &tokio_postgres::Client) -> Vec<HistoryEntry> {
    let sql = "SELECT id,pdf_id,pipeline_id,state AS result,pdf_url,timestamp,status,score,label AS result_label \
               FROM analysis_history ORDER BY timestamp DESC";
    let stmt = match db.prepare(sql).await {
        Ok(s) => s,
        Err(e) => {
            error!(%e, "prepare failed (all_entries)");
            return vec![];
        }
    };
    let rows = match db.query(&stmt, &[]).await {
        Ok(r) => r,
        Err(e) => {
            error!(%e, "query failed (all_entries)");
            return vec![];
        }
    };
    rows.into_iter().map(row_to_entry).collect()
}

async fn latest_by_status(db: &tokio_postgres::Client, status: Option<String>) -> Vec<HistoryEntry> {
    if let Some(s) = &status {
        let stmt = match db.prepare(
            "SELECT * FROM ( \
               SELECT DISTINCT ON (pdf_id) id, pdf_id, pipeline_id, state AS result, pdf_url, timestamp, status, score, label AS result_label \
               FROM analysis_history WHERE status = $1 ORDER BY pdf_id, timestamp DESC \
             ) AS t ORDER BY timestamp DESC"
        ).await {
            Ok(s) => s,
            Err(e) => { error!(%e, "prepare failed (latest_by_status)"); return vec![]; }
        };
        match db.query(&stmt, &[s]).await {
            Ok(rows) => rows.into_iter().map(row_to_entry).collect(),
            Err(e) => { error!(%e, "query failed (latest_by_status)"); vec![] }
        }
    } else {
        let stmt = match db.prepare(
            "SELECT * FROM ( \
               SELECT DISTINCT ON (pdf_id) id, pdf_id, pipeline_id, state AS result, pdf_url, timestamp, status, score, label AS result_label \
               FROM analysis_history ORDER BY pdf_id, timestamp DESC \
             ) AS t ORDER BY timestamp DESC"
        ).await {
            Ok(s) => s,
            Err(e) => { error!(%e, "prepare failed (latest_by_status ALL)"); return vec![]; }
        };
        match db.query(&stmt, &[]).await {
            Ok(rows) => rows.into_iter().map(row_to_entry).collect(),
            Err(e) => { error!(%e, "query failed (latest_by_status ALL)"); vec![] }
        }
    }
}

async fn classifications(
    state: web::Data<AppState>,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    let limit = query.get("limit").and_then(|v| v.parse::<i64>().ok()).unwrap_or(50);
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

async fn result(state: web::Data<AppState>, path: web::Path<i32>) -> impl Responder {
    let pdf_id = path.into_inner();
    match state.db.query_opt(
        "SELECT state FROM analysis_history WHERE pdf_id=$1 AND status='completed' ORDER BY timestamp DESC LIMIT 1",
        &[&pdf_id],
    ).await {
        Ok(Some(r)) => {
            let value: serde_json::Value = r.get(0);
            HttpResponse::Ok().json(value)
        }
        Ok(None) => HttpResponse::NotFound().finish(),
        Err(e) => {
            error!(%e, "failed to fetch result");
            HttpResponse::InternalServerError().finish()
        }
    }
}

async fn health() -> impl Responder { "OK" }

struct WsConn {
    db: Arc<tokio_postgres::Client>,
    rx: tokio::sync::broadcast::Receiver<HistoryEntry>,
}

impl actix::Actor for WsConn {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        let db = self.db.clone();
        async move { all_entries(&db).await }
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

async fn start_kafka(
    db: Arc<tokio_postgres::Client>,
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
                                    let id = mark_pending(&db, data.pdf_id, data.pipeline_id, &pdf_url, ts).await;
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
                                    if let Err(e) = db.execute(
                                        "INSERT INTO analysis_history (pdf_id, pipeline_id, state, pdf_url, timestamp, status, score, label) \
                                         VALUES ($1,$2,$3,$4,$5,'completed',$6,$7)",
                                        &[&data.pdf_id, &data.pipeline_id, &value, &entry.pdf_url, &entry.timestamp, &entry.score, &entry.result_label],
                                    ).await {
                                        error!(%e, "failed to insert pipeline result");
                                    }
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

/* ------------------------------ DB-Connect Helper (DNS Preflight + TLS/NoTLS auto) ------------------------------ */

mod db_connect {
    use tokio::time::{sleep, Duration};
    use tokio_postgres::{Client, NoTls};
    use tracing::{error, info, warn};

    fn parse_host_port(url: &str) -> (Option<String>, Option<u16>) {
        if let Some(after_scheme) = url.splitn(2, "://").nth(1) {
            let after_at = after_scheme.splitn(2, '@').last().unwrap_or(after_scheme);
            let host_port = after_at.splitn(2, '/').next().unwrap_or(after_at);
            let mut it = host_port.splitn(2, ':');
            let host = it.next().map(|s| s.to_string());
            let port = it.next().and_then(|p| p.parse::<u16>().ok());
            (host, port)
        } else {
            (None, None)
        }
    }

    // Prüft Query-String der URL auf sslmode=disable; ohne sslmode -> TLS versuchen
    fn want_tls(database_url: &str) -> bool {
        let Some(qs) = database_url.splitn(2, '?').nth(1) else { return true };
        for pair in qs.split('&') {
            let mut it = pair.splitn(2, '=');
            let k = it.next().unwrap_or("");
            let v = it.next().unwrap_or("");
            if k.eq_ignore_ascii_case("sslmode") {
                return !v.eq_ignore_ascii_case("disable");
            }
        }
        true
    }

    pub async fn connect_with_retry(database_url: &str) -> Client {
        // DNS-Preflight (nur Logging)
        let (host_opt, port_opt) = parse_host_port(database_url);
        if let Some(h) = host_opt.as_deref() {
            let p = port_opt.unwrap_or(5432);
            match tokio::net::lookup_host((h, p)).await {
                Ok(mut addrs) => {
                    if let Some(a) = addrs.next() {
                        info!("DB DNS ok: {} -> {}", h, a);
                    } else {
                        warn!("DB DNS: {} hat keine Adressen geliefert", h);
                    }
                }
                Err(e) => warn!("DB DNS-Auflösung fehlgeschlagen ({}:{}): {}", h, p, e),
            }
        }

        let mut backoff = 1u64;
        loop {
            if want_tls(database_url) {
                // Erst TLS probieren
                match native_tls::TlsConnector::builder().build() {
                    Ok(tls) => {
                        let tls = postgres_native_tls::MakeTlsConnector::new(tls);
                        match tokio_postgres::connect(database_url, tls).await {
                            Ok((client, connection)) => {
                                tokio::spawn(async move {
                                    if let Err(e) = connection.await {
                                        error!(%e, "postgres connection task ended with error (TLS)");
                                    }
                                });
                                info!("Connected to PostgreSQL (TLS).");
                                return client;
                            }
                            Err(e) => error!(%e, "DB connect (TLS) failed; will try NoTLS"),
                        }
                    }
                    Err(e) => warn!(%e, "building TLS connector failed; falling back to NoTLS"),
                }
            }

            // NoTLS (aktuelles Setup: sslmode=disable)
            match tokio_postgres::connect(database_url, NoTls).await {
                Ok((client, connection)) => {
                    tokio::spawn(async move {
                        if let Err(e) = connection.await {
                            error!(%e, "postgres connection task ended with error (NoTLS)");
                        }
                    });
                    info!("Connected to PostgreSQL (NoTLS).");
                    return client;
                }
                Err(e) => {
                    error!(%e, "DB connect (NoTLS) failed");
                    let wait = backoff.min(10);
                    sleep(Duration::from_secs(wait)).await;
                    backoff = (backoff + 1).min(10);
                }
            }
        }
    }
}

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

    // Robuster DB‑Connect (kein unwrap, DNS‑Preflight + TLS/NoTLS)
    let db_client = db_connect::connect_with_retry(&settings.database_url).await;
    ensure_schema(&db_client).await;

    let (tx, _) = tokio::sync::broadcast::channel(100);
    let db = Arc::new(db_client);

    let pdf_base = std::env::var("PDF_INGEST_URL").unwrap_or_else(|_| "http://localhost:8081".into());
    let state = web::Data::new(AppState { db: db.clone(), tx: tx.clone(), pdf_base: pdf_base.clone() });

    // Kafka in separater Task, Fehler nur loggen
    let broker_url = settings.message_broker_url.clone();
    {
        let db_for_kafka = db.clone();
        let tx_for_kafka = tx.clone();
        let pdf_base_for_kafka = pdf_base.clone();
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
