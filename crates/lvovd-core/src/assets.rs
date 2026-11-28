use crate::{
    AppError, Result,
    inspection::{self, Inspection},
    process::CancellationToken,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

pub const MAX_SOURCE_BYTES: u64 = 100 * 1024 * 1024 * 1024;
// Application aggregate. Workbenches enforce twenty members apiece.
pub const MAX_ASSETS: usize = 40;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub asset_id: Uuid,
    pub name: String,
    pub size: u64,
    pub inspection: Inspection,
    pub origin: SourceOrigin,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceOrigin {
    Local,
    Url,
}

struct StagedSource {
    id: Uuid,
    path: PathBuf,
    directory: Option<PathBuf>,
    name: String,
    size: u64,
}

pub struct Asset {
    pub source: Source,
    pub(crate) revoked: AtomicBool,
    cancelled: CancellationToken,
    file: Mutex<Option<File>>,
    path: PathBuf,
    // Provider streams, merge intermediates, and the inspected final media
    // share this one private directory and one source reservation.
    directory: Option<PathBuf>,
    // A read/worker lease keeps the session directory alive as well as the file.
    _root: Arc<tempfile::TempDir>,
    seal: Option<crate::owned_file::Seal>,
}

impl Asset {
    pub(crate) fn processing_path(&self) -> Result<&Path> {
        if self.revoked.load(Ordering::Acquire) {
            return Err(AppError::new("ASSET_GONE", "This media has been removed."));
        }
        self.seal
            .as_ref()
            .ok_or_else(|| AppError::new("SOURCE_CHANGED", "The owned source is unavailable."))?
            .check(&self.path)?;
        Ok(&self.path)
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.cancelled.clone()
    }
    pub fn read(&self, offset: u64, count: usize) -> Result<Vec<u8>> {
        if count > crate::media::MAX_RESPONSE_BYTES as usize
            || offset > self.source.size
            || count as u64 > self.source.size - offset
        {
            return Err(AppError::new(
                "MEDIA_RANGE",
                "The requested media range is invalid.",
            ));
        }
        let mut file = self
            .file
            .lock()
            .map_err(|_| AppError::new("ASSET_STATE", "Media state is unavailable."))?;
        if self.revoked.load(Ordering::Acquire) {
            return Err(AppError::new("ASSET_GONE", "This media has been removed."));
        }
        let file = file
            .as_mut()
            .ok_or_else(|| AppError::new("ASSET_GONE", "This media has been removed."))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| AppError::new("MEDIA_READ", "Could not seek media."))?;
        let mut bytes = vec![0; count];
        file.read_exact(&mut bytes)
            .map_err(|_| AppError::new("MEDIA_READ", "Could not read media."))?;
        if self.revoked.load(Ordering::Acquire) {
            return Err(AppError::new("ASSET_GONE", "This media has been removed."));
        }
        Ok(bytes)
    }
}

#[derive(Default)]
struct Registry {
    active: HashMap<Uuid, Arc<Asset>>,
    retired: HashMap<Uuid, Arc<Asset>>,
    pending: bool,
    closing: bool,
}
#[derive(Clone)]
pub struct Assets {
    root: Arc<tempfile::TempDir>,
    registry: Arc<Mutex<Registry>>,
    intake: Arc<tokio::sync::Mutex<()>>,
    cancel: CancellationToken,
    imports: tokio_util::task::TaskTracker,
    #[cfg(test)]
    pause_probe: Arc<(AtomicBool, tokio::sync::Notify, tokio::sync::Notify)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub asset_id: Uuid,
    pub cleanup_complete: bool,
}

impl Assets {
    pub(crate) fn session_root(&self) -> Arc<tempfile::TempDir> {
        self.root.clone()
    }
    pub fn new(parent: &Path) -> Result<Self> {
        std::fs::create_dir_all(parent).map_err(|_| {
            AppError::new(
                "TEMP_DIRECTORY",
                "Could not create the temporary-media directory.",
            )
        })?;
        let root = tempfile::Builder::new()
            .prefix("lvovd-desktop-")
            .tempdir_in(parent)
            .map_err(|_| {
                AppError::new(
                    "TEMP_DIRECTORY",
                    "Could not create a private media session.",
                )
            })?;
        Ok(Self {
            root: Arc::new(root),
            registry: Arc::new(Mutex::new(Registry::default())),
            intake: Arc::new(tokio::sync::Mutex::new(())),
            cancel: CancellationToken::new(),
            imports: tokio_util::task::TaskTracker::new(),
            #[cfg(test)]
            pause_probe: Arc::new((
                AtomicBool::new(false),
                tokio::sync::Notify::new(),
                tokio::sync::Notify::new(),
            )),
        })
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.cancel.clone()
    }
    pub fn lease(&self, id: Uuid) -> Result<Arc<Asset>> {
        self.registry
            .lock()
            .unwrap()
            .active
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::new("ASSET_GONE", "This media has expired or been removed."))
    }
    /// Linearize publication against removal. The callback cannot await or call
    /// back into this registry; only an active, identical owned source qualifies.
    pub(crate) fn with_current<T>(
        &self,
        asset: &Arc<Asset>,
        publish: impl FnOnce() -> T,
    ) -> Result<T> {
        let registry = self.registry.lock().unwrap();
        if registry.closing
            || !registry
                .active
                .get(&asset.source.asset_id)
                .is_some_and(|current| Arc::ptr_eq(current, asset))
        {
            return Err(AppError::new(
                "ASSET_GONE",
                "This media has expired or been removed.",
            ));
        }
        Ok(publish())
    }
    /// Batch admission must validate every source under one registry guard.
    /// The callback must not await or acquire this registry again.
    pub(crate) fn with_current_batch<T>(
        &self,
        assets: &[Arc<Asset>],
        admit: impl FnOnce() -> T,
    ) -> Result<T> {
        let registry = self.registry.lock().unwrap();
        if registry.closing
            || assets.iter().any(|asset| {
                !registry
                    .active
                    .get(&asset.source.asset_id)
                    .is_some_and(|current| Arc::ptr_eq(current, asset))
            })
        {
            return Err(AppError::new(
                "ASSET_GONE",
                "A reviewed file was removed or expired.",
            ));
        }
        Ok(admit())
    }
    pub fn list(&self) -> Vec<Source> {
        self.registry
            .lock()
            .unwrap()
            .active
            .values()
            .map(|a| a.source.clone())
            .collect()
    }
    pub fn pending_cleanup(&self) -> Vec<Uuid> {
        self.registry
            .lock()
            .unwrap()
            .retired
            .keys()
            .copied()
            .collect()
    }
    pub fn is_busy(&self) -> bool {
        self.registry.lock().unwrap().pending
    }

    /// Call after a reader releases its lease. Failed deletion stays registered
    /// for explicit retry; active readers still prevent retirement.
    pub fn retry_pending_cleanup(&self) -> bool {
        let mut changed = false;
        for id in self.pending_cleanup() {
            if self.remove(id).is_ok_and(|result| result.cleanup_complete) {
                changed = true;
            }
        }
        changed
    }
    pub(crate) fn cleanup_has_readers(&self, id: Uuid) -> bool {
        self.registry
            .lock()
            .unwrap()
            .retired
            .get(&id)
            .is_some_and(|asset| Arc::strong_count(asset) > 1)
    }

    /// Only the trusted native picker/drop handler may supply this path, never a frontend command argument.
    pub async fn import(&self, selected: &Path, ffprobe: &Path) -> Result<Source> {
        self.import_cancellable(selected, ffprobe, &self.cancel)
            .await
    }
    pub(crate) async fn import_cancellable(
        &self,
        selected: &Path,
        ffprobe: &Path,
        parent_cancel: &CancellationToken,
    ) -> Result<Source> {
        let admission = self.intake.clone().try_lock_owned().map_err(|_| {
            AppError::new(
                "INTAKE_BUSY",
                "Wait for the current file to finish importing.",
            )
        })?;
        let cancel = parent_cancel.child_token();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let owned = self.clone();
        let selected = selected.to_owned();
        let ffprobe = ffprobe.to_owned();
        let (send, receive) = tokio::sync::oneshot::channel();
        {
            let registry = self.registry.lock().unwrap();
            if registry.closing {
                return Err(AppError::new("CLOSING", "The application is closing."));
            }
            self.imports.spawn(async move {
                let _admission = admission;
                let result = owned.import_inner(&selected, &ffprobe, &cancel).await;
                // No source may become unreachable just because its caller left.
                if let Err(Ok(source)) = send.send(result) {
                    let _ = owned.remove(source.asset_id);
                }
            });
        }
        receive
            .await
            .map_err(|_| AppError::new("INTAKE_FAILED", "Media intake ended unexpectedly."))?
    }

    async fn import_inner(
        &self,
        selected: &Path,
        ffprobe: &Path,
        cancel: &CancellationToken,
    ) -> Result<Source> {
        let mut input = tokio::fs::File::open(selected)
            .await
            .map_err(|_| AppError::new("SOURCE_READ", "Could not open the selected file."))?;
        let metadata = input
            .metadata()
            .await
            .map_err(|_| AppError::new("SOURCE_READ", "Could not inspect the selected file."))?;
        let size = metadata.len();
        if !metadata.is_file() || size == 0 || size > MAX_SOURCE_BYTES {
            return Err(AppError::new(
                "SOURCE_SIZE",
                "Choose a nonempty media file no larger than 100 GiB.",
            ));
        }
        self.reserve_intake(Some(size))?;
        let id = Uuid::new_v4();
        let owned = self.root.path().join(id.to_string());
        let result = async {
            let mut output = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&owned).await.map_err(|_| AppError::new("SOURCE_COPY", "Could not create an owned media copy."))?;
            let mut copied = 0;
            let mut buffer = vec![0u8; 256 * 1024];
            loop {
                let count = tokio::select! { biased; _ = cancel.cancelled() => return Err(AppError::new("CANCELLED", "Import cancelled.")), count = input.read(&mut buffer) => count.map_err(|_| AppError::new("SOURCE_READ", "Could not read the selected file."))? };
                if count == 0 { break; }
                copied += count as u64;
                if copied > size { return Err(AppError::new("SOURCE_CHANGED", "The selected file changed while importing.")); }
                output.write_all(&buffer[..count]).await.map_err(|_| AppError::new("SOURCE_COPY", "Could not copy media. Check free space and permissions."))?;
            }
            if copied != size { return Err(AppError::new("SOURCE_CHANGED", "The selected file changed while importing.")); }
            output.flush().await.map_err(|_| AppError::new("SOURCE_COPY", "Could not finish copying media."))?;
            drop(output);
            let name = selected.file_name().unwrap_or_default().to_string_lossy().chars().filter(|c| !c.is_control()).take(240).collect();
            self.inspect_and_publish(StagedSource { id, path: owned.clone(), directory: None, name, size }, ffprobe, cancel, None).await
        }.await;
        self.finish_intake(result, id, owned, None, size).await
    }

    // All source intake holds the same exclusive intake guard through
    // publication or cleanup. For a URL with unknown size, reserve the entire
    // remaining allowance until its intermediates are gone.
    fn reserve_intake(&self, size: Option<u64>) -> Result<u64> {
        let mut registry = self.registry.lock().unwrap();
        if registry.closing || self.cancel.is_cancelled() {
            return Err(AppError::new("CLOSING", "The application is closing."));
        }
        let used = registry
            .active
            .values()
            .chain(registry.retired.values())
            .map(|a| a.source.size)
            .sum();
        let remaining = MAX_SOURCE_BYTES.saturating_sub(used);
        if registry.active.len() + registry.retired.len() >= MAX_ASSETS
            || remaining == 0
            || size.is_some_and(|size| size > remaining)
        {
            return Err(AppError::new(
                "STORAGE_LIMIT",
                "Remove files and finish cleanup before importing more media.",
            ));
        }
        registry.pending = true;
        Ok(size.unwrap_or(remaining))
    }

    /// The workbench owns this future in its task tracker even if the window disconnects.
    pub(crate) async fn acquire_source(
        &self,
        downloads: &crate::downloads::Downloads,
        acquisition: &crate::downloads::EditorAcquisition,
        ffprobe: &Path,
        cancel: &CancellationToken,
    ) -> Result<Source> {
        let _intake = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(AppError::new("CANCELLED", "Source acquisition cancelled.")),
            guard = self.intake.lock() => guard,
        };
        let maximum = self.reserve_intake(None)?;
        let id = Uuid::new_v4();
        let directory = self.root.path().join(id.to_string());
        if tokio::fs::create_dir(&directory).await.is_err() {
            self.registry.lock().unwrap().pending = false;
            return Err(AppError::new(
                "DOWNLOAD_STORAGE",
                "Could not create the temporary source folder.",
            ));
        }
        let result = async {
            let (path, name) = downloads
                .acquire_editor(acquisition, &directory, maximum, cancel)
                .await?;
            if path.parent() != Some(directory.as_path()) {
                return Err(AppError::new(
                    "SOURCE_CHANGED",
                    "The acquired source is unavailable.",
                ));
            }
            let size = tokio::fs::symlink_metadata(&path)
                .await
                .map_err(|_| {
                    AppError::new("SOURCE_READ", "Could not inspect the acquired source.")
                })?
                .len();
            if size == 0 || size > maximum {
                return Err(AppError::new(
                    "STORAGE_LIMIT",
                    "The acquired file is empty or exceeds the remaining source allowance.",
                ));
            }
            self.inspect_and_publish(
                StagedSource {
                    id,
                    path,
                    directory: Some(directory.clone()),
                    name,
                    size,
                },
                ffprobe,
                cancel,
                Some(acquisition),
            )
            .await
        }
        .await;
        self.finish_intake(result, id, directory.clone(), Some(directory), maximum)
            .await
    }

    async fn inspect_and_publish(
        &self,
        staged: StagedSource,
        ffprobe: &Path,
        cancel: &CancellationToken,
        editor: Option<&crate::downloads::EditorAcquisition>,
    ) -> Result<Source> {
        let seal = crate::owned_file::Seal::capture(&staged.path)?;
        #[cfg(test)]
        if self.pause_probe.0.load(Ordering::Acquire) {
            self.pause_probe.1.notify_one();
            self.pause_probe.2.notified().await;
        }
        let inspection = inspection::inspect(ffprobe, &staged.path, cancel).await?;
        if let Some(editor) = editor {
            editor.validate_source(&inspection)?;
        }
        seal.check(&staged.path)?;
        let file = File::open(&staged.path)
            .map_err(|_| AppError::new("SOURCE_READ", "Could not reopen owned media."))?;
        let origin = if editor.is_some() {
            SourceOrigin::Url
        } else {
            SourceOrigin::Local
        };
        let source = Source {
            asset_id: staged.id,
            name: staged.name,
            size: staged.size,
            inspection,
            origin,
        };
        let asset = Arc::new(Asset {
            source: source.clone(),
            revoked: AtomicBool::new(false),
            cancelled: CancellationToken::new(),
            file: Mutex::new(Some(file)),
            path: staged.path,
            directory: staged.directory,
            _root: self.root.clone(),
            seal: Some(seal),
        });
        let mut registry = self.registry.lock().unwrap();
        if registry.closing || cancel.is_cancelled() {
            return Err(AppError::new("CANCELLED", "Import cancelled."));
        }
        registry.active.insert(staged.id, asset);
        Ok(source)
    }

    async fn finish_intake(
        &self,
        mut result: Result<Source>,
        id: Uuid,
        owned: PathBuf,
        directory: Option<PathBuf>,
        size: u64,
    ) -> Result<Source> {
        if result.is_err()
            && let Err(error) = match &directory {
                Some(dir) => tokio::fs::remove_dir_all(dir).await,
                None => tokio::fs::remove_file(&owned).await,
            }
            && error.kind() != std::io::ErrorKind::NotFound
        {
            let source = Source {
                asset_id: id,
                name: "Incomplete import".into(),
                origin: if directory.is_some() {
                    SourceOrigin::Url
                } else {
                    SourceOrigin::Local
                },
                size,
                inspection: Inspection {
                    format: String::new(),
                    duration_seconds: None,
                    streams: vec![],
                    mime: None,
                    media: None,
                },
            };
            self.registry.lock().unwrap().retired.insert(
                id,
                Arc::new(Asset {
                    source,
                    revoked: AtomicBool::new(true),
                    cancelled: CancellationToken::new(),
                    file: Mutex::new(None),
                    path: owned,
                    directory,
                    _root: self.root.clone(),
                    seal: None,
                }),
            );
            if let Err(error) = &mut result {
                error.cleanup_asset_id = Some(id);
            }
        }
        self.registry.lock().unwrap().pending = false;
        result
    }

    pub fn remove(&self, id: Uuid) -> Result<Removal> {
        let mut registry = self.registry.lock().unwrap();
        if let Some(asset) = registry.active.remove(&id) {
            asset.revoked.store(true, Ordering::Release);
            asset.cancelled.cancel();
            registry.retired.insert(id, asset);
        }
        let complete = if let Some(asset) = registry.retired.get(&id) {
            if Arc::strong_count(asset) > 1 {
                false
            } else {
                asset.file.lock().unwrap().take();
                let removal = match &asset.directory {
                    Some(dir) => std::fs::remove_dir_all(dir),
                    None => std::fs::remove_file(&asset.path),
                };
                match removal {
                    Ok(()) => true,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                    Err(_) => false,
                }
            }
        } else {
            true
        };
        if complete {
            registry.retired.remove(&id);
        }
        Ok(Removal {
            asset_id: id,
            cleanup_complete: complete,
        })
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.registry.lock().unwrap().closing = true;
        self.cancel.cancel();
        self.imports.close();
        tokio::time::timeout(std::time::Duration::from_secs(5), self.imports.wait())
            .await
            .map_err(|_| {
                AppError::new(
                    "CLEANUP_PENDING",
                    "Media intake is still stopping. Try closing again.",
                )
            })?;
        let _admission = self.intake.lock().await;
        let ids: Vec<_> = {
            let registry = self.registry.lock().unwrap();
            registry
                .active
                .keys()
                .chain(registry.retired.keys())
                .copied()
                .collect()
        };
        for id in ids {
            if !self.remove(id)?.cleanup_complete {
                return Err(AppError::new(
                    "CLEANUP_PENDING",
                    "A media read or cleanup is still pending. Try closing again.",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod ownership_tests {
    use super::*;
    #[tokio::test]
    async fn retired_sources_keep_the_aggregate_byte_budget_until_cleanup_completes() {
        let parent = tempfile::tempdir().unwrap();
        let original = parent.path().join("original");
        std::fs::write(&original, b"unchanged original").unwrap();
        let assets = Assets::new(parent.path()).unwrap();
        let id = Uuid::new_v4();
        let asset = Arc::new(Asset {
            source: Source {
                asset_id: id,
                name: "Retained source".into(),
                origin: SourceOrigin::Local,
                size: MAX_SOURCE_BYTES,
                inspection: Inspection {
                    format: String::new(),
                    duration_seconds: None,
                    streams: vec![],
                    mime: None,
                    media: None,
                },
            },
            revoked: AtomicBool::new(true),
            cancelled: CancellationToken::new(),
            file: Mutex::new(None),
            path: assets.root.path().join(id.to_string()),
            directory: None,
            _root: assets.root.clone(),
            seal: None,
        });
        assets
            .registry
            .lock()
            .unwrap()
            .retired
            .insert(id, asset.clone());
        let probe = PathBuf::from(std::env::var_os("LVOVD_DESKTOP_FFPROBE").unwrap());
        assert!(!assets.remove(id).unwrap().cleanup_complete);
        assert_eq!(
            assets.import(&original, &probe).await.err().unwrap().code,
            "STORAGE_LIMIT"
        );
        drop(asset);
        assert!(assets.remove(id).unwrap().cleanup_complete);
        // The synthetic bytes fail inspection, proving storage admission was
        // released without creating a real hundred-GiB fixture.
        assert_ne!(
            assets.import(&original, &probe).await.err().unwrap().code,
            "STORAGE_LIMIT"
        );
        assets.shutdown().await.unwrap();
        assert_eq!(std::fs::read(original).unwrap(), b"unchanged original");
    }
    #[tokio::test]
    async fn failed_acquisition_cleanup_keeps_its_reserved_allowance_until_retry() {
        let parent = tempfile::tempdir().unwrap();
        let assets = Assets::new(parent.path()).unwrap();
        let id = Uuid::new_v4();
        let directory = assets.root.path().join(id.to_string());
        let original = parent.path().join("user-original");
        std::fs::write(&original, b"keep").unwrap();
        // The private directory's expected type is unavailable. Do not
        // discard its reservation or erase a path of an unexpected type.
        std::fs::write(&directory, b"replacement").unwrap();
        let bytes = assets.reserve_intake(None).unwrap();
        let error = assets
            .finish_intake(
                Err(AppError::new("CANCELLED", "Cancelled.")),
                id,
                directory.clone(),
                Some(directory.clone()),
                bytes,
            )
            .await
            .err()
            .unwrap();
        assert_eq!(error.cleanup_asset_id, Some(id));
        assert!(assets.list().is_empty());
        assert_eq!(assets.pending_cleanup(), vec![id]);
        assert_eq!(
            assets.reserve_intake(None).unwrap_err().code,
            "STORAGE_LIMIT"
        );
        std::fs::remove_file(&directory).unwrap();
        assert!(assets.remove(id).unwrap().cleanup_complete);
        assert_eq!(assets.reserve_intake(None).unwrap(), MAX_SOURCE_BYTES);
        assets.shutdown().await.unwrap();
        assert_eq!(std::fs::read(original).unwrap(), b"keep");
    }

    #[tokio::test]
    async fn abandoned_import_keeps_intake_owned_until_cleanup_finishes() {
        let parent = tempfile::tempdir().unwrap();
        let original = parent.path().join("original");
        std::fs::write(&original, b"original bytes").unwrap();
        let assets = Assets::new(parent.path()).unwrap();
        assets.pause_probe.0.store(true, Ordering::Release);
        let importer = assets.clone();
        let path = original.clone();
        let probe = PathBuf::from(std::env::var_os("LVOVD_DESKTOP_FFPROBE").unwrap());
        let handle = tokio::spawn(async move { importer.import(&path, &probe).await });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            assets.pause_probe.1.notified(),
        )
        .await
        .unwrap();
        handle.abort();
        assert!(handle.await.err().unwrap().is_cancelled());
        assert!(assets.is_busy());
        assert_eq!(std::fs::read_dir(assets.root.path()).unwrap().count(), 1);
        assert!(assets.intake.try_lock().is_err());
        assets.pause_probe.2.notify_one();
        assets.shutdown().await.unwrap();
        assert!(!assets.is_busy());
        assert!(assets.list().is_empty());
        assert_eq!(std::fs::read_dir(assets.root.path()).unwrap().count(), 0);
        assert_eq!(std::fs::read(original).unwrap(), b"original bytes");
    }
}
