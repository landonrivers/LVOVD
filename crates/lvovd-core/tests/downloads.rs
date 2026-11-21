use lvovd_core::{
    downloads::{DownloadSnapshot, DownloadStatus, Downloads, Profile},
    process::{self, CancellationToken},
    tools::Tools,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::watch,
};
use uuid::Uuid;

fn tools() -> Tools {
    fn path(key: &str) -> PathBuf {
        std::env::var_os(format!("LVOVD_DESKTOP_{key}"))
            .expect("an explicit fixture tool is required")
            .into()
    }
    Tools {
        ffprobe: path("FFPROBE"),
        ffmpeg: path("FFMPEG"),
        ytdlp: path("YTDLP"),
        node: path("NODE"),
    }
}
async fn fixture(tools: &Tools, destination: &Path, video: bool) -> Vec<u8> {
    let mut inputs = vec!["-hide_banner", "-loglevel", "error"];
    if video {
        inputs.extend(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10"]);
    }
    inputs.extend(["-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "1"]);
    if video {
        inputs.extend(["-c:v", "libx264"]);
    }
    inputs.extend(["-c:a", "aac", "-movflags", "+faststart"]);
    let args = inputs
        .into_iter()
        .map(Into::into)
        .chain([destination.as_os_str().to_owned()])
        .collect::<Vec<_>>();
    process::run(
        &tools.ffmpeg,
        &args,
        Duration::from_secs(30),
        64 * 1024,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    std::fs::read(destination).unwrap()
}

async fn wait_for(rx: &mut watch::Receiver<DownloadSnapshot>, id: Uuid, status: DownloadStatus) {
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Some(row) = rx.borrow_and_update().jobs.iter().find(|j| j.job_id == id) {
                if row.status == status {
                    break;
                }
                assert_ne!(
                    row.status,
                    DownloadStatus::Failed,
                    "unexpected provider failure: {:?}",
                    row.error
                );
            }
            rx.changed().await.unwrap();
        }
    })
    .await
    .expect("download did not reach expected state");
}

#[tokio::test]
async fn real_single_url_review_acquire_retry_cancel_and_collision_safe_publication() {
    let root = tempfile::tempdir().unwrap();
    let tools = tools();
    let bytes = Arc::new(fixture(&tools, &root.path().join("fixture.mp4"), true).await);
    let audio_only = Arc::new(fixture(&tools, &root.path().join("audio.mp4"), false).await);
    let source = Arc::new(std::sync::Mutex::new(bytes.clone()));
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}/fixture.mp4", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let stalled = Arc::new(AtomicBool::new(false));
    let stop = CancellationToken::new();
    let server = tokio::spawn({
        let source = source.clone();
        let requests = requests.clone();
        let stalled = stalled.clone();
        let stop = stop.clone();
        async move {
            loop {
                let (mut socket, _) = tokio::select! { _=stop.cancelled()=>return, incoming=listener.accept()=>incoming.unwrap() };
                let bytes = source.lock().unwrap().clone();
                let stall = stalled.load(Ordering::SeqCst);
                let stop = stop.clone();
                let requests = requests.clone();
                tokio::spawn(async move {
                    let mut request = [0; 8192];
                    let Ok(used) = socket.read(&mut request).await else {
                        return;
                    };
                    let line = String::from_utf8_lossy(&request[..used]);
                    let method = line.split_ascii_whitespace().next().unwrap_or("");
                    if !matches!(method, "HEAD" | "GET") || !line.contains(" /fixture.mp4 ") {
                        return;
                    }
                    requests.fetch_add(1, Ordering::SeqCst);
                    if stall {
                        stop.cancelled().await;
                        return;
                    }
                    let headers = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    );
                    if socket.write_all(headers.as_bytes()).await.is_ok() && method == "GET" {
                        let _ = socket.write_all(&bytes).await;
                    }
                });
            }
        }
    });
    let manager = Downloads::new(&root.path().join("sessions"), tools).unwrap();
    let mut events = manager.subscribe();
    let (one, two) = tokio::join!(manager.preview(url.clone()), manager.preview(url.clone()));
    let view = one.unwrap();
    assert_eq!(view.preview_id, two.unwrap().preview_id);
    assert!(view.can_download);
    assert_eq!(view.profile, Profile::Maximum);
    assert!(view.filename.ends_with(".mp4"));
    assert!(view.artwork.is_none());
    let output = root.path().join("output");
    std::fs::create_dir(&output).unwrap();
    assert!(manager.enqueue(Uuid::new_v4(), output.clone()).is_err());
    let job = manager
        .enqueue(view.preview_id, output.clone())
        .unwrap()
        .jobs[0]
        .job_id;
    std::fs::remove_dir(&output).unwrap(); // destination disconnected after admission
    wait_for(&mut events, job, DownloadStatus::SaveFailed).await;
    assert!(manager.needs_quit_confirmation());
    let finished = manager.snapshot();
    let progress = finished.jobs[0]
        .progress
        .as_ref()
        .expect("real yt-dlp emitted progress");
    assert_eq!(progress.percent, Some(100.0));
    let requests_before_retry = requests.load(Ordering::SeqCst);
    std::fs::create_dir(&output).unwrap();
    std::fs::write(output.join(&view.filename), b"earlier file").unwrap();
    manager.retry_save(job, output.clone()).unwrap();
    wait_for(&mut events, job, DownloadStatus::Saved).await;
    assert_eq!(requests.load(Ordering::SeqCst), requests_before_retry);
    let saved = manager.exported_path(job).unwrap();
    assert_ne!(saved, output.join(&view.filename));
    assert_eq!(std::fs::read(&saved).unwrap(), *bytes);
    assert_eq!(
        std::fs::read(output.join(&view.filename)).unwrap(),
        b"earlier file"
    );

    stalled.store(true, Ordering::SeqCst);
    let first = manager
        .enqueue(view.preview_id, output.clone())
        .unwrap()
        .jobs
        .last()
        .unwrap()
        .job_id;
    let second = manager
        .enqueue(view.preview_id, output.clone())
        .unwrap()
        .jobs
        .last()
        .unwrap()
        .job_id;
    manager.cancel(second).unwrap();
    wait_for(&mut events, first, DownloadStatus::Downloading).await;
    tokio::time::timeout(Duration::from_secs(30), async {
        while requests.load(Ordering::SeqCst) == requests_before_retry {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the queued worker reached the source");
    manager.cancel(first).unwrap();
    wait_for(&mut events, first, DownloadStatus::Cancelled).await;
    assert_eq!(
        manager.snapshot().jobs.last().unwrap().status,
        DownloadStatus::Cancelled
    );
    assert!(!manager.needs_quit_confirmation());
    // The original URL now serves an audio-only MP4. Reuse the review to
    // exercise validation of the actual downloaded streams before publication.
    stalled.store(false, Ordering::SeqCst);
    *source.lock().unwrap() = audio_only;
    let changed = manager
        .enqueue(view.preview_id, output.clone())
        .unwrap()
        .jobs
        .last()
        .unwrap()
        .job_id;
    wait_for(&mut events, changed, DownloadStatus::Failed).await;
    assert!(manager.exported_path(changed).is_err());
    assert_eq!(std::fs::read_dir(&output).unwrap().count(), 2);
    std::fs::write(&saved, b"replaced content").unwrap();
    assert!(manager.exported_path(job).is_err());
    manager.shutdown().await.unwrap();
    assert!(saved.exists());
    stop.cancel();
    server.await.unwrap();
}
