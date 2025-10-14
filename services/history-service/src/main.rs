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

struct Db {
    dsn: String,
    client: RwLock<Option<Arc<Client>>>,
}

impl Db {
    async fn new(dsn: String) -> Arc<Self> {
        let db = Arc::new(Self {
            dsn,
            client: RwLock::new(None),
        });

        // Erste Verbindung versuchen
        if let Err(e) = db.reconnect().await {
            warn!(%e, "initial db connect failed; will retry on demand");
        }

        // Heartbeat, damit Idle-Verbindung nicht stirbt (und Drops früh erkannt werden)
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

    async fn connect_once(&self) -> Result<(Arc<Client>, impl std::future::Future<Output = Result<(), tokio_postgres::Error>> + Send + 'static), tokio_postgres::Error> {
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

    async fn reconnect(&self) -> Result<(), tokio_postgres::Error> {
        let (client, connection_fut) = self.connect_once().await?;
        tokio::spawn(async move {
            let _ = connection_fut.await;
        });
        *self.client.write().await = Some(client);
        info!("postgres connected (NoTLS)");
        Ok(())
    }

    async fn current(&self) -> Result<Arc<Client>, tokio_postgres::Error> {
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

    #[inline]
    fn looks_like_closed(err: &tokio_postgres::Error) -> bool {
        let s = err.to_string().to_lowercase();
        s.contains("closed") || s.contains("broken pipe") || s.contains("connection reset")
    }

    /// query mit 1x Auto-Reconnect-Retry
    async fn query(&self, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Vec<Row>, tokio_postgres::Error> {
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

    /// execute mit 1x Auto-Reconnect-Retry
    async fn execute(&self, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<u64, tokio_postgres::Error> {
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

    /// query_opt mit 1x Auto-Reconnect-Retry
    async fn query_opt(&self, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Option<Row>, tokio_postgres::Error> {
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

async fn ensure_schema_db(db: &Db) {
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

    let _ = db.execute(
        "ALTER TABLE analysis_history \
         ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running'",
        &[],
    ).await;

    // NEU: Start/Ende-Spalten hinzufügen
    let _ = db.execute(
        "ALTER TABLE analysis_history \
         ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ",
        &[],
    ).await;
    let _ = db.execute(
        "ALTER TABLE analysis_history \
         ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ",
        &[],
    ).await;

    // Backfill: started_at := timestamp; finished_at := timestamp wenn completed
    let _ = db.execute(
        "UPDATE analysis_history SET started_at = COALESCE(started_at, timestamp)",
        &[],
    ).await;
    let _ = db.execute(
        "UPDATE analysis_history \
         SET finished_at = CASE WHEN status='completed' THEN COALESCE(finished_at, timestamp) ELSE finished_at END",
        &[],
    ).await;

    info!("database schema ensured");
}

// Mapping für Selektierungen aus der View (enthält zusätzlich tenant_name)
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

async fn latest_by_status_db(db: &Db, status: Option<String>) -> Vec<HistoryEntry> {
    if let Some(s) = status {
        match db.query(
            "SELECT * FROM ( \
               SELECT DISTINCT ON (pdf_id) id, pdf_id, pipeline_id, state AS result, \
                      pdf_url, timestamp, status, score, label AS result_label, tenant_name \
               FROM v_analysis_history_with_tenant WHERE status = $1 \
               ORDER BY pdf_id, timestamp DESC \
             ) AS t ORDER BY timestamp DESC",
            &[&s],
        ).await {
            Ok(rows) => rows.into_iter().map(row_to_entry_with_tenant).collect(),
            Err(e) => {
                error!(%e, "latest_by_status_db(status): query failed");
                vec![]
            }
        }
    } else {
        match db.query(
            "SELECT * FROM ( \
               SELECT DISTINCT ON (pdf_id) id, pdf_id, pipeline_id, state AS result, \
                      pdf_url, timestamp, status, score, label AS result_label, tenant_name \
               FROM v_analysis_history_with_tenant \
               ORDER BY pdf_id, timestamp DESC \
             ) AS t ORDER BY timestamp DESC",
            &[],
        ).await {
            Ok(rows) => rows.into_iter().map(row_to_entry_with_tenant).collect(),
            Err(e) => {
                error!(%e, "latest_by_status_db(all): query failed");
                vec![]
            }
        }
    }
}

// NEU: gleiche Logik wie oben, aber über die View v_analysis_history_with_tenant + Tenant-Filter
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

async fn insert_result_db(db: &Db, entry: &HistoryEntry) -> i32 {
    match db.query_opt(
        "SELECT id FROM analysis_history WHERE pdf_id=$1 AND status='running' \
         ORDER BY timestamp DESC LIMIT 1",
        &[&entry.pdf_id],
    ).await {
        Ok(Some(row)) => {
            let id: i32 = row.get(0);
            if let Err(e) = db.execute(
                // finished_at beim Abschluss setzen
                "UPDATE analysis_history \
                 SET state=$2, pdf_url=$3, timestamp=$4, status='completed', score=$5, label=$6, finished_at=$4 \
                 WHERE id=$1",
                &[
                    &id,
                    &entry.result,
                    &entry.pdf_url,
                    &entry.timestamp,
                    &entry.score,
                    &entry.result_label,
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
                 VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,$5,$5) RETURNING id",
                &[
                    &entry.pdf_id,
                    &entry.pipeline_id,
                    &entry.result,
                    &entry.pdf_url,
                    &entry.timestamp,
                    &entry.score,
                    &entry.result_label,
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

async fn classifications(
    state: web::Data<AppState>,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    let limit = query.get("limit").and_then(|v| v.parse::<i64>().ok()).unwrap_or(50);
    let items = latest_db(&state.db, limit).await;
    HttpResponse::Ok().json(items)
}

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

#[derive(Deserialize)]
struct PdfNameSearchQuery {
    q: Option<String>,
    limit: Option<i64>,
    tenant_id: Option<Uuid>,
    tenant: Option<String>,
    pipeline_id: Option<Uuid>,
    pipeline: Option<String>,
    status: Option<String>,
    pdf_id: Option<i32>,
}

#[derive(Serialize)]
struct PdfNameSearchHit {
    analysis_id: i32,
    pdf_id: i32,
    pipeline_id: Uuid,
    pipeline_name: Option<String>,
    tenant_id: Option<Uuid>,
    tenant_name: Option<String>,
    status: String,
    timestamp: DateTime<Utc>,
    pdf_name: String,
}

#[derive(Serialize)]
struct PdfNameSearchResponse {
    total: i64,
    hits: Vec<PdfNameSearchHit>,
}

async fn search_pdf_names(
    state: web::Data<AppState>,
    query: web::Query<PdfNameSearchQuery>,
) -> impl Responder {
    let search = match query
        .q
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned())
    {
        Some(s) => s,
        None => {
            return HttpResponse::Ok().json(PdfNameSearchResponse { total: 0, hits: vec![] });
        }
    };

    let limit = query.limit.unwrap_or(12).clamp(1, 100);

    let tenant_like = query
        .tenant
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned());

    let pipeline_like = query
        .pipeline
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned());

    let status_like = query
        .status
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned());

    let rows = match state
        .db
        .query(
            "WITH filtered AS (
                SELECT
                    v.id,
                    v.pdf_id,
                    v.pipeline_id,
                    v.status,
                    v.timestamp,
                    v.tenant_id,
                    v.tenant_name,
                    COALESCE(v.state->>'pipeline_name', v.state->'pipeline'->>'name') AS pipeline_name,
                    jsonb_array_elements_text(
                        CASE
                            WHEN v.pdf_names IS NULL OR v.pdf_names = '' THEN '[]'::jsonb
                            ELSE v.pdf_names::jsonb
                        END
                    ) AS pdf_name
                FROM v_analysis_history_with_tenant v
                WHERE ($2::uuid IS NULL OR v.tenant_id = $2)
                  AND ($7::text IS NULL OR v.tenant_name ILIKE '%' || $7 || '%')
                  AND ($3::uuid IS NULL OR v.pipeline_id = $3)
                  AND (
                        $8::text IS NULL
                        OR COALESCE(v.state->>'pipeline_name', v.state->'pipeline'->>'name')
                            ILIKE '%' || $8 || '%'
                  )
                  AND ($4::text IS NULL OR v.status = $4)
                  AND ($5::int IS NULL OR v.pdf_id = $5)
            )
            SELECT
                COUNT(*) OVER() AS total,
                id,
                pdf_id,
                pipeline_id,
                pipeline_name,
                status,
                timestamp,
                tenant_id,
                tenant_name,
                pdf_name
            FROM filtered
            WHERE pdf_name ILIKE '%' || $1 || '%'
            ORDER BY timestamp DESC
            LIMIT $6",
            &[
                &search,
                &query.tenant_id,
                &query.pipeline_id,
                &status_like,
                &query.pdf_id,
                &limit,
                &tenant_like,
                &pipeline_like,
            ],
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            error!(%e, "search_pdf_names: db error");
            return HttpResponse::InternalServerError().finish();
        }
    };

    let mut hits = Vec::with_capacity(rows.len());
    let mut total: i64 = 0;

    for row in rows {
        total = row.get::<_, i64>(0);
        let analysis_id: i32 = row.get(1);
        let pdf_id: i32 = row.get(2);
        let pipeline_id: Uuid = row.get(3);
        let pipeline_name: Option<String> = row.get(4);
        let status: String = row.get(5);
        let timestamp: DateTime<Utc> = row.get(6);
        let tenant_id: Option<Uuid> = row.get(7);
        let tenant_name: Option<String> = row.get(8);
        let pdf_name: String = row.get(9);

        hits.push(PdfNameSearchHit {
            analysis_id,
            pdf_id,
            pipeline_id,
            pipeline_name,
            tenant_id,
            tenant_name,
            status,
            timestamp,
            pdf_name,
        });
    }

    HttpResponse::Ok().json(PdfNameSearchResponse { total, hits })
}

async fn result(state: web::Data<AppState>, path: web::Path<i32>) -> impl Responder {
    let pdf_id = path.into_inner();
    match state.db.query_opt(
        // Meta-Felder mit selektieren
        "SELECT state, started_at, finished_at, status, pipeline_id, pdf_id \
         FROM analysis_history \
         WHERE pdf_id=$1 AND status='completed' \
         ORDER BY timestamp DESC LIMIT 1",
        &[&pdf_id],
    ).await {
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
                    map.insert("started_at".into(), serde_json::to_value(dt).unwrap_or_default());
                }
                if let Some(dt) = finished_at {
                    map.insert("finished_at".into(), serde_json::to_value(dt).unwrap_or_default());
                }
                map.insert("status".into(), serde_json::Value::String(status));
                map.insert("pipeline_id".into(), serde_json::Value::String(pipeline_id.to_string()));
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

async fn health(state: web::Data<AppState>) -> impl Responder {
    match state.db.ping().await {
        Ok(_) => HttpResponse::Ok().body("OK"),
        Err(e) => HttpResponse::ServiceUnavailable().body(format!("db not ok: {e}")),
    }
}

// NEU: Tenants auflisten
async fn tenants_list(state: web::Data<AppState>) -> impl Responder {
    match state.db.query("SELECT id, name FROM tenants ORDER BY name ASC", &[]).await {
        Ok(rows) => {
            let out: Vec<_> = rows.into_iter()
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
struct CreateTenantBody { name: String }

async fn tenants_create(state: web::Data<AppState>, body: web::Json<CreateTenantBody>) -> impl Responder {
    let nm = body.name.trim();
    if nm.is_empty() {
        return HttpResponse::BadRequest().body("name must not be empty");
    }
    match state.db.query_opt(
        "INSERT INTO tenants (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name",
        &[&nm],
    ).await {
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

    fn started(&mut self, ctx: &mut Self::Context) {
        let dbwrap = self.db.clone();
        async move { all_entries_db(&dbwrap).await }
            .into_actor(self)
            .map(|entries, _act, ctx| {
                if let Ok(text) = serde_json::to_string(
                    &serde_json::json!({"type":"history","data":entries})
                ) {
                    ctx.text(text);
                }
            })
            .spawn(ctx);

        ctx.add_stream(BroadcastStream::new(self.rx.resubscribe()));
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

/* ============================================================================================
   Kafka-Consumer
   ============================================================================================ */

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

                                    let id = mark_pending_db(&db, data.pdf_id, data.pipeline_id, &pdf_url, ts).await;
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

                                    let mut entry = HistoryEntry {
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
                                        tenant_name: None,
                                    };

                                    let id = insert_result_db(&db, &entry).await;
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
    let pdf_base = std::env::var("PDF_INGEST_URL").unwrap_or_else(|_| "http://localhost:8081".into());
    let state = web::Data::new(AppState { db: db.clone(), tx: tx.clone(), pdf_base: pdf_base.clone() });

    // Kafka-Consumer
    {
        let db_for_kafka = db.clone();
        let tx_for_kafka = tx.clone();
        let pdf_base_for_kafka = pdf_base.clone();
        let broker_url = settings.message_broker_url.clone();
        actix_web::rt::spawn(start_kafka(db_for_kafka, tx_for_kafka, broker_url, pdf_base_for_kafka));
    }

    let port: u16 = std::env::var("SERVER_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8090);
    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(state.clone())
            .route("/classifications", web::get().to(classifications))
            .route("/analyses", web::get().to(analyses))
            .route("/analyses/search", web::get().to(search_pdf_names))
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
