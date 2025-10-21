//! Service responsible for scanning SharePoint folders and enqueueing PDF jobs.

mod config;
mod job;
mod msgraph;
mod pdfops;
mod scan;
mod upload_adapter;

use std::collections::HashMap;
use std::sync::Arc;

use actix_cors::Cors;
use actix_web::{
    error::ErrorBadRequest, http::header, middleware::Logger, web, App, HttpRequest, HttpResponse,
    HttpServer, Responder,
};
use anyhow::anyhow;
use job::{job_summary, JobOrder, JobRegistry, JobStatus, ManagedJob};
use msgraph::{GraphFile, GraphFolder, MsGraphClient};
use pdfops::merge_pdfs;
use scan::{assert_pdf, scan_with_clamd, ScanConfig};
use serde_json::json;
use tokio::sync::{watch, Semaphore};
use tracing::{error, info, warn};
use upload_adapter::UploadAdapter;
use uuid::Uuid;

use crate::config::Config;

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    graph: Arc<MsGraphClient>,
    uploader: Arc<UploadAdapter>,
    jobs: JobRegistry,
    semaphore: Arc<Semaphore>,
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

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .init();

    let config = Config::from_env().expect("configuration error");
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

    let state = AppState {
        config: Arc::new(config),
        graph,
        uploader,
        jobs: JobRegistry::new(),
        semaphore: Arc::new(Semaphore::new(max_concurrency)),
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
    );
    let summary = job_summary(&job);
    let app_state = state.get_ref().clone();
    spawn_job_worker(app_state, job);
    Ok(HttpResponse::Ok().json(json!({ "job": summary })))
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
                if let Some(snapshot) = jobs.get(&job_id).map(|j| j.state.lock().clone()) {
                    let dest_path = format!(
                        "{}/{}",
                        config.drive_failed_path(),
                        sanitize_path_component(&snapshot.folder_name)
                    );
                    if let Err(move_err) = graph.move_item(&snapshot.folder_id, &dest_path).await {
                        error!(%job_id, error = ?move_err, "failed to move to failed folder");
                    }
                }
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
    let upload_result = uploader
        .upload(
            &merged_path,
            &upload_name,
            upload_override.as_deref(),
            tenant_override,
        )
        .await
        .map_err(JobRunError::Failure)?;
    jobs.update(&job_id, |s| {
        s.set_progress(download_weight + merge_weight + upload_weight * 0.5);
        s.set_message("upload completed");
        s.set_output(upload_result.clone());
    });

    wait_until_running(&jobs, job_id, &mut control_rx).await?;
    let dest_path = format!(
        "{}/{}",
        config.drive_processed_path(),
        sanitize_path_component(&snapshot.folder_name)
    );
    graph
        .move_item(&snapshot.folder_id, &dest_path)
        .await
        .map_err(JobRunError::Failure)?;

    jobs.update(&job_id, |s| {
        s.set_progress(download_weight + merge_weight + upload_weight);
        s.set_message("folder moved to processed");
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
            if let Some(snapshot) = snapshot {
                let dest_path = format!(
                    "{}/{}",
                    config.drive_failed_path(),
                    sanitize_path_component(&snapshot.folder_name)
                );
                if let Err(move_err) = graph.move_item(&snapshot.folder_id, &dest_path).await {
                    error!(%job_id, error = ?move_err, "failed to move job to failed folder");
                }
            }
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

fn sanitize_path_component(name: &str) -> String {
    let sanitized = sanitize_filename(name);
    if sanitized.is_empty() {
        "attachment".to_string()
    } else {
        sanitized
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
