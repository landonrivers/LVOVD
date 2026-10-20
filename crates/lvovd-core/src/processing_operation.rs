//! Owned admission and result publication for unified processing. There is no
//! frontend path/argument API here. The 8C collection/queue transport must use
//! this boundary instead of composing the policy primitives itself.
use crate::{
    AppError, Result,
    assets::{Asset, Assets},
    capabilities::Capabilities,
    inspection,
    media_inspection::MediaInspection,
    owned_file::Seal,
    process::{self, CancellationToken, Progress, Supervisor},
    processing_command::{self, Attempt, SizeControl, SizeDecision, ValidationFailure},
    processing_plan::{self, Input, ReviewedPlan},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::task::TaskTracker;
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Error {
    Request(AppError),
    Validation(ValidationFailure),
}
impl From<AppError> for Error {
    fn from(error: AppError) -> Self {
        Self::Request(error)
    }
}
impl From<ValidationFailure> for Error {
    fn from(error: ValidationFailure) -> Self {
        Self::Validation(error)
    }
}
type Outcome<T> = std::result::Result<T, Error>;
fn stale() -> AppError {
    AppError::new(
        "PROCESSING_STALE",
        "The processing review has changed. Review the current settings again.",
    )
}
fn cancelled() -> AppError {
    AppError::new(
        "CANCELLED",
        "Processing cancelled. Your source and previous result remain available.",
    )
}
fn cleanup_pending() -> AppError {
    AppError::new(
        "CLEANUP_PENDING",
        "Retry temporary cleanup before processing this file again.",
    )
}
fn invalid_output() -> AppError {
    AppError::new(
        "PROCESSING_OUTPUT",
        "Processed output is missing, changed, or is not an owned regular file. Retry processing; your source and previous result remain available.",
    )
}

/// Values are supplied by the Rust application, never command JSON.
pub struct Limits {
    pub maximum_bytes: u64,
    pub worker_deadline: Duration,
}
pub struct ReviewRequest {
    pub source_id: Uuid,
    pub draft_revision: u32,
    pub settings: Option<Value>,
    pub edit_plan: Option<Value>,
}
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Admission {
    pub source_id: Uuid,
    pub key: String,
    pub acknowledgements: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub result_id: Uuid,
    pub source_id: Uuid,
    pub draft_revision: u32,
    pub filename: String,
    pub no_op: bool,
    pub size: u64,
    pub mime: Option<String>,
    pub attempts: u8,
    pub effective_video_bitrate: Option<u64>,
    pub inspection: MediaInspection,
    pub review: Value,
}
enum Bytes {
    Original(Arc<Asset>),
    Encoded {
        directory: PathBuf,
        file: Mutex<Option<File>>,
    },
}
struct Output {
    descriptor: Published,
    bytes: Bytes,
    _root: Arc<tempfile::TempDir>,
}
/// Replacement revokes new lookup, while an already leased result retains its
/// bytes until the reader finishes. Provenance alone never leases source bytes.
pub struct OutputLease(Arc<Output>);
impl OutputLease {
    pub fn descriptor(&self) -> &Published {
        &self.0.descriptor
    }
    pub fn read(&self, offset: u64, count: usize) -> Result<Vec<u8>> {
        if count > crate::media::MAX_RESPONSE_BYTES as usize
            || offset > self.0.descriptor.size
            || count as u64 > self.0.descriptor.size - offset
        {
            return Err(AppError::new(
                "MEDIA_RANGE",
                "The requested media range is invalid.",
            ));
        }
        match &self.0.bytes {
            Bytes::Original(source) => source.read(offset, count),
            Bytes::Encoded { file, .. } => {
                let mut file = file.lock().unwrap();
                let file = file
                    .as_mut()
                    .ok_or_else(|| AppError::new("ASSET_GONE", "This result has been removed."))?;
                let mut bytes = vec![0; count];
                file.seek(SeekFrom::Start(offset))
                    .and_then(|_| file.read_exact(&mut bytes))
                    .map_err(|_| {
                        AppError::new("MEDIA_READ", "Could not read the processed result.")
                    })?;
                Ok(bytes)
            }
        }
    }
}
struct Review {
    plan: ReviewedPlan,
    intent: String,
    revision: u32,
}
#[derive(Default)]
struct Slot {
    review: Option<Review>,
    active: Option<(Uuid, CancellationToken)>,
    output: Option<Arc<Output>>,
}
#[derive(Default)]
struct Registry {
    slots: HashMap<Uuid, Slot>,
    retired: Vec<Arc<Output>>,
    // Attempt directories stay here until deletion or successful publication.
    cleanup: HashMap<PathBuf, Cleanup>,
    closing: bool,
}
struct Cleanup {
    source_id: Uuid,
    // Unpublished attempts retain the input reservation until deletion succeeds.
    // Retiring a published result has provenance only, never an input lease.
    _source: Option<Arc<Asset>>,
    failed: bool,
}
struct State {
    id: Uuid,
    assets: Assets,
    root: Arc<tempfile::TempDir>,
    registry: Mutex<Registry>,
    workers: Supervisor,
    operations: TaskTracker,
    execution: tokio::sync::Mutex<()>,
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    limits: Limits,
    #[cfg(test)]
    hooks: tests::Hooks,
}
#[derive(Clone)]
pub struct Processing(Arc<State>);
/// A single-use, immutable admitted operation. It cannot be deserialized or
/// transferred to a different Processing owner; dropping it cancels admission.
pub struct Prepared {
    owner: Processing,
    source: Arc<Asset>,
    plan: ReviewedPlan,
    revision: u32,
    operation_id: Uuid,
    cancel: CancellationToken,
}
struct Waiter {
    owner: Processing,
    source_id: Uuid,
    operation_id: Uuid,
}
impl Drop for Waiter {
    fn drop(&mut self) {
        // Cancellation and publication share the registry lock. A raw token
        // drop guard could cancel between publication's check and its commit.
        self.owner.cancel(self.source_id, self.operation_id);
    }
}
impl Prepared {
    pub fn source_id(&self) -> Uuid {
        self.source.source.asset_id
    }
    pub fn draft_revision(&self) -> u32 {
        self.revision
    }
    pub fn operation_id(&self) -> Uuid {
        self.operation_id
    }
    pub fn review(&self) -> &ReviewedPlan {
        &self.plan
    }
    fn release_admission(&self) {
        let mut registry = self.owner.0.registry.lock().unwrap();
        if let Some(slot) = registry.slots.get_mut(&self.source.source.asset_id)
            && slot
                .active
                .as_ref()
                .is_some_and(|(id, _)| *id == self.operation_id)
        {
            slot.active = None;
        }
    }
}
impl Drop for Prepared {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.release_admission();
    }
}
impl Processing {
    pub fn new(
        assets: Assets,
        parent: &Path,
        ffmpeg: PathBuf,
        ffprobe: PathBuf,
        limits: Limits,
    ) -> Result<Self> {
        if !ffmpeg.is_absolute()
            || !ffprobe.is_absolute()
            || limits.maximum_bytes == 0
            || limits.maximum_bytes > crate::assets::MAX_SOURCE_BYTES
            || limits.worker_deadline.is_zero()
        {
            return Err(AppError::new(
                "PROCESSING_CONFIGURATION",
                "Explicit tools and bounded processing limits are required.",
            ));
        }
        let root = tempfile::Builder::new()
            .prefix("lvovd-results-")
            .tempdir_in(parent)
            .map_err(|_| {
                AppError::new(
                    "TEMP_DIRECTORY",
                    "Could not create owned processing storage.",
                )
            })?;
        Ok(Self(Arc::new(State {
            id: Uuid::new_v4(),
            assets,
            root: Arc::new(root),
            registry: Mutex::new(Registry::default()),
            workers: Supervisor::default(),
            operations: TaskTracker::new(),
            execution: tokio::sync::Mutex::new(()),
            ffmpeg,
            ffprobe,
            limits,
            #[cfg(test)]
            hooks: tests::Hooks::default(),
        })))
    }
    pub async fn review(
        &self,
        request: ReviewRequest,
        capabilities: Option<Arc<Capabilities>>,
    ) -> Result<ReviewedPlan> {
        let owner = self.clone();
        blocking(move || owner.review_sync(request, capabilities.as_deref())).await
    }
    fn review_sync(
        &self,
        request: ReviewRequest,
        capabilities: Option<&Capabilities>,
    ) -> Result<ReviewedPlan> {
        if request.draft_revision > i32::MAX as u32 {
            return Err(AppError::new(
                "PROCESSING_REQUEST",
                "Invalid draft revision.",
            ));
        }
        let source = self.0.assets.lease(request.source_id)?;
        source.processing_path()?;
        let plan = processing_plan::plan(
            Input {
                workspace_id: Some(&self.0.id.to_string()),
                source_asset_id: Some(&request.source_id.to_string()),
                input_filename: Some(&source.source.name),
                draft_revision: request.draft_revision as f64,
                inspection: source.source.inspection.media.as_ref(),
                settings: request.settings.as_ref(),
                edit_plan: request.edit_plan.as_ref(),
            },
            capabilities,
        )?;
        let intent = processing_plan::hash(
            &serde_json::json!({"settings":plan.document()["settings"], "editPlan":plan.document()["editPlan"], "inspectionKey":plan.document()["inspectionKey"]}),
        );
        let mut registry = self.0.registry.lock().unwrap();
        if registry.closing {
            return Err(cancelled());
        }
        self.0.assets.with_current(&source, || {
            let slot = registry.slots.entry(request.source_id).or_default();
            if slot.review.as_ref().is_some_and(|old| {
                request.draft_revision < old.revision
                    || (request.draft_revision == old.revision && intent != old.intent)
            }) {
                return Err(stale());
            }
            slot.review = Some(Review {
                plan: plan.clone(),
                intent,
                revision: request.draft_revision,
            });
            Ok(plan)
        })?
    }
    pub async fn prepare(
        &self,
        source_id: Uuid,
        key: String,
        acknowledgements: Vec<String>,
    ) -> Result<Prepared> {
        Ok(self
            .prepare_batch(vec![Admission {
                source_id,
                key,
                acknowledgements,
            }])
            .await?
            .pop()
            .unwrap())
    }
    pub async fn prepare_batch(&self, entries: Vec<Admission>) -> Result<Vec<Prepared>> {
        let owner = self.clone();
        blocking(move || owner.prepare_batch_sync(entries)).await
    }
    fn prepare_batch_sync(&self, entries: Vec<Admission>) -> Result<Vec<Prepared>> {
        if entries.is_empty()
            || entries.len() > 20
            || entries.iter().any(|entry| {
                entry.key.len() > 128
                    || entry.acknowledgements.len() > 64
                    || entry.acknowledgements.iter().any(|id| id.len() > 128)
            })
        {
            return Err(AppError::new(
                "PROCESSING_REQUEST",
                "Submit a bounded list of reviewed files.",
            ));
        }
        let mut seen = std::collections::HashSet::new();
        let sources: Vec<_> = entries
            .iter()
            .map(|entry| {
                if !seen.insert(entry.source_id) {
                    return Err(AppError::new(
                        "PROCESSING_REQUEST",
                        "Submit each file only once.",
                    ));
                }
                let source = self.0.assets.lease(entry.source_id)?;
                source.processing_path()?;
                Ok(source)
            })
            .collect::<Result<_>>()?;
        let mut registry = self.0.registry.lock().unwrap();
        if registry.closing {
            return Err(cancelled());
        }
        if registry
            .cleanup
            .values()
            .any(|entry| seen.contains(&entry.source_id))
        {
            return Err(cleanup_pending());
        }
        if registry
            .slots
            .values()
            .filter(|s| s.active.is_some())
            .count()
            + entries.len()
            > 20
        {
            return Err(AppError::new(
                "PROCESSING_QUEUE_FULL",
                "Wait for a queued file to finish before adding another.",
            ));
        }
        self.0.assets.with_current_batch(&sources, || {
            // Validate the whole batch before reserving any slot. Reviews and
            // membership cannot change between this check and its commit.
            for entry in &entries {
                let slot = registry.slots.get(&entry.source_id).ok_or_else(stale)?;
                if slot.active.is_some() {
                    return Err(AppError::new(
                        "PROCESSING_BUSY",
                        "This file already has a queued or running operation.",
                    ));
                }
                let review = slot.review.as_ref().ok_or_else(stale)?;
                review.plan.check_key(&entry.key)?;
                let p = review.plan.document();
                if !review.plan.is_executable() && p["status"] != "no-op" {
                    return Err(AppError::new(
                        "PROCESSING_UNAVAILABLE",
                        p["message"]
                            .as_str()
                            .unwrap_or("This processing plan is unavailable."),
                    ));
                }
                if p["warnings"].as_array().unwrap().iter().any(|w| {
                    w["required"] == true && !entry.acknowledgements.iter().any(|id| w["id"] == *id)
                }) {
                    return Err(AppError::new(
                        "PROCESSING_WARNINGS",
                        "Acknowledge the reviewed omissions before processing.",
                    ));
                }
            }
            Ok(sources
                .iter()
                .map(|source| {
                    let slot = registry.slots.get_mut(&source.source.asset_id).unwrap();
                    let review = slot.review.as_ref().unwrap();
                    let operation_id = Uuid::new_v4();
                    let cancel = source.cancellation().child_token();
                    slot.active = Some((operation_id, cancel.clone()));
                    Prepared {
                        owner: self.clone(),
                        source: source.clone(),
                        plan: review.plan.clone(),
                        revision: review.revision,
                        operation_id,
                        cancel,
                    }
                })
                .collect())
        })?
    }
    pub fn cancel(&self, source_id: Uuid, operation_id: Uuid) -> bool {
        let registry = self.0.registry.lock().unwrap();
        if let Some((id, cancel)) = registry
            .slots
            .get(&source_id)
            .and_then(|s| s.active.as_ref())
            && *id == operation_id
        {
            cancel.cancel();
            true
        } else {
            false
        }
    }
    pub async fn run(
        &self,
        prepared: Prepared,
        progress: tokio::sync::watch::Sender<Progress>,
    ) -> Outcome<Published> {
        if !Arc::ptr_eq(&self.0, &prepared.owner.0) {
            return Err(stale().into());
        }
        let _cancel_on_drop = Waiter {
            owner: self.clone(),
            source_id: prepared.source.source.asset_id,
            operation_id: prepared.operation_id,
        };
        let owner = self.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        {
            let registry = self.0.registry.lock().unwrap();
            if registry.closing {
                return Err(cancelled().into());
            }
            self.0.operations.spawn(async move {
                let execution = tokio::select! {
                    biased;
                    _ = prepared.cancel.cancelled() => None,
                    guard = owner.0.execution.lock() => Some(guard),
                };
                let result = if execution.is_some() {
                    owner.perform(&prepared, progress).await
                } else {
                    Err(cancelled().into())
                };
                // All workers/probes have confirmed exit before cleanup or
                // releasing the admitted source. A departed UI cannot abort it.
                prepared.release_admission();
                let cleanup_owner = owner.clone();
                let _ = blocking(move || cleanup_owner.cleanup_sync(false)).await;
                #[cfg(test)]
                owner.0.hooks.before_retirement().await;
                drop(prepared);
                drop(execution);
                let _ = send.send(result);
            });
        }
        receive.await.map_err(|_| {
            AppError::new(
                "PROCESSING_FAILED",
                "Processing supervision ended unexpectedly.",
            )
        })?
    }
    async fn perform(
        &self,
        job: &Prepared,
        progress: tokio::sync::watch::Sender<Progress>,
    ) -> Outcome<Published> {
        self.check(job).await?;
        if job.plan.document()["status"] == "no-op" {
            return Ok(self.publish(
                job,
                Bytes::Original(job.source.clone()),
                job.source.source.size,
                job.source
                    .source
                    .inspection
                    .media
                    .clone()
                    .ok_or_else(stale)?,
                0,
                None,
            )?);
        }
        let mut size = SizeControl::new(&job.plan)?;
        let mut bitrate = job.plan.document()["rateBudget"]["videoBitrate"]
            .as_f64()
            .map(|rate| rate as u64);
        let mut attempts = 0;
        loop {
            self.check(job).await?;
            attempts += 1;
            let owner = self.clone();
            let source_id = job.source.source.asset_id;
            let source = job.source.clone();
            let directory = blocking(move || {
                let directory = owner.0.root.path().join(Uuid::new_v4().to_string());
                std::fs::create_dir(&directory).map_err(|_| {
                    AppError::new("PROCESSING_STORAGE", "Could not create processing storage.")
                })?;
                owner.0.registry.lock().unwrap().cleanup.insert(
                    directory.clone(),
                    Cleanup {
                        source_id,
                        _source: Some(source),
                        failed: false,
                    },
                );
                Ok(directory)
            })
            .await?;
            let extension = job.plan.document()["output"]["extension"]
                .as_str()
                .ok_or_else(stale)?;
            if extension.is_empty() || !extension.bytes().all(|c| c.is_ascii_alphanumeric()) {
                return Err(stale().into());
            }
            let output = directory.join(format!("result.{extension}"));
            let pass_log = directory.join("pass");
            let passes = job.plan.document()["passes"].as_u64().unwrap_or(1);
            for pass in 1..=passes {
                self.check(job).await?;
                let args = processing_command::arguments(
                    job.source.processing_path()?,
                    &output,
                    job.source
                        .source
                        .inspection
                        .media
                        .as_ref()
                        .ok_or_else(stale)?,
                    &job.plan,
                    Attempt {
                        pass: (passes == 2).then_some(pass as u8),
                        pass_log_prefix: Some(&pass_log),
                        video_bitrate: bitrate,
                        ..Default::default()
                    },
                )?;
                self.0
                    .workers
                    .run_processing_owned(
                        process::Request {
                            executable: &self.0.ffmpeg,
                            args: &args,
                            deadline: self.0.limits.worker_deadline,
                            diagnostic_limit: 4 * 1024 * 1024,
                            cancel: &job.cancel,
                        },
                        progress.clone(),
                        (job.source.clone(), self.0.root.clone()),
                    )
                    .await?;
            }
            self.check(job).await?;
            #[cfg(test)]
            self.0.hooks.after_encode(&output).await;
            let path = output.clone();
            let (seal, metadata) = blocking(move || {
                Ok((
                    Seal::capture(&path).map_err(|_| invalid_output())?,
                    std::fs::symlink_metadata(path).map_err(|_| invalid_output())?,
                ))
            })
            .await?;
            // Reject unsafe output before starting another native reader.
            if metadata.len() == 0 || metadata.len() >= self.0.limits.maximum_bytes {
                size.assess(&metadata, self.0.limits.maximum_bytes)?;
            }
            let actual = inspection::inspect(&self.0.ffprobe, &output, &job.cancel)
                .await?
                .media
                .ok_or_else(stale)?;
            self.check(job).await?;
            seal.check(&output).map_err(|_| invalid_output())?;
            processing_command::validate(&actual, &job.plan)?;
            match size.assess(&metadata, self.0.limits.maximum_bytes)? {
                SizeDecision::CorrectVideoBitrate(next) => {
                    // A failed deletion blocks correction. Keep the same size
                    // controller so a new attempt cannot reset its retry budget.
                    let owner = self.clone();
                    blocking(move || owner.remove_attempt(&directory, false)).await?;
                    bitrate = Some(next);
                }
                SizeDecision::Accept => {
                    let directory_for_cleanup = directory.clone();
                    let file = blocking(move || {
                        // Pass logs are attempt data, not part of a ready result.
                        let entries = std::fs::read_dir(&directory_for_cleanup)
                            .map_err(|_| cleanup_pending())?;
                        for (index, entry) in entries.enumerate() {
                            if index >= 1024 {
                                return Err(cleanup_pending());
                            }
                            let path = entry.map_err(|_| cleanup_pending())?.path();
                            if path != output {
                                std::fs::remove_file(path).map_err(|_| cleanup_pending())?;
                            }
                        }
                        let file = File::open(&output).map_err(|_| {
                            AppError::new(
                                "PROCESSING_OUTPUT",
                                "Could not open the validated result.",
                            )
                        })?;
                        seal.check(&output).map_err(|_| invalid_output())?;
                        Ok(file)
                    })
                    .await?;
                    return Ok(self.publish(
                        job,
                        Bytes::Encoded {
                            directory,
                            file: Mutex::new(Some(file)),
                        },
                        metadata.len(),
                        actual,
                        attempts,
                        bitrate,
                    )?);
                }
            }
        }
    }
    async fn check(&self, job: &Prepared) -> Result<()> {
        if job.cancel.is_cancelled() {
            return Err(cancelled());
        }
        let source = job.source.clone();
        blocking(move || source.processing_path().map(|_| ())).await?;
        self.0.assets.with_current(&job.source, || ())?;
        if job.cancel.is_cancelled() {
            return Err(cancelled());
        }
        Ok(())
    }
    fn publish(
        &self,
        job: &Prepared,
        bytes: Bytes,
        size: u64,
        inspection: MediaInspection,
        attempts: u8,
        effective_video_bitrate: Option<u64>,
    ) -> Result<Published> {
        let mut registry = self.0.registry.lock().unwrap();
        if registry.closing
            || job.cancel.is_cancelled()
            || !registry
                .slots
                .get(&job.source.source.asset_id)
                .and_then(|s| s.active.as_ref())
                .is_some_and(|(id, _)| *id == job.operation_id)
        {
            return Err(cancelled());
        }
        self.0.assets.with_current(&job.source, || {
            let descriptor = Published {
                result_id: Uuid::new_v4(),
                source_id: job.source.source.asset_id,
                draft_revision: job.revision,
                filename: job.plan.document()["downloadFilename"]
                    .as_str()
                    .unwrap_or(&job.source.source.name)
                    .into(),
                no_op: matches!(bytes, Bytes::Original(_)),
                size,
                mime: if matches!(bytes, Bytes::Original(_)) {
                    job.source.source.inspection.mime.clone()
                } else {
                    job.plan.document()["output"]["mime"]
                        .as_str()
                        .map(String::from)
                },
                attempts,
                effective_video_bitrate,
                inspection,
                review: job.plan.public_document(),
            };
            if let Bytes::Encoded { directory, .. } = &bytes {
                registry.cleanup.remove(directory);
            }
            let output = Arc::new(Output {
                descriptor: descriptor.clone(),
                bytes,
                _root: self.0.root.clone(),
            });
            if let Some(previous) = registry
                .slots
                .get_mut(&descriptor.source_id)
                .unwrap()
                .output
                .replace(output)
            {
                registry.retired.push(previous);
            }
            descriptor
        })
    }
    pub fn latest(&self, source_id: Uuid) -> Option<Published> {
        let registry = self.0.registry.lock().unwrap();
        if registry.closing {
            return None;
        }
        let source = self.0.assets.lease(source_id).ok()?;
        self.0
            .assets
            .with_current(&source, || {
                registry
                    .slots
                    .get(&source_id)?
                    .output
                    .as_ref()
                    .map(|o| o.descriptor.clone())
            })
            .ok()
            .flatten()
    }
    pub fn lease(&self, result_id: Uuid) -> Result<OutputLease> {
        let registry = self.0.registry.lock().unwrap();
        if registry.closing {
            return Err(cancelled());
        }
        let output = registry
            .slots
            .values()
            .filter_map(|s| s.output.as_ref())
            .find(|o| o.descriptor.result_id == result_id)
            .ok_or_else(|| {
                AppError::new("ASSET_GONE", "This result has expired or been replaced.")
            })?;
        let source = self.0.assets.lease(output.descriptor.source_id)?;
        self.0
            .assets
            .with_current(&source, || OutputLease(output.clone()))
    }
    fn remove_attempt(&self, directory: &Path, retry_failed: bool) -> Result<()> {
        // Only internally allocated direct children are ever removed.
        if directory.parent() != Some(self.0.root.path())
            || !self
                .0
                .registry
                .lock()
                .unwrap()
                .cleanup
                .contains_key(directory)
        {
            return Err(cleanup_pending());
        }
        if !retry_failed
            && self
                .0
                .registry
                .lock()
                .unwrap()
                .cleanup
                .get(directory)
                .is_some_and(|entry| entry.failed)
        {
            return Err(cleanup_pending());
        }
        #[cfg(test)]
        let inject_failure = self
            .0
            .hooks
            .fail_cleanup
            .load(std::sync::atomic::Ordering::Acquire);
        #[cfg(not(test))]
        let inject_failure = false;
        let deletion = if inject_failure {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        } else {
            std::fs::remove_dir_all(directory)
        };
        match deletion {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                if let Some(entry) = self.0.registry.lock().unwrap().cleanup.get_mut(directory) {
                    entry.failed = true;
                }
                return Err(cleanup_pending());
            }
        }
        self.0.registry.lock().unwrap().cleanup.remove(directory);
        Ok(())
    }
    pub async fn cleanup(&self) -> Result<()> {
        let owner = self.clone();
        blocking(move || owner.cleanup_sync(true)).await
    }
    pub(crate) async fn reconcile_cleanup(&self) -> Result<()> {
        let owner = self.clone();
        blocking(move || owner.cleanup_sync(false)).await
    }
    fn cleanup_sync(&self, retry_failed: bool) -> Result<()> {
        let mut registry = self.0.registry.lock().unwrap();
        let closing = registry.closing;
        let mut discarded = Vec::new();
        registry.slots.retain(|id, slot| {
            if closing || self.0.assets.lease(*id).is_err() {
                if let Some(output) = slot.output.take() {
                    discarded.push(output);
                }
                slot.active.is_some()
            } else {
                true
            }
        });
        registry.retired.extend(discarded);
        let retired = std::mem::take(&mut registry.retired);
        for output in retired {
            if Arc::strong_count(&output) > 1 {
                registry.retired.push(output);
                continue;
            }
            if let Bytes::Encoded { directory, file } = &output.bytes {
                file.lock().unwrap().take();
                // Failed deletion remains owned and blocks that source's next
                // admission. An active reader alone does not block admission.
                registry.cleanup.insert(
                    directory.clone(),
                    Cleanup {
                        source_id: output.descriptor.source_id,
                        _source: None,
                        failed: false,
                    },
                );
            }
        }
        let directories: Vec<_> = registry
            .cleanup
            .iter()
            .filter(|(_, entry)| {
                !registry
                    .slots
                    .get(&entry.source_id)
                    .is_some_and(|slot| slot.active.is_some())
            })
            .map(|(path, _)| path.clone())
            .collect();
        drop(registry);
        let mut failed = false;
        for directory in directories {
            if self.remove_attempt(&directory, retry_failed).is_err() {
                failed = true;
            }
        }
        if failed {
            Err(cleanup_pending())
        } else {
            Ok(())
        }
    }
    pub fn pending_cleanup(&self) -> usize {
        let registry = self.0.registry.lock().unwrap();
        registry.cleanup.len() + registry.retired.len()
    }
    /// Retired workbench membership cannot release its reservation while a
    /// worker, published output lease, or failed deletion still owns the source.
    pub fn retains_source(&self, id: Uuid) -> bool {
        let registry = self.0.registry.lock().unwrap();
        registry.slots.contains_key(&id)
            || registry
                .retired
                .iter()
                .any(|output| output.descriptor.source_id == id)
            || registry.cleanup.values().any(|entry| entry.source_id == id)
    }
    pub async fn shutdown(&self) -> Result<()> {
        {
            let mut registry = self.0.registry.lock().unwrap();
            registry.closing = true;
            for (_, cancel) in registry.slots.values().filter_map(|s| s.active.as_ref()) {
                cancel.cancel();
            }
            self.0.operations.close();
        }
        self.0.workers.shutdown().await?;
        tokio::time::timeout(Duration::from_secs(5), self.0.operations.wait())
            .await
            .map_err(|_| cleanup_pending())?;
        self.cleanup().await?;
        if self.pending_cleanup() != 0
            || self
                .0
                .registry
                .lock()
                .unwrap()
                .slots
                .values()
                .any(|s| s.active.is_some())
        {
            return Err(cleanup_pending());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests;
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| AppError::new("PROCESSING_STORAGE", "Owned media storage is unavailable."))?
}
