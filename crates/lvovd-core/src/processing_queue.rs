//! Ordered application-owned jobs over Processing's immutable admission tickets.
//! Transport subscribers observe snapshots; they do not own or cancel workers.
use crate::{
    AppError, Result,
    process::Progress,
    processing_operation::{Admission, Error, Prepared, Processing, Published},
};
use serde::Serialize;
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;
use tokio_util::task::TaskTracker;
use uuid::Uuid;

pub const MAX_LIVE_JOBS: usize = 20;
// Two workbenches of twenty sources. Terminal rows are replaced per source,
// not appended forever. The collection owner must forget removed members.
const MAX_ROWS: usize = 40;
const QUEUED_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}
impl Status {
    fn live(self) -> bool {
        matches!(self, Self::Queued | Self::Running | Self::Cancelling)
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: Uuid,
    pub source_id: Uuid,
    pub draft_revision: u32,
    pub plan_key: String,
    pub status: Status,
    pub progress: Progress,
    pub result: Option<Published>,
    pub failure: Option<serde_json::Value>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub queue_id: Uuid,
    pub revision: u64,
    pub closing: bool,
    pub jobs: Vec<Job>,
}
struct Entry {
    job: Job,
    prepared: Option<Prepared>,
    queued_at: Instant,
}
#[derive(Default)]
struct Registry {
    entries: Vec<Entry>,
    order: VecDeque<Uuid>,
    epoch: u64,
    revision: u64,
    draining: bool,
    closing: bool,
}
struct State {
    id: Uuid,
    processing: Processing,
    registry: Mutex<Registry>,
    admission: tokio::sync::Mutex<()>,
    snapshots: watch::Sender<Snapshot>,
    tasks: TaskTracker,
    #[cfg(test)]
    hooks: tests::Hooks,
}
#[derive(Clone)]
pub struct ProcessingQueue(Arc<State>);

impl ProcessingQueue {
    pub fn new(processing: Processing) -> Self {
        let id = Uuid::new_v4();
        let (snapshots, _) = watch::channel(Snapshot {
            queue_id: id,
            revision: 0,
            closing: false,
            jobs: Vec::new(),
        });
        Self(Arc::new(State {
            id,
            processing,
            registry: Mutex::new(Registry::default()),
            admission: tokio::sync::Mutex::new(()),
            snapshots,
            tasks: TaskTracker::new(),
            #[cfg(test)]
            hooks: tests::Hooks::default(),
        }))
    }
    pub fn snapshot(&self) -> Snapshot {
        self.0.snapshots.borrow().clone()
    }
    /// A slow reader retains one current snapshot, never a progress-event log.
    /// Resubscribing always begins with authoritative state.
    pub fn subscribe(&self) -> watch::Receiver<Snapshot> {
        self.0.snapshots.subscribe()
    }
    fn publish(&self, registry: &mut Registry) -> Snapshot {
        registry.revision += 1;
        let snapshot = Snapshot {
            queue_id: self.0.id,
            revision: registry.revision,
            closing: registry.closing,
            jobs: registry
                .entries
                .iter()
                .map(|entry| entry.job.clone())
                .collect(),
        };
        self.0.snapshots.send_replace(snapshot.clone());
        snapshot
    }
    /// All-or-none admission; after publication, the queue owns every ticket.
    /// Dropping a command response or subscription cannot lose admitted work.
    pub async fn enqueue(&self, entries: Vec<Admission>) -> Result<Snapshot> {
        if self.0.registry.lock().unwrap().closing {
            return Err(closing());
        }
        let _admission = self.0.admission.try_lock().map_err(|_| {
            AppError::new(
                "PROCESSING_BUSY",
                "A queue submission is already being reviewed.",
            )
        })?;
        let epoch = {
            let registry = self.0.registry.lock().unwrap();
            if registry.closing {
                return Err(closing());
            }
            if entries.is_empty() || entries.len() > MAX_LIVE_JOBS {
                return Err(AppError::new(
                    "PROCESSING_REQUEST",
                    "Submit a bounded list of reviewed files.",
                ));
            }
            if entries.iter().any(|request| {
                registry.entries.iter().any(|entry| {
                    entry.job.source_id == request.source_id && entry.job.status.live()
                })
            }) {
                return Err(AppError::new(
                    "PROCESSING_BUSY",
                    "This file already has a queued or running operation.",
                ));
            }
            if registry
                .entries
                .iter()
                .filter(|entry| entry.job.status.live())
                .count()
                + entries.len()
                > MAX_LIVE_JOBS
            {
                return Err(AppError::new(
                    "PROCESSING_QUEUE_FULL",
                    "The local processing queue is full.",
                ));
            }
            let sources: HashSet<_> = registry
                .entries
                .iter()
                .map(|entry| entry.job.source_id)
                .chain(entries.iter().map(|entry| entry.source_id))
                .collect();
            if sources.len() > MAX_ROWS {
                return Err(AppError::new(
                    "PROCESSING_QUEUE_FULL",
                    "Remove unused files before adding more processing results.",
                ));
            }
            registry.epoch
        };
        let prepared = self.0.processing.prepare_batch(entries).await?;
        #[cfg(test)]
        self.0.hooks.after_admission().await;
        let mut registry = self.0.registry.lock().unwrap();
        if registry.closing {
            return Err(closing());
        }
        if registry.epoch != epoch {
            return Err(AppError::new(
                "CANCELLED",
                "The pending queue submission was cancelled. Review and submit again.",
            ));
        }
        for ticket in prepared {
            // Replacement concerns the job row only. A previous validated
            // result remains owned by Processing even if the new job fails.
            registry
                .entries
                .retain(|entry| entry.job.source_id != ticket.source_id());
            let id = ticket.operation_id();
            registry.order.push_back(id);
            registry.entries.push(Entry {
                job: Job {
                    id,
                    source_id: ticket.source_id(),
                    draft_revision: ticket.draft_revision(),
                    plan_key: ticket.review().key().into(),
                    status: Status::Queued,
                    progress: Progress::default(),
                    result: None,
                    failure: None,
                },
                prepared: Some(ticket),
                queued_at: Instant::now(),
            });
        }
        let snapshot = self.publish(&mut registry);
        if !registry.draining {
            registry.draining = true;
            let owner = self.clone();
            self.0.tasks.spawn(async move {
                owner.drain().await;
            });
        }
        Ok(snapshot)
    }
    async fn drain(&self) {
        loop {
            #[cfg(test)]
            self.0.hooks.before_next().await;
            let prepared = {
                let mut registry = self.0.registry.lock().unwrap();
                self.expire_locked(&mut registry, Instant::now());
                let next = registry
                    .order
                    .pop_front()
                    .and_then(|id| registry.entries.iter_mut().find(|entry| entry.job.id == id));
                match next {
                    Some(entry) => {
                        entry.job.status = Status::Running;
                        let ticket = entry.prepared.take().expect("queued job owns admission");
                        self.publish(&mut registry);
                        ticket
                    }
                    None => {
                        registry.draining = false;
                        return;
                    }
                }
            };
            let id = prepared.operation_id();
            #[cfg(test)]
            self.0.hooks.before_run.wait().await;
            let (progress, mut receiver) = watch::channel(Progress::default());
            let running = self.0.processing.run(prepared, progress);
            tokio::pin!(running);
            let mut expiry = tokio::time::interval(Duration::from_secs(1));
            let outcome = loop {
                tokio::select! {
                    biased;
                    result = &mut running => break result,
                    changed = receiver.changed() => {
                        if changed.is_err() { break running.await; }
                        let progress = *receiver.borrow_and_update();
                        let mut registry = self.0.registry.lock().unwrap();
                        if let Some(entry) = registry.entries.iter_mut().find(|entry| entry.job.id == id) {
                            entry.job.progress = progress;
                            self.publish(&mut registry);
                        }
                    }
                    _ = expiry.tick() => {
                        let mut registry = self.0.registry.lock().unwrap();
                        self.expire_locked(&mut registry, Instant::now());
                    }
                }
            };
            #[cfg(test)]
            self.0.hooks.after_result().await;
            let mut registry = self.0.registry.lock().unwrap();
            if let Some(entry) = registry.entries.iter_mut().find(|entry| entry.job.id == id) {
                match outcome {
                    Ok(result) => {
                        // The core's publication decision wins a cancellation
                        // arriving after publication but before this snapshot.
                        entry.job.status = Status::Completed;
                        entry.job.result = Some(result);
                    }
                    Err(error) => {
                        entry.job.status = if entry.job.status == Status::Cancelling
                            || matches!(&error, Error::Request(e) if e.code == "CANCELLED" || e.code == "ASSET_GONE")
                        {
                            Status::Cancelled
                        } else {
                            Status::Failed
                        };
                        entry.job.failure =
                            Some(serde_json::to_value(error).expect("structured processing error"));
                    }
                }
                self.publish(&mut registry);
            }
        }
    }
    /// Select all jobs before signalling any worker. A later job cannot start
    /// between individual cancellation calls. None also invalidates admission.
    pub fn cancel(&self, job_id: Option<Uuid>) -> Result<Snapshot> {
        let mut registry = self.0.registry.lock().unwrap();
        if job_id.is_some_and(|id| !registry.entries.iter().any(|entry| entry.job.id == id)) {
            return Err(AppError::new(
                "PROCESSING_JOB_GONE",
                "This processing job is no longer available.",
            ));
        }
        registry.epoch += 1;
        self.cancel_locked(&mut registry, |job| job_id.is_none_or(|id| job.id == id));
        Ok(self.publish(&mut registry))
    }
    fn cancel_locked(&self, registry: &mut Registry, selected: impl Fn(&Job) -> bool) {
        for entry in &mut registry.entries {
            if !selected(&entry.job) || !entry.job.status.live() {
                continue;
            }
            if entry.job.status == Status::Queued {
                entry.prepared.take(); // Drop releases this unstarted admission.
                entry.job.status = Status::Cancelled;
            } else {
                self.0.processing.cancel(entry.job.source_id, entry.job.id);
                entry.job.status = Status::Cancelling;
            }
        }
        registry.order.retain(|id| {
            registry
                .entries
                .iter()
                .any(|entry| entry.job.id == *id && entry.job.status == Status::Queued)
        });
    }
    /// The collection owner revokes source access first, then retires the row.
    /// A delayed worker result cannot insert it again. Cleanup remains in the
    /// Processing/Assets owners, not in a disconnected presentation row.
    pub fn forget_source(&self, source_id: Uuid) -> Snapshot {
        let mut registry = self.0.registry.lock().unwrap();
        registry.epoch += 1;
        self.cancel_locked(&mut registry, |job| job.source_id == source_id);
        registry
            .entries
            .retain(|entry| entry.job.source_id != source_id);
        self.publish(&mut registry)
    }
    fn expire_locked(&self, registry: &mut Registry, now: Instant) {
        let expired: HashSet<_> = registry
            .entries
            .iter()
            .filter(|entry| {
                entry.job.status == Status::Queued
                    && now.saturating_duration_since(entry.queued_at) >= QUEUED_TTL
            })
            .map(|entry| entry.job.id)
            .collect();
        if expired.is_empty() {
            return;
        }
        self.cancel_locked(registry, |job| expired.contains(&job.id));
        for entry in &mut registry.entries {
            if expired.contains(&entry.job.id) {
                entry.job.failure = Some(
                    serde_json::json!({"code":"PROCESSING_EXPIRED", "message":"Queued processing expired before it could start. Review and submit again."}),
                );
            }
        }
        self.publish(registry);
    }
    /// Call before Processing::shutdown, then Assets::shutdown. This owner
    /// drains jobs but does not delete sources, results or exported files.
    pub async fn shutdown(&self) -> Result<()> {
        {
            let mut registry = self.0.registry.lock().unwrap();
            registry.closing = true;
            registry.epoch += 1;
            self.cancel_locked(&mut registry, |_| true);
            self.publish(&mut registry);
            self.0.tasks.close();
        }
        // Any in-flight batch must release its uncommitted tickets too.
        tokio::time::timeout(Duration::from_secs(5), async {
            let _admission = self.0.admission.lock().await;
            self.0.tasks.wait().await;
        })
        .await
        .map_err(|_| {
            AppError::new(
                "CLEANUP_PENDING",
                "Processing is still stopping. Retry closing shortly.",
            )
        })
    }
}
fn closing() -> AppError {
    AppError::new("CLOSING", "The processing queue is closing.")
}
#[cfg(test)]
mod tests;
