use super::*;
use std::sync::{
    Mutex as StdMutex,
    atomic::{AtomicUsize, Ordering},
};

struct Fixture {
    mode: AtomicUsize,
    calls: StdMutex<Vec<Vec<String>>>,
    started: tokio::sync::Notify,
}
impl Runner for Arc<Fixture> {
    fn run<'a>(&'a self, args: &'a [&'a str], cancel: &'a CancellationToken) -> Run<'a> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push(args.iter().map(|s| (*s).into()).collect());
            self.started.notify_one();
            let output = match args {
                ["-version"] => "ffmpeg version 7.1-synthetic\n",
                ["-hide_banner", "-encoders"] => " V..... libx264 software\n A..... aac audio\n",
                ["-hide_banner", "-decoders"] => " V....D h264 software\n A....D aac audio\n",
                ["-hide_banner", "-muxers"] => " E mp4 MP4\n",
                _ => panic!("discovery admitted an unexpected command"),
            };
            let mode = self.mode.load(Ordering::SeqCst);
            let script = match mode {
                1 => "process.stderr.write('/synthetic/private/tool failed');process.exit(1)".into(),
                2 | 5 => "setInterval(()=>{},1000)".into(),
                3 => "process.stdout.write('x'.repeat(600));process.stderr.write('y'.repeat(600));setInterval(()=>{},1000)".into(),
                4 => "process.stdout.write('unrecognized listing')".into(),
                _ => format!("process.stdout.write({})", serde_json::to_string(output).unwrap()),
            };
            let node = PathBuf::from(
                std::env::var_os("LVOVD_DESKTOP_NODE").expect("explicit Node fixture-tool path"),
            );
            process::run(
                &node,
                &["-e".into(), script.into()],
                if mode == 2 {
                    Duration::from_millis(50)
                } else {
                    Duration::from_secs(5)
                },
                1024,
                cancel,
            )
            .await
        })
    }
}
fn fixture(mode: usize) -> (CapabilityDiscovery, Arc<Fixture>) {
    let runner = Arc::new(Fixture {
        mode: AtomicUsize::new(mode),
        calls: StdMutex::new(vec![]),
        started: tokio::sync::Notify::new(),
    });
    (
        CapabilityDiscovery {
            runner: Box::new(runner.clone()),
            cached: Mutex::new(None),
        },
        runner,
    )
}
#[tokio::test]
async fn concurrent_discovery_uses_four_fixed_commands_once() {
    let (discovery, runner) = fixture(0);
    let cancel = CancellationToken::new();
    let (a, b) = tokio::join!(discovery.get(&cancel), discovery.get(&cancel));
    let a = a.unwrap();
    let b = b.unwrap();
    assert!(a.available);
    assert!(Arc::ptr_eq(&a, &b));
    assert_eq!(runner.calls.lock().unwrap().len(), 4);
    assert_eq!(a.software_decoder("h264"), Some("h264"));
    cancel.cancel();
    assert_eq!(discovery.get(&cancel).await.unwrap_err().code, "CANCELLED");
}
#[tokio::test]
async fn failed_discovery_is_bounded_redacted_and_retried_after_cooldown() {
    for (mode, reason) in [
        (1, FailureReason::CommandFailed),
        (2, FailureReason::Timeout),
        (3, FailureReason::OutputLimit),
        (4, FailureReason::Unparseable),
    ] {
        let (discovery, runner) = fixture(mode);
        let cancel = CancellationToken::new();
        let failed = discovery.get(&cancel).await.unwrap();
        assert_eq!(failed.failure_reason, Some(reason));
        assert!(!failed.available);
        assert!(failed.encoders.is_empty());
        assert!(
            !serde_json::to_string(&failed.public_summary())
                .unwrap()
                .contains("private")
        );
        let count = runner.calls.lock().unwrap().len();
        runner.mode.store(0, Ordering::SeqCst);
        assert!(Arc::ptr_eq(&failed, &discovery.get(&cancel).await.unwrap()));
        assert_eq!(runner.calls.lock().unwrap().len(), count);
        discovery.cached.lock().await.as_mut().unwrap().retry_after =
            Some(Instant::now() - Duration::from_secs(1));
        assert!(discovery.get(&cancel).await.unwrap().available);
        assert_eq!(runner.calls.lock().unwrap().len(), count + 4);
    }
}
#[tokio::test]
async fn cancellation_is_not_cached_and_a_waiter_does_not_cancel_the_owner() {
    let (discovery, runner) = fixture(5);
    let discovery = Arc::new(discovery);
    let cancel = CancellationToken::new();
    let task_discovery = discovery.clone();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move { task_discovery.get(&task_cancel).await });
    runner.started.notified().await;
    let waiter = CancellationToken::new();
    waiter.cancel();
    assert_eq!(discovery.get(&waiter).await.unwrap_err().code, "CANCELLED");
    assert!(!task.is_finished());
    cancel.cancel();
    assert_eq!(task.await.unwrap().unwrap_err().code, "CANCELLED");
    assert!(discovery.cached.lock().await.is_none());
    runner.mode.store(0, Ordering::SeqCst);
    assert!(
        discovery
            .get(&CancellationToken::new())
            .await
            .unwrap()
            .available
    );
}
#[tokio::test]
async fn missing_tools_and_relative_paths_are_unavailable_without_path_disclosure() {
    let root = tempfile::tempdir().unwrap();
    for path in [
        root.path().join("private-missing-ffmpeg"),
        PathBuf::from("relative-ffmpeg"),
    ] {
        let result = CapabilityDiscovery::new(path)
            .get(&CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.failure_reason, Some(FailureReason::SpawnFailed));
        assert!(!serde_json::to_string(&*result).unwrap().contains("private"));
    }
}
#[test]
fn oversized_listings_and_missing_capabilities_are_not_guessed() {
    for output in [
        "x".repeat(MAX_OUTPUT_BYTES + 1),
        "\n".repeat(10000),
        "x".repeat(4097),
    ] {
        assert!(parse_codecs(&output).is_err());
        assert!(parse_decoders(&output).is_err());
        assert!(parse_muxers(&output).is_err());
    }
    let c = from_listings(
        "ffmpeg version 7.1",
        " A..... flac FLAC",
        " V....D h264_cuvid CUDA (codec h264)",
        " E flac FLAC",
    )
    .unwrap();
    assert!(c.available);
    assert_eq!(c.software_decoder("h264"), None);
    assert_eq!(c.public_summary()["broadMp4"]["aacEncoder"], false);
    assert_eq!(c.public_summary()["broadMp4"]["mp4Muxer"], false);
}
