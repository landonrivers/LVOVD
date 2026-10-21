//! Source-owned playback preparation and bounded waveform tasks. Foreground
//! admission waits for the analysis worker and its process tree to retire.
use crate::{
    AppError, Result,
    assets::{Asset, Assets},
    audio_policy::{self, AudioSource, Timeline},
    capabilities::CapabilityDiscovery,
    inspection,
    media::{Library, Reader},
    media_inspection::MediaInspection,
    process::{CancellationToken, Request, Supervisor},
    waveform::Peaks,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::task::TaskTracker;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Hash, Eq, PartialEq)]
pub enum Kind {
    Preview,
    Waveform,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub status: &'static str,
    pub operation_id: Option<Uuid>,
    pub source_asset_id: Uuid,
    pub message: Option<String>,
    pub asset_id: Option<Uuid>,
    pub proxy: bool,
}
struct Task {
    state: State,
    cancel: CancellationToken,
    source: Arc<Asset>,
    peaks: Option<Arc<Mutex<Peaks>>>,
    running: bool,
}
pub struct Proxy {
    id: Uuid,
    source: Arc<Asset>,
    size: u64,
    mime: &'static str,
    file: Mutex<Option<File>>,
    directory: PathBuf,
    _root: Arc<tempfile::TempDir>,
}
impl Reader for Proxy {
    fn size(&self) -> u64 {
        self.size
    }
    fn mime(&self) -> Option<&str> {
        Some(self.mime)
    }
    fn cancellation(&self) -> CancellationToken {
        self.source.cancellation()
    }
    fn read(&self, offset: u64, count: usize) -> Result<Vec<u8>> {
        if self.cancellation().is_cancelled()
            || count as u64 > crate::media::MAX_RESPONSE_BYTES
            || offset > self.size
            || count as u64 > self.size - offset
        {
            return Err(gone());
        }
        let mut file = self.file.lock().unwrap();
        let file = file.as_mut().ok_or_else(gone)?;
        let mut bytes = vec![0; count];
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| file.read_exact(&mut bytes))
            .map_err(|_| gone())?;
        if self.cancellation().is_cancelled() {
            return Err(gone());
        }
        Ok(bytes)
    }
}
struct Cleanup {
    directory: PathBuf,
    source: Arc<Asset>,
    failed: bool,
    retry: crate::cleanup_retry::Retry,
}
#[derive(Default)]
struct Registry {
    tasks: HashMap<(Uuid, Kind), Task>,
    proxies: HashMap<Uuid, Arc<Proxy>>,
    retired: Vec<Arc<Proxy>>,
    cleanup: Vec<Cleanup>,
    revision: u64,
    foreground: usize,
    processing: bool,
    closing: bool,
}
struct Inner {
    assets: Assets,
    root: Arc<tempfile::TempDir>,
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    capabilities: CapabilityDiscovery,
    registry: Mutex<Registry>,
    worker: tokio::sync::Mutex<()>,
    supervisor: Supervisor,
    tasks: TaskTracker,
}
#[derive(Clone)]
pub struct Analysis(Arc<Inner>);
pub struct Foreground(Analysis);
impl Drop for Foreground {
    fn drop(&mut self) {
        self.0.0.registry.lock().unwrap().foreground -= 1;
    }
}
fn gone() -> AppError {
    AppError::new("ASSET_GONE", "This media has been removed.")
}
fn failed(message: &str) -> AppError {
    AppError::new("PREVIEW_UNAVAILABLE", message)
}
pub fn timeline(media: &MediaInspection) -> Timeline {
    audio_policy::editor_timeline(
        media.duration_seconds,
        media.video.is_some(),
        media.audio.as_ref().map(AudioSource::from).as_ref(),
    )
}
pub fn eligible(media: &MediaInspection) -> bool {
    let clock = timeline(media);
    clock.duration_seconds.is_some_and(|d| d > 0.)
        && clock.offset_seconds.is_some()
        && (media.video.is_some() || media.audio.is_some())
}
fn direct(media: &MediaInspection) -> bool {
    media.time_origin_seconds == 0.
        && if let Some(video) = &media.video {
            media
                .format_names
                .iter()
                .any(|n| ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"].contains(&n.as_str()))
                && video.codec.as_deref() == Some("h264")
                && media
                    .audio
                    .as_ref()
                    .is_none_or(|a| a.codec.as_deref() == Some("aac"))
        } else {
            media.container.kind == "mp4"
                && media
                    .audio
                    .as_ref()
                    .is_some_and(|a| a.codec.as_deref() == Some("aac"))
                && timeline(media).offset_seconds == Some(0.)
        }
}
impl Analysis {
    pub fn new(assets: Assets, ffmpeg: PathBuf, ffprobe: PathBuf) -> Self {
        Self(Arc::new(Inner {
            root: assets.session_root(),
            assets,
            capabilities: CapabilityDiscovery::new(ffmpeg.clone()),
            ffmpeg,
            ffprobe,
            registry: Mutex::new(Registry::default()),
            worker: tokio::sync::Mutex::new(()),
            supervisor: Supervisor::default(),
            tasks: TaskTracker::new(),
        }))
    }
    pub fn revision(&self) -> u64 {
        self.0.registry.lock().unwrap().revision
    }
    pub fn state(&self, source: Uuid, kind: Kind) -> State {
        self.0
            .registry
            .lock()
            .unwrap()
            .tasks
            .get(&(source, kind))
            .map(|t| t.state.clone())
            .unwrap_or(State {
                status: "idle",
                operation_id: None,
                source_asset_id: source,
                message: None,
                asset_id: None,
                proxy: false,
            })
    }
    pub fn start(&self, id: Uuid, kind: Kind) -> Result<State> {
        let source = self.0.assets.lease(id)?;
        let media = source
            .source
            .inspection
            .media
            .as_ref()
            .ok_or_else(|| failed("Media inspection is unavailable."))?;
        if !eligible(media) || (kind == Kind::Waveform && media.video.is_some()) {
            return Err(failed(
                "Selected media needs usable audio/video timing before preparation.",
            ));
        }
        let mut registry = self.0.registry.lock().unwrap();
        if registry.closing {
            return Err(gone());
        }
        if let Some(task) = registry.tasks.get(&(id, kind))
            && (task.running || !["failed", "cancelled"].contains(&task.state.status))
        {
            return Ok(task.state.clone());
        }
        let state = State {
            status: if kind == Kind::Preview && direct(media) {
                "ready"
            } else {
                "waiting"
            },
            operation_id: Some(Uuid::new_v4()),
            source_asset_id: id,
            message: None,
            asset_id: (kind == Kind::Preview && direct(media)).then_some(id),
            proxy: false,
        };
        let operation = state.operation_id.unwrap();
        let cancel = source.cancellation().child_token();
        let running = state.status != "ready";
        registry.tasks.insert(
            (id, kind),
            Task {
                state: state.clone(),
                cancel: cancel.clone(),
                source: source.clone(),
                peaks: None,
                running,
            },
        );
        registry.revision += 1;
        if running {
            let owner = self.clone();
            self.0.tasks.spawn(async move {
                owner.perform(id, kind, operation, source, cancel).await;
            });
        }
        Ok(state)
    }
    async fn perform(
        &self,
        id: Uuid,
        kind: Kind,
        operation: Uuid,
        source: Arc<Asset>,
        cancel: CancellationToken,
    ) {
        let result = self
            .perform_owned(id, kind, operation, &source, &cancel)
            .await;
        let mut registry = self.0.registry.lock().unwrap();
        if let Some(task) = registry
            .tasks
            .get_mut(&(id, kind))
            .filter(|t| t.state.operation_id == Some(operation))
        {
            task.running = false;
            match result {
                Ok(()) => {}
                Err(error) => {
                    task.state.status = if cancel.is_cancelled() {
                        "cancelled"
                    } else {
                        "failed"
                    };
                    task.state.message = Some(if error.code == "TOOL_TIMEOUT" {
                        "Preparation timed out. Trimming and processing remain available.".into()
                    } else if cancel.is_cancelled() {
                        "Preparation paused or cancelled. Retry when processing finishes.".into()
                    } else {
                        format!(
                            "{} Trimming and processing remain available.",
                            error.message
                        )
                    });
                }
            }
            registry.revision += 1;
        }
    }
    async fn perform_owned(
        &self,
        id: Uuid,
        kind: Kind,
        operation: Uuid,
        source: &Arc<Asset>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let _worker = loop {
            if cancel.is_cancelled() {
                return Err(gone());
            }
            let guard = tokio::select! { biased; _ = cancel.cancelled() => return Err(gone()), guard = self.0.worker.lock() => guard };
            let busy = {
                let r = self.0.registry.lock().unwrap();
                r.foreground > 0 || r.processing
            };
            if !busy {
                break guard;
            }
            drop(guard);
            tokio::select! { _ = cancel.cancelled() => return Err(gone()), _ = tokio::time::sleep(Duration::from_millis(50)) => {} }
        };
        {
            let mut r = self.0.registry.lock().unwrap();
            let task = r.tasks.get_mut(&(id, kind)).ok_or_else(gone)?;
            task.state.status = "preparing";
            r.revision += 1;
        }
        let began = std::time::Instant::now();
        let caps = self.0.capabilities.get(cancel).await?;
        let media = source.source.inspection.media.as_ref().ok_or_else(gone)?;
        let clock = timeline(media);
        let duration = clock.duration_seconds.ok_or_else(gone)?;
        let mut args: Vec<OsString> = [
            "-y",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-copyts",
            "-start_at_zero",
        ]
        .map(Into::into)
        .into();
        if media.video.is_none() {
            args.extend([
                "-itsoffset".into(),
                (-clock.offset_seconds.ok_or_else(gone)?).to_string().into(),
            ]);
        }
        for (index, codec) in media
            .video
            .iter()
            .map(|v| (v.stream_index, v.codec.as_deref()))
            .chain(
                media
                    .audio
                    .iter()
                    .map(|a| (a.stream_index, a.codec.as_deref())),
            )
        {
            let decoder = codec
                .and_then(|c| caps.software_decoder(c))
                .ok_or_else(|| failed("The selected software decoder is unavailable."))?;
            args.extend([format!("-c:{index}").into(), decoder.into()]);
        }
        crate::processing_command::local_input(&mut args, media)?;
        args.extend([
            "-i".into(),
            source.processing_path()?.as_os_str().to_owned(),
        ]);
        if let Some(video) = &media.video {
            args.extend(["-map".into(), format!("0:{}", video.stream_index).into()]);
        }
        if let Some(audio) = &media.audio {
            args.extend(["-map".into(), format!("0:{}", audio.stream_index).into()]);
        }
        args.extend(["-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"].map(Into::into));
        if media.video.is_none() {
            args.extend(["-vn".into(), "-af".into(), format!("aresample=async=1:first_pts=0:min_hard_comp=0.001,apad=whole_dur={duration},atrim=end={duration}").into()]);
        }
        if kind == Kind::Waveform {
            let audio = media.audio.as_ref().ok_or_else(gone)?;
            if !caps.encoders.iter().any(|v| v == "pcm_f32le")
                || !caps.muxers.iter().any(|v| v == "f32le")
            {
                return Err(failed("Waveform needs FFmpeg float-PCM support."));
            }
            let rate = audio
                .sample_rate
                .ok_or_else(|| failed("Waveform sample rate is unknown."))?;
            let channels = audio
                .channels
                .ok_or_else(|| failed("Waveform channels are unknown."))?;
            let peaks = Arc::new(Mutex::new(Peaks::new(duration, rate, channels)?));
            let accumulator = peaks.clone();
            args.extend([
                "-c:a".into(),
                "pcm_f32le".into(),
                "-ar".into(),
                rate.to_string().into(),
                "-ac".into(),
                channels.to_string().into(),
                "-f".into(),
                "f32le".into(),
                "pipe:1".into(),
            ]);
            self.0
                .supervisor
                .run_stream_owned(
                    Request {
                        executable: &self.0.ffmpeg,
                        args: &args,
                        deadline: Duration::from_secs(120)
                            .checked_sub(began.elapsed())
                            .filter(|d| !d.is_zero())
                            .ok_or_else(|| {
                                AppError::new("TOOL_TIMEOUT", "Waveform preparation timed out.")
                            })?,
                        diagnostic_limit: 512 * 1024,
                        cancel,
                    },
                    move |bytes| accumulator.lock().unwrap().push(bytes),
                    source.clone(),
                )
                .await?;
            peaks.lock().unwrap().finish()?;
            let mut registry = self.0.registry.lock().unwrap();
            let task = registry
                .tasks
                .get_mut(&(id, kind))
                .filter(|t| t.state.operation_id == Some(operation) && !cancel.is_cancelled())
                .ok_or_else(gone)?;
            task.peaks = Some(peaks);
            task.state.status = "ready";
            return Ok(());
        }
        if !caps.muxers.iter().any(|v| v == "mp4")
            || (media.audio.is_some() && !caps.encoders.iter().any(|v| v == "aac"))
            || (media.video.is_some() && !caps.encoders.iter().any(|v| v == "libx264"))
        {
            return Err(failed(
                "Playback proxy needs the MP4 muxer and H.264/AAC encoders.",
            ));
        }
        let directory = self.0.root.path().join(format!("preview-{operation}"));
        tokio::fs::create_dir(&directory)
            .await
            .map_err(|_| failed("Could not allocate playback storage."))?;
        self.0.registry.lock().unwrap().cleanup.push(Cleanup {
            directory: directory.clone(),
            source: source.clone(),
            failed: false,
            retry: Default::default(),
        });
        let path = directory.join("playback.mp4");
        if media.video.is_some() {
            args.extend(["-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p"].map(Into::into));
        }
        if let Some(audio) = &media.audio {
            args.extend([
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                (128000 * audio.channels.unwrap_or(1).min(2))
                    .to_string()
                    .into(),
            ]);
        } else {
            args.push("-an".into());
        }
        args.extend([
            "-movflags".into(),
            "+faststart".into(),
            "-f".into(),
            "mp4".into(),
            "-fs".into(),
            crate::assets::MAX_SOURCE_BYTES.to_string().into(),
            path.as_os_str().to_owned(),
        ]);
        self.0
            .supervisor
            .run_owned(
                &self.0.ffmpeg,
                &args,
                Duration::from_secs(24 * 60 * 60),
                512 * 1024,
                cancel,
                source.clone(),
            )
            .await?;
        let checked = inspection::inspect(&self.0.ffprobe, &path, cancel).await?;
        if !checked
            .duration_seconds
            .is_some_and(|d| (d - duration).abs() < 1.)
        {
            return Err(failed("Playback proxy duration did not match the source."));
        }
        let seal = crate::owned_file::Seal::capture(&path)?;
        let file = File::open(&path).map_err(|_| failed("Playback proxy could not be opened."))?;
        let size = file
            .metadata()
            .map_err(|_| failed("Playback proxy is unavailable."))?
            .len();
        if size == 0 || size >= crate::assets::MAX_SOURCE_BYTES {
            return Err(failed("Playback proxy exceeds its storage bound."));
        }
        seal.check(&path)?;
        let proxy = Arc::new(Proxy {
            id: Uuid::new_v4(),
            source: source.clone(),
            size,
            mime: if media.video.is_some() {
                "video/mp4"
            } else {
                "audio/mp4"
            },
            file: Mutex::new(Some(file)),
            directory: directory.clone(),
            _root: self.0.root.clone(),
        });
        let mut registry = self.0.registry.lock().unwrap();
        let task = registry
            .tasks
            .get_mut(&(id, kind))
            .filter(|t| t.state.operation_id == Some(operation) && !cancel.is_cancelled())
            .ok_or_else(gone)?;
        task.state.status = "ready";
        task.state.asset_id = Some(proxy.id);
        task.state.proxy = true;
        registry.proxies.insert(proxy.id, proxy);
        registry.cleanup.retain(|c| c.directory != directory);
        Ok(())
    }
    pub async fn preempt(&self) -> Foreground {
        {
            let mut registry = self.0.registry.lock().unwrap();
            registry.foreground += 1;
            for task in registry.tasks.values() {
                if task.running {
                    task.cancel.cancel();
                }
            }
        }
        let guard = Foreground(self.clone());
        // A guard is dropped only after run_stream/run_owned has confirmed exit.
        let _worker = self.0.worker.lock().await;
        guard
    }
    pub fn processing_busy(&self, busy: bool) {
        self.0.registry.lock().unwrap().processing = busy;
    }
    pub fn cancel(&self, source: Uuid, kind: Kind, operation: Option<Uuid>) {
        if let Some(task) = self.0.registry.lock().unwrap().tasks.get(&(source, kind))
            && operation.is_none_or(|id| task.state.operation_id == Some(id))
            && task.running
        {
            task.cancel.cancel();
        }
    }
    pub fn retire(&self, source: Uuid) {
        let mut r = self.0.registry.lock().unwrap();
        for ((id, _), task) in &r.tasks {
            if *id == source {
                task.cancel.cancel();
            }
        }
        let ids: Vec<_> = r
            .proxies
            .iter()
            .filter(|(_, p)| p.source.source.asset_id == source)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let proxy = r.proxies.remove(&id).unwrap();
            r.retired.push(proxy);
        }
        r.tasks.retain(|(id, _), t| *id != source || t.running);
        r.revision += 1;
    }
    pub fn retains_source(&self, source: Uuid) -> bool {
        let r = self.0.registry.lock().unwrap();
        r.tasks.iter().any(|((id, _), _)| *id == source)
            || r.retired.iter().any(|p| p.source.source.asset_id == source)
            || r.cleanup.iter().any(|c| c.source.source.asset_id == source)
    }
    pub fn window(
        &self,
        source: Uuid,
        operation: Uuid,
        start: f64,
        end: f64,
        points: usize,
    ) -> Result<Value> {
        self.0.assets.lease(source)?;
        let r = self.0.registry.lock().unwrap();
        let task = r
            .tasks
            .get(&(source, Kind::Waveform))
            .filter(|t| t.state.operation_id == Some(operation) && t.state.status == "ready")
            .ok_or_else(|| failed("The waveform operation changed. Retry the overview."))?;
        let peaks = task.peaks.as_ref().ok_or_else(gone)?.lock().unwrap();
        Ok(
            json!({"workspaceId":source,"sourceAssetId":source,"operationId":operation,"status":"ready","startSeconds":start,"endSeconds":end,"peaks":peaks.window(start,end,points)?}),
        )
    }
    pub async fn cleanup(&self, retry: bool) -> Result<()> {
        let owner = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut r = owner.0.registry.lock().unwrap();
            r.tasks
                .retain(|_, t| !t.source.cancellation().is_cancelled() || t.running);
            let mut retired = std::mem::take(&mut r.retired);
            for proxy in retired.drain(..) {
                if Arc::strong_count(&proxy) > 1 {
                    r.retired.push(proxy);
                    continue;
                }
                proxy.file.lock().unwrap().take();
                r.cleanup.push(Cleanup {
                    directory: proxy.directory.clone(),
                    source: proxy.source.clone(),
                    failed: false,
                    retry: Default::default(),
                });
            }
            let running: Vec<_> = r
                .tasks
                .values()
                .filter(|t| t.running)
                .filter_map(|t| t.state.operation_id)
                .collect();
            let before = (
                r.cleanup.len(),
                r.cleanup.iter().filter(|c| c.failed).count(),
            );
            r.cleanup.retain_mut(|entry| {
                if running
                    .iter()
                    .any(|id| entry.directory.ends_with(format!("preview-{id}")))
                    || (entry.failed && !retry && !entry.retry.due())
                {
                    return true;
                }
                entry.failed = std::fs::remove_dir_all(&entry.directory)
                    .is_err_and(|e| e.kind() != std::io::ErrorKind::NotFound);
                if entry.failed {
                    entry.retry.failed();
                }
                entry.failed
            });
            if (
                r.cleanup.len(),
                r.cleanup.iter().filter(|c| c.failed).count(),
            ) != before
            {
                r.revision += 1;
            }
            if r.cleanup.iter().any(|c| c.failed) {
                return Err(failed("Temporary preview cleanup failed. Retry cleanup."));
            }
            Ok(())
        })
        .await
        .map_err(|_| failed("Preview cleanup ended unexpectedly."))?
    }
    pub fn cleanup_pending(&self, source: Uuid) -> bool {
        self.0
            .registry
            .lock()
            .unwrap()
            .cleanup
            .iter()
            .any(|c| c.source.source.asset_id == source && c.failed)
    }
    pub async fn shutdown(&self) -> Result<()> {
        {
            let mut r = self.0.registry.lock().unwrap();
            r.closing = true;
            for t in r.tasks.values() {
                t.cancel.cancel();
            }
            self.0.tasks.close();
        }
        self.0.supervisor.shutdown().await?;
        tokio::time::timeout(Duration::from_secs(5), self.0.tasks.wait())
            .await
            .map_err(|_| failed("Preview workers are still stopping. Retry closing."))?;
        self.cleanup(true).await
    }
}
impl Library for Analysis {
    fn media_lease(&self, id: Uuid) -> Result<Arc<dyn Reader>> {
        let r = self.0.registry.lock().unwrap();
        let proxy = r.proxies.get(&id).ok_or_else(gone)?;
        if proxy.cancellation().is_cancelled() {
            return Err(gone());
        }
        Ok(proxy.clone())
    }
}
