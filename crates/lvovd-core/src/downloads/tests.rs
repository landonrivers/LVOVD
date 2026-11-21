use super::*;

#[tokio::test]
async fn concurrent_admission_is_bounded_and_keeps_active_receipts_and_unsaved_jobs() {
    let root = tempfile::tempdir().unwrap();
    let manager = Downloads::new(root.path(), Tools::bundled(root.path())).unwrap();
    let url = provider::validate_url("https://example.org/fixture").unwrap();
    let (view, _) = provider::metadata(
        br#"{"title":"fixture","vcodec":"avc1","acodec":"aac"}"#,
        &url,
    )
    .unwrap();
    let id = view.preview_id;
    manager.state.lock().unwrap().reviews.push_back(Reviewed {
        url,
        preview: view,
        time: Instant::now(),
    });
    let permit = manager.source.clone().acquire_owned().await.unwrap();
    for _ in 0..SNAPSHOT_ROWS {
        manager.enqueue(id, root.path().to_owned()).unwrap();
    }
    let before = manager.snapshot();
    assert!(matches!(
        manager.enqueue(id, root.path().to_owned()),
        Err(AppError {
            code: "DOWNLOAD_QUEUE_FULL",
            ..
        })
    ));
    let after = manager.snapshot();
    assert_eq!(before.revision, after.revision);
    assert_eq!(before.jobs[0].job_id, after.jobs[0].job_id);
    let cancelled = manager.cancel(before.jobs[0].job_id).unwrap();
    assert_eq!(cancelled.jobs[0].status, Cancelled);
    assert!(cancelled.jobs[1..].iter().all(|j| j.status == Queued));
    manager.shutdown().await.unwrap();
    drop(permit);
}

#[tokio::test]
async fn abandoned_preview_waiters_release_their_deduplication_entry() {
    let root = tempfile::tempdir().unwrap();
    let manager = Downloads::new(root.path(), Tools::bundled(root.path())).unwrap();
    let _gate = manager.source.clone().acquire_owned().await.unwrap();
    let waiting = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.preview("https://example.org/video".into()).await })
    };
    tokio::task::yield_now().await;
    assert!(manager.needs_quit_confirmation());
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    assert!(!manager.needs_quit_confirmation());
    manager.shutdown().await.unwrap();
}
