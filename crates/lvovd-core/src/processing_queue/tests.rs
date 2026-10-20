use super::*;
use crate::{
    assets::Assets,
    capabilities::{Capabilities, CapabilityDiscovery},
    process::CancellationToken,
    processing_operation::{Limits, ReviewRequest},
};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub(super) struct Gate {
    armed: AtomicBool,
    arrived: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}
impl Gate {
    fn arm(&self) {
        self.armed.store(true, Ordering::Release);
    }
    pub(super) async fn wait(&self) {
        if self.armed.swap(false, Ordering::AcqRel) {
            self.arrived.notify_one();
            self.resume.notified().await;
        }
    }
    async fn reached(&self) {
        tokio::time::timeout(Duration::from_secs(30), self.arrived.notified())
            .await
            .unwrap();
    }
    fn release(&self) {
        self.resume.notify_one();
    }
}
#[derive(Default)]
pub(super) struct Hooks {
    admission: Gate,
    next: Gate,
    result: Gate,
    pub(super) before_run: Gate,
}
impl Hooks {
    pub(super) async fn after_admission(&self) {
        self.admission.wait().await;
    }
    pub(super) async fn before_next(&self) {
        self.next.wait().await;
    }
    pub(super) async fn after_result(&self) {
        self.result.wait().await;
    }
}
fn tool(name: &str) -> PathBuf {
    std::env::var_os(format!("LVOVD_DESKTOP_{name}"))
        .expect("media tools required")
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
    bytes: Vec<u8>,
    assets: Assets,
    processing: Processing,
    queue: ProcessingQueue,
    ids: [Uuid; 2],
}
impl Fixture {
    async fn new(missing_encoder: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("synthetic source ü.wav");
        let samples: Vec<u8> = (0..48_000_i32)
            .flat_map(|n| ((n % 200 - 100) as i16 * 100).to_le_bytes())
            .collect();
        let mut bytes = b"RIFF".to_vec();
        bytes.extend((36 + samples.len() as u32).to_le_bytes());
        bytes.extend(b"WAVEfmt ");
        bytes.extend(16_u32.to_le_bytes());
        bytes.extend(1_u16.to_le_bytes());
        bytes.extend(1_u16.to_le_bytes());
        bytes.extend(48_000_u32.to_le_bytes());
        bytes.extend(96_000_u32.to_le_bytes());
        bytes.extend(2_u16.to_le_bytes());
        bytes.extend(16_u16.to_le_bytes());
        bytes.extend(b"data");
        bytes.extend((samples.len() as u32).to_le_bytes());
        bytes.extend(samples);
        std::fs::write(&original, &bytes).unwrap();
        let assets = Assets::new(root.path()).unwrap();
        let first = assets.import(&original, &tool("FFPROBE")).await.unwrap();
        let second = assets.import(&original, &tool("FFPROBE")).await.unwrap();
        let processing = Processing::new(
            assets.clone(),
            root.path(),
            if missing_encoder {
                root.path().join("absent-ffmpeg")
            } else {
                tool("FFMPEG")
            },
            tool("FFPROBE"),
            Limits {
                maximum_bytes: 10 * 1024 * 1024,
                worker_deadline: Duration::from_secs(30),
            },
        )
        .unwrap();
        let queue = ProcessingQueue::new(processing.clone());
        Self {
            root,
            original,
            bytes,
            assets,
            processing,
            queue,
            ids: [first.asset_id, second.asset_id],
        }
    }
    async fn review(&self, index: usize, revision: u32, flac: bool) -> Admission {
        let plan = self
            .processing
            .review(
                ReviewRequest {
                    source_id: self.ids[index],
                    draft_revision: revision,
                    settings: if flac {
                        Some(json!({"container":"flac","audio":{"codec":"flac"}}))
                    } else {
                        None
                    },
                    edit_plan: None,
                },
                if flac { Some(caps().await) } else { None },
            )
            .await
            .unwrap();
        assert!(
            plan.is_executable() || plan.document()["status"] == "no-op",
            "{}",
            plan.document()
        );
        Admission {
            source_id: self.ids[index],
            key: plan.key().into(),
            acknowledgements: vec![],
        }
    }
    async fn finished(&self) -> Snapshot {
        let mut receiver = self.queue.subscribe();
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let snapshot = receiver.borrow_and_update().clone();
                if !snapshot.jobs.is_empty() && snapshot.jobs.iter().all(|job| !job.status.live()) {
                    return snapshot;
                }
                receiver.changed().await.unwrap();
            }
        })
        .await
        .unwrap()
    }
    async fn close(self) {
        self.queue.shutdown().await.unwrap();
        self.processing.shutdown().await.unwrap();
        self.assets.shutdown().await.unwrap();
        assert_eq!(
            std::fs::read(&self.original).unwrap(),
            self.bytes,
            "original must survive queue and temporary cleanup"
        );
        drop(self.root);
    }
}

#[tokio::test]
async fn atomic_batch_rejects_stale_duplicate_and_invalid_entries_without_partial_admission() {
    let f = Fixture::new(false).await;
    let first = f.review(0, 1, false).await;
    let second = f.review(1, 1, false).await;
    let mut invalid = second.clone();
    invalid.key = "stale".into();
    assert!(f.queue.enqueue(vec![first.clone(), invalid]).await.is_err());
    assert!(f.queue.snapshot().jobs.is_empty());
    assert!(
        f.queue
            .enqueue(vec![first.clone(), first.clone()])
            .await
            .is_err()
    );
    assert!(f.queue.enqueue(vec![first.clone(); 21]).await.is_err());
    let current = f.review(0, 2, true).await;
    assert!(f.queue.enqueue(vec![first, second.clone()]).await.is_err());
    assert!(f.queue.snapshot().jobs.is_empty());
    f.queue.enqueue(vec![current, second]).await.unwrap();
    assert!(
        f.finished()
            .await
            .jobs
            .iter()
            .all(|job| job.status == Status::Completed)
    );
    f.close().await;
}

#[tokio::test]
async fn fifo_keeps_immutable_reviews_and_real_outputs_after_subscriber_disconnect() {
    let f = Fixture::new(false).await;
    let first = f.review(0, 1, true).await;
    let second = f.review(1, 1, false).await;
    f.queue.0.hooks.result.arm();
    let submitted = f.queue.enqueue(vec![first.clone(), second]).await.unwrap();
    assert_eq!(
        submitted
            .jobs
            .iter()
            .map(|job| job.source_id)
            .collect::<Vec<_>>(),
        f.ids
    );
    let disconnected = f.queue.subscribe();
    drop(disconnected);
    f.queue.0.hooks.result.reached().await;
    let current = f.queue.snapshot();
    assert_eq!(current.jobs[0].status, Status::Running);
    assert_eq!(current.jobs[1].status, Status::Queued);
    assert!(f.processing.latest(f.ids[0]).is_some());
    assert!(f.processing.latest(f.ids[1]).is_none());
    let updated = f.review(0, 2, false).await;
    assert_eq!(
        f.queue.enqueue(vec![updated]).await.unwrap_err().code,
        "PROCESSING_BUSY",
        "a finished worker cannot admit a replacement before its queue row settles"
    );
    f.queue.0.hooks.result.release();
    let final_state = f.finished().await;
    assert_eq!(final_state.queue_id, submitted.queue_id);
    assert!(final_state.revision > submitted.revision);
    assert_eq!(final_state.jobs[0].plan_key, first.key);
    assert_eq!(final_state.jobs[0].draft_revision, 1);
    assert_eq!(
        final_state.jobs[0]
            .result
            .as_ref()
            .unwrap()
            .inspection
            .audio
            .as_ref()
            .unwrap()
            .codec
            .as_deref(),
        Some("flac")
    );
    let result = final_state.jobs[1].result.as_ref().unwrap();
    assert!(result.no_op);
    let reader = f.processing.lease(result.result_id).unwrap();
    assert_eq!(reader.read(0, result.size as usize).unwrap(), f.bytes);
    drop(reader);
    let fresh = f.queue.subscribe();
    assert_eq!(fresh.borrow().revision, final_state.revision);
    drop(fresh);
    f.close().await;
}

#[tokio::test]
async fn cancel_all_invalidates_in_flight_batch_and_releases_every_ticket() {
    let f = Fixture::new(false).await;
    let batch = vec![f.review(0, 1, false).await, f.review(1, 1, false).await];
    f.queue.0.hooks.admission.arm();
    let queue = f.queue.clone();
    let entries = batch.clone();
    let submitting = tokio::spawn(async move { queue.enqueue(entries).await });
    f.queue.0.hooks.admission.reached().await;
    assert_eq!(
        f.queue.enqueue(batch.clone()).await.unwrap_err().code,
        "PROCESSING_BUSY"
    );
    f.queue.cancel(None).unwrap();
    f.queue.0.hooks.admission.release();
    assert_eq!(submitting.await.unwrap().unwrap_err().code, "CANCELLED");
    assert!(f.queue.snapshot().jobs.is_empty());
    f.queue.enqueue(batch).await.unwrap();
    assert!(
        f.finished()
            .await
            .jobs
            .iter()
            .all(|job| job.status == Status::Completed)
    );
    f.close().await;
}

#[tokio::test]
async fn abandoned_batch_releases_unpublished_admission_and_does_not_enqueue() {
    let f = Fixture::new(false).await;
    let batch = vec![f.review(0, 1, false).await, f.review(1, 1, false).await];
    f.queue.0.hooks.admission.arm();
    let queue = f.queue.clone();
    let entries = batch.clone();
    let submitting = tokio::spawn(async move { queue.enqueue(entries).await });
    f.queue.0.hooks.admission.reached().await;
    submitting.abort();
    assert!(submitting.await.unwrap_err().is_cancelled());
    assert!(f.queue.snapshot().jobs.is_empty());
    f.queue.enqueue(batch).await.unwrap();
    assert!(
        f.finished()
            .await
            .jobs
            .iter()
            .all(|job| job.status == Status::Completed)
    );
    f.close().await;
}

#[tokio::test]
async fn active_cancellation_does_not_cancel_next_file_and_unknown_job_is_rejected() {
    let f = Fixture::new(false).await;
    f.queue.0.hooks.before_run.arm();
    let submitted = f
        .queue
        .enqueue(vec![
            f.review(0, 1, true).await,
            f.review(1, 1, false).await,
        ])
        .await
        .unwrap();
    f.queue.0.hooks.before_run.reached().await;
    assert_eq!(
        f.queue.cancel(Some(Uuid::new_v4())).unwrap_err().code,
        "PROCESSING_JOB_GONE"
    );
    let cancelling = f.queue.cancel(Some(submitted.jobs[0].id)).unwrap();
    assert_eq!(cancelling.jobs[0].status, Status::Cancelling);
    assert_eq!(cancelling.jobs[1].status, Status::Queued);
    f.queue.0.hooks.before_run.release();
    let final_state = f.finished().await;
    assert_eq!(final_state.jobs[0].status, Status::Cancelled);
    assert_eq!(final_state.jobs[1].status, Status::Completed);
    assert!(f.processing.latest(f.ids[0]).is_none());
    f.close().await;
}

#[tokio::test]
async fn late_cancel_respects_publication_and_cancels_the_unstarted_batch() {
    let f = Fixture::new(false).await;
    f.queue.0.hooks.result.arm();
    f.queue
        .enqueue(vec![
            f.review(0, 1, false).await,
            f.review(1, 1, false).await,
        ])
        .await
        .unwrap();
    f.queue.0.hooks.result.reached().await;
    f.queue.cancel(None).unwrap();
    f.queue.0.hooks.result.release();
    let final_state = f.finished().await;
    assert_eq!(final_state.jobs[0].status, Status::Completed);
    assert_eq!(final_state.jobs[1].status, Status::Cancelled);
    assert!(f.processing.latest(f.ids[1]).is_none());
    f.close().await;
}

#[tokio::test]
async fn failed_attempt_preserves_prior_success_without_presenting_it_as_the_new_result() {
    let f = Fixture::new(true).await;
    f.queue
        .enqueue(vec![f.review(0, 1, false).await])
        .await
        .unwrap();
    let first = f.finished().await.jobs[0].result.clone().unwrap();
    f.queue
        .enqueue(vec![
            f.review(0, 2, true).await,
            f.review(1, 1, false).await,
        ])
        .await
        .unwrap();
    let final_state = f.finished().await;
    assert_eq!(final_state.jobs.len(), 2);
    assert_eq!(final_state.jobs[0].status, Status::Failed);
    assert!(final_state.jobs[0].failure.is_some());
    assert!(final_state.jobs[0].result.is_none());
    assert_eq!(
        f.processing.latest(f.ids[0]).unwrap().result_id,
        first.result_id
    );
    assert_eq!(final_state.jobs[1].status, Status::Completed);
    f.close().await;
}

#[tokio::test]
async fn source_removal_cannot_be_undone_by_a_late_job_completion() {
    let f = Fixture::new(false).await;
    f.queue.0.hooks.result.arm();
    f.queue
        .enqueue(vec![
            f.review(0, 1, false).await,
            f.review(1, 1, false).await,
        ])
        .await
        .unwrap();
    f.queue.0.hooks.result.reached().await;
    let previous = f.processing.latest(f.ids[0]).unwrap();
    let lease = f.processing.lease(previous.result_id).unwrap();
    assert!(!f.assets.remove(f.ids[0]).unwrap().cleanup_complete);
    f.queue.forget_source(f.ids[0]);
    assert!(f.processing.lease(previous.result_id).is_err());
    f.queue.0.hooks.result.release();
    let final_state = f.finished().await;
    assert_eq!(final_state.jobs.len(), 1);
    assert_eq!(final_state.jobs[0].source_id, f.ids[1]);
    assert!(f.assets.pending_cleanup().contains(&f.ids[0]));
    drop(lease);
    f.processing.cleanup().await.unwrap();
    assert!(f.assets.remove(f.ids[0]).unwrap().cleanup_complete);
    f.close().await;
}

#[tokio::test]
async fn queued_expiry_and_capacity_leave_other_jobs_and_sources_available() {
    let f = Fixture::new(false).await;
    let first = f.review(0, 1, false).await;
    let second = f.review(1, 1, false).await;
    f.queue.0.hooks.next.arm();
    f.queue.enqueue(vec![first.clone(), second]).await.unwrap();
    f.queue.0.hooks.next.reached().await;
    let mut unrelated = first.clone();
    unrelated.source_id = Uuid::new_v4();
    assert_eq!(
        f.queue.enqueue(vec![unrelated; 19]).await.unwrap_err().code,
        "PROCESSING_QUEUE_FULL"
    );
    {
        let mut registry = f.queue.0.registry.lock().unwrap();
        registry.entries[0].queued_at = Instant::now() - QUEUED_TTL;
        f.queue.expire_locked(&mut registry, Instant::now());
    }
    assert_eq!(
        f.queue.snapshot().jobs[0].failure.as_ref().unwrap()["code"],
        "PROCESSING_EXPIRED"
    );
    f.queue.0.hooks.next.release();
    assert_eq!(f.finished().await.jobs[1].status, Status::Completed);
    f.queue.enqueue(vec![first]).await.unwrap();
    assert!(
        f.finished()
            .await
            .jobs
            .iter()
            .all(|job| job.status == Status::Completed)
    );
    f.close().await;
}

#[tokio::test]
async fn shutdown_waits_for_owned_jobs_cancels_queued_tickets_and_denies_new_admission() {
    let f = Fixture::new(false).await;
    let first = f.review(0, 1, false).await;
    f.queue.0.hooks.result.arm();
    f.queue
        .enqueue(vec![first.clone(), f.review(1, 1, false).await])
        .await
        .unwrap();
    f.queue.0.hooks.result.reached().await;
    let queue = f.queue.clone();
    let shutdown = tokio::spawn(async move { queue.shutdown().await });
    let mut receiver = f.queue.subscribe();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !receiver.borrow_and_update().closing {
            receiver.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(!shutdown.is_finished());
    assert_eq!(
        f.queue.enqueue(vec![first]).await.unwrap_err().code,
        "CLOSING"
    );
    f.queue.0.hooks.result.release();
    shutdown.await.unwrap().unwrap();
    assert_eq!(f.queue.snapshot().jobs[1].status, Status::Cancelled);
    drop(receiver);
    f.close().await;
}
