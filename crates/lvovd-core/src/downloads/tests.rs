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

#[tokio::test]
async fn provider_extraction_is_owned_until_exit_during_success_timeout_and_cancellation() {
    let root = tempfile::tempdir().unwrap();
    let supervisor = Arc::new(Supervisor::default());
    let node =
        PathBuf::from(std::env::var_os("LVOVD_DESKTOP_NODE").expect("configured Node test helper"));
    for mode in ["success", "timeout", "cancel"] {
        let parent = root.path().join(mode);
        std::fs::create_dir(&parent).unwrap();
        let receipt = root.path().join(format!("{mode}.json"));
        let script = r#"
            const fs = require('node:fs'), path = require('node:path');
            const temp = require('node:os').tmpdir();
            fs.mkdirSync(path.join(temp, '_MEI-fixture'));
            fs.writeFileSync(process.argv[1],JSON.stringify([temp,process.env.TMPDIR,process.env.TMP,process.env.TEMP]));
            if (process.argv[2] !== 'success') setInterval(() => {},1000);
        "#;
        let cancel = CancellationToken::new();
        let work = tokio::spawn({
            let supervisor = supervisor.clone();
            let parent = parent.clone();
            let node = node.clone();
            let cancel = cancel.clone();
            let receipt = receipt.clone();
            async move {
                let args = [
                    "-e".into(),
                    script.into(),
                    receipt.into_os_string(),
                    mode.into(),
                ];
                let request = Request {
                    executable: &node,
                    args: &args,
                    cancel: &cancel,
                    deadline: Duration::from_secs(if mode == "timeout" { 3 } else { 30 }),
                    diagnostic_limit: 4096,
                };
                if mode == "cancel" {
                    supervisor
                        .run_provider_stream_owned(request, &parent, |_| Ok(()), ())
                        .await
                } else {
                    supervisor.run_provider_owned(request, &parent, ()).await
                }
            }
        });
        let paths: Vec<PathBuf> = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Some(paths) = std::fs::read(&receipt)
                    .ok()
                    .and_then(|data| serde_json::from_slice(&data).ok())
                {
                    break paths;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("helper started and wrote its extraction receipt");
        assert_eq!(paths[0].parent(), Some(parent.as_path()));
        assert!(paths.iter().all(|path| path == &paths[0]));
        if mode == "cancel" {
            cancel.cancel();
        }
        let result = work.await.unwrap();
        match mode {
            "success" => assert!(result.is_ok()),
            "cancel" => assert_eq!(result.unwrap_err().code, "CANCELLED"),
            _ => assert_eq!(result.unwrap_err().code, "TOOL_TIMEOUT"),
        }
        assert!(
            !paths[0].exists(),
            "owned extraction removed before completion"
        );
    }
    supervisor.shutdown().await.unwrap();
}
