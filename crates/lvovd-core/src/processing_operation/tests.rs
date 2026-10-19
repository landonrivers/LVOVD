use super::*;
use crate::capabilities::CapabilityDiscovery;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

type Mutation = Box<dyn Fn(&Path) + Send + Sync>;
#[derive(Default)]
pub(super) struct Hooks {
    mutate: Mutex<Option<Mutation>>,
    pause: AtomicBool,
    arrived: tokio::sync::Notify,
    resume: tokio::sync::Notify,
    pub(super) fail_cleanup: AtomicBool,
    attempts: AtomicUsize,
}
impl Hooks {
    pub(super) async fn after_encode(&self, output: &Path) {
        self.attempts.fetch_add(1, Ordering::AcqRel);
        if let Some(mutate) = self.mutate.lock().unwrap().as_ref() {
            mutate(output);
        }
        if self.pause.load(Ordering::Acquire) {
            self.arrived.notify_one();
            self.resume.notified().await;
        }
    }
}
fn tool(name: &str) -> PathBuf {
    std::env::var_os(format!("LVOVD_DESKTOP_{name}"))
        .expect("required generated-media tool")
        .into()
}
async fn caps() -> Arc<Capabilities> {
    static CAPS: tokio::sync::OnceCell<Arc<Capabilities>> = tokio::sync::OnceCell::const_new();
    CAPS.get_or_init(|| async {
        CapabilityDiscovery::new(tool("FFMPEG"))
            .get(&CancellationToken::new())
            .await
            .unwrap()
    })
    .await
    .clone()
}
struct Fixture {
    root: tempfile::TempDir,
    original: PathBuf,
    original_bytes: Vec<u8>,
    assets: Assets,
    processing: Processing,
    id: Uuid,
}
impl Fixture {
    async fn new(video: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join(if video {
            "original ü.mp4"
        } else {
            "original ü.wav"
        });
        let mut args: Vec<std::ffi::OsString> =
            ["-hide_banner", "-v", "error", "-f", "lavfi", "-i"]
                .map(Into::into)
                .into();
        if video {
            args.extend(
                [
                    "testsrc2=size=160x120:rate=24:duration=2",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=441:sample_rate=48000:duration=2",
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-map",
                    "1:a:0",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-c:a",
                    "aac",
                ]
                .map(Into::into),
            );
        } else {
            args.extend(
                [
                    "sine=frequency=441:sample_rate=48000:duration=1",
                    "-c:a",
                    "pcm_s16le",
                ]
                .map(Into::into),
            );
        }
        args.push(original.as_os_str().into());
        process::run(
            &tool("FFMPEG"),
            &args,
            Duration::from_secs(30),
            1024 * 1024,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let original_bytes = std::fs::read(&original).unwrap();
        let assets = Assets::new(root.path()).unwrap();
        let source = assets.import(&original, &tool("FFPROBE")).await.unwrap();
        let processing = Processing::new(
            assets.clone(),
            root.path(),
            tool("FFMPEG"),
            tool("FFPROBE"),
            Limits {
                maximum_bytes: 10 * 1024 * 1024,
                worker_deadline: Duration::from_secs(30),
            },
        )
        .unwrap();
        Self {
            root,
            original,
            original_bytes,
            assets,
            processing,
            id: source.asset_id,
        }
    }
    async fn review(&self, revision: u32, settings: Value) -> ReviewedPlan {
        self.processing
            .review(
                ReviewRequest {
                    source_id: self.id,
                    draft_revision: revision,
                    settings: Some(settings),
                    edit_plan: None,
                },
                Some(caps().await),
            )
            .await
            .unwrap()
    }
    async fn prepare(&self, review: &ReviewedPlan) -> Prepared {
        let acknowledgements = review.document()["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|w| w["id"].as_str().map(String::from))
            .collect();
        self.processing
            .prepare(self.id, review.key().into(), acknowledgements)
            .await
            .unwrap()
    }
    async fn run(&self, review: &ReviewedPlan) -> Outcome<Published> {
        let (progress, _latest) = tokio::sync::watch::channel(Progress::default());
        self.processing
            .run(self.prepare(review).await, progress)
            .await
    }
    async fn finish(self) {
        assert_eq!(
            std::fs::read(&self.original).unwrap(),
            self.original_bytes,
            "the user's original never changes"
        );
        self.processing.shutdown().await.unwrap();
        self.assets.shutdown().await.unwrap();
        assert!(self.original.exists());
    }
}
fn flac() -> Value {
    json!({"container":"flac","audio":{"codec":"flac"}})
}
async fn wait_for_idle(owner: &Processing) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if owner
                .0
                .registry
                .lock()
                .unwrap()
                .slots
                .values()
                .all(|s| s.active.is_none())
                && owner.pending_cleanup() == 0
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
fn request_code(error: Error) -> &'static str {
    match error {
        Error::Request(e) => e.code,
        other => panic!("expected request failure: {other:?}"),
    }
}

#[tokio::test]
async fn admission_binds_source_owner_review_warnings_and_immutable_revision() {
    let f = Fixture::new(true).await;
    let first = f.review(1, flac()).await;
    // Lossy AAC cannot use strict FLAC. WAV also omits the extra audio stream,
    // which requires the reference workflow's explicit acknowledgement.
    assert!(!first.is_executable());
    let review = f
        .review(2, json!({"container":"wav","audio":{"codec":"pcm"}}))
        .await;
    assert!(
        review.document()["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w["required"] == true)
    );
    assert_eq!(
        f.processing
            .prepare(f.id, review.key().into(), vec![])
            .await
            .err()
            .unwrap()
            .code,
        "PROCESSING_WARNINGS"
    );
    assert_eq!(
        f.processing
            .prepare(Uuid::new_v4(), review.key().into(), vec![])
            .await
            .err()
            .unwrap()
            .code,
        "ASSET_GONE"
    );
    assert_eq!(
        f.processing
            .prepare(f.id, first.key().into(), vec![])
            .await
            .err()
            .unwrap()
            .code,
        "PROCESSING_STALE"
    );
    let job = f.prepare(&review).await;
    let revision3 = f.review(3, json!({})).await;
    assert_eq!(job.review().key(), review.key());
    assert_eq!(
        f.processing
            .review(
                ReviewRequest {
                    source_id: f.id,
                    draft_revision: 2,
                    settings: None,
                    edit_plan: None
                },
                Some(caps().await)
            )
            .await
            .unwrap_err()
            .code,
        "PROCESSING_STALE"
    );
    assert_eq!(
        f.processing
            .review(
                ReviewRequest {
                    source_id: f.id,
                    draft_revision: 3,
                    settings: Some(flac()),
                    edit_plan: None
                },
                Some(caps().await)
            )
            .await
            .unwrap_err()
            .code,
        "PROCESSING_STALE"
    );
    let (progress, _) = tokio::sync::watch::channel(Progress::default());
    let output = f.processing.run(job, progress).await.unwrap();
    assert_eq!(
        output.draft_revision, 2,
        "newer edits do not rewrite admitted work"
    );
    assert_eq!(output.review["key"], review.key());
    assert_ne!(output.review["key"], revision3.key());
    let other = Processing::new(
        f.assets.clone(),
        f.root.path(),
        tool("FFMPEG"),
        tool("FFPROBE"),
        Limits {
            maximum_bytes: 1000000,
            worker_deadline: Duration::from_secs(30),
        },
    )
    .unwrap();
    let other_review = other
        .review(
            ReviewRequest {
                source_id: f.id,
                draft_revision: 3,
                settings: None,
                edit_plan: None,
            },
            Some(caps().await),
        )
        .await
        .unwrap();
    assert_ne!(
        other_review.key(),
        revision3.key(),
        "reviews bind their owning session"
    );
    assert_eq!(
        other
            .prepare(f.id, revision3.key().into(), vec![])
            .await
            .err()
            .unwrap()
            .code,
        "PROCESSING_STALE"
    );
    let (progress, _) = tokio::sync::watch::channel(Progress::default());
    assert_eq!(
        request_code(
            other
                .run(f.prepare(&revision3).await, progress)
                .await
                .unwrap_err()
        ),
        "PROCESSING_STALE"
    );
    other.shutdown().await.unwrap();
    f.finish().await;
}

#[tokio::test]
async fn no_op_leases_exact_original_without_tools_or_source_retirement() {
    let mut f = Fixture::new(false).await;
    f.processing = Processing::new(
        f.assets.clone(),
        f.root.path(),
        f.root.path().join("missing-ffmpeg"),
        f.root.path().join("missing-ffprobe"),
        Limits {
            maximum_bytes: 1000000,
            worker_deadline: Duration::from_secs(1),
        },
    )
    .unwrap();
    let review = f
        .processing
        .review(
            ReviewRequest {
                source_id: f.id,
                draft_revision: 1,
                settings: None,
                edit_plan: None,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(review.document()["status"], "no-op");
    let output = f.run(&review).await.unwrap();
    let reader = f.processing.lease(output.result_id).unwrap();
    assert!(output.no_op);
    assert_eq!(
        reader.read(0, output.size as usize).unwrap(),
        f.original_bytes
    );
    let second = f
        .run(&f.review(2, json!({"filenameSuffix":"-second"})).await)
        .await
        .unwrap();
    assert_ne!(second.result_id, output.result_id);
    assert!(f.processing.lease(output.result_id).is_err());
    assert_eq!(reader.read(0, 4).unwrap(), b"RIFF");
    drop(reader);
    f.processing.cleanup().await.unwrap();
    assert!(
        f.assets.lease(f.id).is_ok(),
        "retiring an alias never retires its original"
    );
    assert!(
        !f.assets.remove(f.id).unwrap().cleanup_complete,
        "the current no-op result still leases source bytes"
    );
    assert!(f.processing.latest(f.id).is_none());
    assert!(f.processing.lease(second.result_id).is_err());
    f.processing.cleanup().await.unwrap();
    assert!(f.assets.retry_pending_cleanup());
    f.finish().await;
}

#[tokio::test]
async fn invalid_output_preserves_previous_result_and_replacement_preserves_readers() {
    let f = Fixture::new(false).await;
    let first = f.run(&f.review(1, flac()).await).await.unwrap();
    assert_eq!(
        f.processing
            .prepare(
                first.result_id,
                first.review["key"].as_str().unwrap().into(),
                vec![]
            )
            .await
            .err()
            .unwrap()
            .code,
        "ASSET_GONE",
        "a result is not an original processing source"
    );
    let reader = f.processing.lease(first.result_id).unwrap();
    let first_bytes = reader.read(0, first.size as usize).unwrap();
    assert_eq!(&first_bytes[..4], b"fLaC");
    // A tool can exit successfully yet produce a valid file in the wrong format.
    let original = f.original.clone();
    *f.processing.0.hooks.mutate.lock().unwrap() = Some(Box::new(move |path| {
        std::fs::copy(&original, path).unwrap();
    }));
    let error = f.run(&f.review(2, flac()).await).await.unwrap_err();
    assert!(matches!(error, Error::Validation(_)));
    assert_eq!(
        f.processing.latest(f.id).unwrap().result_id,
        first.result_id
    );
    assert_eq!(f.processing.pending_cleanup(), 0);
    assert_eq!(reader.read(0, first.size as usize).unwrap(), first_bytes);
    // A hardlink cannot convert an unowned original into a publishable output.
    let original = f.original.clone();
    *f.processing.0.hooks.mutate.lock().unwrap() = Some(Box::new(move |path| {
        std::fs::remove_file(path).unwrap();
        std::fs::hard_link(&original, path).unwrap();
    }));
    assert_eq!(
        request_code(f.run(&f.review(3, flac()).await).await.unwrap_err()),
        "PROCESSING_OUTPUT"
    );
    assert_eq!(
        f.processing.latest(f.id).unwrap().result_id,
        first.result_id
    );
    *f.processing.0.hooks.mutate.lock().unwrap() = None;
    let second = f.run(&f.review(4, flac()).await).await.unwrap();
    assert_ne!(second.result_id, first.result_id);
    assert!(f.processing.lease(first.result_id).is_err());
    assert_eq!(f.processing.pending_cleanup(), 1);
    assert_eq!(reader.read(0, first.size as usize).unwrap(), first_bytes);
    drop(reader);
    f.processing.cleanup().await.unwrap();
    assert_eq!(f.processing.pending_cleanup(), 0);
    f.finish().await;
}

#[tokio::test]
async fn queued_source_replacement_is_rejected_before_worker_start() {
    let f = Fixture::new(false).await;
    let review = f.review(1, flac()).await;
    let job = f.prepare(&review).await;
    let source = f.assets.lease(f.id).unwrap();
    let path = source.processing_path().unwrap().to_owned();
    // Keep byte count unchanged; metadata identity/last-write evidence still changes.
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_times(
        std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + Duration::from_secs(100)),
    )
    .unwrap();
    let (progress, _) = tokio::sync::watch::channel(Progress::default());
    assert_eq!(
        request_code(f.processing.run(job, progress).await.unwrap_err()),
        "SOURCE_CHANGED"
    );
    assert_eq!(f.processing.0.hooks.attempts.load(Ordering::Acquire), 0);
    assert!(f.processing.latest(f.id).is_none());
    drop(file);
    drop(source);
    f.finish().await;
}

#[tokio::test]
async fn delayed_completion_removal_and_abandoned_waiters_cannot_publish() {
    for abandon in [false, true] {
        let f = Fixture::new(false).await;
        let job = f.prepare(&f.review(1, flac()).await).await;
        f.processing.0.hooks.pause.store(true, Ordering::Release);
        let owner = f.processing.clone();
        let (progress, _) = tokio::sync::watch::channel(Progress::default());
        let running = tokio::spawn(async move { owner.run(job, progress).await });
        tokio::time::timeout(
            Duration::from_secs(10),
            f.processing.0.hooks.arrived.notified(),
        )
        .await
        .unwrap();
        assert!(!f.assets.remove(f.id).unwrap().cleanup_complete);
        assert_eq!(f.processing.pending_cleanup(), 1);
        if abandon {
            running.abort();
        }
        f.processing.0.hooks.resume.notify_one();
        if !abandon {
            assert!(running.await.unwrap().is_err());
        } else {
            assert!(running.await.unwrap_err().is_cancelled());
        }
        wait_for_idle(&f.processing).await;
        assert!(f.processing.latest(f.id).is_none());
        assert!(f.assets.retry_pending_cleanup());
        assert_eq!(
            std::fs::read_dir(f.processing.0.root.path())
                .unwrap()
                .count(),
            0
        );
        f.finish().await;
    }
}

#[tokio::test]
async fn size_correction_is_once_and_requires_confirmed_attempt_cleanup() {
    for mode in ["succeed", "oversized-twice", "cleanup-fails"] {
        let f = Fixture::new(true).await;
        let baseline = f.run(&f.review(1, json!({})).await).await.unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        *f.processing.0.hooks.mutate.lock().unwrap() = Some(Box::new(move |path| {
            let attempt = seen.fetch_add(1, Ordering::AcqRel);
            if attempt == 0 || mode == "oversized-twice" {
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(path)
                    .unwrap()
                    .set_len(115000)
                    .unwrap();
            }
        }));
        f.processing
            .0
            .hooks
            .fail_cleanup
            .store(mode == "cleanup-fails", Ordering::Release);
        let review = f.review(2, json!({"container":"mp4","audio":{"codec":"aac","bitrateKbps":96},"rate":{"mode":"size","maximumMB":0.1}})).await;
        assert!(review.is_executable(), "{}", review.document());
        let result = f.run(&review).await;
        if mode == "succeed" {
            let result = result.unwrap();
            assert!(result.size <= 100000);
            assert_eq!(result.attempts, 2);
            assert!(
                (result.effective_video_bitrate.unwrap() as f64)
                    < review.document()["rateBudget"]["videoBitrate"]
                        .as_f64()
                        .unwrap()
            );
            assert_eq!(count.load(Ordering::Acquire), 2);
        } else {
            assert!(result.is_err());
            assert_eq!(
                f.processing.latest(f.id).unwrap().result_id,
                baseline.result_id
            );
            assert_eq!(
                count.load(Ordering::Acquire),
                if mode == "cleanup-fails" { 1 } else { 2 }
            );
            if mode == "cleanup-fails" {
                assert_eq!(f.processing.pending_cleanup(), 1);
                assert_eq!(
                    f.processing
                        .prepare(f.id, review.key().into(), vec![])
                        .await
                        .err()
                        .unwrap()
                        .code,
                    "CLEANUP_PENDING"
                );
                assert_eq!(
                    std::fs::read_dir(f.processing.0.root.path())
                        .unwrap()
                        .count(),
                    1
                );
                f.processing
                    .0
                    .hooks
                    .fail_cleanup
                    .store(false, Ordering::Release);
                f.processing.cleanup().await.unwrap();
                assert_eq!(f.processing.pending_cleanup(), 0);
                drop(f.prepare(&review).await);
            }
        }
        f.finish().await;
    }
}

#[tokio::test]
async fn shutdown_retains_open_result_and_cancels_unstarted_admission() {
    let f = Fixture::new(false).await;
    let first = f.run(&f.review(1, flac()).await).await.unwrap();
    let reader = f.processing.lease(first.result_id).unwrap();
    let job = f.prepare(&f.review(2, flac()).await).await;
    assert_eq!(
        f.processing.shutdown().await.unwrap_err().code,
        "CLEANUP_PENDING"
    );
    assert!(job.cancel.is_cancelled());
    assert_eq!(reader.read(0, 4).unwrap(), b"fLaC");
    assert!(f.processing.lease(first.result_id).is_err());
    drop(job);
    drop(reader);
    f.finish().await;
}

#[tokio::test]
async fn cancelling_one_file_preserves_other_admissions_and_prior_success() {
    let f = Fixture::new(false).await;
    let previous = f.run(&f.review(1, flac()).await).await.unwrap();
    let second_source = f
        .assets
        .import(&f.original, &tool("FFPROBE"))
        .await
        .unwrap()
        .asset_id;
    let second_review = f
        .processing
        .review(
            ReviewRequest {
                source_id: second_source,
                draft_revision: 1,
                settings: Some(flac()),
                edit_plan: None,
            },
            Some(caps().await),
        )
        .await
        .unwrap();
    let first = f.prepare(&f.review(2, flac()).await).await;
    let first_id = first.operation_id();
    let second = f
        .processing
        .prepare(second_source, second_review.key().into(), vec![])
        .await
        .unwrap();
    let second_id = second.operation_id();
    f.processing.0.hooks.pause.store(true, Ordering::Release);
    let owner = f.processing.clone();
    let (progress, _) = tokio::sync::watch::channel(Progress::default());
    let running = tokio::spawn(async move { owner.run(first, progress).await });
    tokio::time::timeout(
        Duration::from_secs(10),
        f.processing.0.hooks.arrived.notified(),
    )
    .await
    .unwrap();
    let owner = f.processing.clone();
    let (progress, _) = tokio::sync::watch::channel(Progress::default());
    let waiting = tokio::spawn(async move { owner.run(second, progress).await });
    assert!(
        !f.processing.cancel(f.id, second_id),
        "a stale/cross-file operation cannot cancel this file"
    );
    assert!(f.processing.cancel(f.id, first_id));
    assert_eq!(
        f.processing.0.hooks.attempts.load(Ordering::Acquire),
        2,
        "the other file cannot run before the first releases execution"
    );
    f.processing.0.hooks.pause.store(false, Ordering::Release);
    f.processing.0.hooks.resume.notify_one();
    assert!(running.await.unwrap().is_err());
    let completed = waiting.await.unwrap().unwrap();
    assert_eq!(completed.source_id, second_source);
    assert_eq!(
        f.processing.latest(f.id).unwrap().result_id,
        previous.result_id
    );
    assert_eq!(
        f.processing.latest(second_source).unwrap().result_id,
        completed.result_id
    );
    assert_eq!(f.processing.pending_cleanup(), 0);
    f.finish().await;
}
