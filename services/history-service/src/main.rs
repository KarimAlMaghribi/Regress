//! WebSocket service that streams pipeline run updates to connected clients.

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
use serde_json::json;
use shared::config::Settings;
use shared::dto::PipelineRunResult;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_postgres::{types::ToSql, Client, NoTls, Row};
use tokio_stream::wrappers::{errors::BroadcastStreamRecvError, BroadcastStream};
use tracing::{error, info, warn};
use uuid::Uuid;

/* ============================================================================================
DB-Manager: NoTLS, Auto-Reconnect bei "connection closed" + Heartbeat (SELECT 1)
============================================================================================ */

/// Manages a connection to Postgres and provides automatic reconnection with a
/// lightweight heartbeat loop.
struct Db {
    dsn: String,
    client: RwLock<Option<Arc<Client>>>,
}

impl Db {
    /// Creates a new connection manager and kicks off the heartbeat task used
    /// to monitor connection liveness.
    async fn new(dsn: String) -> Arc<Self> {
        let db = Arc::new(Self {
            dsn,
            client: RwLock::new(None),
        });

        // Attempt an eager connection so we fail fast on invalid configuration.
        if let Err(e) = db.reconnect().await {
            warn!(%e, "initial db connect failed; will retry on demand");
        }

        // Maintain a heartbeat to keep idle connections alive and detect drops
        // quickly.
        let weak = Arc::downgrade(&db);
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

        db
    }

    /// Establishes a new client and returns it along with the connection task
    /// that must be polled to drive the protocol.
    async fn connect_once(
        &self,
    ) -> Result<
        (
            Arc<Client>,
            impl std::future::Future<Output = Result<(), tokio_postgres::Error>> + Send + 'static,
        ),
        tokio_postgres::Error,
    > {
        let (client, connection) = tokio_postgres::connect(&self.dsn, NoTls).await?;
        let client = Arc::new(client);
        let fut = async move {
            if let Err(e) = connection.await {
                error!(%e, "postgres connection task ended (NoTLS)");
                return Err(e);
            }
            Ok(())
        };
        Ok((client, fut))
    }

    /// Replaces the current client with a freshly connected one.
    async fn reconnect(&self) -> Result<(), tokio_postgres::Error> {
        let (client, connection_fut) = self.connect_once().await?;
        tokio::spawn(async move {
            let _ = connection_fut.await;
        });
        *self.client.write().await = Some(client);
        info!("postgres connected (NoTLS)");
        Ok(())
    }

    /// Returns a live client, reconnecting if the current one is unavailable.
    async fn current(&self) -> Result<Arc<Client>, tokio_postgres::Error> {
        if let Some(c) = self.client.read().await.as_ref() {
            return Ok(c.clone());
        }
        self.reconnect().await?;
        Ok(self.client.read().await.as_ref().unwrap().clone())
    }

    /// Performs a health check query to verify the connection is responsive.
    async fn ping(&self) -> Result<(), tokio_postgres::Error> {
        let c = self.current().await?;
        let _ = c.simple_query("SELECT 1").await?;
        Ok(())
    }

    #[inline]
    /// Heuristically detects whether an error indicates a closed connection so
    /// the caller can decide to retry.
    fn looks_like_closed(err: &tokio_postgres::Error) -> bool {
        let s = err.to_string().to_lowercase();
        s.contains("closed") || s.contains("broken pipe") || s.contains("connection reset")
    }

    /// Executes a query with a single reconnect retry if the connection was
    /// dropped.
    async fn query(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, tokio_postgres::Error> {
        let c1 = self.current().await?;
        match c1.query(sql, params).await {
            Ok(rows) => Ok(rows),
            Err(e) if Self::looks_like_closed(&e) => {
                warn!(%e, "query failed on closed connection; reconnecting once");
                self.reconnect().await?;
                let c2 = self.current().await?;
                c2.query(sql, params).await
            }
            Err(e) => Err(e),
        }
    }

    /// Executes a statement with a single reconnect retry if the connection was
    /// dropped.
    async fn execute(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, tokio_postgres::Error> {
        let c1 = self.current().await?;
        match c1.execute(sql, params).await {
            Ok(n) => Ok(n),
            Err(e) if Self::looks_like_closed(&e) => {
                warn!(%e, "execute failed on closed connection; reconnecting once");
                self.reconnect().await?;
                let c2 = self.current().await?;
                c2.execute(sql, params).await
            }
            Err(e) => Err(e),
        }
    }

    /// Executes a query returning at most one row with a reconnect retry if
    /// needed.
    async fn query_opt(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, tokio_postgres::Error> {
        let mut rows = self.query(sql, params).await?;
        Ok(rows.pop()) // erste Zeile (oder None)
    }
}

/* ============================================================================================
Types & AppState
============================================================================================ */

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
    // NEU: optionaler Tenant-Name (nur gesetzt, wenn aus View selektiert)
    tenant_name: Option<String>,
}

#[derive(Clone)]
struct AppState {
    db: Arc<Db>,
    tx: tokio::sync::broadcast::Sender<HistoryEntry>,
    pdf_base: String,
}

/* ============================================================================================
DB-Helfer (ohne gecachte Prepared Statements → reconnection-safe)
============================================================================================ */

/// Ensures the expected database schema exists, creating tables if necessary.
async fn ensure_schema_db(db: &Db) {
    let _ = db
        .execute(
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
        )
        .await;

    let _ = db
        .execute(
            "ALTER TABLE analysis_history \
         ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running'",
            &[],
        )
        .await;

    // NEU: Start/Ende-Spalten hinzufügen
    let _ = db
        .execute(
            "ALTER TABLE analysis_history \
         ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ",
            &[],
        )
        .await;
    let _ = db
        .execute(
            "ALTER TABLE analysis_history \
         ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ",
            &[],
        )
        .await;

    // Backfill: started_at := timestamp; finished_at := timestamp wenn completed
    let _ = db
        .execute(
            "UPDATE analysis_history SET started_at = COALESCE(started_at, timestamp)",
            &[],
        )
        .await;
    let _ = db.execute(
        "UPDATE analysis_history \
         SET finished_at = CASE WHEN status='completed' THEN COALESCE(finished_at, timestamp) ELSE finished_at END",
        &[],
    ).await;

    info!("database schema ensured");
}

// Mapping für Selektierungen aus der View (enthält zusätzlich tenant_name)
/// Converts a database row into an in-memory history entry representation.
fn row_to_entry_with_tenant(r: Row) -> HistoryEntry {
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
        tenant_name: r.get(9), // tenant_name
    }
}

/// Loads the latest run results up to the provided limit.
async fn latest_db(db: &Db, limit: i64) -> Vec<HistoryEntry> {
    match db.query(
        "SELECT id,pdf_id,pipeline_id,state AS result,pdf_url,timestamp,status,score,label AS result_label, tenant_name \
         FROM v_analysis_history_with_tenant ORDER BY timestamp DESC LIMIT $1",
        &[&limit],
    ).await {
        Ok(rows) => rows.into_iter().map(row_to_entry_with_tenant).collect(),
        Err(e) => {
            error!(%e, "latest_db: query failed");
            vec![]
        }
    }
}

/// Retrieves every run result stored for the tenant.
async fn all_entries_db(db: &Db) -> Vec<HistoryEntry> {
    match db.query(
        "SELECT id,pdf_id,pipeline_id,state AS result,pdf_url,timestamp,status,score,label AS result_label, tenant_name \
         FROM v_analysis_history_with_tenant ORDER BY timestamp DESC",
        &[],
    ).await {
        Ok(rows) => rows.into_iter().map(row_to_entry_with_tenant).collect(),
        Err(e) => {
            error!(%e, "all_entries_db: query failed");
            vec![]
        }
    }
}

/// Returns the newest runs filtered by the provided optional status.
async fn latest_by_status_db(db: &Db, status: Option<String>) -> Vec<HistoryEntry> {
    if let Some(s) = status {
        match db
            .query(
                "SELECT * FROM ( \
               SELECT DISTINCT ON (pdf_id) id, pdf_id, pipeline_id, state AS result, \
                      pdf_url, timestamp, status, score, label AS result_label, tenant_name \
               FROM v_analysis_history_with_tenant WHERE status = $1 \
               ORDER BY pdf_id, timestamp DESC \
             ) AS t ORDER BY timestamp DESC",
                &[&s],
            )
            .await
        {
            Ok(rows) => rows.into_iter().map(row_to_entry_with_tenant).collect(),
            Err(e) => {
                error!(%e, "latest_by_status_db(status): query failed");
                vec![]
            }
        }
    } else {
        match db
            .query(
                "SELECT * FROM ( \
               SELECT DISTINCT ON (pdf_id) id, pdf_id, pipeline_id, state AS result, \
                      pdf_url, timestamp, status, score, label AS result_label, tenant_name \
               FROM v_analysis_history_with_tenant \
               ORDER BY pdf_id, timestamp DESC \
             ) AS t ORDER BY timestamp DESC",
                &[],
            )
            .await
        {
            Ok(rows) => rows.into_iter().map(row_to_entry_with_tenant).collect(),
            Err(e) => {
                error!(%e, "latest_by_status_db(all): query failed");
                vec![]
            }
        }
    }
}

// NEU: gleiche Logik wie oben, aber über die View v_analysis_history_with_tenant + Tenant-Filter
/// Returns the newest runs and their associated tenant when filtered by
/// status.
async fn latest_by_status_with_tenant_db(
    db: &Db,
    status: Option<String>,
    tenant_like: Option<String>,
) -> Vec<HistoryEntry> {
    match (tenant_like, status) {
        (Some(t), Some(s)) => {
            let sql = r#"
                SELECT * FROM (
                  SELECT DISTINCT ON (pdf_id)
                         id, pdf_id, pipeline_id, state AS result,
                         pdf_url, timestamp, status, score, label AS result_label,
                         tenant_name
                  FROM v_analysis_history_with_tenant
                  WHERE tenant_name ILIKE '%' || $1 || '%'
                    AND status = $2
                  ORDER BY pdf_id, timestamp DESC
                ) AS t
                ORDER BY timestamp DESC
            "#;
            match db.query(sql, &[&t, &s]).await {
                Ok(rows) => rows.into_iter().map(row_to_entry_with_tenant).collect(),
                Err(e) => {
                    error!(%e, "latest_by_status_with_tenant_db(t,s): query failed");
                    vec![]
                }
            }
        }
        (Some(t), None) => {
            let sql = r#"
                SELECT * FROM (
                  SELECT DISTINCT ON (pdf_id)
                         id, pdf_id, pipeline_id, state AS result,
                         pdf_url, timestamp, status, score, label AS result_label,
                         tenant_name
                  FROM v_analysis_history_with_tenant
                  WHERE tenant_name ILIKE '%' || $1 || '%'
                  ORDER BY pdf_id, timestamp DESC
                ) AS t
                ORDER BY timestamp DESC
            "#;
            match db.query(sql, &[&t]).await {
                Ok(rows) => rows.into_iter().map(row_to_entry_with_tenant).collect(),
                Err(e) => {
                    error!(%e, "latest_by_status_with_tenant_db(t): query failed");
                    vec![]
                }
            }
        }
        (None, Some(s)) => {
            let sql = r#"
                SELECT * FROM (
                  SELECT DISTINCT ON (pdf_id)
                         id, pdf_id, pipeline_id, state AS result,
                         pdf_url, timestamp, status, score, label AS result_label,
                         tenant_name
                  FROM v_analysis_history_with_tenant
                  WHERE status = $1
                  ORDER BY pdf_id, timestamp DESC
                ) AS t
                ORDER BY timestamp DESC
            "#;
            match db.query(sql, &[&s]).await {
                Ok(rows) => rows.into_iter().map(row_to_entry_with_tenant).collect(),
                Err(e) => {
                    error!(%e, "latest_by_status_with_tenant_db(s): query failed");
                    vec![]
                }
            }
        }
        (None, None) => {
            let sql = r#"
                SELECT * FROM (
                  SELECT DISTINCT ON (pdf_id)
                         id, pdf_id, pipeline_id, state AS result,
                         pdf_url, timestamp, status, score, label AS result_label,
                         tenant_name
                  FROM v_analysis_history_with_tenant
                  ORDER BY pdf_id, timestamp DESC
                ) AS t
                ORDER BY timestamp DESC
            "#;
            match db.query(sql, &[]).await {
                Ok(rows) => rows.into_iter().map(row_to_entry_with_tenant).collect(),
                Err(e) => {
                    error!(%e, "latest_by_status_with_tenant_db(all): query failed");
                    vec![]
                }
            }
        }
    }
}

/// Fetches a single run result by its identifier.
async fn fetch_entry_by_id(db: &Db, id: i32) -> Option<HistoryEntry> {
    match db
        .query_opt(
            "SELECT id,pdf_id,pipeline_id,state AS result,pdf_url,timestamp,status,score,label AS result_label, tenant_name \
             FROM v_analysis_history_with_tenant WHERE id = $1",
            &[&id],
        )
        .await
    {
        Ok(Some(row)) => Some(row_to_entry_with_tenant(row)),
        Ok(None) => None,
        Err(e) => {
            error!(%e, id, "fetch_entry_by_id: query failed");
            None
        }
    }
}

/// Marks an existing run result as pending while persisting metadata.
async fn mark_pending_db(
    db: &Db,
    pdf_id: i32,
    pipeline_id: Uuid,
    pdf_url: &str,
    timestamp: DateTime<Utc>,
) -> i32 {
    match db.query_opt(
        // started_at direkt auf timestamp setzen
        "INSERT INTO analysis_history (pdf_id, pipeline_id, pdf_url, timestamp, status, started_at) \
         VALUES ($1,$2,$3,$4,'running',$4) RETURNING id",
        &[&pdf_id, &pipeline_id, &pdf_url, &timestamp],
    ).await {
        Ok(Some(row)) => row.get(0),
        Ok(None) => {
            error!("mark_pending_db: no row returned");
            0
        }
        Err(e) => {
            error!(%e, pdf_id, "failed to insert running row");
            0
        }
    }
}

/// Persists a completed run result and updates associated metadata.
async fn insert_result_db(
    db: &Db,
    entry: &HistoryEntry,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
) -> i32 {
    let finished_ts = finished_at.unwrap_or(entry.timestamp);
    let started_override = started_at.clone();
    let started_ts = started_at.unwrap_or(entry.timestamp);
    match db
        .query_opt(
            "SELECT id FROM analysis_history WHERE pdf_id=$1 AND status='running' \
         ORDER BY timestamp DESC LIMIT 1",
            &[&entry.pdf_id],
        )
        .await
    {
        Ok(Some(row)) => {
            let id: i32 = row.get(0);
            if let Err(e) = db.execute(
                // finished_at beim Abschluss setzen
                "UPDATE analysis_history \
                 SET state=$2, pdf_url=$3, timestamp=$4, status='completed', score=$5, label=$6, finished_at=$7, \
                     started_at = COALESCE($8, started_at) \
                 WHERE id=$1",
                &[
                    &id,
                    &entry.result,
                    &entry.pdf_url,
                    &finished_ts,
                    &entry.score,
                    &entry.result_label,
                    &finished_ts,
                    &started_override,
                ],
            ).await {
                error!(%e, id, "failed to update running row to completed");
            }
            id
        }
        Ok(None) => {
            match db.query_opt(
                // Fallback: direkt completed eintragen – Start/Ende = timestamp
                "INSERT INTO analysis_history \
                 (pdf_id, pipeline_id, state, pdf_url, timestamp, status, score, label, started_at, finished_at) \
                 VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,$8,$9) RETURNING id",
                &[
                    &entry.pdf_id,
                    &entry.pipeline_id,
                    &entry.result,
                    &entry.pdf_url,
                    &finished_ts,
                    &entry.score,
                    &entry.result_label,
                    &started_ts,
                    &finished_ts,
                ],
            ).await {
                Ok(Some(row)) => row.get(0),
                Ok(None) => {
                    error!("insert_result_db: no row returned");
                    0
                }
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

/* ============================================================================================
HTTP-Handler
============================================================================================ */

/// Returns the most recent classification results.
async fn classifications(
    state: web::Data<AppState>,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    let limit = query
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(50);
    let items = latest_db(&state.db, limit).await;
    HttpResponse::Ok().json(items)
}

/// Returns the most recent analysis results.
async fn analyses(
    state: web::Data<AppState>,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    // NEU: run_id-Suche (liefert Liste mit max. 1 Eintrag, kompatibel zum Frontend)
    if let Some(rid) = query.get("run_id") {
        match state.db.query_opt(
            "SELECT id,pdf_id,pipeline_id,state AS result,pdf_url,timestamp,status,score,label AS result_label, tenant_name \
             FROM v_analysis_history_with_tenant WHERE state->>'run_id' = $1 ORDER BY timestamp DESC LIMIT 1",
            &[rid],
        ).await {
            Ok(Some(row)) => return HttpResponse::Ok().json(vec![row_to_entry_with_tenant(row)]),
            Ok(None) => return HttpResponse::Ok().json(Vec::<HistoryEntry>::new()),
            Err(e) => {
                error!(%e, "analyses(run_id): db error");
                return HttpResponse::InternalServerError().finish();
            }
        }
    }

    let status = query.get("status").cloned();
    let tenant_like = query.get("tenant").cloned();
    // View-basierte Ergebnisse (inkl. optionalem Tenant-Filter)
    let items = latest_by_status_with_tenant_db(&state.db, status, tenant_like).await;
    HttpResponse::Ok().json(items)
}

/// Returns the stored result for the provided identifier.
async fn result(state: web::Data<AppState>, path: web::Path<i32>) -> impl Responder {
    let pdf_id = path.into_inner();
    match state
        .db
        .query_opt(
            // Meta-Felder mit selektieren
            "SELECT state, started_at, finished_at, status, pipeline_id, pdf_id \
         FROM analysis_history \
         WHERE pdf_id=$1 AND status='completed' \
         ORDER BY timestamp DESC LIMIT 1",
            &[&pdf_id],
        )
        .await
    {
        Ok(Some(r)) => {
            let mut value: serde_json::Value = r.get(0);
            let started_at: Option<DateTime<Utc>> = r.get(1);
            let finished_at: Option<DateTime<Utc>> = r.get(2);
            let status: String = r.get(3);
            let pipeline_id: Uuid = r.get(4);
            let pdf_id_val: i32 = r.get(5);

            // sicherstellen, dass wir ein Object haben
            if !value.is_object() {
                value = json!({ "payload": value });
            }
            if let Some(map) = value.as_object_mut() {
                if let Some(dt) = started_at {
                    map.insert(
                        "started_at".into(),
                        serde_json::to_value(dt).unwrap_or_default(),
                    );
                }
                if let Some(dt) = finished_at {
                    map.insert(
                        "finished_at".into(),
                        serde_json::to_value(dt).unwrap_or_default(),
                    );
                }
                map.insert("status".into(), serde_json::Value::String(status));
                map.insert(
                    "pipeline_id".into(),
                    serde_json::Value::String(pipeline_id.to_string()),
                );
                map.insert("pdf_id".into(), serde_json::Value::from(pdf_id_val));
            }

            HttpResponse::Ok().json(value)
        }
        Ok(None) => HttpResponse::NotFound().finish(),
        Err(e) => {
            error!(%e, "result: db error");
            HttpResponse::InternalServerError().finish()
        }
    }
}

/// Reports health status for both the service and the downstream database.
async fn health(state: web::Data<AppState>) -> impl Responder {
    match state.db.ping().await {
        Ok(_) => HttpResponse::Ok().body("OK"),
        Err(e) => HttpResponse::ServiceUnavailable().body(format!("db not ok: {e}")),
    }
}

// NEU: Tenants auflisten
/// Lists the tenants known to the history service.
async fn tenants_list(state: web::Data<AppState>) -> impl Responder {
    match state
        .db
        .query("SELECT id, name FROM tenants ORDER BY name ASC", &[])
        .await
    {
        Ok(rows) => {
            let out: Vec<_> = rows
                .into_iter()
                .map(|r| json!({"id": r.get::<_, Uuid>(0), "name": r.get::<_, String>(1)}))
                .collect();
            HttpResponse::Ok().json(out)
        }
        Err(e) => {
            error!(%e, "tenants_list: db error");
            HttpResponse::InternalServerError().finish()
        }
    }
}

// NEU: Tenant anlegen (idempotent per UNIQUE name)
#[derive(Deserialize)]
struct CreateTenantBody {
    name: String,
}

/// Creates a new tenant and persists its configuration metadata.
async fn tenants_create(
    state: web::Data<AppState>,
    body: web::Json<CreateTenantBody>,
) -> impl Responder {
    let nm = body.name.trim();
    if nm.is_empty() {
        return HttpResponse::BadRequest().body("name must not be empty");
    }
    match state
        .db
        .query_opt(
            "INSERT INTO tenants (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name",
            &[&nm],
        )
        .await
    {
        Ok(Some(row)) => {
            let id: Uuid = row.get(0);
            let name: String = row.get(1);
            HttpResponse::Created().json(json!({"id": id, "name": name}))
        }
        Ok(None) => HttpResponse::InternalServerError().finish(),
        Err(e) => {
            error!(%e, "tenants_create: db error");
            HttpResponse::InternalServerError().finish()
        }
    }
}

/* ============================================================================================
WebSocket
============================================================================================ */

struct WsConn {
    db: Arc<Db>,
    rx: tokio::sync::broadcast::Receiver<HistoryEntry>,
}

impl actix::Actor for WsConn {
    type Context = ws::WebsocketContext<Self>;

    /// Sends the most recent history entries to the client when the socket is
    /// established.
    fn started(&mut self, ctx: &mut Self::Context) {
        let dbwrap = self.db.clone();
        async move { all_entries_db(&dbwrap).await }
            .into_actor(self)
            .map(|entries, _act, ctx| {
                if let Ok(text) =
                    serde_json::to_string(&serde_json::json!({"type":"history","data":entries}))
                {
                    ctx.text(text);
                }
            })
            .spawn(ctx);

        ctx.add_stream(BroadcastStream::new(self.rx.resubscribe()));
    }
}

impl actix::StreamHandler<Result<HistoryEntry, BroadcastStreamRecvError>> for WsConn {
    /// Pushes history updates from the broadcast channel to the socket.
    fn handle(
        &mut self,
        item: Result<HistoryEntry, BroadcastStreamRecvError>,
        ctx: &mut Self::Context,
    ) {
        if let Ok(entry) = item {
            if let Ok(text) =
                serde_json::to_string(&serde_json::json!({"type":"update","data":entry}))
            {
                ctx.text(text);
            }
        }
    }
}

impl actix::StreamHandler<Result<ws::Message, ws::ProtocolError>> for WsConn {
    /// Handles WebSocket control frames and closes the connection when
    /// requested by the client.
    fn handle(&mut self, item: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match item {
            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            Ok(ws::Message::Close(_)) => ctx.stop(),
            _ => {}
        }
    }
}

/// Upgrades a HTTP request to a WebSocket session for history streaming.
async fn ws_index(
    req: HttpRequest,
    stream: Payload,
    state: web::Data<AppState>,
) -> Result<HttpResponse, Error> {
    let ws = WsConn {
        db: state.db.clone(),
        rx: state.tx.subscribe(),
    };
    ws::start(ws, &req, stream)
}

/* ============================================================================================
Kafka-Consumer
============================================================================================ */

/// Starts a Kafka consumer that forwards run updates to the broadcast channel.
async fn start_kafka(
    db: Arc<Db>,
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
        .create()
    {
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

                                    let id = mark_pending_db(
                                        &db,
                                        data.pdf_id,
                                        data.pipeline_id,
                                        &pdf_url,
                                        ts,
                                    )
                                    .await;
                                    if id > 0 {
                                        if let Some(entry) = fetch_entry_by_id(&db, id).await {
                                            let _ = tx.send(entry);
                                        } else {
                                            let fallback = HistoryEntry {
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
                                                tenant_name: None,
                                            };
                                            let _ = tx.send(fallback);
                                        }
                                    }
                                }
                                Err(e) => error!(%e, "failed to parse pdf-merged payload"),
                            }
                        }
                        "pipeline-result" => {
                            match serde_json::from_str::<PipelineRunResult>(payload) {
                                Ok(data) => {
                                    let value = serde_json::to_value(&data).unwrap_or_default();

                                    let started_at_ts = data
                                        .started_at
                                        .as_ref()
                                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                                        .map(|dt| dt.with_timezone(&Utc));
                                    let finished_at_ts = data
                                        .finished_at
                                        .as_ref()
                                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                                        .map(|dt| dt.with_timezone(&Utc));

                                    let mut entry = HistoryEntry {
                                        id: 0,
                                        pdf_id: data.pdf_id,
                                        pipeline_id: data.pipeline_id,
                                        prompt: None,
                                        result: Some(value.clone()),
                                        pdf_url: format!("{}/pdf/{}", pdf_base, data.pdf_id),
                                        timestamp: finished_at_ts.unwrap_or_else(Utc::now),
                                        status: "completed".into(),
                                        score: data.overall_score.map(|f| f as f64),
                                        result_label: None,
                                        tenant_name: None,
                                    };

                                    let id = insert_result_db(
                                        &db,
                                        &entry,
                                        started_at_ts,
                                        finished_at_ts,
                                    )
                                    .await;
                                    entry.id = id;
                                    if id > 0 {
                                        if let Some(updated) = fetch_entry_by_id(&db, id).await {
                                            let _ = tx.send(updated);
                                        } else {
                                            let _ = tx.send(entry);
                                        }
                                    } else {
                                        let _ = tx.send(entry);
                                    }
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

/* ============================================================================================
main
============================================================================================ */

#[actix_web::main]
/// Boots the history service HTTP server and supporting background tasks.
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

    // NoTLS + Auto-Reconnect
    let db = Db::new(settings.database_url.clone()).await;

    // Schema sicherstellen (inkl. started_at/finished_at Backfill)
    ensure_schema_db(&db).await;

    let (tx, _) = tokio::sync::broadcast::channel(100);
    let pdf_base =
        std::env::var("PDF_INGEST_URL").unwrap_or_else(|_| "http://localhost:8081".into());
    let state = web::Data::new(AppState {
        db: db.clone(),
        tx: tx.clone(),
        pdf_base: pdf_base.clone(),
    });

    // Kafka-Consumer
    {
        let db_for_kafka = db.clone();
        let tx_for_kafka = tx.clone();
        let pdf_base_for_kafka = pdf_base.clone();
        let broker_url = settings.message_broker_url.clone();
        actix_web::rt::spawn(start_kafka(
            db_for_kafka,
            tx_for_kafka,
            broker_url,
            pdf_base_for_kafka,
        ));
    }

    let port: u16 = std::env::var("SERVER_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8090);
    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(state.clone())
            .route("/classifications", web::get().to(classifications))
            .route("/analyses", web::get().to(analyses))
            .route("/results/{id}", web::get().to(result))
            // WebSocket (Root)
            .route("/", web::get().to(ws_index))
            .route("/health", web::get().to(health))
            // NEU: Tenants-API
            .route("/tenants", web::get().to(tenants_list))
            .route("/tenants", web::post().to(tenants_create))
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
