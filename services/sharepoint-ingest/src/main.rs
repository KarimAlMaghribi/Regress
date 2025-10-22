//! Service responsible for scanning SharePoint folders and enqueueing PDF jobs.

mod config;
mod job;
mod msgraph;
mod pdfops;
mod pipeline_adapter;
mod scan;
mod upload_adapter;

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

use actix_cors::Cors;
use actix_web::{
    error::ErrorBadRequest, http::header, middleware::Logger, web, App, HttpRequest, HttpResponse,
    HttpServer, Responder,
};
use anyhow::anyhow;
use chrono::{DateTime, Utc};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use job::{job_summary, JobOrder, JobPersistence, JobRegistry, JobStatus, JobStore, ManagedJob};
use msgraph::{GraphFile, GraphFolder, MsGraphClient};
use pdfops::merge_pdfs;
use pipeline_adapter::PipelineAdapter;
use scan::{assert_pdf, scan_with_clamd, ScanConfig};
use serde_json::json;
use tokio::sync::{watch, Semaphore};
use tokio_postgres::NoTls;
use tracing::{error, info, warn};
use upload_adapter::UploadAdapter;
use uuid::Uuid;

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
}

#[derive(serde::Serialize)]
struct JobsResponse {
    jobs: Vec<job::JobSummary>,
}

#[derive(serde::Serialize)]
struct ProcessedFoldersResponse {
    items: Vec<ProcessedFolderItem>,
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
    let items = folders
        .into_iter()
        .map(|folder| FolderItem {
            id: folder.id,
            name: folder.name,
            file_count: folder.file_count,
        })
        .collect::<Vec<_>>();
    Ok(web::Json(FoldersResponse {
        base,
        total: items.len(),
        items,
    }))
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

    let upload_override = payload.upload_url.as_ref().and_then(|url| {
        let trimmed = url.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let tenant_override = payload.tenant_id;
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
            None,
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
) -> actix_web::Result<impl Responder> {
    ensure_authorized(&req, &state.config)?;
    let client = state
        .db_pool
        .get()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let rows = client
        .query(
            "SELECT id, folder_id, folder_name, status, progress, message, tenant_id,
                    pipeline_id, pipeline_run_id, upload_id, pdf_id, created_at, updated_at
             FROM sharepoint_jobs
             WHERE status = 'succeeded' AND upload_id IS NOT NULL
             ORDER BY updated_at DESC",
            &[],
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let status_text: String = row.get("status");
        let status = JobStatus::from_str(&status_text).unwrap_or(JobStatus::Succeeded);
        let progress: f64 = row.get("progress");
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

    let mut client = state
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
                "SELECT status, upload_id, pdf_id, folder_name FROM sharepoint_jobs WHERE id = $1",
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

    let handle = tokio::spawn(async move {
        jobs.update(&job_id, |s| {
            s.set_status(JobStatus::Running);
            s.set_message("job started");
        });

        if let Err(err) = wait_until_running(&jobs, job_id, &mut control_rx).await {
            handle_control_error(err, &jobs, job_id, &config, &graph).await;
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

async fn run_job_inner(
    config: Arc<Config>,
    graph: Arc<MsGraphClient>,
    uploader: Arc<UploadAdapter>,
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
    let pipeline_override = snapshot.pipeline_id;
    let upload_result = uploader
        .upload(
            &merged_path,
            &upload_name,
            upload_override.as_deref(),
            tenant_override,
            pipeline_override,
        )
        .await
        .map_err(JobRunError::Failure)?;
    jobs.update(&job_id, |s| {
        s.set_progress(download_weight + merge_weight + upload_weight * 0.5);
        s.set_message("upload completed");
        s.set_output(upload_result.clone());
    });

    jobs.update(&job_id, |s| {
        s.set_progress(download_weight + merge_weight + upload_weight);
        s.set_message("bereit für Pipeline-Verarbeitung");
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

async fn handle_control_error(
    err: JobRunError,
    jobs: &JobRegistry,
    job_id: Uuid,
    config: &Arc<Config>,
    graph: &Arc<MsGraphClient>,
) {
    let snapshot = jobs.get(&job_id).map(|j| j.state.lock().clone());
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
