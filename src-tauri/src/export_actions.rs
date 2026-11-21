//! Only the Rust download owner can resolve a saved result to this path.
use lvovd_core::{AppError, Result};
use std::path::Path;

pub(crate) fn show(path: &Path, reveal: bool) -> Result<()> {
    if platform_show(path, reveal) {
        Ok(())
    } else {
        Err(AppError::new(
            "EXPORT_OPEN",
            if reveal {
                "Could not show the saved file in its folder."
            } else {
                "Could not open this video. Use Show in Folder to choose a player."
            },
        ))
    }
}

#[cfg(target_os = "macos")]
fn platform_show(path: &Path, reveal: bool) -> bool {
    let mut open = std::process::Command::new("/usr/bin/open");
    if reveal {
        open.arg("-R");
    }
    open.arg(path).status().is_ok_and(|s| s.success())
}

#[cfg(target_os = "linux")]
fn platform_show(path: &Path, reveal: bool) -> bool {
    use gio::prelude::*;
    let target = if reveal {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    gio::AppInfo::launch_default_for_uri(
        &gio::File::for_path(target).uri(),
        None::<&gio::AppLaunchContext>,
    )
    .is_ok()
}

#[cfg(target_os = "windows")]
fn platform_show(path: &Path, reveal: bool) -> bool {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
        UI::{
            Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems, ShellExecuteW},
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    };
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // Calls run on a blocking worker. Keep its COM apartment balanced, including S_FALSE.
    unsafe {
        let initialized = CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32);
        let opened = if reveal {
            let item = ILCreateFromPathW(path.as_ptr());
            if item.is_null() {
                false
            } else {
                let result = SHOpenFolderAndSelectItems(item, 0, ptr::null(), 0);
                ILFree(item);
                result >= 0
            }
        } else {
            (ShellExecuteW(
                ptr::null_mut(),
                ptr::null(),
                path.as_ptr(),
                ptr::null(),
                ptr::null(),
                SW_SHOWNORMAL,
            ) as isize)
                > 32
        };
        if initialized >= 0 {
            CoUninitialize();
        }
        opened
    }
}
