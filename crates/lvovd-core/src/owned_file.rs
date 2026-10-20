//! Evidence for an immutable owned file. This detects replacement and links; it
//! is not an OS sandbox against another process running as the same user.
use crate::{AppError, Result};
use std::{fs::File, path::Path, time::SystemTime};

#[derive(Debug, PartialEq)]
pub(crate) struct Seal {
    identity: (u64, u64),
    length: u64,
    modified: SystemTime,
}
fn changed() -> AppError {
    AppError::new(
        "SOURCE_CHANGED",
        "The owned media changed or is unavailable. Remove the entry and choose the file again.",
    )
}
impl Seal {
    pub(crate) fn capture(path: &Path) -> Result<Self> {
        let entry = std::fs::symlink_metadata(path).map_err(|_| changed())?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if entry.file_attributes() & 0x400 != 0 {
                return Err(changed());
            }
        }
        if !entry.is_file() || entry.file_type().is_symlink() {
            return Err(changed());
        }
        let file = File::open(path).map_err(|_| changed())?;
        let metadata = file.metadata().map_err(|_| changed())?;
        let (identity, links) = identity(&file)?;
        if !metadata.is_file() || links != 1 {
            return Err(changed());
        }
        Ok(Self {
            identity,
            length: metadata.len(),
            modified: metadata.modified().map_err(|_| changed())?,
        })
    }
    pub(crate) fn check(&self, path: &Path) -> Result<()> {
        if Self::capture(path)? != *self {
            return Err(changed());
        }
        Ok(())
    }
}
#[cfg(unix)]
fn identity(file: &File) -> Result<((u64, u64), u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = file.metadata().map_err(|_| changed())?;
    Ok(((m.dev(), m.ino()), m.nlink()))
}
#[cfg(windows)]
fn identity(file: &File) -> Result<((u64, u64), u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: file owns the handle, and info is a correctly sized writable buffer.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(changed());
    }
    // Reject every reparse-point kind, including non-symlink Windows redirects.
    if info.dwFileAttributes & 0x400 != 0 {
        return Err(changed());
    }
    Ok((
        (
            info.dwVolumeSerialNumber as u64,
            (info.nFileIndexHigh as u64) << 32 | info.nFileIndexLow as u64,
        ),
        info.nNumberOfLinks as u64,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacements_mutations_and_hardlinks_are_not_owned_bytes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("owned");
        std::fs::write(&path, b"first").unwrap();
        let seal = Seal::capture(&path).unwrap();
        seal.check(&path).unwrap();
        let alias = root.path().join("alias");
        std::fs::hard_link(&path, &alias).unwrap();
        assert!(seal.check(&path).is_err());
        std::fs::remove_file(alias).unwrap();
        std::fs::write(&path, b"changed length").unwrap();
        assert!(seal.check(&path).is_err());
        let other = root.path().join("other");
        std::fs::write(&other, b"first").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(other, &path).unwrap();
        assert!(seal.check(&path).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_owned() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("original");
        let link = root.path().join("link");
        std::fs::write(&target, b"keep").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(Seal::capture(&link).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"keep");
    }
}
