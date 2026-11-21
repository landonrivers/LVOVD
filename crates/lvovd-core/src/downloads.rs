//! Rust owns the reviewed source, worker, temporary result and saved-file receipt.
mod artwork;
mod provider;
#[cfg(test)]
mod tests;

use crate::{
    AppError, Result, export, inspection,
    owned_file::Seal,
    process::{CancellationToken, Request, Supervisor},
    tools::Tools,
};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio::sync::{OnceCell, Semaphore, watch};
use tokio_util::task::TaskTracker;
use url::Url;
use uuid::Uuid;

const TTL: Duration = Duration::from_secs(60 * 60);
const CACHE_SIZE: usize = 32;
// This first native queue sends complete snapshots. Keep saved receipts and
// failed-save bytes reachable; never evict another job to admit a new one.
const SNAPSHOT_ROWS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Profile {
    Compatible,
    Maximum,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPreview {
    pub preview_id: Uuid,
    pub title: String,
    pub source: String,
    pub filename: String,
    pub duration: Option<f64>,
    pub profile: Profile,
    pub can_download: bool,
    pub message: Option<String>,
    pub artwork: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub percent: Option<f64>,
    pub speed: Option<f64>,
    pub eta: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Processing,
    Saving,
    Saved,
    SaveFailed,
    Failed,
    Cancelling,
    Cancelled,
}
use DownloadStatus::*;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub job_id: Uuid,
    pub title: String,
    pub filename: String,
    pub destination: String,
    pub status: DownloadStatus,
    pub progress: Option<DownloadProgress>,
    pub error: Option<String>,
    pub saved_name: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSnapshot {
    pub revision: u64,
    pub jobs: Vec<DownloadJob>,
}

struct Reviewed {
    preview: DownloadPreview,
    url: Url,
    time: Instant,
}
struct Prepared {
    _directory: Arc<TempDir>,
    path: PathBuf,
    seal: Seal,
}
struct Job {
    view: DownloadJob,
    url: Url,
    profile: Profile,
    destination: PathBuf,
    directory_id: (u64, u64),
    cancel: CancellationToken,
    prepared: Option<Arc<Prepared>>,
    exported: Option<(PathBuf, Seal)>,
    updated: Instant,
}
type PreviewCell = Arc<OnceCell<Result<DownloadPreview>>>;
struct PreviewWaiter<'a> {
    owner: &'a Downloads,
    url: &'a Url,
    cell: PreviewCell,
}
impl Drop for PreviewWaiter<'_> {
    fn drop(&mut self) {
        let mut state = self.owner.state.lock().unwrap();
        if state
            .pending
            .get(self.url)
            .is_some_and(|c| Arc::ptr_eq(c, &self.cell))
            && (self.cell.initialized() || Arc::strong_count(&self.cell) == 2)
        {
            state.pending.remove(self.url);
        }
    }
}
#[derive(Default)]
struct State {
    revision: u64,
    jobs: Vec<Job>,
    reviews: VecDeque<Reviewed>,
    pending: HashMap<Url, PreviewCell>,
    worker: bool,
    closing: bool,
}

pub struct Downloads {
    state: Mutex<State>,
    tools: Tools,
    root: TempDir,
    source: Arc<Semaphore>,
    supervisor: Supervisor,
    channel: watch::Sender<DownloadSnapshot>,
    cancel: CancellationToken,
    tasks: TaskTracker,
}

fn closed() -> AppError {
    AppError::new("DOWNLOAD_CLOSING", "The application is closing.")
}
fn missing() -> AppError {
    AppError::new("DOWNLOAD_GONE", "This download is no longer available.")
}
fn cancelled() -> AppError {
    AppError::new("CANCELLED", "Download cancelled.")
}
fn directory_error() -> AppError {
    AppError::new(
        "DOWNLOAD_STORAGE",
        "Could not create a temporary download folder. Check available storage.",
    )
}
pub(crate) fn provider_error(stderr: &[u8]) -> AppError {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    let (code, message) = if text.contains("429") || text.contains("rate limit") {
        (
            "PROVIDER_LIMIT",
            "The source is limiting requests. Wait before trying Preview again.",
        )
    } else if text.contains("private")
        || text.contains("sign in")
        || text.contains("403")
        || text.contains("drm")
        || text.contains("login")
    {
        (
            "PROVIDER_ACCESS",
            "The source denied access. Check the URL and whether the media is publicly available.",
        )
    } else if text.contains("requested format") {
        (
            "PROVIDER_FORMAT",
            "The reviewed format is no longer available. Preview this URL again.",
        )
    } else if text.contains("unsupported url")
        || text.contains("404")
        || text.contains("unavailable")
    {
        (
            "PROVIDER_UNAVAILABLE",
            "The provider could not find supported media at this URL. Check the link.",
        )
    } else if text.contains("no space left") || text.contains("disk full") {
        (
            "DOWNLOAD_STORAGE",
            "Temporary storage is full. Free space before starting another download.",
        )
    } else if text.contains("timed out")
        || text.contains("unable to download")
        || text.contains("connection refused")
    {
        (
            "PROVIDER_NETWORK",
            "Could not reach the source. Check the connection and try Preview again.",
        )
    } else {
        (
            "PROVIDER_FAILED",
            "The provider could not complete this request. Check Runtime status or try Preview again.",
        )
    };
    AppError::new(code, message)
}
fn destination_id(path: &Path) -> Result<(u64, u64)> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(AppError::new(
            "DESTINATION_UNAVAILABLE",
            "Choose an available output folder.",
        ));
    }
    crate::owned_file::directory_identity(path).map_err(|_| {
        AppError::new(
            "DESTINATION_UNAVAILABLE",
            "Choose an available output folder.",
        )
    })
}

impl Downloads {
    pub fn new(parent: &Path, tools: Tools) -> Result<Arc<Self>> {
        std::fs::create_dir_all(parent).map_err(|_| directory_error())?;
        let root = tempfile::Builder::new()
            .prefix("downloads-")
            .tempdir_in(parent)
            .map_err(|_| directory_error())?;
        Ok(Arc::new(Self {
            state: Default::default(),
            tools,
            root,
            source: Arc::new(Semaphore::new(1)),
            supervisor: Default::default(),
            channel: watch::channel(DownloadSnapshot::default()).0,
            cancel: Default::default(),
            tasks: TaskTracker::new(),
        }))
    }
    pub fn snapshot(&self) -> DownloadSnapshot {
        self.channel.borrow().clone()
    }
    pub fn subscribe(&self) -> watch::Receiver<DownloadSnapshot> {
        self.channel.subscribe()
    }
    fn publish(&self, state: &mut State) -> DownloadSnapshot {
        state.revision += 1;
        let snapshot = DownloadSnapshot {
            revision: state.revision,
            jobs: state.jobs.iter().map(|j| j.view.clone()).collect(),
        };
        self.channel.send_replace(snapshot.clone());
        snapshot
    }
    pub fn needs_quit_confirmation(&self) -> bool {
        let state = self.state.lock().unwrap();
        !state.pending.is_empty()
            || state
                .jobs
                .iter()
                .any(|j| !matches!(j.view.status, Saved | Failed | Cancelled))
    }
    pub async fn preview(&self, url: String) -> Result<DownloadPreview> {
        let url = provider::validate_url(&url)?;
        let cell = {
            let mut state = self.state.lock().unwrap();
            if state.closing {
                return Err(closed());
            }
            if state.pending.len() >= CACHE_SIZE && !state.pending.contains_key(&url) {
                return Err(AppError::new(
                    "PREVIEW_BUSY",
                    "Wait for the current previews to finish.",
                ));
            }
            state.pending.entry(url.clone()).or_default().clone()
        };
        let waiter = PreviewWaiter {
            owner: self,
            url: &url,
            cell,
        };
        waiter
            .cell
            .get_or_init(|| async {
                let permit = tokio::select! {
                    biased;
                    _ = self.cancel.cancelled() => return Err(closed()),
                    result = self.source.clone().acquire_owned() => result.map_err(|_|closed())?,
                };
                let args = provider::preview_args(&self.tools, &url)?;
                let output = self
                    .supervisor
                    .run_provider_owned(
                        Request {
                            executable: &self.tools.ytdlp,
                            args: &args,
                            deadline: Duration::from_secs(120),
                            diagnostic_limit: 20 * 1024 * 1024,
                            cancel: &self.cancel,
                        },
                        permit,
                    )
                    .await?;
                let (mut view, candidate) = provider::metadata(&output.stdout, &url)?;
                if let Some(candidate) = candidate {
                    view.artwork = tokio::select! {
                        biased;
                        _ = self.cancel.cancelled() => return Err(closed()),
                        image = artwork::fetch(&candidate, url.as_str()) => image,
                    };
                }
                let mut state = self.state.lock().unwrap();
                if state.closing {
                    return Err(closed());
                }
                state.reviews.retain(|r| r.time.elapsed() < TTL);
                if state.reviews.len() == CACHE_SIZE {
                    state.reviews.pop_front();
                }
                state.reviews.push_back(Reviewed {
                    url: url.clone(),
                    preview: view.clone(),
                    time: Instant::now(),
                });
                Ok(view)
            })
            .await
            .clone()
    }
    pub fn enqueue(
        self: &Arc<Self>,
        preview_id: Uuid,
        destination: PathBuf,
    ) -> Result<DownloadSnapshot> {
        let directory_id = destination_id(&destination)?;
        let mut state = self.state.lock().unwrap();
        if state.closing {
            return Err(closed());
        }
        let review = state
            .reviews
            .iter()
            .find(|r| r.preview.preview_id == preview_id && r.time.elapsed() < TTL)
            .ok_or_else(|| {
                AppError::new(
                    "PREVIEW_EXPIRED",
                    "Preview this URL again before downloading.",
                )
            })?;
        if !review.preview.can_download {
            return Err(AppError::new(
                "DOWNLOAD_UNAVAILABLE",
                review.preview.message.clone().unwrap_or_default(),
            ));
        }
        if state.jobs.len() >= SNAPSHOT_ROWS {
            return Err(AppError::new(
                "DOWNLOAD_QUEUE_FULL",
                "This build can display 256 recent downloads. Finish pending saves and wait for completed entries to expire, or restart after saving.",
            ));
        }
        let job = Job {
            view: DownloadJob {
                job_id: Uuid::new_v4(),
                title: review.preview.title.clone(),
                filename: review.preview.filename.clone(),
                destination: destination.display().to_string(),
                status: Queued,
                progress: None,
                error: None,
                saved_name: None,
            },
            url: review.url.clone(),
            profile: review.preview.profile,
            destination,
            directory_id,
            cancel: self.cancel.child_token(),
            prepared: None,
            exported: None,
            updated: Instant::now(),
        };
        state.jobs.push(job);
        if !state.worker {
            state.worker = true;
            self.tasks.spawn(self.clone().work());
        }
        Ok(self.publish(&mut state))
    }
    fn update(&self, id: Uuid, update: impl FnOnce(&mut Job)) {
        let mut state = self.state.lock().unwrap();
        if let Some(job) = state.jobs.iter_mut().find(|j| j.view.job_id == id) {
            update(job);
            job.updated = Instant::now();
            self.publish(&mut state);
        }
    }
    async fn work(self: Arc<Self>) {
        loop {
            let (id, url, profile, cancel) = {
                let mut state = self.state.lock().unwrap();
                let next = state.jobs.iter().find(|j| j.view.status == Queued);
                let Some(j) = next.filter(|_| !state.closing) else {
                    state.worker = false;
                    break;
                };
                (j.view.job_id, j.url.clone(), j.profile, j.cancel.clone())
            };
            let prepared = self.acquire(id, url, profile, &cancel).await;
            match prepared {
                Ok(result) if !cancel.is_cancelled() => {
                    let to_save = {
                        let mut state = self.state.lock().unwrap();
                        let job = state.jobs.iter_mut().find(|j| j.view.job_id == id).unwrap();
                        let target = if job.cancel.is_cancelled() {
                            job.view.status = Cancelled;
                            None
                        } else {
                            job.view.status = Saving;
                            let result = Arc::new(result);
                            job.prepared = Some(result.clone());
                            Some((
                                result,
                                job.destination.join(&job.view.filename),
                                job.directory_id,
                            ))
                        };
                        self.publish(&mut state);
                        target
                    };
                    if let Some((result, destination, directory_id)) = to_save {
                        self.save(id, result, destination, directory_id).await;
                    }
                }
                outcome => self.update(id, |j| {
                    if cancel.is_cancelled() {
                        j.view.status = Cancelled;
                    } else if let Err(err) = outcome {
                        j.view.status = Failed;
                        j.view.error = Some(err.message);
                    }
                }),
            }
            self.expire_later(id);
        }
    }
    async fn acquire(
        self: &Arc<Self>,
        id: Uuid,
        url: Url,
        profile: Profile,
        cancel: &CancellationToken,
    ) -> Result<Prepared> {
        let permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(cancelled()),
            result = self.source.clone().acquire_owned() => result.map_err(|_|closed())?,
        };
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        self.update(id, |j| {
            if j.view.status == Queued {
                j.view.status = Downloading;
            }
        });
        let dir = Arc::new(
            tempfile::Builder::new()
                .prefix("job-")
                .tempdir_in(self.root.path())
                .map_err(|_| directory_error())?,
        );
        let args = provider::acquire_args(&self.tools, &url, profile, dir.path())?;
        let manager = self.clone();
        let mut lines = provider::ProgressLines::default();
        self.supervisor
            .run_provider_stream_owned(
                Request {
                    executable: &self.tools.ytdlp,
                    args: &args,
                    deadline: Duration::from_secs(86400),
                    diagnostic_limit: 256 * 1024,
                    cancel,
                },
                move |bytes| {
                    lines.feed(bytes, |progress| {
                        manager.update(id, |j| {
                            if matches!(j.view.status, Downloading | Processing) {
                                j.view.status = if progress.is_some() {
                                    Downloading
                                } else {
                                    Processing
                                };
                                if progress.is_some() {
                                    j.view.progress = progress;
                                }
                            }
                        });
                    })
                },
                (permit, dir.clone()),
            )
            .await?;
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        self.update(id, |j| {
            if j.view.status == Downloading {
                j.view.status = Processing;
            }
        });
        let path = dir.path().join("media.mp4");
        let invalid = || {
            AppError::new(
                "DOWNLOAD_OUTPUT",
                "The download did not produce a valid Video + Audio MP4. Preview the source again.",
            )
        };
        let seal = Seal::capture(&path).map_err(|_| invalid())?;
        let media = inspection::inspect(&self.tools.ffprobe, &path, cancel).await?;
        let media = media.media.ok_or_else(invalid)?;
        // An attached cover picture is not the requested video, and the MOV
        // family demuxer name alone does not identify the MP4 container.
        let tracks = media.video.zip(media.audio).ok_or_else(invalid)?;
        if media.container.kind != "mp4"
            || (profile == Profile::Compatible
                && (tracks.0.codec.as_deref() != Some("h264")
                    || tracks.1.codec.as_deref() != Some("aac")))
        {
            return Err(invalid());
        }
        seal.check(&path)?;
        Ok(Prepared {
            _directory: dir,
            path,
            seal,
        })
    }
    async fn save(
        &self,
        id: Uuid,
        result: Arc<Prepared>,
        target: PathBuf,
        directory_id: (u64, u64),
    ) {
        let receipt = tokio::task::spawn_blocking(move || {
            export::save_download(&result.path, &result.seal, &target, || {
                if target.parent().and_then(|p| destination_id(p).ok()) != Some(directory_id) {
                    return Err(AppError::new("DESTINATION_CHANGED", "The output folder changed or disconnected. Choose a folder and retry saving."));
                }
                Ok(())
            })
        })
        .await
        .map_err(|_| {
            AppError::new(
                "SAVE_FAILED",
                "Saving was interrupted. Retry saving the prepared file.",
            )
        })
        .and_then(|r| r);
        self.update(id, |j| match receipt {
            Ok((path, seal)) => {
                j.view.saved_name = path.file_name().map(|s| s.to_string_lossy().into_owned());
                j.exported = Some((path, seal));
                j.prepared = None;
                j.view.status = Saved;
                j.view.error = None;
            }
            Err(err) => {
                j.view.status = SaveFailed;
                j.view.error = Some(err.message);
            }
        });
    }
    pub fn retry_save(
        self: &Arc<Self>,
        job_id: Uuid,
        destination: PathBuf,
    ) -> Result<DownloadSnapshot> {
        let directory_id = destination_id(&destination)?;
        let mut state = self.state.lock().unwrap();
        if state.closing {
            return Err(closed());
        }
        let job = state
            .jobs
            .iter_mut()
            .find(|j| j.view.job_id == job_id)
            .ok_or_else(missing)?;
        let result = job
            .prepared
            .clone()
            .filter(|_| job.view.status == SaveFailed)
            .ok_or_else(|| AppError::new("SAVE_STATE", "There is no failed save to retry."))?;
        job.destination = destination;
        job.directory_id = directory_id;
        job.view.destination = job.destination.display().to_string();
        job.view.status = Saving;
        job.view.error = None;
        let target = job.destination.join(&job.view.filename);
        let manager = self.clone();
        self.tasks.spawn(async move {
            manager.save(job_id, result, target, directory_id).await;
            manager.expire_later(job_id);
        });
        Ok(self.publish(&mut state))
    }
    pub fn cancel(self: &Arc<Self>, job_id: Uuid) -> Result<DownloadSnapshot> {
        let mut state = self.state.lock().unwrap();
        let j = state
            .jobs
            .iter_mut()
            .find(|j| j.view.job_id == job_id)
            .ok_or_else(missing)?;
        match j.view.status {
            Queued => {
                j.cancel.cancel();
                j.view.status = Cancelled;
                self.expire_later(job_id);
            }
            Downloading | Processing | Cancelling => {
                j.cancel.cancel();
                j.view.status = Cancelling;
            }
            _ => {
                return Err(AppError::new(
                    "DOWNLOAD_STATE",
                    "This download has already finished acquiring media.",
                ));
            }
        }
        j.updated = Instant::now();
        Ok(self.publish(&mut state))
    }
    pub fn exported_path(&self, job_id: Uuid) -> Result<PathBuf> {
        let state = self.state.lock().unwrap();
        let (path, seal) = state
            .jobs
            .iter()
            .find(|j| j.view.job_id == job_id)
            .and_then(|j| j.exported.as_ref())
            .ok_or_else(missing)?;
        seal.check(path).map_err(|_| {
            AppError::new(
                "EXPORT_CHANGED",
                "The saved file was moved, replaced or removed.",
            )
        })?;
        Ok(path.clone())
    }
    fn expire_later(self: &Arc<Self>, id: Uuid) {
        let manager = Arc::downgrade(self);
        let closing = self.cancel.clone();
        self.tasks.spawn(async move {
            tokio::select! { _=closing.cancelled()=>return, _=tokio::time::sleep(TTL)=>{} }
            let Some(manager) = manager.upgrade() else {
                return;
            };
            let mut state = manager.state.lock().unwrap();
            let count = state.jobs.len();
            state.jobs.retain(|j| {
                !(j.view.job_id == id
                    && matches!(j.view.status, Saved | Failed | Cancelled)
                    && j.updated.elapsed() >= TTL)
            });
            if state.jobs.len() != count {
                manager.publish(&mut state);
            }
        });
    }
    pub async fn shutdown(&self) -> Result<()> {
        {
            let mut state = self.state.lock().unwrap();
            state.closing = true;
            self.cancel.cancel();
            self.tasks.close();
        }
        self.supervisor.shutdown().await?;
        tokio::time::timeout(Duration::from_secs(5),self.tasks.wait()).await.map_err(|_| AppError::new("DOWNLOAD_CLOSING","Waiting for the download worker or destination write to finish. Try closing again."))?;
        {
            let mut state = self.state.lock().unwrap();
            state.jobs.clear();
            state.reviews.clear();
            state.pending.clear();
            self.publish(&mut state);
        }
        // TempDir also cleans up on drop. Explicitly check the private session
        // here so a locked partial download cannot silently survive shutdown.
        match tokio::fs::remove_dir_all(self.root.path()).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(AppError::new(
                "DOWNLOAD_CLEANUP",
                "Temporary download files are still in use. Close programs using them and retry closing.",
            )),
        }
    }
}
