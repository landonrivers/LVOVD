//! A native-selected destination, never a frontend-supplied filesystem path.
use crate::{AppError, Result, processing_operation::OutputLease};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

/// Bind a native-picked destination to its filesystem identity across a save or reveal.
pub fn destination_id(path: &Path) -> Result<(u64, u64)> {
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

pub fn save_copy(result: OutputLease, destination: &Path) -> Result<PathBuf> {
    save_copy_checked(result, destination, || Ok(()))
}

pub(crate) fn save_copy_checked(
    result: OutputLease,
    destination: &Path,
    mut current: impl FnMut() -> Result<()>,
) -> Result<PathBuf> {
    let folder = destination.parent().ok_or_else(save_error)?;
    current()?;
    let identity = destination_id(folder).map_err(|_| save_error())?;
    let check_current = || {
        if destination_id(folder)? != identity {
            return Err(AppError::new(
                "FOLDER_CHANGED",
                "The selected folder was replaced while saving.",
            ));
        }
        current()
    };
    publish(
        destination,
        None,
        |temp, current| {
            let mut offset = 0;
            while offset < result.descriptor().size {
                current()?;
                let count = (result.descriptor().size - offset).min(1024 * 1024) as usize;
                let bytes = result.read(offset, count)?;
                temp.write_all(&bytes).map_err(|_| save_error())?;
                offset += count as u64;
            }
            current()
        },
        check_current,
    )
    .map(|(path, _)| path)
}

fn save_error() -> AppError {
    AppError::new(
        "SAVE_FAILED",
        "Could not save this file. The prepared result remains available; choose another folder or retry.",
    )
}

pub(crate) fn save_download(
    source: &Path,
    seal: &crate::owned_file::Seal,
    destination: &Path,
    suffix: &str,
    check_directory: impl Fn() -> Result<()>,
) -> Result<(PathBuf, crate::owned_file::Seal)> {
    check_directory()?;
    seal.check(source)?;
    let mut source_file = File::open(source).map_err(|_| save_error())?;
    publish(
        destination,
        Some(suffix),
        |temp, _| {
            let mut buffer = vec![0; 1024 * 1024];
            loop {
                let size = source_file.read(&mut buffer).map_err(|_| save_error())?;
                if size == 0 {
                    break;
                }
                temp.write_all(&buffer[..size]).map_err(|_| save_error())?;
            }
            Ok(())
        },
        || {
            check_directory()?;
            seal.check(source)
        },
    )
}

fn publish(
    destination: &Path,
    suffix: Option<&str>,
    write_bytes: impl FnOnce(&mut File, &mut dyn FnMut() -> Result<()>) -> Result<()>,
    mut current: impl FnMut() -> Result<()>,
) -> Result<(PathBuf, crate::owned_file::Seal)> {
    let error = save_error;
    let parent = destination
        .parent()
        .filter(|p| p.is_absolute())
        .ok_or_else(error)?;
    let name = destination.file_name().ok_or_else(error)?.to_string_lossy();
    let extension = suffix
        .map(|s| format!(".{s}"))
        .or_else(|| {
            destination
                .extension()
                .map(|s| format!(".{}", s.to_string_lossy()))
        })
        .unwrap_or_default();
    let stem = name.strip_suffix(&extension).ok_or_else(error)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".lvovd-save-")
        .tempfile_in(parent)
        .map_err(|_| error())?;
    write_bytes(temp.as_file_mut(), &mut current)?;
    temp.flush()
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| error())?;
    // Close the writable handle before making the completed file visible.
    let mut temp = temp.into_temp_path();
    let seal = crate::owned_file::Seal::capture(&temp)?;
    for index in 0..10_000 {
        current()?;
        let target = if index == 0 {
            destination.to_owned()
        } else {
            parent.join(format!("{stem} ({index}){extension}"))
        };
        match temp.persist_noclobber(&target) {
            Ok(()) => return Ok((target, seal)),
            Err(failure) if failure.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temp = failure.path;
            }
            Err(_) => return Err(error()),
        }
    }
    Err(error())
}
