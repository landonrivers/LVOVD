fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_handshake",
            "runtime_health",
            "subscribe_sources",
            "pick_source",
            "remove_source",
            "shutdown_desktop",
        ]),
    ))
    .expect("build Tauri permission manifest");
}
