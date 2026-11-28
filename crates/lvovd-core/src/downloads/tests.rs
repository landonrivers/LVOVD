use super::*;

fn reviewed_options_fixture() -> DownloadPreview {
    let info = serde_json::json!({
        "title":"Synthetic fixture","extractor":"youtube","thumbnail":"https://example.invalid/image",
        "formats":[
            {"format_id":"c","url":"https://example.invalid/c","vcodec":"avc1","acodec":"mp4a","height":720},
            {"format_id":"v","url":"https://example.invalid/v","vcodec":"avc1","acodec":"none","height":720},
            {"format_id":"a","url":"https://example.invalid/a","vcodec":"none","acodec":"mp4a"}],
        "subtitles":{"fr":[]},"automatic_captions":{"en":[]},
        "chapters":[{"start_time":0,"end_time":8},{"start_time":8,"end_time":13}]
    });
    provider::metadata(
        &serde_json::to_vec(&info).unwrap(),
        &provider::validate_url("https://example.invalid/fixture").unwrap(),
    )
    .unwrap()
    .0
}

#[tokio::test]
async fn interrupted_companion_save_resumes_at_first_unpublished_file() {
    let root = tempfile::tempdir().unwrap();
    let owner = Downloads::new(root.path(), Tools::bundled(root.path())).unwrap();
    let prepared = Arc::new(tempfile::tempdir().unwrap());
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let mut files = Vec::new();
    for suffix in ["mp4", "info.json"] {
        let name = format!("Fixture.{suffix}");
        let path = prepared.path().join(&name);
        std::fs::write(&path, b"fixture").unwrap();
        files.push(PreparedFile {
            seal: Seal::capture(&path).unwrap(),
            path,
            name,
            suffix: suffix.into(),
        });
    }
    let blocked = prepared.path().join("held.json");
    let companion = files[1].path.clone();
    std::fs::rename(&companion, &blocked).unwrap();
    let result = Arc::new(Prepared {
        _directory: prepared,
        files,
    });
    let preview = reviewed_options_fixture();
    let job_id = Uuid::new_v4();
    let directory_id = destination_id(first.path()).unwrap();
    owner.state.lock().unwrap().jobs.push(Job {
        view: DownloadJob {
            job_id,
            title: preview.title.clone(),
            filename: preview.filename.clone(),
            destination: first.path().display().to_string(),
            status: Saving,
            progress: None,
            error: None,
            saved_name: None,
            saved_files: vec![],
        },
        url: provider::validate_url("https://example.invalid/fixture").unwrap(),
        plan: DownloadOptions::default().plan(&preview).unwrap(),
        destination: first.path().into(),
        directory_id,
        cancel: CancellationToken::new(),
        prepared: Some(result.clone()),
        exported: vec![],
        updated: Instant::now(),
    });
    owner
        .save(job_id, result, first.path().into(), directory_id)
        .await;
    assert_eq!(owner.snapshot().jobs[0].status, SaveFailed);
    assert_eq!(
        owner.exported_file(job_id, 0).unwrap(),
        first.path().join("Fixture.mp4")
    );
    std::fs::rename(blocked, companion).unwrap();
    std::fs::write(second.path().join("Fixture.info.json"), "existing").unwrap();
    let mut rx = owner.subscribe();
    owner.retry_save(job_id, second.path().into()).unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        rx.wait_for(|s| s.jobs[0].status == Saved),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        owner.exported_file(job_id, 1).unwrap(),
        second.path().join("Fixture (1).info.json")
    );
    assert!(!second.path().join("Fixture.mp4").exists());
    assert_eq!(
        std::fs::read(second.path().join("Fixture.info.json")).unwrap(),
        b"existing"
    );
    let snapshot = owner.snapshot();
    assert_eq!(
        snapshot.jobs[0].saved_files[0].folder,
        first.path().display().to_string()
    );
    assert_eq!(
        snapshot.jobs[0].saved_files[1].folder,
        second.path().display().to_string()
    );
    owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn single_video_arguments_match_released_options() {
    let dir = tempfile::tempdir().unwrap();
    let node = PathBuf::from(std::env::var_os("LVOVD_DESKTOP_NODE").unwrap());
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/download-options.cjs");
    let run = crate::process::run(
        &node,
        &[fixture.into(), dir.path().into()],
        Duration::from_secs(30),
        128 * 1024,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let cases: Vec<serde_json::Value> = serde_json::from_slice(&run.stdout).unwrap();
    let preview = reviewed_options_fixture();
    let manager = Downloads::new(dir.path(), Tools::bundled(dir.path())).unwrap();
    manager.state.lock().unwrap().reviews.push_back(Reviewed {
        url: provider::validate_url("https://example.invalid/video").unwrap(),
        preview: preview.clone(),
        time: Instant::now(),
    });
    for case in cases {
        let opts: DownloadOptions = serde_json::from_value(case["native"].clone()).unwrap();
        let plan = opts.plan(&preview).unwrap();
        let args = plan.provider_args(&plan.sections[0]);
        let mut actual = serde_json::Map::new();
        let mut args = args.iter().map(|s| s.to_str().unwrap()).peekable();
        while let Some(flag) = args.next() {
            let value = if args.peek().is_some_and(|s| !s.starts_with("--")) {
                args.next().unwrap().into()
            } else {
                true.into()
            };
            actual.insert(flag.into(), value);
        }
        if !plan.options.format_ids.is_empty() {
            let ids = case["expected"]["--format"].as_str().unwrap();
            let literal = ids
                .split('+')
                .map(|id| format!("all[format_id='{id}']"))
                .collect::<Vec<_>>()
                .join("+");
            assert_eq!(actual["--format"], literal);
            actual.insert("--format".into(), ids.into());
        }
        assert_eq!(
            serde_json::Value::Object(actual),
            case["expected"],
            "{}",
            case["native"]
        );
        if let Some(expected) = case.get("editor") {
            let native = &case["native"];
            let source: EditorSourceOptions = serde_json::from_value(serde_json::json!({
                "content":native["content"], "profile":native["profile"].as_str().unwrap_or("compatible"),
                "maxHeight":native["maxHeight"],"formatIds":native.get("formatIds").cloned().unwrap_or_else(|| serde_json::json!([]))
            })).unwrap();
            let acquisition = manager.review_editor(preview.preview_id, source).unwrap();
            let args =
                provider::editor_args(&manager.tools, &acquisition, dir.path(), 8192).unwrap();
            let flags: Vec<_> = args.iter().map(|flag| flag.to_str().unwrap()).collect();
            let value = |flag: &str| {
                flags
                    .windows(2)
                    .find(|pair| pair[0] == flag)
                    .map(|pair| pair[1])
            };
            let selected = expected["format"].as_str().unwrap();
            let selector = if acquisition.plan.selected.is_empty() {
                selected.into()
            } else {
                selected
                    .split('+')
                    .map(|id| format!("all[format_id='{id}']"))
                    .collect::<Vec<_>>()
                    .join("+")
            };
            assert_eq!(value("--format"), Some(selector.as_str()));
            assert_eq!(value("--merge-output-format"), expected["merge"].as_str());
            for flag in [
                "--retries",
                "--fragment-retries",
                "--extractor-retries",
                "--file-access-retries",
            ] {
                assert_eq!(value(flag), Some("0"));
            }
            assert_eq!(value("--max-filesize"), Some("8192"));
            for flag in [
                "--download-sections",
                "--remux-video",
                "--extract-audio",
                "--write-info-json",
                "--write-thumbnail",
                "--write-subs",
                "--write-auto-subs",
                "--sponsorblock-mark",
                "--sponsorblock-remove",
            ] {
                assert!(!flags.contains(&flag));
            }
        }
    }
    for invalid in [
        serde_json::json!({"maxHeight":143}),
        serde_json::json!({"maxHeight":8641}),
        serde_json::json!({"formatIds":["missing"]}),
        serde_json::json!({"formatIds":["a","v"]}),
        serde_json::json!({"formatIds":["bestvideo+bestaudio"]}),
        serde_json::json!({"content":"extras"}),
        serde_json::json!({"range":{"type":"chapters","indexes":[8]}}),
        serde_json::json!({"range":{"type":"custom","start":4,"end":3}}),
    ] {
        assert!(
            serde_json::from_value::<DownloadOptions>(invalid)
                .unwrap()
                .plan(&preview)
                .is_err()
        );
    }
}

#[test]
fn video_only_with_unknown_height_keeps_the_released_maximum_profile() {
    let formats = vec![
        serde_json::json!({"format_id":"v","url":"https://example.invalid/v","vcodec":"avc1","acodec":"none"}),
    ];
    let choices = options::Choices::from_info(&serde_json::json!({}), &formats);
    assert!(choices.video);
    assert!(!choices.compatible_video);
    assert!(choices.video_heights.is_empty());
}

#[tokio::test]
async fn editor_source_requires_current_video_choices_and_waits_for_the_shared_source_slot() {
    let root = tempfile::tempdir().unwrap();
    let manager = Downloads::new(root.path(), Tools::bundled(root.path())).unwrap();
    let preview = reviewed_options_fixture();
    let id = preview.preview_id;
    let json = serde_json::json!({"content":"av","profile":"maximum","maxHeight":144,"formatIds":["v","a"]});
    let options = || serde_json::from_value::<EditorSourceOptions>(json.clone()).unwrap();
    assert!(matches!(
        manager.review_editor(id, options()),
        Err(AppError {
            code: "PREVIEW_EXPIRED",
            ..
        })
    ));
    manager.state.lock().unwrap().reviews.push_back(Reviewed {
        url: provider::validate_url("https://example.invalid/editor").unwrap(),
        preview: preview.clone(),
        time: Instant::now(),
    });
    let acquisition = manager.review_editor(id, options()).unwrap();
    let mut changed = preview.clone();
    changed
        .choices
        .formats
        .iter_mut()
        .find(|s| s.id == "v")
        .unwrap()
        .height = Some(1080);
    assert_eq!(
        acquisition.plan.revalidate(&changed).unwrap_err().code,
        "PREVIEW_CHANGED"
    );
    changed.choices.formats.retain(|s| s.id != "v");
    assert!(acquisition.plan.revalidate(&changed).is_err());
    for changes in [
        serde_json::json!({"content":"audio"}),
        serde_json::json!({"content":"extras"}),
        serde_json::json!({"formatIds":["missing"]}),
        serde_json::json!({"maxHeight":99}),
    ] {
        let mut invalid = json.clone();
        invalid
            .as_object_mut()
            .unwrap()
            .extend(changes.as_object().unwrap().clone());
        assert!(
            manager
                .review_editor(id, serde_json::from_value(invalid).unwrap())
                .is_err()
        );
    }
    for key in ["profile", "maxHeight", "formatIds", "content"] {
        let mut missing = json.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<EditorSourceOptions>(missing).is_err());
    }
    for key in [
        "range",
        "sponsor",
        "thumbnail",
        "metadata",
        "subtitles",
        "url",
    ] {
        let mut invalid = json.clone();
        invalid[key] = true.into();
        assert!(serde_json::from_value::<EditorSourceOptions>(invalid).is_err());
    }
    let slot = manager.source.clone().acquire_owned().await.unwrap();
    let cancel = CancellationToken::new();
    let staging = tempfile::tempdir().unwrap();
    let import = manager.acquire_editor(&acquisition, staging.path(), 4096, &cancel);
    tokio::pin!(import);
    assert!(
        tokio::time::timeout(Duration::from_millis(25), &mut import)
            .await
            .is_err()
    );
    cancel.cancel();
    assert_eq!(import.await.unwrap_err().code, "CANCELLED");
    assert_eq!(std::fs::read_dir(staging.path()).unwrap().count(), 0);
    assert!(manager.snapshot().jobs.is_empty());
    drop(slot);
    manager.shutdown().await.unwrap();
}

#[test]
fn editor_inspection_accepts_full_timed_video_and_rejects_missing_or_incompatible_streams() {
    let root = tempfile::tempdir().unwrap();
    let manager = Downloads::new(root.path(), Tools::bundled(root.path())).unwrap();
    let preview = reviewed_options_fixture();
    let id = preview.preview_id;
    manager.state.lock().unwrap().reviews.push_back(Reviewed {
        url: provider::validate_url("https://example.invalid/editor").unwrap(),
        preview,
        time: Instant::now(),
    });
    let review = |mode: &str, profile: &str| {
        manager.review_editor(id,
        serde_json::from_value(serde_json::json!({"content":mode,"profile":profile,"maxHeight":720,"formatIds":[]})).unwrap()).unwrap()
    };
    let av = review("av", "compatible");
    let video = review("video", "maximum");
    let raw = serde_json::json!({"format":{"format_name":"mov,mp4","duration":"17"},"streams":[
        {"index":0,"codec_type":"video","codec_name":"h264","height":720,"width":1280},
        {"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"sample_rate":48000}]});
    let inspect = |raw: &serde_json::Value| {
        crate::inspection::normalize(&serde_json::to_vec(raw).unwrap()).unwrap()
    };
    assert!(av.validate_source(&inspect(&raw)).is_ok());
    assert!(video.validate_source(&inspect(&raw)).is_err());
    let mut silent = raw.clone();
    silent["streams"].as_array_mut().unwrap().pop();
    assert!(video.validate_source(&inspect(&silent)).is_ok());
    assert!(av.validate_source(&inspect(&silent)).is_err());
    for (field, invalid) in [
        ("codec_name", serde_json::json!("vp9")),
        ("height", serde_json::json!(1080)),
    ] {
        let mut changed = raw.clone();
        changed["streams"][0][field] = invalid;
        assert!(av.validate_source(&inspect(&changed)).is_err());
    }
    let mut missing = raw.clone();
    missing["format"]["duration"] = serde_json::Value::Null;
    assert!(av.validate_source(&inspect(&missing)).is_err());
    missing["streams"].as_array_mut().unwrap().remove(0);
    assert!(av.validate_source(&inspect(&missing)).is_err());
}

#[tokio::test]
async fn download_audio_outputs_start_from_compressed_source_and_use_released_encoders() {
    let dir = Arc::new(tempfile::tempdir().unwrap());
    let mut tools = Tools::bundled(dir.path());
    tools.ffmpeg = std::env::var_os("LVOVD_DESKTOP_FFMPEG").unwrap().into();
    tools.ffprobe = std::env::var_os("LVOVD_DESKTOP_FFPROBE").unwrap().into();
    let supervisor = Supervisor::default();
    let cancel = CancellationToken::new();
    let input = dir.path().join("fixture.m4a");
    let mut args: Vec<std::ffi::OsString> = [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=0.6",
        "-c:a",
        "aac",
    ]
    .map(Into::into)
    .into();
    args.push(input.as_os_str().into());
    supervisor
        .run_owned(
            &tools.ffmpeg,
            &args,
            Duration::from_secs(30),
            65536,
            &cancel,
            dir.clone(),
        )
        .await
        .unwrap();
    let preview = reviewed_options_fixture();
    for (format, extension, codec) in [
        ("source", "m4a", "aac"),
        ("m4a", "m4a", "aac"),
        ("mp3", "mp3", "mp3"),
        ("opus", "opus", "opus"),
        ("flac", "flac", "flac"),
        ("wav", "wav", "pcm_s16le"),
    ] {
        let task = dir.path().join(format);
        std::fs::create_dir(&task).unwrap();
        std::fs::copy(&input, task.join("media.m4a")).unwrap();
        let plan = serde_json::from_value::<DownloadOptions>(
            serde_json::json!({"content":"audio","audioFormat":format}),
        )
        .unwrap()
        .plan(&preview)
        .unwrap();
        let files = outputs::collect(
            &tools,
            &supervisor,
            &plan,
            &plan.sections[0],
            &task,
            dir.clone(),
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, format!("Synthetic fixture.{extension}"));
        if format == "source" {
            assert_eq!(
                std::fs::read(&files[0].path).unwrap(),
                std::fs::read(&input).unwrap()
            );
        }
        let inspected = crate::inspection::inspect(&tools.ffprobe, &files[0].path, &cancel)
            .await
            .unwrap();
        assert_eq!(inspected.streams[0].codec.as_deref(), Some(codec));
    }
}

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
