//! Background job definitions that coordinate SharePoint downloads and uploads.

use std::{collections::HashMap, str::FromStr, sync::Arc};

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use tracing::warn;
use uuid::Uuid;

use crate::upload_adapter::UploadResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Paused,
    Succeeded,
    Failed,
    Canceled,
}

impl JobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobStatus::Queued => "queued",
            JobStatus::Running => "running",
            JobStatus::Paused => "paused",
            JobStatus::Succeeded => "succeeded",
            JobStatus::Failed => "failed",
            JobStatus::Canceled => "canceled",
        }
    }
}

impl FromStr for JobStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "queued" => Ok(JobStatus::Queued),
            "running" => Ok(JobStatus::Running),
            "paused" => Ok(JobStatus::Paused),
            "succeeded" => Ok(JobStatus::Succeeded),
            "failed" => Ok(JobStatus::Failed),
            "canceled" => Ok(JobStatus::Canceled),
            other => Err(anyhow!("unknown job status '{other}'")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobOrder {
    Alpha,
    NameAsc,
    NameDesc,
}

impl JobOrder {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobOrder::Alpha => "alpha",
            JobOrder::NameAsc => "name_asc",
            JobOrder::NameDesc => "name_desc",
        }
    }
}

impl FromStr for JobOrder {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "alpha" => Ok(JobOrder::Alpha),
            "name_asc" => Ok(JobOrder::NameAsc),
            "name_desc" => Ok(JobOrder::NameDesc),
            other => Err(anyhow!("unknown job order '{other}'")),
        }
    }
}

impl Default for JobOrder {
    fn default() -> Self {
        JobOrder::Alpha
    }
}

#[derive(Debug, Clone)]
pub struct ManagedJob {
    pub state: Arc<Mutex<JobState>>,
    pub control_tx: watch::Sender<JobCommand>,
}

#[derive(Debug, Clone)]
pub struct JobState {
    pub id: Uuid,
    pub folder_id: String,
    pub folder_name: String,
    pub status: JobStatus,
    pub progress: f32,
    pub message: Option<String>,
    pub order: JobOrder,
    pub filenames_override: Option<Vec<String>>,
    pub output: Option<UploadResult>,
    pub upload_url: Option<String>,
    pub tenant_id: Option<Uuid>,
    pub pipeline_id: Option<Uuid>,
    pub pipeline_run_id: Option<Uuid>,
    pub upload_id: Option<i32>,
    pub pdf_id: Option<i32>,
    pub auto_managed: bool,
    pub auto_last_seen_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl JobState {
    pub fn set_status(&mut self, status: JobStatus) {
        self.status = status;
        self.updated_at = Utc::now();
    }

    pub fn set_progress(&mut self, progress: f32) {
        self.progress = progress.clamp(0.0, 1.0);
        self.updated_at = Utc::now();
    }

    pub fn set_message<T: Into<String>>(&mut self, message: T) {
        self.message = Some(message.into());
        self.updated_at = Utc::now();
    }

    pub fn set_output(&mut self, output: UploadResult) {
        self.upload_id = output.upload_id;
        self.pdf_id = output.pdf_id;
        self.output = Some(output);
        self.updated_at = Utc::now();
    }
}

#[derive(Debug, Clone)]
pub struct JobRegistry {
    inner: Arc<JobRegistryInner>,
    persistence: Option<JobPersistence>,
}

#[derive(Debug)]
struct JobRegistryInner {
    jobs: RwLock<HashMap<Uuid, ManagedJob>>,
    handles: Mutex<HashMap<Uuid, JoinHandle<()>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobCommand {
    Run,
    Pause,
    Cancel,
}

#[derive(Debug, Serialize, Clone)]
pub struct JobSummary {
    pub id: Uuid,
    pub folder_id: String,
    pub folder_name: String,
    pub status: JobStatus,
    pub progress: f32,
    pub message: Option<String>,
    pub output: Option<UploadResult>,
    pub order: JobOrder,
    pub filenames_override: Option<Vec<String>>,
    pub upload_url: Option<String>,
    pub tenant_id: Option<Uuid>,
    pub pipeline_id: Option<Uuid>,
    pub pipeline_run_id: Option<Uuid>,
    pub upload_id: Option<i32>,
    pub pdf_id: Option<i32>,
    pub auto_managed: bool,
    pub auto_last_seen_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl JobRegistry {
    pub fn new(persistence: Option<JobPersistence>) -> Self {
        Self {
            inner: Arc::new(JobRegistryInner {
                jobs: RwLock::new(HashMap::new()),
                handles: Mutex::new(HashMap::new()),
            }),
            persistence,
        }
    }

    pub fn create_job(
        &self,
        folder_id: String,
        folder_name: String,
        order: JobOrder,
        filenames_override: Option<Vec<String>>,
        upload_url: Option<String>,
        tenant_id: Option<Uuid>,
        pipeline_id: Option<Uuid>,
        auto_managed: bool,
    ) -> ManagedJob {
        let id = Uuid::new_v4();
        let (tx, _rx) = watch::channel(JobCommand::Run);
        let now = Utc::now();
        let state = JobState {
            id,
            folder_id,
            folder_name,
            status: JobStatus::Queued,
            progress: 0.0,
            message: None,
            order,
            filenames_override,
            output: None,
            upload_url,
            tenant_id,
            pipeline_id,
            pipeline_run_id: None,
            upload_id: None,
            pdf_id: None,
            auto_managed,
            auto_last_seen_at: auto_managed.then_some(now),
            created_at: now,
            updated_at: now,
        };
        let managed = ManagedJob {
            state: Arc::new(Mutex::new(state)),
            control_tx: tx,
        };
        let snapshot = managed.state.lock().clone();
        self.inner.jobs.write().insert(id, managed.clone());
        self.notify(snapshot);
        managed
    }

    pub fn restore_job(&self, state: JobState) -> ManagedJob {
        let id = state.id;
        let (tx, _rx) = watch::channel(JobCommand::Run);
        let managed = ManagedJob {
            state: Arc::new(Mutex::new(state)),
            control_tx: tx,
        };
        self.inner.jobs.write().insert(id, managed.clone());
        managed
    }

    pub fn insert_handle(&self, job_id: Uuid, handle: JoinHandle<()>) {
        self.inner.handles.lock().insert(job_id, handle);
    }

    pub fn list(&self) -> Vec<JobSummary> {
        self.inner
            .jobs
            .read()
            .values()
            .map(|job| job_summary(job))
            .collect()
    }

    pub fn get(&self, id: &Uuid) -> Option<ManagedJob> {
        self.inner.jobs.read().get(id).cloned()
    }

    pub fn update<F: FnOnce(&mut JobState)>(&self, id: &Uuid, updater: F) {
        if let Some(job) = self.inner.jobs.read().get(id) {
            let snapshot = {
                let mut state = job.state.lock();
                updater(&mut state);
                state.clone()
            };
            self.notify(snapshot);
        }
    }

    pub fn cancel(&self, id: &Uuid) -> bool {
        if let Some(job) = self.get(id) {
            let _ = job.control_tx.send(JobCommand::Cancel);
            true
        } else {
            false
        }
    }

    pub fn pause(&self, id: &Uuid) -> bool {
        if let Some(job) = self.get(id) {
            let _ = job.control_tx.send(JobCommand::Pause);
            true
        } else {
            false
        }
    }

    pub fn resume(&self, id: &Uuid) -> bool {
        if let Some(job) = self.get(id) {
            let _ = job.control_tx.send(JobCommand::Run);
            true
        } else {
            false
        }
    }

    fn notify(&self, state: JobState) {
        if let Some(persistence) = &self.persistence {
            persistence.send(state);
        }
    }
}

pub fn job_summary(job: &ManagedJob) -> JobSummary {
    let state = job.state.lock();
    JobSummary {
        id: state.id,
        folder_id: state.folder_id.clone(),
        folder_name: state.folder_name.clone(),
        status: state.status.clone(),
        progress: state.progress,
        message: state.message.clone(),
        output: state.output.clone(),
        order: state.order.clone(),
        filenames_override: state.filenames_override.clone(),
        upload_url: state.upload_url.clone(),
        tenant_id: state.tenant_id,
        pipeline_id: state.pipeline_id,
        pipeline_run_id: state.pipeline_run_id,
        upload_id: state.upload_id,
        pdf_id: state.pdf_id,
        auto_managed: state.auto_managed,
        auto_last_seen_at: state.auto_last_seen_at,
        created_at: state.created_at,
        updated_at: state.updated_at,
    }
}

#[derive(Debug, Clone)]
pub struct JobPersistence {
    tx: mpsc::UnboundedSender<JobState>,
}

impl JobPersistence {
    pub fn new(store: Arc<JobStore>) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(state) = rx.recv().await {
                if let Err(err) = store.persist_state(&state).await {
                    warn!(job_id = %state.id, error = %err, "failed to persist job state");
                }
            }
        });
        Self { tx }
    }

    pub fn send(&self, state: JobState) {
        let _ = self.tx.send(state);
    }
}

#[derive(Clone)]
pub struct JobStore {
    pool: Pool,
}

impl JobStore {
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }

    pub async fn persist_state(&self, state: &JobState) -> anyhow::Result<()> {
        let client = self.pool.get().await?;
        let output_json: Option<Value> = match state.output.as_ref() {
            Some(result) => Some(serde_json::to_value(result)?),
            None => None,
        };
        let filenames = state.filenames_override.as_ref();
        let message = state.message.as_deref();
        client
            .execute(
                "INSERT INTO sharepoint_jobs (
                    id, folder_id, folder_name, status, progress, message, order_key,
                    filenames_override, upload_url, tenant_id, pipeline_id, pipeline_run_id,
                    upload_id, pdf_id, output, auto_managed, auto_last_seen_at, created_at, updated_at
                 ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17, $18, $19
                 )
                 ON CONFLICT (id) DO UPDATE SET
                    folder_id = EXCLUDED.folder_id,
                    folder_name = EXCLUDED.folder_name,
                    status = EXCLUDED.status,
                    progress = EXCLUDED.progress,
                    message = EXCLUDED.message,
                    order_key = EXCLUDED.order_key,
                    filenames_override = EXCLUDED.filenames_override,
                    upload_url = EXCLUDED.upload_url,
                    tenant_id = EXCLUDED.tenant_id,
                    pipeline_id = EXCLUDED.pipeline_id,
                    pipeline_run_id = EXCLUDED.pipeline_run_id,
                    upload_id = EXCLUDED.upload_id,
                    pdf_id = EXCLUDED.pdf_id,
                    output = EXCLUDED.output,
                    auto_managed = EXCLUDED.auto_managed,
                    auto_last_seen_at = EXCLUDED.auto_last_seen_at,
                    updated_at = EXCLUDED.updated_at",
                &[
                    &state.id,
                    &state.folder_id,
                    &state.folder_name,
                    &state.status.as_str(),
                    &(state.progress as f64),
                    &message,
                    &state.order.as_str(),
                    &filenames,
                    &state.upload_url,
                    &state.tenant_id,
                    &state.pipeline_id,
                    &state.pipeline_run_id,
                    &state.upload_id,
                    &state.pdf_id,
                    &output_json,
                    &state.auto_managed,
                    &state.auto_last_seen_at,
                    &state.created_at,
                    &state.updated_at,
                ],
            )
            .await?;
        Ok(())
    }

    pub async fn load_all(&self) -> anyhow::Result<Vec<JobState>> {
        let client = self.pool.get().await?;
        let rows = client
            .query(
                "SELECT id, folder_id, folder_name, status, progress, message, order_key,
                        filenames_override, upload_url, tenant_id, pipeline_id, pipeline_run_id,
                        upload_id, pdf_id, output, auto_managed, auto_last_seen_at, created_at, updated_at
                 FROM sharepoint_jobs
                 ORDER BY created_at ASC",
                &[],
            )
            .await?;

        let mut jobs = Vec::with_capacity(rows.len());
        for row in rows {
            let status_text: String = row.get("status");
            let status = JobStatus::from_str(&status_text).unwrap_or_else(|err| {
                warn!(error = %err, status = %status_text, "unknown job status in sharepoint_jobs; defaulting to failed");
                JobStatus::Failed
            });
            let order_text: String = row.get("order_key");
            let order = JobOrder::from_str(&order_text).unwrap_or_else(|err| {
                warn!(error = %err, order = %order_text, "unknown job order in sharepoint_jobs; defaulting to alpha");
                JobOrder::Alpha
            });
            let message: Option<String> = row.get("message");
            let filenames: Option<Vec<String>> = row.get("filenames_override");
            let upload_url: Option<String> = row.get("upload_url");
            let tenant_id: Option<Uuid> = row.get("tenant_id");
            let pipeline_id: Option<Uuid> = row.get("pipeline_id");
            let pipeline_run_id: Option<Uuid> = row.get("pipeline_run_id");
            let upload_id: Option<i32> = row.get("upload_id");
            let pdf_id: Option<i32> = row.get("pdf_id");
            let auto_managed: bool = row.get("auto_managed");
            let auto_last_seen_at: Option<DateTime<Utc>> = row.get("auto_last_seen_at");
            let output_value: Option<Value> = row.get("output");
            let output = match output_value {
                Some(value) => match serde_json::from_value::<UploadResult>(value) {
                    Ok(parsed) => Some(parsed),
                    Err(err) => {
                        warn!(%err, "failed to parse upload_result from sharepoint_jobs");
                        None
                    }
                },
                None => None,
            };
            let progress: f64 = row.get("progress");
            let created_at: DateTime<Utc> = row.get("created_at");
            let updated_at: DateTime<Utc> = row.get("updated_at");

            jobs.push(JobState {
                id: row.get("id"),
                folder_id: row.get("folder_id"),
                folder_name: row.get("folder_name"),
                status,
                progress: progress as f32,
                message,
                order,
                filenames_override: filenames,
                output,
                upload_url,
                tenant_id,
                pipeline_id,
                pipeline_run_id,
                upload_id,
                pdf_id,
                auto_managed,
                auto_last_seen_at,
                created_at,
                updated_at,
            });
        }

        Ok(jobs)
    }
}
