fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        let output = std::process::Command::new("pkg-config")
            .args(["--variable=pluginsdir", "gstreamer-1.0"])
            .output()
            .expect("GStreamer development files are required");
        assert!(
            output.status.success(),
            "Could not locate system GStreamer plugins"
        );
        let plugins =
            String::from_utf8(output.stdout).expect("GStreamer plugin path must be UTF-8");
        let plugins = plugins.trim();
        assert!(
            std::path::Path::new(plugins).is_absolute(),
            "GStreamer plugin path must be absolute"
        );
        println!("cargo:rustc-env=LVOVD_SYSTEM_GST_PLUGINS={plugins}");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_handshake",
            "runtime_health",
            "create_workbench",
            "list_workbenches",
            "subscribe_workbench",
            "acknowledge_workbench",
            "review_processing",
            "queue_processing",
            "cancel_processing",
            "discard_workbench",
            "cleanup_workbench",
            "pick_source",
            "remove_source",
            "shutdown_desktop",
        ]),
    ))
    .expect("build Tauri permission manifest");
}
