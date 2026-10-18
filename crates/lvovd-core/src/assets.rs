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
pub const MAX_ASSETS: usize = 20;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub asset_id: Uuid,
    pub name: String,
    pub size: u64,
    pub inspection: Inspection,
}

pub struct Asset {
    pub source: Source,
    pub(crate) revoked: AtomicBool,
    cancelled: CancellationToken,
    file: Mutex<Option<File>>,
    path: PathBuf,
}

impl Asset {
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
pub struct Assets {
    root: tempfile::TempDir,
    registry: Mutex<Registry>,
    intake: tokio::sync::Mutex<()>,
    cancel: CancellationToken,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub asset_id: Uuid,
    pub cleanup_complete: bool,
}

impl Assets {
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
            root,
            registry: Mutex::new(Registry::default()),
            intake: tokio::sync::Mutex::new(()),
            cancel: CancellationToken::new(),
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

    /// Only the trusted native picker/drop handler may supply this path, never a frontend command argument.
    pub async fn import(&self, selected: &Path, ffprobe: &Path) -> Result<Source> {
        let _admission = self.intake.try_lock().map_err(|_| {
            AppError::new(
                "INTAKE_BUSY",
                "Wait for the current file to finish importing.",
            )
        })?;
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
        {
            let mut registry = self.registry.lock().unwrap();
            let bytes: u64 = registry
                .active
                .values()
                .chain(registry.retired.values())
                .map(|a| a.source.size)
                .sum();
            if registry.closing || self.cancel.is_cancelled() {
                return Err(AppError::new("CLOSING", "The application is closing."));
            }
            if registry.active.len() + registry.retired.len() >= MAX_ASSETS
                || size > MAX_SOURCE_BYTES.saturating_sub(bytes)
            {
                return Err(AppError::new(
                    "STORAGE_LIMIT",
                    "Remove files and finish cleanup before importing more media.",
                ));
            }
            registry.pending = true;
        }
        let id = Uuid::new_v4();
        let owned = self.root.path().join(id.to_string());
        let mut result = async {
            let mut output = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&owned).await.map_err(|_| AppError::new("SOURCE_COPY", "Could not create an owned media copy."))?;
            let mut copied = 0;
            let mut buffer = vec![0u8; 256 * 1024];
            loop {
                let count = tokio::select! { biased; _ = self.cancel.cancelled() => return Err(AppError::new("CANCELLED", "Import cancelled.")), count = input.read(&mut buffer) => count.map_err(|_| AppError::new("SOURCE_READ", "Could not read the selected file."))? };
                if count == 0 { break; }
                copied += count as u64;
                if copied > size { return Err(AppError::new("SOURCE_CHANGED", "The selected file changed while importing.")); }
                output.write_all(&buffer[..count]).await.map_err(|_| AppError::new("SOURCE_COPY", "Could not copy media. Check free space and permissions."))?;
            }
            if copied != size { return Err(AppError::new("SOURCE_CHANGED", "The selected file changed while importing.")); }
            output.flush().await.map_err(|_| AppError::new("SOURCE_COPY", "Could not finish copying media."))?;
            drop(output);
            let inspection = inspection::inspect(ffprobe, &owned, &self.cancel).await?;
            let name = selected.file_name().unwrap_or_default().to_string_lossy().chars().filter(|c| !c.is_control()).take(240).collect();
            let source = Source { asset_id: id, name, size, inspection };
            let file = File::open(&owned).map_err(|_| AppError::new("SOURCE_READ", "Could not reopen owned media."))?;
            let asset = Arc::new(Asset { source: source.clone(), revoked: AtomicBool::new(false), cancelled: CancellationToken::new(), file: Mutex::new(Some(file)), path: owned.clone() });
            let mut registry = self.registry.lock().unwrap();
            if registry.closing || self.cancel.is_cancelled() { return Err(AppError::new("CANCELLED", "Import cancelled.")); }
            registry.active.insert(id, asset);
            Ok(source)
        }.await;
        if result.is_err()
            && let Err(error) = tokio::fs::remove_file(&owned).await
            && error.kind() != std::io::ErrorKind::NotFound
        {
            let source = Source {
                asset_id: id,
                name: "Incomplete import".into(),
                size,
                inspection: Inspection {
                    format: String::new(),
                    duration_seconds: None,
                    streams: vec![],
                    mime: None,
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
                match std::fs::remove_file(&asset.path) {
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
