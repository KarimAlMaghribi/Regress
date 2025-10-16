//! Defines the in-memory job registry that tracks SharePoint ingest progress
//! and exposes helpers for coordinating background work with control commands.

use std::{collections::HashMap, sync::Arc};

use chrono::{DateTime, Utc};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tokio::{sync::watch, task::JoinHandle};
use uuid::Uuid;

use crate::upload_adapter::UploadResult;

/// High level lifecycle stages reported for an ingest job.
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

/// Controls how nested folders and documents should be processed when a job
/// enumerates SharePoint content.
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

/// Container tying the mutable [`JobState`] to the control channel used for
/// pausing, resuming, or cancelling execution.
#[derive(Debug, Clone)]
pub struct ManagedJob {
    pub state: Arc<Mutex<JobState>>,
    pub control_tx: watch::Sender<JobCommand>,
}

/// Snapshot of an ingest job that is shared between the background task and
/// API handlers.
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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl JobState {
    /// Update the lifecycle state while refreshing the `updated_at` timestamp.
    pub fn set_status(&mut self, status: JobStatus) {
        self.status = status;
        self.updated_at = Utc::now();
    }

    /// Persist a normalized progress value and ensure it stays within bounds.
    pub fn set_progress(&mut self, progress: f32) {
        self.progress = progress.clamp(0.0, 1.0);
        self.updated_at = Utc::now();
    }

    /// Attach a human readable status message to aid debugging or display.
    pub fn set_message<T: Into<String>>(&mut self, message: T) {
        self.message = Some(message.into());
        self.updated_at = Utc::now();
    }

    /// Store the outcome from the upload API so clients can fetch artifacts.
    pub fn set_output(&mut self, output: UploadResult) {
        self.output = Some(output);
        self.updated_at = Utc::now();
    }
}

/// Concurrent registry of active jobs alongside their asynchronous handles.
#[derive(Debug, Clone)]
pub struct JobRegistry {
    inner: Arc<JobRegistryInner>,
}

/// Inner state guarded by locks to manage concurrent access safely.
#[derive(Debug)]
struct JobRegistryInner {
    jobs: RwLock<HashMap<Uuid, ManagedJob>>,
    handles: Mutex<HashMap<Uuid, JoinHandle<()>>>,
}

/// Signals that can be sent to the background task to change execution state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobCommand {
    Run,
    Pause,
    Cancel,
}

/// Simplified representation returned via the API for client consumption.
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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl JobRegistry {
    /// Create an empty [`JobRegistry`] without any tracked jobs.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(JobRegistryInner {
                jobs: RwLock::new(HashMap::new()),
                handles: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Register a new ingest job with default state and command channel.
    pub fn create_job(
        &self,
        folder_id: String,
        folder_name: String,
        order: JobOrder,
        filenames_override: Option<Vec<String>>,
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

    /// Track the asynchronous task handle responsible for performing work.
    pub fn insert_handle(&self, job_id: Uuid, handle: JoinHandle<()>) {
        self.inner.handles.lock().insert(job_id, handle);
    }

    /// Return an ordered list of summaries for all known jobs.
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
                    created_at: state.created_at,
                    updated_at: state.updated_at,
                }
            })
            .collect()
    }

    /// Fetch the [`ManagedJob`] for the provided identifier if it exists.
    pub fn get(&self, id: &Uuid) -> Option<ManagedJob> {
        self.inner.jobs.read().get(id).cloned()
    }

    /// Mutably update a job state while holding the necessary lock.
    pub fn update<F: FnOnce(&mut JobState)>(&self, id: &Uuid, updater: F) {
        if let Some(job) = self.inner.jobs.read().get(id) {
            let mut state = job.state.lock();
            updater(&mut state);
        }
    }

    /// Send a cancellation signal to the background worker if the job exists.
    pub fn cancel(&self, id: &Uuid) -> bool {
        if let Some(job) = self.get(id) {
            let _ = job.control_tx.send(JobCommand::Cancel);
            true
        } else {
            false
        }
    }

    /// Request that the job enter a paused state to temporarily stop work.
    pub fn pause(&self, id: &Uuid) -> bool {
        if let Some(job) = self.get(id) {
            let _ = job.control_tx.send(JobCommand::Pause);
            true
        } else {
            false
        }
    }

    /// Resume work by signalling the background worker to run again.
    pub fn resume(&self, id: &Uuid) -> bool {
        if let Some(job) = self.get(id) {
            let _ = job.control_tx.send(JobCommand::Run);
            true
        } else {
            false
        }
    }
}

/// Helper to derive a serializable summary from a managed job reference.
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
        created_at: state.created_at,
        updated_at: state.updated_at,
    }
}
