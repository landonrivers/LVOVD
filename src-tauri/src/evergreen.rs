//! Check the shared runtime before creating a webview so failures have a native dialog.
use sha2::{Digest, Sha256};
use std::{fs::OpenOptions, io, os::windows::fs::OpenOptionsExt, process::Command};
use windows_sys::Win32::UI::{
    Shell::IsUserAnAdmin,
    WindowsAndMessaging::{IDYES, MB_ICONERROR, MB_ICONQUESTION, MB_YESNO, MessageBoxW},
};

fn message(text: &str, style: u32) -> i32 {
    let title: Vec<u16> = "LVOVD\0".encode_utf16().collect();
    let text: Vec<u16> = text.encode_utf16().chain([0]).collect();
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), style) }
}

fn installed() -> bool {
    // The stable runtime reports four numeric components. Preview browser
    // channels append a suffix and cannot satisfy the Evergreen prerequisite.
    tauri::webview_version().is_ok_and(|version| {
        let parts: Vec<_> = version.split('.').collect();
        parts.len() == 4 && parts.iter().all(|part| part.parse::<u32>().is_ok())
    })
}

fn install() -> Result<(), &'static str> {
    let path = std::env::current_exe()
        .ok()
        .and_then(|p| {
            p.parent()
                .map(|p| p.join("prerequisites/MicrosoftEdgeWebView2RuntimeInstallerX64.exe"))
        })
        .ok_or("Open LVOVD from its extracted portable folder.")?;
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(1) // FILE_SHARE_READ; keep the checked bytes stable until installer exit.
        .open(&path)
        .map_err(|_| "The WebView2 installer is missing. Extract the complete LVOVD ZIP and reopen the application.")?;
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../distribution/provider-tools.json"))
            .map_err(|_| "The LVOVD package is incomplete. Extract a fresh copy.")?;
    let size = file
        .metadata()
        .map_err(|_| "Cannot read the WebView2 installer.")?
        .len();
    let pinned = &manifest["evergreen"];
    let mut hash = Sha256::new();
    if Some(size) != pinned["bytes"].as_u64()
        || io::copy(&mut file, &mut hash).is_err()
        || Some(format!("{:x}", hash.finalize()).as_str()) != pinned["sha256"].as_str()
    {
        return Err("The WebView2 installer failed verification. Extract a fresh LVOVD ZIP.");
    }
    if unsafe { IsUserAnAdmin() } != 0 {
        return Err("Reopen LVOVD as a regular user to install Evergreen for your account.");
    }
    let status = Command::new(path)
        .args(["/silent", "/install"])
        .status()
        .map_err(
            |_| "Windows could not start the WebView2 installer. Check your installation policy.",
        )?;
    if !status.success() || !installed() {
        return Err(
            "WebView2 installation did not complete. Check Windows installation policy and reopen LVOVD.",
        );
    }
    Ok(())
}

pub fn ready() -> bool {
    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some() {
        message(
            "LVOVD requires Evergreen WebView2. Remove the fixed-runtime override for this application and reopen it.",
            MB_ICONERROR,
        );
        return false;
    }
    if installed() {
        return true;
    }
    if message(
        "LVOVD needs Microsoft Edge WebView2 Runtime. Install the bundled Evergreen runtime for your Windows account?",
        MB_YESNO | MB_ICONQUESTION,
    ) != IDYES
    {
        return false;
    }
    match install() {
        Ok(()) => true,
        Err(error) => {
            message(error, MB_ICONERROR);
            false
        }
    }
}
