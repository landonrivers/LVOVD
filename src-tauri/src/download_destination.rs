use lvovd_core::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Destination {
    pub(crate) id: Uuid,
    path: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preference {
    folder: PathBuf,
}

pub(crate) struct Destinations {
    file: PathBuf,
    selected: Mutex<Option<Destination>>,
}

impl Destinations {
    pub(crate) fn new(config: &Path, default: Option<PathBuf>) -> Self {
        let file = config.join("download-destination.json");
        let folder = match File::open(&file) {
            Ok(reader) => {
                let mut bytes = Vec::new();
                reader
                    .take(32_769)
                    .read_to_end(&mut bytes)
                    .ok()
                    .filter(|count| *count <= 32_768)
                    .and_then(|_| serde_json::from_slice::<Preference>(&bytes).ok())
                    .map(|value| value.folder)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => default.filter(|d| d.is_dir()),
            Err(_) => None,
        };
        Self {
            file,
            selected: Mutex::new(folder.filter(|p| p.is_absolute()).map(|path| Destination {
                id: Uuid::new_v4(),
                path,
            })),
        }
    }

    pub(crate) fn selected(&self) -> Option<Destination> {
        self.selected.lock().unwrap().clone()
    }

    pub(crate) fn capture(&self, id: Uuid) -> Result<PathBuf> {
        self.selected()
            .filter(|s| s.id == id)
            .map(|s| s.path)
            .ok_or_else(|| {
                AppError::new(
                    "DESTINATION_CHANGED",
                    "The destination changed. Check the folder and try again.",
                )
            })
    }

    pub(crate) fn remember(&self, folder: PathBuf) -> Result<Destination> {
        if !folder.is_absolute() || !folder.is_dir() {
            return Err(AppError::new(
                "DESTINATION_UNAVAILABLE",
                "Choose an available output folder.",
            ));
        }
        let error = || {
            AppError::new(
                "SETTINGS_WRITE",
                "Could not remember the output folder. Check application settings permissions and try again.",
            )
        };
        let parent = self.file.parent().ok_or_else(error)?;
        std::fs::create_dir_all(parent).map_err(|_| error())?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| error())?;
        serde_json::to_writer(
            &mut temporary,
            &Preference {
                folder: folder.clone(),
            },
        )
        .map_err(|_| error())?;
        temporary
            .flush()
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| error())?;
        let mut selected = self.selected.lock().unwrap();
        temporary.persist(&self.file).map_err(|_| error())?;
        let destination = Destination {
            id: Uuid::new_v4(),
            path: folder,
        };
        *selected = Some(destination.clone());
        Ok(destination)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_is_atomic_opaque_and_survives_restart() {
        let config = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let choices = Destinations::new(config.path(), None);
        assert!(choices.selected().is_none());
        let first = choices.remember(folder.path().to_owned()).unwrap();
        assert_eq!(choices.capture(first.id).unwrap(), folder.path());
        assert!(choices.remember(folder.path().join("gone")).is_err());
        let restarted = Destinations::new(config.path(), None);
        assert_eq!(restarted.selected().unwrap().path, folder.path());
        assert!(restarted.capture(first.id).is_err());
        let second = choices.remember(config.path().to_owned()).unwrap();
        assert_ne!(first.id, second.id);
        assert!(choices.capture(first.id).is_err());
    }
}
