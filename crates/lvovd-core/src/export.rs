//! A native-selected destination, never a frontend-supplied filesystem path.
use crate::{AppError, Result, processing_operation::OutputLease};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub fn save_copy(result: OutputLease, destination: &Path) -> Result<PathBuf> {
    let error = || {
        AppError::new(
            "SAVE_FAILED",
            "Could not save this file. The prepared result remains available; choose another folder or retry.",
        )
    };
    let parent = destination
        .parent()
        .filter(|p| p.is_absolute())
        .ok_or_else(error)?;
    let stem = destination.file_stem().ok_or_else(error)?.to_string_lossy();
    let extension = destination
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let mut temp = tempfile::Builder::new()
        .prefix(".lvovd-save-")
        .tempfile_in(parent)
        .map_err(|_| error())?;
    let mut offset = 0;
    while offset < result.descriptor().size {
        let count = (result.descriptor().size - offset).min(1024 * 1024) as usize;
        let bytes = result.read(offset, count)?;
        temp.write_all(&bytes).map_err(|_| error())?;
        offset += count as u64;
    }
    temp.flush()
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| error())?;
    for index in 0..10_000 {
        let target = if index == 0 {
            destination.to_owned()
        } else {
            parent.join(format!("{stem} ({index}){extension}"))
        };
        match temp.persist_noclobber(&target) {
            Ok(file) => {
                drop(file);
                return Ok(target);
            }
            Err(failure) if failure.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temp = failure.file;
            }
            Err(_) => return Err(error()),
        }
    }
    Err(error())
}
