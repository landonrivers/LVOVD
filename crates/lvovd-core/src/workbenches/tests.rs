use super::*;
use crate::processing_operation::Limits;
use serde_json::json;

struct Fixture {
    _root: tempfile::TempDir,
    original: PathBuf,
    owner: Workbenches,
    ids: [Uuid; 2],
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("synthetic ü.wav");
        let samples = vec![0_u8; 9600];
        let mut bytes = b"RIFF".to_vec();
        bytes.extend((36 + samples.len() as u32).to_le_bytes());
        bytes.extend(b"WAVEfmt ");
        bytes.extend(16_u32.to_le_bytes());
        bytes.extend(1_u16.to_le_bytes());
        bytes.extend(1_u16.to_le_bytes());
        bytes.extend(48000_u32.to_le_bytes());
        bytes.extend(96000_u32.to_le_bytes());
        bytes.extend(2_u16.to_le_bytes());
        bytes.extend(16_u16.to_le_bytes());
        bytes.extend(b"data");
        bytes.extend((samples.len() as u32).to_le_bytes());
        bytes.extend(samples);
        std::fs::write(&original, bytes).unwrap();
        let tool = |name| PathBuf::from(std::env::var_os(format!("LVOVD_DESKTOP_{name}")).unwrap());
        let assets = Assets::new(root.path()).unwrap();
        let processing = Processing::new(
            assets.clone(),
            root.path(),
            tool("FFMPEG"),
            tool("FFPROBE"),
            Limits {
                maximum_bytes: 1024 * 1024,
                worker_deadline: Duration::from_secs(30),
            },
        )
        .unwrap();
        let owner = Workbenches::new(assets, processing, tool("FFMPEG"), tool("FFPROBE"));
        let ids = [
            owner.create().unwrap().workbench_id,
            owner.create().unwrap().workbench_id,
        ];
        Self {
            _root: root,
            original,
            owner,
            ids,
        }
    }
    async fn import(&self, index: usize) -> Uuid {
        let result = self
            .owner
            .import(self.ids[index], vec![self.original.clone()])
            .await
            .unwrap();
        assert!(result.failure.is_none(), "{:?}", result.failure);
        result.sources[0].asset_id
    }
    async fn review(&self, index: usize, source: Uuid) -> Admission {
        let review = self
            .owner
            .review(
                self.ids[index],
                ReviewRequest {
                    source_id: source,
                    draft_revision: 0,
                    settings: None,
                    edit_plan: None,
                },
            )
            .await
            .unwrap();
        Admission {
            source_id: source,
            key: review.key().into(),
            acknowledgements: vec![],
        }
    }
    async fn completed(&self, index: usize) -> Published {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let snapshot = self.owner.snapshot(self.ids[index]).unwrap();
                if let Some(result) = snapshot.results.first() {
                    return result.clone();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn membership_scopes_review_admission_cancellation_and_removal() {
    let f = Fixture::new();
    assert_eq!(f.owner.create().err().unwrap().code, "WORKBENCH_LIMIT");
    let a = f.import(0).await;
    let b = f.import(1).await;
    let first = f.review(0, a).await;
    let second = f.review(1, b).await;
    assert!(
        f.owner
            .review(
                f.ids[1],
                ReviewRequest {
                    source_id: a,
                    draft_revision: 0,
                    settings: None,
                    edit_plan: None
                }
            )
            .await
            .is_err()
    );
    assert!(
        f.owner
            .enqueue(f.ids[0], vec![first.clone(), second.clone()])
            .await
            .is_err()
    );
    assert!(f.owner.0.queue.snapshot().jobs.is_empty());
    assert!(f.owner.remove(f.ids[1], a).is_err());
    f.owner.enqueue(f.ids[0], vec![first]).await.unwrap();
    let job = f.owner.snapshot(f.ids[0]).unwrap().jobs[0].id;
    assert!(f.owner.cancel(f.ids[1], Some(job)).is_err());
    f.owner.cancel(f.ids[1], None).unwrap();
    let result = f.completed(0).await;
    assert_eq!(result.source_id, a);
    assert!(result.no_op);
    assert!(f.owner.snapshot(f.ids[1]).unwrap().jobs.is_empty());
    f.owner.enqueue(f.ids[1], vec![second]).await.unwrap();
    assert_eq!(f.completed(1).await.source_id, b);
    f.owner.shutdown().await.unwrap();
    assert!(f.original.exists());
}

#[tokio::test]
async fn ordered_intake_holds_twenty_slots_per_workbench_and_forty_globally() {
    let f = Fixture::new();
    for id in f.ids {
        let result = f
            .owner
            .import(id, vec![f.original.clone(); 20])
            .await
            .unwrap();
        assert!(result.failure.is_none());
        assert_eq!(result.sources.len(), 20);
        assert!(f.owner.import(id, vec![f.original.clone()]).await.is_err());
    }
    assert_eq!(f.owner.0.assets.list().len(), 40);
    let source = f.owner.snapshot(f.ids[0]).unwrap().sources[0].asset_id;
    let lease = f.owner.0.assets.lease(source).unwrap();
    f.owner.remove(f.ids[0], source).unwrap();
    f.owner.cleanup().await.unwrap();
    assert!(
        f.owner
            .import(f.ids[0], vec![f.original.clone()])
            .await
            .is_err()
    );
    assert_eq!(f.owner.snapshot(f.ids[0]).unwrap().cleanup, vec![source]);
    drop(lease);
    f.owner.cleanup().await.unwrap();
    f.import(0).await;
    assert_eq!(f.owner.0.assets.list().len(), 40);
    f.owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn removal_retains_result_and_source_reservations_until_last_reader_exits() {
    let f = Fixture::new();
    let source = f.import(0).await;
    let admission = f.review(0, source).await;
    f.owner.enqueue(f.ids[0], vec![admission]).await.unwrap();
    let result = f.completed(0).await;
    let lease = f.owner.0.processing.lease(result.result_id).unwrap();
    let snapshot = f.owner.remove(f.ids[0], source).unwrap();
    assert!(snapshot.sources.is_empty());
    assert!(snapshot.jobs.is_empty());
    assert!(f.owner.0.processing.lease(result.result_id).is_err());
    f.owner.reconcile().await.unwrap();
    assert_eq!(f.owner.snapshot(f.ids[0]).unwrap().cleanup, vec![source]);
    assert_eq!(f.owner.0.assets.pending_cleanup(), vec![source]);
    f.owner.discard(f.ids[0]).unwrap();
    let reopened = f.owner.reopen(f.ids[0]).unwrap();
    assert!(reopened.discarded);
    assert_eq!(
        reopened.cleanup,
        vec![source],
        "discarded cleanup must stay reachable after switching workbenches"
    );
    drop(lease);
    f.owner.reconcile().await.unwrap();
    assert!(f.owner.reopen(f.ids[0]).is_err());
    assert!(f.owner.0.assets.pending_cleanup().is_empty());
    assert!(f.original.exists());
    f.owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn discarded_workbench_is_not_recreated_by_queued_or_abandoned_intake() {
    let f = Fixture::new();
    let gate = f.owner.0.intake.lock().await;
    let owner = f.owner.clone();
    let id = f.ids[0];
    let path = f.original.clone();
    let caller = tokio::spawn(async move { owner.import(id, vec![path]).await });
    while !f.owner.snapshot(id).unwrap().importing {
        tokio::task::yield_now().await;
    }
    caller.abort();
    assert!(caller.await.err().unwrap().is_cancelled());
    assert!(f.owner.snapshot(id).unwrap().importing);
    f.owner.0.registry.lock().unwrap().entries[0].touched = Instant::now() - TTL * 2;
    f.owner.expire();
    assert!(!f.owner.snapshot(id).unwrap().discarded);
    assert!(
        f.owner.0.registry.lock().unwrap().entries[0]
            .touched
            .elapsed()
            < TTL
    );
    f.owner.discard(id).unwrap();
    assert!(f.owner.touch(id).is_err());
    assert!(f.owner.import(id, vec![f.original.clone()]).await.is_err());
    drop(gate);
    tokio::time::timeout(Duration::from_secs(10), async {
        while f.owner.snapshot(id).unwrap().importing {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    f.owner.cleanup().await.unwrap();
    assert!(f.owner.snapshot(id).is_err());
    assert!(f.owner.0.assets.list().is_empty());
    assert!(f.owner.create().is_ok());
    assert!(f.original.exists());
    f.owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn disconnected_import_finishes_into_its_original_collection() {
    let f = Fixture::new();
    let gate = f.owner.0.intake.lock().await;
    let owner = f.owner.clone();
    let id = f.ids[0];
    let path = f.original.clone();
    let caller = tokio::spawn(async move { owner.import(id, vec![path]).await });
    while !f.owner.snapshot(id).unwrap().importing {
        tokio::task::yield_now().await;
    }
    caller.abort();
    let _ = caller.await;
    assert!(f.owner.import(id, vec![f.original.clone()]).await.is_err());
    f.owner.touch(f.ids[1]).unwrap();
    drop(gate);
    tokio::time::timeout(Duration::from_secs(10), async {
        while f.owner.snapshot(id).unwrap().importing {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(f.owner.snapshot(id).unwrap().sources.len(), 1);
    assert!(f.owner.snapshot(f.ids[1]).unwrap().sources.is_empty());
    f.owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_batch_keeps_earlier_files_and_expiry_revokes_only_idle_workbench() {
    let f = Fixture::new();
    let result = f
        .owner
        .import(
            f.ids[0],
            vec![
                f.original.clone(),
                f.original.with_extension("missing"),
                f.original.clone(),
            ],
        )
        .await
        .unwrap();
    assert_eq!(result.sources.len(), 1);
    assert!(result.failure.is_some());
    assert_eq!(
        f.owner
            .snapshot(f.ids[0])
            .unwrap()
            .intake_failure
            .unwrap()
            .code,
        "SOURCE_READ"
    );
    assert!(f.owner.snapshot(f.ids[1]).unwrap().intake_failure.is_none());
    let source = f.import(1).await;
    {
        let mut registry = f.owner.0.registry.lock().unwrap();
        registry.entries[0].touched = Instant::now() - TTL * 2;
    }
    f.owner.expire();
    let snapshot = f.owner.snapshot(f.ids[0]).unwrap();
    assert!(snapshot.discarded);
    assert!(snapshot.sources.is_empty());
    assert!(f.owner.0.assets.lease(result.sources[0].asset_id).is_err());
    assert!(f.owner.0.assets.lease(source).is_ok());
    f.owner.cleanup().await.unwrap();
    f.owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn hostile_settings_and_stale_reviews_cannot_become_jobs() {
    let f = Fixture::new();
    let source = f.import(0).await;
    assert!(
        f.owner
            .review(
                f.ids[0],
                ReviewRequest {
                    source_id: source,
                    draft_revision: 0,
                    settings: Some(json!({"payload":"x".repeat(65536)})),
                    edit_plan: None,
                }
            )
            .await
            .is_err()
    );
    let old = f.review(0, source).await;
    f.owner
        .review(
            f.ids[0],
            ReviewRequest {
                source_id: source,
                draft_revision: 1,
                settings: None,
                edit_plan: None,
            },
        )
        .await
        .unwrap();
    assert!(f.owner.enqueue(f.ids[0], vec![old]).await.is_err());
    assert!(f.owner.snapshot(f.ids[0]).unwrap().jobs.is_empty());
    f.owner.shutdown().await.unwrap();
}
