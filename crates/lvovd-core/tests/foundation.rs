use lvovd_core::{
    assets::Assets,
    media,
    process::{self, CancellationToken},
    tools::Tools,
};
use std::{ffi::OsString, path::PathBuf, sync::Arc, time::Duration};

fn node() -> PathBuf {
    std::env::var_os("LVOVD_DESKTOP_NODE")
        .map(PathBuf::from)
        .expect("tests require the explicit Node fixture-tool path")
}
fn args(script: &str) -> Vec<OsString> {
    vec!["-e".into(), script.into()]
}

#[tokio::test]
async fn commands_are_bounded_and_cancellable() {
    let cancel = CancellationToken::new();
    let output = process::run(
        &node(),
        &args("process.stdout.write('ok')"),
        Duration::from_secs(5),
        1024,
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(output.stdout, b"ok");
    let failed = process::run(
        &node(),
        &args("process.exit(2)"),
        Duration::from_secs(5),
        1024,
        &cancel,
    )
    .await
    .unwrap_err();
    assert_eq!(failed.code, "TOOL_FAILED");
    let huge = process::run(
        &node(),
        &args("process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"),
        Duration::from_secs(5),
        1024,
        &cancel,
    )
    .await
    .unwrap_err();
    assert_eq!(huge.code, "TOOL_OUTPUT_LIMIT");
    let timeout = process::run(
        &node(),
        &args("setInterval(()=>{},1000)"),
        Duration::from_millis(100),
        1024,
        &cancel,
    )
    .await
    .unwrap_err();
    assert_eq!(timeout.code, "TOOL_TIMEOUT");
    let token = cancel.clone();
    let task = tokio::spawn(async move {
        process::run(
            &node(),
            &args("setInterval(()=>{},1000)"),
            Duration::from_secs(30),
            1024,
            &token,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    cancel.cancel();
    assert_eq!(task.await.unwrap().unwrap_err().code, "CANCELLED");
}

#[tokio::test]
async fn missing_health_finishes_without_paths_in_errors() {
    let root = tempfile::tempdir().unwrap();
    let health = Tools::bundled(root.path())
        .health(&CancellationToken::new())
        .await;
    assert!(!health.ffprobe.installed);
    assert!(!health.ffmpeg.installed);
    assert!(!health.ytdlp.installed);
    assert!(
        !health
            .ffprobe
            .error
            .unwrap()
            .contains(root.path().to_str().unwrap())
    );
}

fn wav(path: &std::path::Path) {
    let frames = 48000u32;
    let data = frames * 2;
    let mut b = b"RIFF".to_vec();
    b.extend((36 + data).to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(48000u32.to_le_bytes());
    b.extend(96000u32.to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend(data.to_le_bytes());
    b.resize(b.len() + data as usize, 0);
    std::fs::write(path, b).unwrap();
}

#[tokio::test]
async fn owned_media_ranges_revocation_and_cleanup_preserve_original() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("synthetic audio.wav");
    wav(&input);
    let original = std::fs::read(&input).unwrap();
    let assets = Arc::new(Assets::new(temp.path()).unwrap());
    let ffprobe = PathBuf::from(
        std::env::var_os("LVOVD_DESKTOP_FFPROBE").expect("FFprobe is required, never skipped"),
    );
    let source = assets.import(&input, &ffprobe).await.unwrap();
    assert_eq!(source.inspection.streams[0].bits_per_sample, Some(16));
    let url = format!("lvovd-media://localhost/{}", source.asset_id);
    let response = media::respond(
        &assets,
        http::Request::builder()
            .uri(&url)
            .header("range", "bytes=10-19")
            .body(vec![])
            .unwrap(),
        "main",
    );
    assert_eq!(response.status(), 206);
    assert_eq!(response.body(), &original[10..20]);
    for (address, origin, window, expected) in [
        (url.as_str(), "https://evil.invalid", "main", 403),
        (url.as_str(), "tauri://localhost", "other", 403),
        (
            "lvovd-media://localhost/../secrets",
            "tauri://localhost",
            "main",
            404,
        ),
        (
            "http://lvovd-media.evil.invalid/x",
            "tauri://localhost",
            "main",
            403,
        ),
    ] {
        let request = http::Request::builder()
            .uri(address)
            .header("origin", origin)
            .body(vec![])
            .unwrap();
        assert_eq!(media::respond(&assets, request, window).status(), expected);
    }
    let lease = assets.lease(source.asset_id).unwrap();
    assert!(!assets.remove(source.asset_id).unwrap().cleanup_complete);
    assert!(!assets.retry_pending_cleanup());
    assert_eq!(assets.pending_cleanup(), [source.asset_id]);
    assert!(assets.lease(source.asset_id).is_err());
    assert!(lease.read(0, 4).is_err());
    drop(lease);
    assert!(assets.retry_pending_cleanup());
    assert!(assets.pending_cleanup().is_empty());
    assert!(!assets.retry_pending_cleanup());
    assert!(assets.remove(source.asset_id).unwrap().cleanup_complete);
    assert!(assets.remove(source.asset_id).unwrap().cleanup_complete);
    assert_eq!(std::fs::read(input).unwrap(), original);
    assets.shutdown().await.unwrap();
}
