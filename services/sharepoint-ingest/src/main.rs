//! Service responsible for scanning SharePoint folders and enqueueing PDF jobs.

mod config;
mod job;
mod msgraph;
mod pdfops;
mod pipeline_adapter;
mod scan;
mod upload_adapter;

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::Arc;

use actix_cors::Cors;
use actix_web::{
    error::ErrorBadRequest, http::header, middleware::Logger, web, App, HttpRequest, HttpResponse,
    HttpServer, Responder,
};
use anyhow::{anyhow, Context};
use chrono::{DateTime, Utc};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use job::{job_summary, JobOrder, JobPersistence, JobRegistry, JobStatus, JobStore, ManagedJob};
use msgraph::{GraphFile, GraphFolder, MsGraphClient};
use pdfops::merge_pdfs;
use pipeline_adapter::PipelineAdapter;
use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    ClientConfig, Message,
};
use scan::{assert_pdf, scan_with_clamd, ScanConfig};
use serde_json::json;
use shared::dto::PipelineRunResult;
use tokio::sync::{watch, Semaphore};
use tokio::time::sleep;
use tokio_postgres::{NoTls, Row};
use tracing::{error, info, warn};
use upload_adapter::UploadAdapter;
use uuid::Uuid;

const SHAREPOINT_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sharepoint_jobs (
    id UUID PRIMARY KEY,
    folder_id TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','paused','succeeded','failed','canceled')),
    progress DOUBLE PRECISION NOT NULL DEFAULT 0,
    message TEXT,
    order_key TEXT NOT NULL,
    filenames_override TEXT[],
    upload_url TEXT,
    tenant_id UUID,
    pipeline_id UUID,
    pipeline_run_id UUID REFERENCES pipeline_runs(id) ON DELETE SET NULL,
    upload_id INTEGER,
    pdf_id INTEGER,
    output JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sharepoint_jobs_created_at ON sharepoint_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sharepoint_jobs_status ON sharepoint_jobs (status);
CREATE INDEX IF NOT EXISTS idx_sharepoint_jobs_pdf_id ON sharepoint_jobs (pdf_id);
CREATE INDEX IF NOT EXISTS idx_sharepoint_jobs_upload_id ON sharepoint_jobs (upload_id);

CREATE TABLE IF NOT EXISTS sharepoint_automation (
    folder_id TEXT PRIMARY KEY,
    folder_name TEXT NOT NULL,
    tenant_id UUID,
    pipeline_id UUID,
    auto_ingest BOOLEAN NOT NULL DEFAULT FALSE,
    auto_pipeline BOOLEAN NOT NULL DEFAULT FALSE,
    managed_by_default BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sharepoint_automation_tenant ON sharepoint_automation (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sharepoint_automation_pipeline ON sharepoint_automation (pipeline_id);

ALTER TABLE sharepoint_automation
    ADD COLUMN IF NOT EXISTS managed_by_default BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS sharepoint_automation_defaults (
    scope TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    tenant_id UUID,
    pipeline_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO sharepoint_automation_defaults (scope, enabled, tenant_id, pipeline_id)
VALUES ('ingest', FALSE, NULL, NULL)
ON CONFLICT (scope) DO NOTHING;

INSERT INTO sharepoint_automation_defaults (scope, enabled, tenant_id, pipeline_id)
VALUES ('processing', FALSE, NULL, NULL)
ON CONFLICT (scope) DO NOTHING;

ALTER TABLE sharepoint_jobs
    ADD COLUMN IF NOT EXISTS auto_managed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sharepoint_jobs
    ADD COLUMN IF NOT EXISTS auto_last_seen_at TIMESTAMPTZ;
"#;

use crate::config::Config;

fn ensure_sslmode_disable(url: &str) -> String {
    if url.to_ascii_lowercase().contains("sslmode=") {
        return url.to_string();
    }
    if url.contains('?') {
        format!("{url}&sslmode=disable")
    } else {
        format!("{url}?sslmode=disable")
    }
}

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    graph: Arc<MsGraphClient>,
    uploader: Arc<UploadAdapter>,
    jobs: JobRegistry,
    semaphore: Arc<Semaphore>,
    db_pool: Pool,
    job_store: Arc<JobStore>,
    pipeline: Arc<PipelineAdapter>,
}

#[derive(serde::Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[derive(serde::Serialize)]
struct FoldersResponse {
    base: String,
    total: usize,
    items: Vec<FolderItem>,
}

#[derive(serde::Serialize)]
struct FolderItem {
    id: String,
    name: String,
    file_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    automation: Option<FolderAutomation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    automation_source: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct FolderAutomation {
    #[serde(skip_serializing_if = "Option::is_none")]
    tenant_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pipeline_id: Option<Uuid>,
    auto_ingest: bool,
    auto_pipeline: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_seen: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<DateTime<Utc>>,
}

#[derive(Clone)]
struct AutomationRecord {
    folder_id: String,
    folder_name: String,
    tenant_id: Option<Uuid>,
    pipeline_id: Option<Uuid>,
    auto_ingest: bool,
    auto_pipeline: bool,
    managed_by_default: bool,
    last_seen: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
}

#[derive(serde::Serialize)]
struct AutomationRuleResponse {
    folder_id: String,
    folder_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tenant_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pipeline_id: Option<Uuid>,
    auto_ingest: bool,
    auto_pipeline: bool,
    managed_by_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_seen: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
}

#[derive(serde::Serialize)]
struct AutomationListResponse {
    items: Vec<AutomationRuleResponse>,
}

#[derive(Clone)]
struct DefaultAutomationSettings {
    scope: String,
    enabled: bool,
    tenant_id: Option<Uuid>,
    pipeline_id: Option<Uuid>,
    updated_at: DateTime<Utc>,
}

#[derive(serde::Serialize)]
struct AutomationDefaultResponse {
    scope: String,
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tenant_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pipeline_id: Option<Uuid>,
    updated_at: DateTime<Utc>,
}

#[derive(serde::Serialize)]
struct AutomationDefaultsResponse {
    items: Vec<AutomationDefaultResponse>,
}

#[derive(serde::Deserialize)]
struct AutomationUpsertRequest {
    #[serde(default)]
    folder_name: Option<String>,
    #[serde(default)]
    tenant_id: Option<Uuid>,
    #[serde(default)]
    pipeline_id: Option<Uuid>,
    #[serde(default)]
    auto_ingest: Option<bool>,
    #[serde(default)]
    auto_pipeline: Option<bool>,
}

#[derive(serde::Deserialize)]
struct AutomationDefaultUpdateRequest {
    enabled: bool,
    #[serde(default)]
    tenant_id: Option<Uuid>,
    #[serde(default)]
    pipeline_id: Option<Uuid>,
}

impl AutomationRecord {
    fn to_folder_automation(&self) -> FolderAutomation {
        FolderAutomation {
            tenant_id: self.tenant_id,
            pipeline_id: self.pipeline_id,
            auto_ingest: self.auto_ingest,
            auto_pipeline: self.auto_pipeline,
            last_seen: self.last_seen,
            updated_at: Some(self.updated_at),
        }
    }

    fn into_response(self) -> AutomationRuleResponse {
        AutomationRuleResponse {
            folder_id: self.folder_id,
            folder_name: self.folder_name,
            tenant_id: self.tenant_id,
            pipeline_id: self.pipeline_id,
            auto_ingest: self.auto_ingest,
            auto_pipeline: self.auto_pipeline,
            managed_by_default: self.managed_by_default,
            last_seen: self.last_seen,
            updated_at: self.updated_at,
        }
    }
}

impl DefaultAutomationSettings {
    fn into_response(self) -> AutomationDefaultResponse {
        AutomationDefaultResponse {
            scope: self.scope,
            enabled: self.enabled,
            tenant_id: self.tenant_id,
            pipeline_id: self.pipeline_id,
            updated_at: self.updated_at,
        }
    }
}

#[derive(serde::Deserialize)]
struct JobCreateRequest {
    folder_ids: Vec<String>,
    #[serde(default)]
    order: Option<JobOrder>,
    #[serde(default)]
    filenames: Option<HashMap<String, Vec<String>>>,
    #[serde(default)]
    upload_url: Option<String>,
    #[serde(default)]
    tenant_id: Option<Uuid>,
    #[serde(default)]
    pipeline_id: Option<Uuid>,
}

#[derive(serde::Serialize)]
struct JobsResponse {
    jobs: Vec<job::JobSummary>,
}

#[derive(serde::Serialize)]
struct ProcessedFoldersResponse {
    items: Vec<ProcessedFolderItem>,
}

#[derive(serde::Deserialize)]
struct ProcessedFoldersQuery {
    #[serde(default)]
    stage: Option<String>,
}

#[derive(serde::Serialize)]
struct ProcessedFolderItem {
    job_id: Uuid,
    folder_id: String,
    folder_name: String,
    status: JobStatus,
    progress: f32,
    message: Option<String>,
    tenant_id: Option<Uuid>,
    pipeline_id: Option<Uuid>,
    pipeline_run_id: Option<Uuid>,
    upload_id: Option<i32>,
    pdf_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upload_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pipeline_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pipeline_status_category: Option<JobStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pipeline_progress: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pipeline_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pipeline_started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pipeline_finished_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(serde::Deserialize)]
struct ProcessedFoldersRunRequest {
    job_ids: Vec<Uuid>,
    pipeline_id: Uuid,
}

#[derive(serde::Serialize)]
struct ProcessedRunResponse {
    started: Vec<ProcessedRunStarted>,
    skipped: Vec<ProcessedRunSkipped>,
}

#[derive(serde::Serialize)]
struct ProcessedRunStarted {
    job_id: Uuid,
    upload_id: i32,
    pdf_id: Option<i32>,
    pipeline_id: Uuid,
}

#[derive(serde::Serialize)]
struct ProcessedRunSkipped {
    job_id: Uuid,
    reason: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum AggregatedJobSource {
    Sharepoint,
    Pipeline,
}

#[derive(serde::Serialize)]
struct AggregatedJobEntry {
    id: String,
    source: AggregatedJobSource,
    status: String,
    status_category: JobStatus,
    progress: f32,
    message: Option<String>,
    folder_name: Option<String>,
    pipeline_name: Option<String>,
    sharepoint_job_id: Option<Uuid>,
    pipeline_id: Option<Uuid>,
    pdf_id: Option<i32>,
    upload_id: Option<i32>,
    created_at: DateTime<Utc>,
    updated_at: Option<DateTime<Utc>>,
}

#[derive(serde::Serialize)]
struct AggregatedJobsResponse {
    jobs: Vec<AggregatedJobEntry>,
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .init();

    let raw_config = Config::from_env().expect("configuration error");
    let db_url = ensure_sslmode_disable(&raw_config.database_url);
    let pg_config = tokio_postgres::Config::from_str(&db_url).map_err(|err| {
        error!(error = %err, "failed to parse DATABASE_URL");
        std::io::Error::new(std::io::ErrorKind::Other, "invalid database url")
    })?;
    let manager = Manager::from_config(
        pg_config,
        NoTls,
        ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        },
    );
    let pool = Pool::builder(manager).max_size(16).build().map_err(|err| {
        error!(error = %err, "failed to build postgres pool");
        std::io::Error::new(std::io::ErrorKind::Other, "db-pool")
    })?;
    info!("created postgres pool");

    ensure_sharepoint_schema(&pool).await.map_err(|err| {
        error!(error = %err, "failed to ensure sharepoint schema");
        std::io::Error::new(std::io::ErrorKind::Other, "db-migrate")
    })?;

    let job_store = Arc::new(JobStore::new(pool.clone()));
    let jobs = JobRegistry::new(Some(JobPersistence::new(job_store.clone())));

    match job_store.load_all().await {
        Ok(records) => {
            let mut restored = 0usize;
            for mut state in records {
                if matches!(state.status, JobStatus::Running | JobStatus::Queued) {
                    state.set_status(JobStatus::Failed);
                    state.set_message("Verarbeitung beim Neustart unterbrochen");
                    if let Err(err) = job_store.persist_state(&state).await {
                        warn!(job_id = %state.id, error = %err, "failed to persist interrupted state");
                    }
                }
                jobs.restore_job(state);
                restored += 1;
            }
            if restored > 0 {
                info!(count = restored, "restored persisted SharePoint jobs");
            }
        }
        Err(err) => {
            warn!(error = %err, "failed to load persisted SharePoint jobs");
        }
    }

    let config = Arc::new(raw_config);
    let max_concurrency = config.max_concurrency;
    let graph = Arc::new(MsGraphClient::new(&config).expect("graph client"));
    graph
        .bootstrap(&config)
        .await
        .expect("graph bootstrap failed");
    let uploader = Arc::new(
        UploadAdapter::new(
            config.upload_url.clone(),
            config.upload_api_token.clone(),
            config.upload_timeout,
        )
        .expect("upload adapter"),
    );
    let pipeline = Arc::new(
        PipelineAdapter::new(
            config.pipeline_api_url.clone(),
            config.pipeline_api_token.clone(),
            config.upload_timeout,
        )
        .expect("pipeline adapter"),
    );

    let state = AppState {
        config: config.clone(),
        graph,
        uploader,
        jobs,
        semaphore: Arc::new(Semaphore::new(max_concurrency)),
        db_pool: pool.clone(),
        job_store,
        pipeline,
    };

    spawn_folder_poller(state.clone());
    spawn_pipeline_result_consumer(state.clone());

    let bind_addr = format!("{}:{}", state.config.http_bind, state.config.http_port);
    info!(%bind_addr, "starting server");

    let server_state = state.clone();

    HttpServer::new(move || {
        let app_state = server_state.clone();
        let mut cors = Cors::default()
            .allowed_methods(vec!["GET", "POST"])
            .allowed_headers(vec![header::CONTENT_TYPE, header::AUTHORIZATION])
            .max_age(3600);

        if let Some(origins) = &app_state.config.cors_origins {
            for origin in origins {
                cors = cors.allowed_origin(origin);
            }
        } else {
            warn!("CORS_ORIGINS not set; allowing any origin");
            cors = cors.allow_any_origin();
        }

        App::new()
            .app_data(web::Data::new(app_state))
            .wrap(Logger::default())
            .wrap(cors)
            .route("/healthz", web::get().to(healthz))
            .route("/folders", web::get().to(list_folders))
            .route("/processed-folders", web::get().to(list_processed_folders))
            .route(
                "/processed-folders/run",
                web::post().to(run_processed_folders),
            )
            .route("/jobs/all", web::get().to(list_all_jobs))
            .service(
                web::scope("/automation")
                    .route("/settings", web::get().to(list_automation_settings))
                    .route(
                        "/settings/{scope}",
                        web::put().to(upsert_automation_setting),
                    )
                    .route("/folders", web::get().to(list_automation_rules))
                    .route("/folders/{id}", web::put().to(upsert_automation_rule)),
            )
            .service(
                web::scope("/jobs")
                    .route("", web::get().to(list_jobs))
                    .route("", web::post().to(create_jobs))
                    .route("/{id}/pause", web::post().to(pause_job))
                    .route("/{id}/resume", web::post().to(resume_job))
                    .route("/{id}/cancel", web::post().to(cancel_job))
                    .route("/{id}/retry", web::post().to(retry_job)),
            )
    })
    .bind(bind_addr)?
    .run()
    .await
}

async fn ensure_sharepoint_schema(pool: &Pool) -> anyhow::Result<()> {
    let client = pool
        .get()
        .await
        .context("get connection for sharepoint schema setup")?;
    client
        .batch_execute(SHAREPOINT_SCHEMA_SQL)
        .await
        .context("create sharepoint_jobs schema")?;
    Ok(())
}

fn automation_from_row(row: &Row) -> AutomationRecord {
    AutomationRecord {
        folder_id: row.get("folder_id"),
        folder_name: row.get("folder_name"),
        tenant_id: row.get("tenant_id"),
        pipeline_id: row.get("pipeline_id"),
        auto_ingest: row.get("auto_ingest"),
        auto_pipeline: row.get("auto_pipeline"),
        managed_by_default: row.get("managed_by_default"),
        last_seen: row.get("last_seen"),
        updated_at: row.get("updated_at"),
    }
}

fn default_from_row(row: &Row) -> DefaultAutomationSettings {
    DefaultAutomationSettings {
        scope: row.get("scope"),
        enabled: row.get("enabled"),
        tenant_id: row.get("tenant_id"),
        pipeline_id: row.get("pipeline_id"),
        updated_at: row.get("updated_at"),
    }
}

async fn load_automation_rules(
    client: &tokio_postgres::Client,
) -> anyhow::Result<Vec<AutomationRecord>> {
    let rows = client
        .query(
            "SELECT folder_id, folder_name, tenant_id, pipeline_id, auto_ingest, auto_pipeline, managed_by_default, last_seen, updated_at
             FROM sharepoint_automation",
            &[],
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| automation_from_row(&row))
        .collect())
}

async fn load_automation_rule(
    client: &tokio_postgres::Client,
    folder_id: &str,
) -> anyhow::Result<Option<AutomationRecord>> {
    let row = client
        .query_opt(
            "SELECT folder_id, folder_name, tenant_id, pipeline_id, auto_ingest, auto_pipeline, managed_by_default, last_seen, updated_at
             FROM sharepoint_automation WHERE folder_id = $1",
            &[&folder_id],
        )
        .await?;
    Ok(row.map(|row| automation_from_row(&row)))
}

async fn load_automation_defaults(
    client: &tokio_postgres::Client,
) -> anyhow::Result<Vec<DefaultAutomationSettings>> {
    let rows = client
        .query(
            "SELECT scope, enabled, tenant_id, pipeline_id, updated_at FROM sharepoint_automation_defaults",
            &[],
        )
        .await?;
    Ok(rows.into_iter().map(|row| default_from_row(&row)).collect())
}

async fn load_automation_default(
    client: &tokio_postgres::Client,
    scope: &str,
) -> anyhow::Result<Option<DefaultAutomationSettings>> {
    let row = client
        .query_opt(
            "SELECT scope, enabled, tenant_id, pipeline_id, updated_at FROM sharepoint_automation_defaults WHERE scope = $1",
            &[&scope],
        )
        .await?;
    Ok(row.map(|row| default_from_row(&row)))
}

async fn upsert_automation_default(
    client: &tokio_postgres::Client,
    scope: &str,
    payload: &AutomationDefaultUpdateRequest,
) -> anyhow::Result<DefaultAutomationSettings> {
    let row = client
        .query_one(
            "INSERT INTO sharepoint_automation_defaults (scope, enabled, tenant_id, pipeline_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (scope) DO UPDATE SET
                 enabled = EXCLUDED.enabled,
                 tenant_id = EXCLUDED.tenant_id,
                 pipeline_id = EXCLUDED.pipeline_id,
                 updated_at = now()
             RETURNING scope, enabled, tenant_id, pipeline_id, updated_at",
            &[
                &scope,
                &payload.enabled,
                &payload.tenant_id,
                &payload.pipeline_id,
            ],
        )
        .await?;
    Ok(default_from_row(&row))
}

async fn healthz(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    Ok(web::Json(HealthResponse { status: "ok" }))
}

async fn list_folders(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    let base = state.config.drive_input_path();
    let folders = state
        .graph
        .list_subfolders(&base)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let client = state
        .db_pool
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let rows = client
        .query("SELECT folder_id, status FROM sharepoint_jobs", &[])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let mut hidden_folders: HashSet<String> = HashSet::new();
    for row in rows {
        let folder_id: String = row.get("folder_id");
        let status_text: String = row.get("status");
        match JobStatus::from_str(&status_text) {
            Ok(JobStatus::Failed) | Ok(JobStatus::Canceled) => {}
            Ok(_) => {
                hidden_folders.insert(folder_id);
            }
            Err(_) => {
                hidden_folders.insert(folder_id);
            }
        }
    }
    let automation_rules = load_automation_rules(&client)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let mut automation_map: HashMap<String, AutomationRecord> = automation_rules
        .into_iter()
        .map(|record| (record.folder_id.clone(), record))
        .collect();
    let items = folders
        .into_iter()
        .filter(|folder| !hidden_folders.contains(&folder.id))
        .map(|folder| {
            let folder_id = folder.id.clone();
            let automation_entry = automation_map.remove(&folder_id);
            let automation_source = automation_entry.as_ref().map(|record| {
                if record.managed_by_default {
                    "default".to_string()
                } else {
                    "folder".to_string()
                }
            });
            let automation = automation_entry.map(|record| record.to_folder_automation());
            FolderItem {
                id: folder_id,
                name: folder.name,
                file_count: folder.file_count,
                automation,
                automation_source,
            }
        })
        .collect::<Vec<_>>();
    Ok(web::Json(FoldersResponse {
        base,
        total: items.len(),
        items,
    }))
}

async fn list_automation_rules(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    let client = state
        .db_pool
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let records = load_automation_rules(&client)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let items = records
        .into_iter()
        .map(AutomationRecord::into_response)
        .collect();
    Ok(web::Json(AutomationListResponse { items }))
}

async fn list_automation_settings(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    let client = state
        .db_pool
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let defaults = load_automation_defaults(&client)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let items = defaults
        .into_iter()
        .map(DefaultAutomationSettings::into_response)
        .collect();
    Ok(web::Json(AutomationDefaultsResponse { items }))
}

async fn upsert_automation_rule(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
    payload: web::Json<AutomationUpsertRequest>,
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    let folder_id = path.into_inner();
    if folder_id.trim().is_empty() {
        return Err(ErrorBadRequest("folder id required"));
    }

    let client = state
        .db_pool
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    let existing = load_automation_rule(&client, &folder_id)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let fallback_name = existing
        .as_ref()
        .map(|record| record.folder_name.clone())
        .unwrap_or_else(|| folder_id.clone());
    let requested_name = payload
        .folder_name
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let folder_name = requested_name.unwrap_or(fallback_name);
    let auto_ingest = payload.auto_ingest.unwrap_or(false);
    let auto_pipeline = payload.auto_pipeline.unwrap_or(false);

    client
        .execute(
            "INSERT INTO sharepoint_automation (folder_id, folder_name, tenant_id, pipeline_id, auto_ingest, auto_pipeline, managed_by_default)
             VALUES ($1, $2, $3, $4, $5, $6, FALSE)
             ON CONFLICT (folder_id) DO UPDATE SET
                 folder_name = EXCLUDED.folder_name,
                 tenant_id = EXCLUDED.tenant_id,
                 pipeline_id = EXCLUDED.pipeline_id,
                 auto_ingest = EXCLUDED.auto_ingest,
                 auto_pipeline = EXCLUDED.auto_pipeline,
                 managed_by_default = FALSE,
                 updated_at = now()",
            &[&folder_id, &folder_name, &payload.tenant_id, &payload.pipeline_id, &auto_ingest, &auto_pipeline],
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    let updated = load_automation_rule(&client, &folder_id)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let Some(rule) = updated else {
        return Ok(HttpResponse::InternalServerError().finish());
    };

    Ok(HttpResponse::Ok().json(rule.into_response()))
}

async fn upsert_automation_setting(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<String>,
    payload: web::Json<AutomationDefaultUpdateRequest>,
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    let scope = path.into_inner();
    let normalized = scope.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err(ErrorBadRequest("scope required"));
    }
    if normalized != "ingest" && normalized != "processing" {
        return Err(ErrorBadRequest("unknown automation scope"));
    }

    if payload.enabled {
        if normalized == "ingest" && payload.tenant_id.is_none() {
            return Err(ErrorBadRequest(
                "tenant_id required when enabling ingest automation",
            ));
        }
        if normalized == "processing" && payload.pipeline_id.is_none() {
            return Err(ErrorBadRequest(
                "pipeline_id required when enabling processing automation",
            ));
        }
    }

    let client = state
        .db_pool
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    let updated = upsert_automation_default(&client, &normalized, &payload)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(updated.into_response()))
}

async fn create_jobs(
    req: HttpRequest,
    state: web::Data<AppState>,
    payload: web::Json<JobCreateRequest>,
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    if payload.folder_ids.is_empty() {
        return Err(ErrorBadRequest("folder_ids required"));
    }

    let base_folders = state
        .graph
        .list_subfolders(&state.config.drive_input_path())
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let folder_map: HashMap<_, _> = base_folders
        .into_iter()
        .map(|f| (f.id.clone(), f))
        .collect();

    let db_client = state
        .db_pool
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let defaults = load_automation_defaults(&db_client)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let mut default_map: HashMap<String, DefaultAutomationSettings> = HashMap::new();
    for default in defaults {
        default_map.insert(default.scope.clone(), default);
    }
    let ingest_default = default_map.get("ingest");
    let fallback_tenant = ingest_default
        .filter(|default| default.enabled)
        .and_then(|default| default.tenant_id);
    let fallback_pipeline = ingest_default
        .filter(|default| default.enabled)
        .and_then(|default| default.pipeline_id);
    drop(db_client);

    let upload_override = payload.upload_url.as_ref().and_then(|url| {
        let trimmed = url.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let tenant_override = payload.tenant_id.or(fallback_tenant);
    let pipeline_override = payload.pipeline_id.or(fallback_pipeline);
    let app_state = state.get_ref().clone();
    let mut created = Vec::new();
    for folder_id in &payload.folder_ids {
        let folder = folder_map.get(folder_id).cloned().unwrap_or(GraphFolder {
            id: folder_id.clone(),
            name: folder_id.clone(),
            file_count: 0,
        });
        let filenames_override = payload
            .filenames
            .as_ref()
            .and_then(|map| map.get(folder_id).cloned());
        let job_order = payload.order.clone().unwrap_or_default();
        let job = state.jobs.create_job(
            folder.id.clone(),
            folder.name.clone(),
            job_order.clone(),
            filenames_override.clone(),
            upload_override.clone(),
            tenant_override,
            pipeline_override,
            false,
        );
        let summary = job_summary(&job);
        spawn_job_worker(app_state.clone(), job);
        created.push(summary);
    }

    Ok(web::Json(JobsResponse { jobs: created }))
}

async fn list_jobs(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    let jobs = state.jobs.list();
    Ok(web::Json(JobsResponse { jobs }))
}

async fn list_processed_folders(
    req: HttpRequest,
    state: web::Data<AppState>,
    query: web::Query<ProcessedFoldersQuery>,
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    let client = state
        .db_pool
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let stage = query
        .stage
        .as_deref()
        .unwrap_or("pending")
        .to_ascii_lowercase();
    let include_pipeline = matches!(stage.as_str(), "completed" | "finished");
    let rows = if include_pipeline {
        client
            .query(
                "SELECT sp.id, sp.folder_id, sp.folder_name, sp.status, sp.progress, sp.message, sp.tenant_id,
                        sp.pipeline_id, sp.pipeline_run_id, sp.upload_id, sp.pdf_id, sp.created_at, sp.updated_at,
                        u.status AS upload_status, pr.status AS pipeline_status, pr.error AS pipeline_error,
                        pr.started_at AS pipeline_started_at, pr.finished_at AS pipeline_finished_at
                 FROM sharepoint_jobs sp
                 JOIN uploads u ON u.id = sp.upload_id
                 LEFT JOIN pipeline_runs pr ON pr.id = sp.pipeline_run_id
                 WHERE sp.status = 'succeeded' AND sp.upload_id IS NOT NULL AND sp.pipeline_run_id IS NOT NULL
                       AND lower(u.status) = 'ready'
                 ORDER BY sp.updated_at DESC",
                &[],
            )
            .await
            .map_err(actix_web::error::ErrorInternalServerError)?
    } else {
        client
            .query(
                "SELECT sp.id, sp.folder_id, sp.folder_name, sp.status, sp.progress, sp.message, sp.tenant_id,
                        sp.pipeline_id, sp.pipeline_run_id, sp.upload_id, sp.pdf_id, sp.created_at, sp.updated_at,
                        u.status AS upload_status
                 FROM sharepoint_jobs sp
                 JOIN uploads u ON u.id = sp.upload_id
                 WHERE sp.status = 'succeeded' AND sp.upload_id IS NOT NULL AND lower(u.status) = 'ready'
                       AND sp.pipeline_run_id IS NULL
                 ORDER BY sp.updated_at DESC",
                &[],
            )
            .await
            .map_err(actix_web::error::ErrorInternalServerError)?
    };

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let status_text: String = row.get("status");
        let status = JobStatus::from_str(&status_text).unwrap_or(JobStatus::Succeeded);
        let progress: f64 = row.get("progress");
        let (
            pipeline_status,
            pipeline_status_category,
            pipeline_progress,
            pipeline_error,
            pipeline_started_at,
            pipeline_finished_at,
        ) = if include_pipeline {
            let status: Option<String> = row.get("pipeline_status");
            let category = status.as_deref().map(|value| map_pipeline_status(value));
            let progress = status.as_deref().map(|value| map_pipeline_progress(value));
            let error = row.get::<_, Option<String>>("pipeline_error");
            let started_at = row.get::<_, Option<DateTime<Utc>>>("pipeline_started_at");
            let finished_at = row.get::<_, Option<DateTime<Utc>>>("pipeline_finished_at");
            (status, category, progress, error, started_at, finished_at)
        } else {
            (None, None, None, None, None, None)
        };
        items.push(ProcessedFolderItem {
            job_id: row.get("id"),
            folder_id: row.get("folder_id"),
            folder_name: row.get("folder_name"),
            status,
            progress: progress as f32,
            message: row.get("message"),
            tenant_id: row.get("tenant_id"),
            pipeline_id: row.get("pipeline_id"),
            pipeline_run_id: row.get("pipeline_run_id"),
            upload_id: row.get("upload_id"),
            pdf_id: row.get("pdf_id"),
            upload_status: Some(row.get("upload_status")),
            pipeline_status,
            pipeline_status_category,
            pipeline_progress,
            pipeline_error,
            pipeline_started_at,
            pipeline_finished_at,
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        });
    }

    Ok(web::Json(ProcessedFoldersResponse { items }))
}

async fn pause_job(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<Uuid>,
) -> actix_web::Result<HttpResponse> {
    ensure_authorized(&req, &state.config)?;
    let job_id = path.into_inner();
    if state.jobs.pause(&job_id) {
        state.jobs.update(&job_id, |s| {
            s.set_status(JobStatus::Paused);
            s.set_message("paused by operator");
        });
        Ok(HttpResponse::Ok().finish())
    } else {
        Ok(HttpResponse::NotFound().finish())
    }
}

async fn run_processed_folders(
    req: HttpRequest,
    state: web::Data<AppState>,
    payload: web::Json<ProcessedFoldersRunRequest>,
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    if payload.job_ids.is_empty() {
        return Err(ErrorBadRequest("job_ids required"));
    }

    let client = state
        .db_pool
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let pipeline_name = client
        .query_opt(
            "SELECT name FROM pipelines WHERE id = $1",
            &[&payload.pipeline_id],
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?
        .and_then(|row| row.get::<_, Option<String>>(0));

    let mut started = Vec::new();
    let mut skipped = Vec::new();

    for job_id in &payload.job_ids {
        let row = client
            .query_opt(
                "SELECT sp.status, sp.upload_id, sp.pdf_id, sp.folder_name, u.status AS upload_status
                 FROM sharepoint_jobs sp
                 LEFT JOIN uploads u ON u.id = sp.upload_id
                 WHERE sp.id = $1",
                &[job_id],
            )
            .await
            .map_err(actix_web::error::ErrorInternalServerError)?;

        let Some(row) = row else {
            skipped.push(ProcessedRunSkipped {
                job_id: *job_id,
                reason: "job not found".to_string(),
            });
            continue;
        };

        let status_text: String = row.get("status");
        let status = JobStatus::from_str(&status_text).unwrap_or(JobStatus::Failed);
        if status != JobStatus::Succeeded {
            skipped.push(ProcessedRunSkipped {
                job_id: *job_id,
                reason: format!("job status is {status_text}"),
            });
            continue;
        }

        let upload_id: Option<i32> = row.get("upload_id");
        if upload_id.is_none() {
            skipped.push(ProcessedRunSkipped {
                job_id: *job_id,
                reason: "upload id missing".to_string(),
            });
            continue;
        }
        let upload_id = upload_id.unwrap();
        let upload_status: Option<String> = row.get("upload_status");
        let is_ready = upload_status
            .as_deref()
            .map(|status| status.eq_ignore_ascii_case("ready"))
            .unwrap_or(false);
        if !is_ready {
            let status = upload_status.as_deref().unwrap_or("unknown");
            skipped.push(ProcessedRunSkipped {
                job_id: *job_id,
                reason: format!("upload status is {status}"),
            });
            continue;
        }
        let pdf_id: Option<i32> = row.get("pdf_id");
        let folder_name: String = row.get("folder_name");

        match state
            .pipeline
            .start_run(payload.pipeline_id, upload_id)
            .await
        {
            Ok(_resp) => {
                let message = match pipeline_name.as_deref() {
                    Some(name) => format!("Pipeline \"{name}\" gestartet"),
                    None => format!("Pipeline {} gestartet", payload.pipeline_id),
                };
                state.jobs.update(job_id, |s| {
                    s.pipeline_id = Some(payload.pipeline_id);
                    s.set_message(message);
                });
                started.push(ProcessedRunStarted {
                    job_id: *job_id,
                    upload_id,
                    pdf_id,
                    pipeline_id: payload.pipeline_id,
                });
                info!(%job_id, %upload_id, folder = %folder_name, "pipeline run triggered");
            }
            Err(err) => {
                warn!(%job_id, error = %err, "failed to start pipeline run");
                skipped.push(ProcessedRunSkipped {
                    job_id: *job_id,
                    reason: format!("pipeline start failed: {err}"),
                });
            }
        }
    }

    Ok(web::Json(ProcessedRunResponse { started, skipped }))
}

async fn resume_job(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<Uuid>,
) -> actix_web::Result<HttpResponse> {
    ensure_authorized(&req, &state.config)?;
    let job_id = path.into_inner();
    if state.jobs.resume(&job_id) {
        state.jobs.update(&job_id, |s| {
            s.set_status(JobStatus::Running);
            s.set_message("resumed by operator");
        });
        Ok(HttpResponse::Ok().finish())
    } else {
        Ok(HttpResponse::NotFound().finish())
    }
}

async fn cancel_job(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<Uuid>,
) -> actix_web::Result<HttpResponse> {
    ensure_authorized(&req, &state.config)?;
    let job_id = path.into_inner();
    if state.jobs.cancel(&job_id) {
        state.jobs.update(&job_id, |s| {
            s.set_status(JobStatus::Canceled);
            s.set_message("canceled by operator");
        });
        Ok(HttpResponse::Ok().finish())
    } else {
        Ok(HttpResponse::NotFound().finish())
    }
}

async fn retry_job(
    req: HttpRequest,
    state: web::Data<AppState>,
    path: web::Path<Uuid>,
) -> actix_web::Result<HttpResponse> {
    ensure_authorized(&req, &state.config)?;
    let job_id = path.into_inner();
    let original = match state.jobs.get(&job_id) {
        Some(job) => job,
        None => return Ok(HttpResponse::NotFound().finish()),
    };
    let snapshot = original.state.lock().clone();
    drop(original);
    let job = state.jobs.create_job(
        snapshot.folder_id,
        snapshot.folder_name,
        snapshot.order,
        snapshot.filenames_override,
        snapshot.upload_url,
        snapshot.tenant_id,
        snapshot.pipeline_id,
        snapshot.auto_managed,
    );
    let summary = job_summary(&job);
    let app_state = state.get_ref().clone();
    spawn_job_worker(app_state, job);
    Ok(HttpResponse::Ok().json(json!({ "job": summary })))
}

async fn list_all_jobs(
    req: HttpRequest,
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    let client = state
        .db_pool
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    let sharepoint_rows = client
        .query(
            "SELECT id, folder_name, status, progress, message, pipeline_id, pipeline_run_id,
                    upload_id, pdf_id, created_at, updated_at
             FROM sharepoint_jobs
             ORDER BY created_at DESC
             LIMIT 200",
            &[],
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    let mut jobs = Vec::with_capacity(sharepoint_rows.len());
    for row in sharepoint_rows {
        let status_text: String = row.get("status");
        let status = JobStatus::from_str(&status_text).unwrap_or(JobStatus::Failed);
        let progress: f64 = row.get("progress");
        jobs.push(AggregatedJobEntry {
            id: row.get::<_, Uuid>("id").to_string(),
            source: AggregatedJobSource::Sharepoint,
            status: status.as_str().to_string(),
            status_category: status,
            progress: progress as f32,
            message: row.get("message"),
            folder_name: Some(row.get("folder_name")),
            pipeline_name: None,
            sharepoint_job_id: Some(row.get("id")),
            pipeline_id: row.get("pipeline_id"),
            pdf_id: row.get("pdf_id"),
            upload_id: row.get("upload_id"),
            created_at: row.get("created_at"),
            updated_at: Some(row.get("updated_at")),
        });
    }

    let pipeline_rows = client
        .query(
            "SELECT pr.id, pr.status, pr.error, pr.created_at, pr.started_at, pr.finished_at,
                    pr.pipeline_id, sp.id AS sharepoint_job_id, sp.folder_name, sp.upload_id,
                    sp.pdf_id, p.name
             FROM pipeline_runs pr
             JOIN sharepoint_jobs sp ON sp.pdf_id = pr.pdf_id
             LEFT JOIN pipelines p ON p.id = pr.pipeline_id
             ORDER BY pr.created_at DESC
             LIMIT 200",
            &[],
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    for row in pipeline_rows {
        let status_text: String = row.get("status");
        let status_category = map_pipeline_status(&status_text);
        let progress = map_pipeline_progress(&status_text);
        let created_at: DateTime<Utc> = row.get("created_at");
        let started_at: Option<DateTime<Utc>> = row.get("started_at");
        let finished_at: Option<DateTime<Utc>> = row.get("finished_at");
        let updated_at = finished_at.or(started_at).or(Some(created_at));
        jobs.push(AggregatedJobEntry {
            id: row.get::<_, Uuid>("id").to_string(),
            source: AggregatedJobSource::Pipeline,
            status: status_text,
            status_category,
            progress,
            message: row.get::<_, Option<String>>("error"),
            folder_name: Some(row.get("folder_name")),
            pipeline_name: row.get::<_, Option<String>>("name"),
            sharepoint_job_id: Some(row.get("sharepoint_job_id")),
            pipeline_id: row.get("pipeline_id"),
            pdf_id: row.get("pdf_id"),
            upload_id: row.get("upload_id"),
            created_at,
            updated_at,
        });
    }

    jobs.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(web::Json(AggregatedJobsResponse { jobs }))
}

fn spawn_job_worker(state: AppState, job: ManagedJob) {
    let job_id = job.state.lock().id;
    let jobs = state.jobs.clone();
    let graph = state.graph.clone();
    let uploader = state.uploader.clone();
    let config = state.config.clone();
    let semaphore = state.semaphore.clone();
    let mut control_rx = job.control_tx.subscribe();
    let pipeline = state.pipeline.clone();
    let db_pool = state.db_pool.clone();

    let handle = tokio::spawn(async move {
        jobs.update(&job_id, |s| {
            s.set_status(JobStatus::Running);
            s.set_message("job started");
        });

        if let Err(err) = wait_until_running(&jobs, job_id, &mut control_rx).await {
            handle_control_error(err, &jobs, job_id).await;
            return;
        }

        let permit = match semaphore.acquire_owned().await {
            Ok(permit) => permit,
            Err(err) => {
                jobs.update(&job_id, |s| {
                    s.set_status(JobStatus::Failed);
                    s.set_message(format!("failed to schedule job: {err}"));
                });
                return;
            }
        };

        let run_result = run_job_inner(
            config.clone(),
            graph.clone(),
            uploader.clone(),
            pipeline.clone(),
            db_pool.clone(),
            jobs.clone(),
            job_id,
            job,
            control_rx,
        )
        .await;

        drop(permit);

        match run_result {
            Ok(()) => {
                jobs.update(&job_id, |s| {
                    s.set_progress(1.0);
                    s.set_status(JobStatus::Succeeded);
                    s.set_message("job completed");
                });
            }
            Err(JobRunError::Canceled) => {
                jobs.update(&job_id, |s| {
                    s.set_status(JobStatus::Canceled);
                    s.set_message("job canceled");
                });
            }
            Err(JobRunError::Failure(err)) => {
                error!(%job_id, error = ?err, "job failed");
                jobs.update(&job_id, |s| {
                    s.set_status(JobStatus::Failed);
                    s.set_message(format!("job failed: {err}"));
                });
            }
        }
    });

    state.jobs.insert_handle(job_id, handle);
}

fn spawn_folder_poller(state: AppState) {
    let interval = state.config.automation_poll_interval;
    if interval.is_zero() {
        warn!("automation poll interval is zero; poller disabled");
        return;
    }
    let poll_state = state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(err) = poll_automation_once(&poll_state).await {
                warn!(error = %err, "automation poller iteration failed");
            }
            sleep(interval).await;
        }
    });
}

fn spawn_pipeline_result_consumer(state: AppState) {
    let Some(broker) = state
        .config
        .message_broker_url
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        warn!("MESSAGE_BROKER_URL missing; pipeline consumer disabled");
        return;
    };
    let topic = state.config.pipeline_result_topic.clone();
    let group = state.config.pipeline_result_group.clone();
    let consumer_state = state.clone();
    tokio::spawn(async move {
        if let Err(err) = run_pipeline_consumer(consumer_state, broker, topic, group).await {
            error!(error = %err, "pipeline result consumer stopped");
        }
    });
}

async fn poll_automation_once(state: &AppState) -> anyhow::Result<()> {
    let folders = state
        .graph
        .list_subfolders(&state.config.drive_input_path())
        .await?;
    if folders.is_empty() {
        return Ok(());
    }

    let mut folder_map: HashMap<String, GraphFolder> = HashMap::new();
    for folder in folders {
        folder_map.insert(folder.id.clone(), folder);
    }

    let client = state.db_pool.get().await?;
    let defaults = load_automation_defaults(&client).await?;
    let mut defaults_map: HashMap<String, DefaultAutomationSettings> = HashMap::new();
    for default in defaults {
        defaults_map.insert(default.scope.clone(), default);
    }
    let ingest_default = defaults_map.get("ingest").cloned();
    let processing_default = defaults_map.get("processing").cloned();

    let rules = load_automation_rules(&client).await?;
    let mut rule_map: HashMap<String, AutomationRecord> = rules
        .into_iter()
        .map(|record| (record.folder_id.clone(), record))
        .collect();

    let now = Utc::now();

    if let Some(default) = ingest_default.clone() {
        if default.enabled {
            let auto_pipeline = default.pipeline_id.is_some();
            for folder in folder_map.values() {
                if let Some(existing) = rule_map.get(&folder.id) {
                    if existing.managed_by_default {
                        let needs_update = existing.tenant_id != default.tenant_id
                            || existing.pipeline_id != default.pipeline_id
                            || !existing.auto_ingest
                            || existing.auto_pipeline != auto_pipeline;
                        if needs_update {
                            client
                                .execute(
                                    "UPDATE sharepoint_automation
                                     SET tenant_id = $2,
                                         pipeline_id = $3,
                                         auto_ingest = TRUE,
                                         auto_pipeline = $4,
                                         managed_by_default = TRUE,
                                         updated_at = now()
                                     WHERE folder_id = $1",
                                    &[
                                        &folder.id,
                                        &default.tenant_id,
                                        &default.pipeline_id,
                                        &auto_pipeline,
                                    ],
                                )
                                .await?;
                            if let Some(updated) = rule_map.get_mut(&folder.id) {
                                updated.tenant_id = default.tenant_id;
                                updated.pipeline_id = default.pipeline_id;
                                updated.auto_ingest = true;
                                updated.auto_pipeline = auto_pipeline;
                                updated.managed_by_default = true;
                                updated.updated_at = now;
                            }
                        }
                    }
                    continue;
                }

                let inserted = client
                    .query_opt(
                        "INSERT INTO sharepoint_automation (
                             folder_id, folder_name, tenant_id, pipeline_id, auto_ingest, auto_pipeline, managed_by_default, last_seen
                         ) VALUES ($1, $2, $3, $4, TRUE, $5, TRUE, $6)
                         ON CONFLICT (folder_id) DO NOTHING
                         RETURNING folder_id, folder_name, tenant_id, pipeline_id, auto_ingest, auto_pipeline, managed_by_default, last_seen, updated_at",
                        &[&folder.id, &folder.name, &default.tenant_id, &default.pipeline_id, &auto_pipeline, &now],
                    )
                    .await?;
                if let Some(row) = inserted {
                    let record = automation_from_row(&row);
                    rule_map.insert(folder.id.clone(), record);
                }
            }
        } else {
            client
                .execute(
                    "DELETE FROM sharepoint_automation WHERE managed_by_default = TRUE",
                    &[],
                )
                .await?;
            rule_map.retain(|_, record| !record.managed_by_default);
        }
    }

    for folder in folder_map.values() {
        let _ = client
            .execute(
                "UPDATE sharepoint_automation SET folder_name = $2, last_seen = $3, updated_at = now()
                 WHERE folder_id = $1",
                &[&folder.id, &folder.name, &now],
            )
            .await?;
        if let Some(record) = rule_map.get_mut(&folder.id) {
            record.folder_name = folder.name.clone();
            record.last_seen = Some(now);
            record.updated_at = now;
        }
    }

    let rules: Vec<AutomationRecord> = rule_map.into_values().collect();

    for rule in &rules {
        if !rule.auto_ingest {
            continue;
        }
        let Some(folder) = folder_map.get(&rule.folder_id) else {
            continue;
        };

        let existing = client
            .query_opt(
                "SELECT id FROM sharepoint_jobs WHERE folder_id = $1",
                &[&rule.folder_id],
            )
            .await?;
        if existing.is_some() {
            continue;
        }

        let pipeline_id = if rule.auto_pipeline {
            rule.pipeline_id
        } else {
            None
        };

        let job = state.jobs.create_job(
            folder.id.clone(),
            folder.name.clone(),
            JobOrder::Alpha,
            None,
            None,
            rule.tenant_id,
            pipeline_id,
            true,
        );
        let job_id = job.state.lock().id;
        let source = if rule.managed_by_default {
            "global"
        } else {
            "folder"
        };
        state.jobs.update(&job_id, |s| {
            if rule.managed_by_default {
                s.set_message("Automatischer Import (global) gestartet");
            } else {
                s.set_message("Automatischer Import gestartet");
            }
        });
        info!(
            %job_id,
            folder = %folder.name,
            auto_pipeline = rule.auto_pipeline,
            source = source,
            "automation job created"
        );
        spawn_job_worker(state.clone(), job);
    }

    if let Some(default) = processing_default {
        if default.enabled {
            if let Some(pipeline_id) = default.pipeline_id {
                let rows = client
                    .query(
                        "SELECT sp.id, sp.upload_id, sp.pdf_id, sp.folder_name
                         FROM sharepoint_jobs sp
                         JOIN uploads u ON u.id = sp.upload_id
                         WHERE sp.status = 'succeeded'
                           AND sp.upload_id IS NOT NULL
                           AND sp.pipeline_id IS NULL
                           AND sp.pipeline_run_id IS NULL
                           AND lower(u.status) = 'ready'",
                        &[],
                    )
                    .await?;
                for row in rows {
                    let job_id: Uuid = row.get("id");
                    let upload_id: i32 = row.get("upload_id");
                    let pdf_id: Option<i32> = row.get("pdf_id");
                    let folder_name: String = row.get("folder_name");
                    match state.pipeline.start_run(pipeline_id, upload_id).await {
                        Ok(_resp) => {
                            info!(
                                %job_id,
                                %upload_id,
                                %pipeline_id,
                                folder = %folder_name,
                                "default pipeline run started"
                            );
                            client
                                .execute(
                                    "UPDATE sharepoint_jobs SET pipeline_id = $2, updated_at = now() WHERE id = $1",
                                    &[&job_id, &pipeline_id],
                                )
                                .await?;
                            state.jobs.update(&job_id, |s| {
                                s.pipeline_id = Some(pipeline_id);
                                s.set_message("Pipeline automatisch gestartet (global)");
                            });
                        }
                        Err(err) => {
                            warn!(%job_id, error = %err, "failed to start default pipeline run");
                            state.jobs.update(&job_id, |s| {
                                s.set_message(format!(
                                    "Pipeline-Start (global) fehlgeschlagen: {err}"
                                ));
                            });
                            if let Some(pdf_id) = pdf_id {
                                warn!(%job_id, %pdf_id, "pipeline start failed for pdf");
                            }
                        }
                    }
                }
            } else {
                warn!("processing automation enabled without pipeline_id");
            }
        }
    }

    Ok(())
}

async fn run_pipeline_consumer(
    state: AppState,
    broker: String,
    topic: String,
    group: String,
) -> anyhow::Result<()> {
    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", &group)
        .set("bootstrap.servers", &broker)
        .set("enable.auto.commit", "true")
        .set("auto.offset.reset", "earliest")
        .create()?;
    consumer.subscribe(&[&topic])?;
    info!(%topic, %group, "pipeline result consumer started");

    loop {
        match consumer.recv().await {
            Err(err) => warn!(error = %err, "kafka receive error"),
            Ok(message) => {
                if let Some(Ok(payload)) = message.payload_view::<str>() {
                    match serde_json::from_str::<PipelineRunResult>(payload) {
                        Ok(event) => {
                            if let Err(err) = handle_pipeline_result(&state, event).await {
                                warn!(error = %err, "failed to apply pipeline result");
                            }
                        }
                        Err(err) => {
                            warn!(error = %err, "failed to parse pipeline result payload");
                        }
                    }
                }
            }
        }
    }
}

async fn handle_pipeline_result(state: &AppState, result: PipelineRunResult) -> anyhow::Result<()> {
    let client = state.db_pool.get().await?;
    let row = client
        .query_opt(
            "SELECT id FROM sharepoint_jobs WHERE pdf_id = $1 ORDER BY created_at DESC LIMIT 1",
            &[&result.pdf_id],
        )
        .await?;

    let Some(row) = row else {
        warn!(
            pdf_id = result.pdf_id,
            "no sharepoint job found for pipeline result"
        );
        return Ok(());
    };

    let job_id: Uuid = row.get("id");
    client
        .execute(
            "UPDATE sharepoint_jobs
             SET pipeline_id = COALESCE(pipeline_id, $1),
                 pipeline_run_id = COALESCE($2, pipeline_run_id),
                 updated_at = now()
             WHERE id = $3",
            &[&result.pipeline_id, &result.run_id, &job_id],
        )
        .await?;

    let status_text = result
        .status
        .clone()
        .unwrap_or_else(|| "finished".to_string());
    let run_id = result.run_id;
    state.jobs.update(&job_id, |state| {
        if state.pipeline_id.is_none() {
            state.pipeline_id = Some(result.pipeline_id);
        }
        if let Some(run_id) = run_id {
            state.pipeline_run_id = Some(run_id);
        }
        let category = map_pipeline_status(&status_text);
        let mut message = match category {
            JobStatus::Succeeded => "Pipeline abgeschlossen".to_string(),
            JobStatus::Failed => format!("Pipeline fehlgeschlagen ({status_text})"),
            JobStatus::Running => "Pipeline gestartet".to_string(),
            JobStatus::Queued => "Pipeline eingereiht".to_string(),
            JobStatus::Canceled => "Pipeline abgebrochen".to_string(),
            JobStatus::Paused => "Pipeline pausiert".to_string(),
        };
        if let Some(run_id) = run_id {
            message.push_str(&format!(" – Run {run_id}"));
        }
        state.set_message(message);
    });

    Ok(())
}

async fn run_job_inner(
    config: Arc<Config>,
    graph: Arc<MsGraphClient>,
    uploader: Arc<UploadAdapter>,
    pipeline: Arc<PipelineAdapter>,
    db_pool: Pool,
    jobs: JobRegistry,
    job_id: Uuid,
    job: ManagedJob,
    mut control_rx: watch::Receiver<job::JobCommand>,
) -> Result<(), JobRunError> {
    let snapshot = job.state.lock().clone();
    drop(job);

    let files = graph
        .list_pdfs_in_folder(&snapshot.folder_id)
        .await
        .map_err(JobRunError::Failure)?;
    if files.is_empty() {
        return Err(JobRunError::Failure(anyhow!("no pdf files found")));
    }

    let ordered = order_files(
        files,
        snapshot.order.clone(),
        snapshot.filenames_override.clone(),
    );
    let temp_dir = tempfile::tempdir().map_err(|err| JobRunError::Failure(err.into()))?;
    let total = ordered.len();
    let download_weight = 0.5f32;
    let merge_weight = 0.3f32;
    let upload_weight = 0.2f32;

    let mut downloaded = Vec::new();
    for (idx, file) in ordered.iter().enumerate() {
        wait_until_running(&jobs, job_id, &mut control_rx).await?;
        let filename = format!("{idx:03}-{}", sanitize_filename(&file.name));
        let dest = temp_dir.path().join(&filename);
        graph
            .download_file(&file.id, &dest)
            .await
            .map_err(JobRunError::Failure)?;
        downloaded.push(dest);
        let progress = download_weight * ((idx + 1) as f32 / total as f32);
        jobs.update(&job_id, |s| {
            s.set_progress(progress);
            s.set_message(format!("downloaded {}/{}", idx + 1, total));
        });
    }

    wait_until_running(&jobs, job_id, &mut control_rx).await?;
    let merged_path = temp_dir.path().join("merged.pdf");
    merge_pdfs(&downloaded, &merged_path).map_err(JobRunError::Failure)?;
    jobs.update(&job_id, |s| {
        s.set_progress(download_weight + merge_weight);
        s.set_message("pdf merged");
    });

    wait_until_running(&jobs, job_id, &mut control_rx).await?;
    // Validate merged PDF before uploading
    assert_pdf(&merged_path).map_err(JobRunError::Failure)?;
    let scan_cfg = ScanConfig::from_env();
    scan_with_clamd(&merged_path, &scan_cfg)
        .await
        .map_err(JobRunError::Failure)?;
    jobs.update(&job_id, |s| {
        s.set_message("security scan passed");
    });
    let upload_name = format!("{}-merged.pdf", sanitize_filename(&snapshot.folder_name));
    let upload_override = snapshot.upload_url.clone();
    let tenant_override = snapshot.tenant_id;
    let upload_result = uploader
        .upload(
            &merged_path,
            &upload_name,
            upload_override.as_deref(),
            tenant_override,
            snapshot.pipeline_id,
        )
        .await
        .map_err(JobRunError::Failure)?;
    jobs.update(&job_id, |s| {
        s.set_progress(download_weight + merge_weight + upload_weight * 0.5);
        s.set_message("upload completed");
        s.set_output(upload_result.clone());
    });

    let pipeline_id = jobs
        .get(&job_id)
        .map(|managed| managed.state.lock().pipeline_id)
        .unwrap_or(snapshot.pipeline_id);

    let upload_ready = upload_result.upload_id;

    if let Some(pipeline_id) = pipeline_id {
        if let Some(upload_id) = upload_ready {
            jobs.update(&job_id, |s| {
                s.pipeline_id = Some(pipeline_id);
                s.set_message("prüfe Upload-Status für Pipeline");
            });
            let ready = wait_for_upload_ready(
                &db_pool,
                upload_id,
                config.upload_ready_poll_attempts,
                config.upload_ready_poll_interval,
            )
            .await
            .map_err(JobRunError::Failure)?;

            if ready {
                match pipeline.start_run(pipeline_id, upload_id).await {
                    Ok(_) => {
                        info!(%job_id, %upload_id, %pipeline_id, "pipeline run started automatically");
                        jobs.update(&job_id, |s| {
                            s.pipeline_id = Some(pipeline_id);
                            s.set_message("Pipeline automatisch gestartet");
                        });
                    }
                    Err(err) => {
                        warn!(%job_id, %upload_id, error = %err, "automatic pipeline start failed");
                        jobs.update(&job_id, |s| {
                            s.set_message(format!("Pipeline-Start fehlgeschlagen: {err}"));
                        });
                    }
                }
            } else {
                warn!(%job_id, %upload_id, "upload not ready for pipeline start");
                jobs.update(&job_id, |s| {
                    s.set_message("Upload noch nicht bereit für Pipeline");
                });
            }
        } else {
            warn!(%job_id, "upload id missing; cannot start pipeline automatically");
            jobs.update(&job_id, |s| {
                s.set_message("Upload-ID fehlt für Pipeline-Start");
            });
        }
    } else {
        jobs.update(&job_id, |s| {
            s.set_message("bereit für Pipeline-Verarbeitung");
        });
    }

    jobs.update(&job_id, |s| {
        s.set_progress(download_weight + merge_weight + upload_weight);
    });

    Ok(())
}

#[derive(Debug)]
enum JobRunError {
    Canceled,
    Failure(anyhow::Error),
}

impl From<anyhow::Error> for JobRunError {
    fn from(value: anyhow::Error) -> Self {
        JobRunError::Failure(value)
    }
}

async fn wait_until_running(
    jobs: &JobRegistry,
    job_id: Uuid,
    rx: &mut watch::Receiver<job::JobCommand>,
) -> Result<(), JobRunError> {
    loop {
        let current = *rx.borrow();
        match current {
            job::JobCommand::Run => {
                jobs.update(&job_id, |s| {
                    if s.status == JobStatus::Paused {
                        s.set_status(JobStatus::Running);
                        s.set_message("resumed");
                    }
                });
                return Ok(());
            }
            job::JobCommand::Pause => {
                jobs.update(&job_id, |s| {
                    if s.status != JobStatus::Paused {
                        s.set_status(JobStatus::Paused);
                        s.set_message("paused");
                    }
                });
                if rx.changed().await.is_err() {
                    return Err(JobRunError::Canceled);
                }
            }
            job::JobCommand::Cancel => return Err(JobRunError::Canceled),
        }
    }
}

async fn handle_control_error(err: JobRunError, jobs: &JobRegistry, job_id: Uuid) {
    match err {
        JobRunError::Canceled => {
            jobs.update(&job_id, |s| {
                s.set_status(JobStatus::Canceled);
                s.set_message("job canceled");
            });
        }
        JobRunError::Failure(error) => {
            error!(%job_id, error = ?error, "job failed before start");
            jobs.update(&job_id, |s| {
                s.set_status(JobStatus::Failed);
                s.set_message(format!("job failed: {error}"));
            });
        }
    }
}

async fn wait_for_upload_ready(
    pool: &Pool,
    upload_id: i32,
    max_attempts: u32,
    interval: std::time::Duration,
) -> anyhow::Result<bool> {
    for attempt in 0..max_attempts {
        let client = pool.get().await?;
        let row = client
            .query_opt("SELECT status FROM uploads WHERE id = $1", &[&upload_id])
            .await?;
        if let Some(row) = row {
            let status: String = row.get("status");
            if status.eq_ignore_ascii_case("ready") {
                return Ok(true);
            }
        } else {
            return Ok(false);
        }
        if attempt + 1 < max_attempts {
            sleep(interval).await;
        }
    }
    Ok(false)
}

fn order_files(
    mut files: Vec<GraphFile>,
    order: JobOrder,
    filenames_override: Option<Vec<String>>,
) -> Vec<GraphFile> {
    if let Some(custom) = filenames_override {
        let mut map: HashMap<String, GraphFile> = files
            .into_iter()
            .map(|file| (file.name.clone(), file))
            .collect();
        let mut ordered = Vec::new();
        for name in custom {
            if let Some(file) = map.remove(&name) {
                ordered.push(file);
            }
        }
        let mut remaining: Vec<_> = map.into_values().collect();
        remaining.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        ordered.extend(remaining);
        return ordered;
    }

    match order {
        JobOrder::Alpha | JobOrder::NameAsc => {
            files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        }
        JobOrder::NameDesc => {
            files.sort_by(|a, b| b.name.to_lowercase().cmp(&a.name.to_lowercase()));
        }
    }
    files
}

fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => c,
            _ => '_',
        })
        .collect();
    sanitized.trim_matches('_').to_string()
}

fn map_pipeline_status(status: &str) -> JobStatus {
    match status.to_ascii_lowercase().as_str() {
        "queued" => JobStatus::Queued,
        "running" => JobStatus::Running,
        "completed" | "finished" | "finalized" => JobStatus::Succeeded,
        "failed" | "timeout" | "error" => JobStatus::Failed,
        "canceled" => JobStatus::Canceled,
        other => {
            warn!(
                status = other,
                "unknown pipeline status, defaulting to failed"
            );
            JobStatus::Failed
        }
    }
}

fn map_pipeline_progress(status: &str) -> f32 {
    match status.to_ascii_lowercase().as_str() {
        "queued" => 0.0,
        "running" => 0.5,
        "completed" | "finished" | "finalized" => 1.0,
        "failed" | "timeout" | "error" | "canceled" => 1.0,
        _ => 1.0,
    }
}

fn ensure_authorized(req: &HttpRequest, config: &Config) -> actix_web::Result<()> {
    if let Some(expected) = &config.admin_token {
        let auth = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let token = auth.strip_prefix("Bearer ").unwrap_or("");
        if token != expected {
            return Err(actix_web::error::ErrorUnauthorized("invalid token"));
        }
    }
    Ok(())
}
