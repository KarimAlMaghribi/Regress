//! Background job definitions that coordinate SharePoint downloads and uploads.

use std::{collections::HashMap, sync::Arc};

use chrono::{DateTime, Utc};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tokio::{sync::watch, task::JoinHandle};
use uuid::Uuid;

use crate::upload_adapter::UploadResult;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Paused,
    Succeeded,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobOrder {
    Alpha,
    NameAsc,
    NameDesc,
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
    pub upload_id: Option<i32>,
    pub pdf_id: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl JobState {
    /// Updates the job status and refreshes the modification timestamp.
    pub fn set_status(&mut self, status: JobStatus) {
        self.status = status;
        self.updated_at = Utc::now();
    }

    /// Stores progress information as a value between 0 and 1.
    pub fn set_progress(&mut self, progress: f32) {
        self.progress = progress.clamp(0.0, 1.0);
        self.updated_at = Utc::now();
    }

    /// Sets a human readable status message.
    pub fn set_message<T: Into<String>>(&mut self, message: T) {
        self.message = Some(message.into());
        self.updated_at = Utc::now();
    }

    /// Records the outcome produced by the upload adapter.
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
    pub upload_id: Option<i32>,
    pub pdf_id: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl JobRegistry {
    /// Constructs an empty registry that can track SharePoint ingestion jobs.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(JobRegistryInner {
                jobs: RwLock::new(HashMap::new()),
                handles: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Creates and registers a new managed job instance.
    pub fn create_job(
        &self,
        folder_id: String,
        folder_name: String,
        order: JobOrder,
        filenames_override: Option<Vec<String>>,
        upload_url: Option<String>,
        tenant_id: Option<Uuid>,
        pipeline_id: Option<Uuid>,
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
            upload_id: None,
            pdf_id: None,
            created_at: now,
            updated_at: now,
        };
        let managed = ManagedJob {
            state: Arc::new(Mutex::new(state)),
            control_tx: tx,
        };
        self.inner.jobs.write().insert(id, managed.clone());
        managed
    }

    /// Associates a spawned worker handle with the job identifier.
    pub fn insert_handle(&self, job_id: Uuid, handle: JoinHandle<()>) {
        self.inner.handles.lock().insert(job_id, handle);
    }

    /// Returns a snapshot summary for every tracked job.
    pub fn list(&self) -> Vec<JobSummary> {
        self.inner
            .jobs
            .read()
            .values()
            .map(|job| {
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
                    upload_id: state.upload_id,
                    pdf_id: state.pdf_id,
                    created_at: state.created_at,
                    updated_at: state.updated_at,
                }
            })
            .collect()
    }

    /// Retrieves a managed job by identifier if it exists.
    pub fn get(&self, id: &Uuid) -> Option<ManagedJob> {
        self.inner.jobs.read().get(id).cloned()
    }

    /// Applies an in-place update to the job state using the provided closure.
    pub fn update<F: FnOnce(&mut JobState)>(&self, id: &Uuid, updater: F) {
        if let Some(job) = self.inner.jobs.read().get(id) {
            let mut state = job.state.lock();
            updater(&mut state);
        }
    }

    /// Sends a cancel command to the job, returning whether it existed.
    pub fn cancel(&self, id: &Uuid) -> bool {
        if let Some(job) = self.get(id) {
            let _ = job.control_tx.send(JobCommand::Cancel);
            true
        } else {
            false
        }
    }

    /// Sends a pause command to the job, returning whether it existed.
    pub fn pause(&self, id: &Uuid) -> bool {
        if let Some(job) = self.get(id) {
            let _ = job.control_tx.send(JobCommand::Pause);
            true
        } else {
            false
        }
    }

    /// Sends a resume command to the job, returning whether it existed.
    pub fn resume(&self, id: &Uuid) -> bool {
        if let Some(job) = self.get(id) {
            let _ = job.control_tx.send(JobCommand::Run);
            true
        } else {
            false
        }
    }
}

/// Produces a serialisable summary for the given managed job.
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
        upload_id: state.upload_id,
        pdf_id: state.pdf_id,
        created_at: state.created_at,
        updated_at: state.updated_at,
    }
}
