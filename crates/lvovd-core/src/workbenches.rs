//! Collection authority above the single application source/processing owners.
//! Transport lifetimes never own admitted imports or jobs.
use crate::{
    AppError, Result,
    assets::{Asset, Assets, Source},
    capabilities::CapabilityDiscovery,
    process::CancellationToken,
    processing_operation::{Admission, Processing, Published, ReviewRequest},
    processing_plan::ReviewedPlan,
    processing_queue::{Job, ProcessingQueue, Status},
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::task::TaskTracker;
use uuid::Uuid;

const MAX_WORKBENCHES: usize = 2;
const MAX_FILES: usize = 20;
const TTL: Duration = Duration::from_secs(60 * 60);

struct Retired {
    id: Uuid,
    // Keep source storage reserved even when only an encoded output is leased.
    lease: Option<Arc<Asset>>,
    failed: bool,
}
struct Workbench {
    id: Uuid,
    revision: u64,
    sources: Vec<Source>,
    retired: Vec<Retired>,
    intake_slots: usize,
    intake_failure: Option<AppError>,
    discarded: bool,
    cancel: CancellationToken,
    touched: Instant,
    admission_epoch: Arc<AtomicU64>,
}
#[derive(Default)]
struct Registry {
    entries: Vec<Workbench>,
    closing: bool,
}
struct State {
    assets: Assets,
    processing: Processing,
    queue: ProcessingQueue,
    capabilities: CapabilityDiscovery,
    ffprobe: PathBuf,
    registry: Mutex<Registry>,
    // Imports are admitted per collection, then serialized against the source
    // store's aggregate byte reservation. Waiting remains owned and cancellable.
    intake: tokio::sync::Mutex<()>,
    tasks: TaskTracker,
}
#[derive(Clone)]
pub struct Workbenches(Arc<State>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub workbench_id: Uuid,
    pub revision: u64,
    pub queue_revision: u64,
    pub discarded: bool,
    pub importing: bool,
    pub intake_failure: Option<AppError>,
    pub sources: Vec<Source>,
    pub cleanup: Vec<Uuid>,
    pub jobs: Vec<Job>,
    pub results: Vec<Published>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Intake {
    pub sources: Vec<Source>,
    pub failure: Option<AppError>,
}

impl Workbenches {
    pub fn new(assets: Assets, processing: Processing, ffmpeg: PathBuf, ffprobe: PathBuf) -> Self {
        let queue = ProcessingQueue::new(processing.clone());
        Self(Arc::new(State {
            assets,
            processing,
            queue,
            ffprobe,
            capabilities: CapabilityDiscovery::new(ffmpeg),
            registry: Mutex::new(Registry::default()),
            intake: tokio::sync::Mutex::new(()),
            tasks: TaskTracker::new(),
        }))
    }
    pub fn create(&self) -> Result<Snapshot> {
        let id = {
            let mut registry = self.0.registry.lock().unwrap();
            if registry.closing {
                return Err(closing());
            }
            if registry.entries.len() >= MAX_WORKBENCHES {
                return Err(AppError::new(
                    "WORKBENCH_LIMIT",
                    "Reopen or discard a retained workbench and finish cleanup first.",
                ));
            }
            let id = Uuid::new_v4();
            registry.entries.push(Workbench {
                id,
                revision: 1,
                sources: Vec::new(),
                retired: Vec::new(),
                intake_slots: 0,
                intake_failure: None,
                discarded: false,
                cancel: CancellationToken::new(),
                touched: Instant::now(),
                admission_epoch: Arc::new(AtomicU64::new(0)),
            });
            id
        };
        self.snapshot(id)
    }
    pub fn list(&self) -> Vec<Snapshot> {
        let registry = self.0.registry.lock().unwrap();
        registry
            .entries
            .iter()
            .map(|entry| self.snapshot_locked(entry))
            .collect()
    }
    pub fn snapshot(&self, id: Uuid) -> Result<Snapshot> {
        let registry = self.0.registry.lock().unwrap();
        let entry = registry
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(gone)?;
        Ok(self.snapshot_locked(entry))
    }
    fn snapshot_locked(&self, entry: &Workbench) -> Snapshot {
        let queue = self.0.queue.snapshot();
        Snapshot {
            workbench_id: entry.id,
            revision: entry.revision,
            queue_revision: queue.revision,
            discarded: entry.discarded,
            importing: entry.intake_slots > 0,
            intake_failure: entry.intake_failure.clone(),
            sources: entry.sources.clone(),
            cleanup: entry.retired.iter().map(|entry| entry.id).collect(),
            jobs: queue
                .jobs
                .into_iter()
                .filter(|job| entry.sources.iter().any(|s| s.asset_id == job.source_id))
                .collect(),
            results: entry
                .sources
                .iter()
                .filter_map(|source| self.0.processing.latest(source.asset_id))
                .collect(),
        }
    }
    pub fn touch(&self, id: Uuid) -> Result<()> {
        let mut registry = self.0.registry.lock().unwrap();
        let entry = active(&mut registry, id)?;
        entry.touched = Instant::now();
        Ok(())
    }
    /// Discard revokes media operations, not access to outstanding cleanup.
    pub fn reopen(&self, id: Uuid) -> Result<Snapshot> {
        let mut registry = self.0.registry.lock().unwrap();
        if registry.closing {
            return Err(closing());
        }
        let entry = registry
            .entries
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(gone)?;
        entry.touched = Instant::now();
        Ok(self.snapshot_locked(entry))
    }
    fn member(&self, id: Uuid, source: Uuid) -> Result<()> {
        let mut registry = self.0.registry.lock().unwrap();
        let entry = active(&mut registry, id)?;
        if !entry.sources.iter().any(|s| s.asset_id == source) {
            return Err(AppError::new(
                "WORKBENCH_SOURCE",
                "This file does not belong to this workbench.",
            ));
        }
        entry.touched = Instant::now();
        Ok(())
    }
    /// Only native picker/drop code supplies paths. A disconnected caller does
    /// not abandon the batch: its collection receives the eventual owned state.
    pub async fn import(&self, id: Uuid, paths: Vec<PathBuf>) -> Result<Intake> {
        let (send, receive) = tokio::sync::oneshot::channel();
        {
            let mut registry = self.0.registry.lock().unwrap();
            let entry = active(&mut registry, id)?;
            if paths.is_empty() || paths.len() > MAX_FILES {
                return Err(AppError::new(
                    "INTAKE_LIMIT",
                    "Choose between one and twenty files.",
                ));
            }
            if entry.intake_slots != 0 {
                return Err(AppError::new(
                    "INTAKE_BUSY",
                    "Wait for this workbench's import to finish.",
                ));
            }
            if entry.sources.len() + entry.retired.len() + paths.len() > MAX_FILES {
                return Err(AppError::new(
                    "WORKBENCH_FULL",
                    "Remove files and finish cleanup before adding more. A workbench holds twenty files.",
                ));
            }
            entry.intake_slots = paths.len();
            entry.intake_failure = None;
            entry.revision += 1;
            entry.touched = Instant::now();
            let cancel = entry.cancel.clone();
            let owner = self.clone();
            self.0.tasks.spawn(async move {
                let result = owner.import_owned(id, paths, cancel).await;
                let _ = send.send(result);
            });
        }
        receive.await.map_err(|_| {
            AppError::new(
                "INTAKE_FAILED",
                "Media intake ended unexpectedly. Reopen this workbench.",
            )
        })?
    }
    async fn import_owned(
        &self,
        id: Uuid,
        paths: Vec<PathBuf>,
        cancel: CancellationToken,
    ) -> Result<Intake> {
        let mut result = Intake {
            sources: Vec::new(),
            failure: None,
        };
        let admission = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            guard = self.0.intake.lock() => Some(guard),
        };
        if admission.is_none() {
            result.failure = Some(cancelled());
        }
        for path in paths {
            if result.failure.is_some() {
                break;
            }
            let imported = self
                .0
                .assets
                .import_cancellable(&path, &self.0.ffprobe, &cancel)
                .await;
            let mut registry = self.0.registry.lock().unwrap();
            // An importing collection is retained even after discard.
            let entry = registry.entries.iter_mut().find(|e| e.id == id).unwrap();
            match imported {
                Ok(source) if !entry.discarded => {
                    result.sources.push(source.clone());
                    entry.sources.push(source);
                }
                Ok(source) => {
                    self.retire(entry, source.asset_id);
                    result.failure = Some(cancelled());
                }
                Err(error) => {
                    if let Some(id) = error.cleanup_asset_id {
                        entry.retired.push(Retired {
                            id,
                            lease: None,
                            failed: true,
                        });
                    }
                    result.failure = Some(error);
                }
            }
            entry.intake_slots -= 1;
            entry.revision += 1;
        }
        let mut registry = self.0.registry.lock().unwrap();
        let entry = registry.entries.iter_mut().find(|e| e.id == id).unwrap();
        entry.intake_slots = 0;
        entry.intake_failure = result.failure.clone();
        entry.revision += 1;
        Ok(result)
    }
    pub async fn review(&self, id: Uuid, request: ReviewRequest) -> Result<ReviewedPlan> {
        let source = request.source_id;
        self.member(id, source)?;
        // Bound hostile nested settings before policy normalization or hashing.
        if serde_json::to_vec(&(&request.settings, &request.edit_plan))
            .map_or(true, |v| v.len() > 64 * 1024)
        {
            return Err(AppError::new(
                "PROCESSING_REQUEST",
                "The processing request is too large.",
            ));
        }
        let capabilities = self
            .0
            .capabilities
            .get(&self.0.assets.cancellation())
            .await?;
        self.member(id, source)?;
        let review = self
            .0
            .processing
            .review(request, Some(capabilities))
            .await?;
        self.member(id, source)?;
        Ok(review)
    }
    pub async fn enqueue(&self, id: Uuid, entries: Vec<Admission>) -> Result<Snapshot> {
        if entries.is_empty() || entries.len() > MAX_FILES {
            return Err(AppError::new(
                "PROCESSING_REQUEST",
                "Submit between one and twenty reviewed files.",
            ));
        }
        let (epoch, expected) = {
            let mut registry = self.0.registry.lock().unwrap();
            let workbench = active(&mut registry, id)?;
            if entries
                .iter()
                .any(|e| !workbench.sources.iter().any(|s| s.asset_id == e.source_id))
            {
                return Err(AppError::new(
                    "WORKBENCH_SOURCE",
                    "A submitted file does not belong to this workbench.",
                ));
            }
            workbench.touched = Instant::now();
            (
                workbench.admission_epoch.clone(),
                workbench.admission_epoch.load(Ordering::Acquire),
            )
        };
        // Source revocation and queue epoch invalidation linearize remove and
        // discard against the queue's final atomic admission.
        self.0
            .queue
            .enqueue_guarded(entries, move || epoch.load(Ordering::Acquire) == expected)
            .await?;
        self.snapshot(id)
    }
    pub fn cancel(&self, id: Uuid, job: Option<Uuid>) -> Result<Snapshot> {
        let mut registry = self.0.registry.lock().unwrap();
        let entry = active(&mut registry, id)?;
        if let Some(job) = job
            && !self
                .0
                .queue
                .snapshot()
                .jobs
                .iter()
                .any(|j| j.id == job && entry.sources.iter().any(|s| s.asset_id == j.source_id))
        {
            return Err(AppError::new(
                "PROCESSING_JOB_GONE",
                "This job does not belong to this workbench.",
            ));
        }
        entry.admission_epoch.fetch_add(1, Ordering::AcqRel);
        self.0.queue.cancel_sources(
            &entry.sources.iter().map(|s| s.asset_id).collect::<Vec<_>>(),
            job,
        )?;
        entry.touched = Instant::now();
        Ok(self.snapshot_locked(entry))
    }
    fn retire(&self, entry: &mut Workbench, id: Uuid) {
        let lease = self.0.assets.lease(id).ok();
        let _ = self.0.assets.remove(id);
        self.0.queue.forget_source(id);
        entry.admission_epoch.fetch_add(1, Ordering::AcqRel);
        entry.retired.push(Retired {
            id,
            lease,
            failed: false,
        });
    }
    pub fn remove(&self, id: Uuid, source: Uuid) -> Result<Snapshot> {
        let mut registry = self.0.registry.lock().unwrap();
        let entry = active(&mut registry, id)?;
        if let Some(index) = entry.sources.iter().position(|s| s.asset_id == source) {
            entry.sources.remove(index);
            self.retire(entry, source);
            entry.revision += 1;
        } else if !entry.retired.iter().any(|e| e.id == source) {
            return Err(AppError::new(
                "WORKBENCH_SOURCE",
                "This file does not belong to this workbench.",
            ));
        }
        entry.touched = Instant::now();
        Ok(self.snapshot_locked(entry))
    }
    pub fn discard(&self, id: Uuid) -> Result<Snapshot> {
        let mut registry = self.0.registry.lock().unwrap();
        let entry = registry
            .entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(gone)?;
        self.discard_locked(entry);
        Ok(self.snapshot_locked(entry))
    }
    fn discard_locked(&self, entry: &mut Workbench) {
        entry.discarded = true;
        entry.admission_epoch.fetch_add(1, Ordering::AcqRel);
        entry.cancel.cancel();
        for source in std::mem::take(&mut entry.sources) {
            self.retire(entry, source.asset_id);
        }
        entry.revision += 1;
    }
    pub async fn cleanup(&self) -> Result<()> {
        self.cleanup_inner(true).await
    }
    pub async fn reconcile(&self) -> Result<()> {
        self.cleanup_inner(false).await
    }
    async fn cleanup_inner(&self, retry: bool) -> Result<()> {
        // Even a failed attempt leaves its cleanup registered. Always reconcile
        // sources whose independent cleanup can complete.
        let result = if retry {
            self.0.processing.cleanup().await
        } else {
            self.0.processing.reconcile_cleanup().await
        };
        let mut registry = self.0.registry.lock().unwrap();
        for entry in &mut registry.entries {
            let before = entry.retired.len();
            entry.retired.retain_mut(|retired| {
                if self.0.processing.retains_source(retired.id) {
                    return true;
                }
                retired.lease.take();
                if retired.failed && !retry {
                    return true;
                }
                let complete = self
                    .0
                    .assets
                    .remove(retired.id)
                    .is_ok_and(|r| r.cleanup_complete);
                retired.failed = !complete && !self.0.assets.cleanup_has_readers(retired.id);
                !complete
            });
            if before != entry.retired.len() {
                entry.revision += 1;
            }
        }
        registry
            .entries
            .retain(|e| !(e.discarded && e.intake_slots == 0 && e.retired.is_empty()));
        result
    }
    pub fn expire(&self) {
        let mut registry = self.0.registry.lock().unwrap();
        let jobs = self.0.queue.snapshot().jobs;
        for entry in &mut registry.entries {
            let busy = entry.intake_slots > 0
                || jobs.iter().any(|j| {
                    matches!(
                        j.status,
                        Status::Queued | Status::Running | Status::Cancelling
                    ) && entry.sources.iter().any(|s| s.asset_id == j.source_id)
                });
            if busy {
                // Active work is activity. A long encode must not publish a
                // result only to expire it on the very next idle sweep.
                entry.touched = Instant::now();
            } else if !entry.discarded && entry.touched.elapsed() >= TTL {
                self.discard_locked(entry);
            }
        }
    }
    pub fn busy(&self) -> bool {
        self.list().iter().any(|e| {
            e.importing
                || e.jobs.iter().any(|j| {
                    matches!(
                        j.status,
                        Status::Queued | Status::Running | Status::Cancelling
                    )
                })
        })
    }
    pub async fn shutdown(&self) -> Result<()> {
        {
            let mut registry = self.0.registry.lock().unwrap();
            registry.closing = true;
            for entry in &mut registry.entries {
                self.discard_locked(entry);
            }
            self.0.tasks.close();
        }
        self.0.queue.shutdown().await?;
        tokio::time::timeout(Duration::from_secs(5), self.0.tasks.wait())
            .await
            .map_err(|_| {
                AppError::new(
                    "CLEANUP_PENDING",
                    "Imports are still stopping. Retry closing shortly.",
                )
            })?;
        self.0.processing.shutdown().await?;
        self.cleanup().await?;
        self.0.assets.shutdown().await
    }
}
fn active(registry: &mut Registry, id: Uuid) -> Result<&mut Workbench> {
    if registry.closing {
        return Err(closing());
    }
    registry
        .entries
        .iter_mut()
        .find(|e| e.id == id && !e.discarded)
        .ok_or_else(gone)
}
fn gone() -> AppError {
    AppError::new(
        "WORKBENCH_GONE",
        "This workbench has expired or been discarded.",
    )
}
fn closing() -> AppError {
    AppError::new("CLOSING", "The application is closing.")
}
fn cancelled() -> AppError {
    AppError::new("CANCELLED", "Import cancelled.")
}

#[cfg(test)]
mod tests;
