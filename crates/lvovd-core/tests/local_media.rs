//! Complete native-core ownership path, independent of the JavaScript backend.
use lvovd_core::{
    analysis::Kind,
    assets::Assets,
    media::Library,
    process::{self, CancellationToken},
    processing_operation::{Admission, Limits, Processing, ReviewRequest},
    workbenches::Workbenches,
};
use serde_json::json;
use std::{ffi::OsString, path::PathBuf, time::Duration};
fn tool(name: &str) -> PathBuf {
    std::env::var_os(format!("LVOVD_DESKTOP_{name}"))
        .unwrap()
        .into()
}
struct Fixture {
    root: tempfile::TempDir,
    original: PathBuf,
    owner: Workbenches,
    workbench: uuid::Uuid,
    source: uuid::Uuid,
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("synthetic.wav");
        let mut args: Vec<OsString> = [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=500:sample_rate=44100:duration=2",
            "-c:a",
            "pcm_s24le",
        ]
        .map(Into::into)
        .into();
        args.push(original.as_os_str().into());
        process::run(
            &tool("FFMPEG"),
            &args,
            Duration::from_secs(20),
            1024 * 1024,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let assets = Assets::new(root.path()).unwrap();
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
        let owner = Workbenches::new(assets, processing, tool("FFMPEG"), tool("FFPROBE"));
        let workbench = owner.open().unwrap().workbench_id;
        let source = owner
            .import(workbench, vec![original.clone()])
            .await
            .unwrap()
            .sources[0]
            .asset_id;
        Self {
            root,
            original,
            owner,
            workbench,
            source,
        }
    }
    async fn analysis(&self, kind: Kind) -> lvovd_core::analysis::State {
        self.owner
            .prepare_analysis(self.workbench, self.source, kind)
            .unwrap();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let snapshot = self.owner.snapshot(self.workbench).unwrap();
                let state = if kind == Kind::Preview {
                    snapshot.previews[0].clone()
                } else {
                    snapshot.waveforms[0].clone()
                };
                assert_ne!(state.status, "failed", "{:?}", state.message);
                if state.status == "ready" {
                    break state;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn settled(&self) {
        for _ in 0..200 {
            self.owner.reconcile().await.unwrap();
            if self
                .owner
                .snapshot(self.workbench)
                .unwrap()
                .cleanup
                .is_empty()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("cleanup did not retire owned resources");
    }
}
#[tokio::test]
async fn single_workbench_proxy_waveform_and_result_leases_preserve_originals() {
    let f = Fixture::new().await;
    assert_eq!(f.workbench, f.owner.open().unwrap().workbench_id);
    let preview = f.analysis(Kind::Preview).await;
    assert!(preview.proxy);
    assert_ne!(preview.asset_id, Some(f.source));
    let proxy = f.owner.media_lease(preview.asset_id.unwrap()).unwrap();
    assert_eq!(proxy.mime(), Some("audio/mp4"));
    assert!(!proxy.read(0, 64).unwrap().is_empty());
    // A proxy must never be accepted as an original input.
    assert!(
        f.owner
            .review(
                f.workbench,
                ReviewRequest {
                    source_id: preview.asset_id.unwrap(),
                    draft_revision: 0,
                    settings: None,
                    edit_plan: None
                }
            )
            .await
            .is_err()
    );
    let waveform = f.analysis(Kind::Waveform).await;
    let repeated = f
        .owner
        .prepare_analysis(f.workbench, f.source, Kind::Waveform)
        .unwrap();
    assert_eq!(repeated.waveforms[0].operation_id, waveform.operation_id);
    let window = f
        .owner
        .waveform_window(
            f.workbench,
            f.source,
            waveform.operation_id.unwrap(),
            0.,
            2.,
            4096,
        )
        .unwrap();
    assert!(window["peaks"].as_array().unwrap().len() <= 200);
    assert!(
        window["peaks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p[0].as_f64().unwrap() < 0. && p[1].as_f64().unwrap() > 0.)
    );
    assert!(
        f.owner
            .waveform_window(f.workbench, f.source, uuid::Uuid::new_v4(), 0., 2., 12)
            .is_err()
    );
    assert!(
        f.owner
            .waveform_window(
                f.workbench,
                f.source,
                waveform.operation_id.unwrap(),
                0.,
                2.,
                4097
            )
            .is_err()
    );
    f.owner.remove(f.workbench, f.source).unwrap();
    assert!(proxy.cancellation().is_cancelled());
    assert!(proxy.read(0, 1).is_err());
    assert!(f.owner.media_lease(preview.asset_id.unwrap()).is_err());
    f.owner.reconcile().await.unwrap();
    assert_eq!(
        f.owner.snapshot(f.workbench).unwrap().cleanup,
        vec![f.source]
    );
    drop(proxy);
    f.settled().await;
    assert!(f.original.is_file());
    f.owner.shutdown().await.unwrap();
}
#[tokio::test]
async fn foreground_jobs_preempt_analysis_and_saved_copies_are_collision_safe() {
    let f = Fixture::new().await;
    f.owner
        .prepare_analysis(f.workbench, f.source, Kind::Waveform)
        .unwrap();
    let review = f
        .owner
        .review(
            f.workbench,
            ReviewRequest {
                source_id: f.source,
                draft_revision: 1,
                settings: Some(json!({"container":"flac","audio":{"codec":"flac"}})),
                edit_plan: Some(
                    json!({"version":1,"keepRanges":[{"startSeconds":0.25,"endSeconds":1.25}]}),
                ),
            },
        )
        .await
        .unwrap();
    f.owner
        .enqueue(
            f.workbench,
            vec![Admission {
                source_id: f.source,
                key: review.key().into(),
                acknowledgements: vec![],
            }],
        )
        .await
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            f.owner.reconcile().await.unwrap();
            let s = f.owner.snapshot(f.workbench).unwrap();
            if let Some(output) = s.results.first() {
                break output.clone();
            }
            assert!(
                !s.jobs
                    .iter()
                    .any(|j| j.status == lvovd_core::processing_queue::Status::Failed)
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(!output.no_op);
    assert_eq!(
        output
            .inspection
            .audio
            .as_ref()
            .unwrap()
            .bits_per_raw_sample,
        Some(24)
    );
    let destination = f.root.path().join("saved.flac");
    let unavailable = f.root.path().join("unavailable-folder").join("saved.flac");
    assert_eq!(
        lvovd_core::export::save_copy(
            f.owner.result(f.workbench, output.result_id).unwrap(),
            &unavailable,
        )
        .unwrap_err()
        .code,
        "SAVE_FAILED"
    );
    assert!(!unavailable.exists());
    assert_eq!(
        f.owner
            .result(f.workbench, output.result_id)
            .unwrap()
            .descriptor()
            .size,
        output.size
    );
    std::fs::write(&destination, b"existing user file").unwrap();
    let lease = f.owner.result(f.workbench, output.result_id).unwrap();
    let saved = lvovd_core::export::save_copy(lease, &destination).unwrap();
    assert_eq!(saved.file_name().unwrap(), "saved (1).flac");
    assert_eq!(std::fs::read(&destination).unwrap(), b"existing user file");
    let reader = f.owner.media_lease(output.result_id).unwrap();
    assert_eq!(reader.size(), output.size);
    f.owner.remove(f.workbench, f.source).unwrap();
    assert!(reader.read(0, 1).is_err());
    drop(reader);
    f.settled().await;
    assert!(saved.is_file() && f.original.is_file());
    f.owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn legacy_render_conversion_roles_keep_inputs_and_reject_stale_edits() {
    use lvovd_core::processing_operation::ConversionReview;
    for rate in [48000, 44100] {
        let f = Fixture::new().await;
        let audio = format!("sine=frequency=400:sample_rate={rate}:duration=2");
        let video = f.root.path().join("synthetic.mp4");
        let mut args: Vec<OsString> = [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=96x64:rate=20:duration=2",
            "-f",
            "lavfi",
            "-i",
            &audio,
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
        ]
        .map(Into::into)
        .into();
        args.push(video.as_os_str().into());
        process::run(
            &tool("FFMPEG"),
            &args,
            Duration::from_secs(20),
            1024 * 1024,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let source = f
            .owner
            .import(f.workbench, vec![video.clone()])
            .await
            .unwrap()
            .sources[0]
            .asset_id;
        let edit = json!({"version":1,"keepRanges":[{"startSeconds":0.25,"endSeconds":1.25}]});
        let render = f
            .owner
            .review_render(f.workbench, source, 0, edit.clone())
            .await
            .unwrap();
        async fn run(
            f: &Fixture,
            source: uuid::Uuid,
            key: &str,
            revision: u32,
        ) -> lvovd_core::processing_operation::Published {
            f.owner
                .enqueue(
                    f.workbench,
                    vec![Admission {
                        source_id: source,
                        key: key.into(),
                        acknowledgements: vec![],
                    }],
                )
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    f.owner.reconcile().await.unwrap();
                    let s = f.owner.snapshot(f.workbench).unwrap();
                    assert!(
                        !s.jobs.iter().any(|j| j.source_id == source
                            && j.status == lvovd_core::processing_queue::Status::Failed),
                        "{:?}",
                        s.jobs
                    );
                    if let Some(output) = s
                        .results
                        .iter()
                        .find(|r| r.source_id == source && r.draft_revision == revision)
                    {
                        break output.clone();
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap()
        }
        let rendered = run(&f, source, render.key(), 0).await;
        assert_eq!(rendered.role, "edited-output");
        assert!((rendered.inspection.duration_seconds.unwrap() - 1.).abs() < 0.1);
        let held = f.owner.result(f.workbench, rendered.result_id).unwrap();
        let bytes = held.read(0, held.descriptor().size as usize).unwrap();
        for revision in 1..=3 {
            let review = f
                .owner
                .review_conversion(
                    f.workbench,
                    ConversionReview {
                        source_id: source,
                        input_asset_id: rendered.result_id,
                        draft_revision: revision,
                        target_id: "broad-compatibility-mp4".into(),
                        edit_plan: Some(edit.clone()),
                    },
                )
                .await
                .unwrap();
            assert_eq!(review.document()["inputRole"], "edited-output");
            let converted = run(&f, source, review.key(), revision).await;
            assert!(converted.no_op);
            assert_eq!(
                f.owner
                    .result(f.workbench, converted.result_id)
                    .unwrap()
                    .read(0, converted.size as usize)
                    .unwrap(),
                bytes
            );
            assert!(
                f.owner
                    .review_conversion(
                        f.workbench,
                        ConversionReview {
                            source_id: source,
                            input_asset_id: converted.result_id,
                            draft_revision: revision + 1,
                            target_id: "mp3".into(),
                            edit_plan: Some(edit.clone())
                        }
                    )
                    .await
                    .is_err()
            );
        }
        let changed = json!({"version":1,"keepRanges":[{"startSeconds":0.5,"endSeconds":1.5}]});
        assert!(
            f.owner
                .review_conversion(
                    f.workbench,
                    ConversionReview {
                        source_id: source,
                        input_asset_id: rendered.result_id,
                        draft_revision: 4,
                        target_id: "mp3".into(),
                        edit_plan: Some(changed)
                    }
                )
                .await
                .is_err()
        );
        let review = f
            .owner
            .review_conversion(
                f.workbench,
                ConversionReview {
                    source_id: source,
                    input_asset_id: rendered.result_id,
                    draft_revision: 4,
                    target_id: "mp3".into(),
                    edit_plan: Some(edit.clone()),
                },
            )
            .await
            .unwrap();
        if rate == 48000 {
            let converted = run(&f, source, review.key(), 4).await;
            assert!(!converted.no_op);
            assert_eq!(
                converted
                    .inspection
                    .audio
                    .as_ref()
                    .unwrap()
                    .codec
                    .as_deref(),
                Some("mp3")
            );
            assert!((converted.inspection.duration_seconds.unwrap() - 1.).abs() < 0.1);
        } else {
            // The reference validator rejects this short 44.1 kHz AAC-to-MP3 case:
            // AAC padding plus MP3 delay makes its container duration exceed 60 ms.
            // Preserve that failure and the last valid result, without loosening it.
            f.owner
                .enqueue(
                    f.workbench,
                    vec![Admission {
                        source_id: source,
                        key: review.key().into(),
                        acknowledgements: vec![],
                    }],
                )
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    f.owner.reconcile().await.unwrap();
                    let state = f.owner.snapshot(f.workbench).unwrap();
                    if let Some(job) = state.jobs.iter().find(|j| {
                        j.source_id == source
                            && j.status == lvovd_core::processing_queue::Status::Failed
                    }) {
                        assert!(
                            job.failure.as_ref().unwrap()["message"]
                                .as_str()
                                .unwrap()
                                .contains("duration differs from selected presentation")
                        );
                        assert_eq!(
                            state
                                .results
                                .iter()
                                .find(|r| r.source_id == source)
                                .unwrap()
                                .draft_revision,
                            3
                        );
                        break;
                    }
                    if state.jobs.iter().any(|j| {
                        j.source_id == source
                            && j.status == lvovd_core::processing_queue::Status::Completed
                    }) {
                        let output = state
                            .results
                            .iter()
                            .find(|r| r.source_id == source)
                            .unwrap();
                        assert_eq!(output.draft_revision, 4);
                        assert!((output.inspection.duration_seconds.unwrap() - 1.).abs() <= 0.06);
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let review = f
                .owner
                .review_conversion(
                    f.workbench,
                    ConversionReview {
                        source_id: source,
                        input_asset_id: rendered.result_id,
                        draft_revision: 5,
                        target_id: "m4a-aac".into(),
                        edit_plan: Some(edit.clone()),
                    },
                )
                .await
                .unwrap();
            let converted = run(&f, source, review.key(), 5).await;
            assert_eq!(
                converted
                    .inspection
                    .audio
                    .as_ref()
                    .unwrap()
                    .codec
                    .as_deref(),
                Some("aac")
            );
        }
        assert_eq!(held.read(0, bytes.len()).unwrap(), bytes);
        f.owner.remove(f.workbench, source).unwrap();
        f.owner.reconcile().await.unwrap();
        assert!(
            f.owner
                .snapshot(f.workbench)
                .unwrap()
                .cleanup
                .contains(&source)
        );
        drop(held);
        f.settled().await;
        assert!(video.is_file());
        f.owner.shutdown().await.unwrap();
    }
}
