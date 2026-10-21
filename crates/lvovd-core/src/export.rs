//! A native-selected destination, never a frontend-supplied filesystem path.
use crate::{AppError, Result, processing_operation::OutputLease};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub fn save_copy(result: OutputLease, destination: &Path) -> Result<PathBuf> {
    save_copy_checked(result, destination, || Ok(()))
}

pub(crate) fn save_copy_checked(
    result: OutputLease,
    destination: &Path,
    mut current: impl FnMut() -> Result<()>,
) -> Result<PathBuf> {
    current()?;
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
        current()?;
        let count = (result.descriptor().size - offset).min(1024 * 1024) as usize;
        let bytes = result.read(offset, count)?;
        temp.write_all(&bytes).map_err(|_| error())?;
        offset += count as u64;
    }
    temp.flush()
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| error())?;
    // Close the writable handle before making the completed file visible.
    let mut temp = temp.into_temp_path();
    for index in 0..10_000 {
        current()?;
        let target = if index == 0 {
            destination.to_owned()
        } else {
            parent.join(format!("{stem} ({index}){extension}"))
        };
        match temp.persist_noclobber(&target) {
            Ok(()) => return Ok(target),
            Err(failure) if failure.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temp = failure.path;
            }
            Err(_) => return Err(error()),
        }
    }
    Err(error())
}
