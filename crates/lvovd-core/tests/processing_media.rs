//! Generated media runs the Rust planner, argument builder and output validator.
//! It never uses the reference backend to perform a transform.
use lvovd_core::{
    capabilities::{Capabilities, CapabilityDiscovery},
    inspection,
    media_inspection::MediaInspection,
    process::{self, CancellationToken},
    processing_command::{self, Attempt},
    processing_plan::{self, ConversionInput, Input, ReviewedPlan},
};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};
fn tool(name: &str) -> PathBuf {
    PathBuf::from(
        std::env::var_os(format!("LVOVD_DESKTOP_{name}")).expect("required media fixture tool"),
    )
}
async fn run(args: Vec<OsString>) -> process::Output {
    process::run(
        &tool("FFMPEG"),
        &args,
        Duration::from_secs(45),
        16 * 1024 * 1024,
        &CancellationToken::new(),
    )
    .await
    .unwrap()
}
async fn inspect(path: &Path) -> MediaInspection {
    inspection::inspect(&tool("FFPROBE"), path, &CancellationToken::new())
        .await
        .unwrap()
        .media
        .unwrap()
}
async fn caps() -> std::sync::Arc<Capabilities> {
    CapabilityDiscovery::new(tool("FFMPEG"))
        .get(&CancellationToken::new())
        .await
        .unwrap()
}
fn plan(
    source: &MediaInspection,
    settings: &Value,
    edit: Option<&Value>,
    caps: &Capabilities,
) -> ReviewedPlan {
    processing_plan::plan(
        Input {
            workspace_id: Some("test-workbench"),
            source_asset_id: Some("test-source"),
            input_filename: Some("Synthetic ü.wav"),
            draft_revision: 1.,
            inspection: Some(source),
            settings: Some(settings),
            edit_plan: edit,
        },
        Some(caps),
    )
    .unwrap()
}
async fn process_file(
    source: &Path,
    output: &Path,
    inspection: &MediaInspection,
    review: &ReviewedPlan,
) -> MediaInspection {
    assert!(review.is_executable(), "{}", review.document());
    let passes = review.document()["passes"].as_u64().unwrap_or(1);
    let log = output.with_extension("pass");
    let supervisor = process::Supervisor::default();
    for pass in 1..=passes {
        let args = processing_command::arguments(
            source,
            output,
            inspection,
            review,
            Attempt {
                pass: (passes == 2).then_some(pass as u8),
                pass_log_prefix: Some(&log),
                conversion_max_bytes: Some(100 * 1024 * 1024),
                ..Default::default()
            },
        )
        .unwrap();
        let (progress, latest) = tokio::sync::watch::channel(process::Progress::default());
        supervisor
            .run_processing_owned(
                process::Request {
                    executable: &tool("FFMPEG"),
                    args: &args,
                    deadline: Duration::from_secs(45),
                    diagnostic_limit: 4 * 1024 * 1024,
                    cancel: &CancellationToken::new(),
                },
                progress,
                (),
            )
            .await
            .unwrap();
        // copyts builds can legitimately report zero until the final result.
        assert!(latest.borrow().out_time_us.is_some());
    }
    supervisor.shutdown().await.unwrap();
    let actual = inspect(output).await;
    processing_command::validate(&actual, review).unwrap();
    actual
}
async fn decode(path: &Path) -> Vec<u8> {
    run(["-hide_banner", "-v", "error", "-i"]
        .map(OsString::from)
        .into_iter()
        .chain([path.as_os_str().into()])
        .chain(
            [
                "-map",
                "0:a:0",
                "-c:a",
                "pcm_f64le",
                "-f",
                "f64le",
                "pipe:1",
            ]
            .map(Into::into),
        )
        .collect())
    .await
    .stdout
}
fn cuts() -> Value {
    json!({"version":1,"keepRanges":[{"startSeconds":0.2,"endSeconds":0.7},{"startSeconds":1.1,"endSeconds":1.5}]})
}
async fn audio_source(root: &Path, codec: &str, rate: u32) -> PathBuf {
    let path = root.join(format!("Synthetic ü {codec}-{rate}.wav"));
    run([
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        &format!("aevalsrc=0.125*sin(2*PI*223*t)|0.25*sin(2*PI*659*t):s={rate}:d=2:c=stereo"),
        "-c:a",
        codec,
    ]
    .map(OsString::from)
    .into_iter()
    .chain([path.as_os_str().into()])
    .collect())
    .await;
    path
}

#[tokio::test]
async fn lossless_audio_and_retained_samples_preserve_integer_and_float_precision() {
    let root = tempfile::tempdir().unwrap();
    let caps = caps().await;
    let edit = cuts();
    for (codec, rate) in [
        ("pcm_s16le", 44100),
        ("pcm_s24le", 96000),
        ("pcm_s32le", 48000),
        ("pcm_f32le", 44100),
        ("pcm_f64le", 48000),
    ] {
        let source = audio_source(root.path(), codec, rate).await;
        let original = std::fs::read(&source).unwrap();
        let inspection = inspect(&source).await;
        let decoded = decode(&source).await;
        let mut expected = Vec::new();
        for (start, end) in [(0.2, 0.7), (1.1, 1.5)] {
            expected.extend_from_slice(
                &decoded[(start * f64::from(rate)).round() as usize * 16
                    ..(end * f64::from(rate)).round() as usize * 16],
            );
        }
        for container in ["flac", "wav"] {
            let review = plan(
                &inspection,
                &json!({"container":container}),
                Some(&edit),
                &caps,
            );
            if container == "flac" && !["pcm_s16le", "pcm_s24le"].contains(&codec) {
                assert_eq!(review.document()["status"], "unavailable");
                assert!(
                    review.document()["message"]
                        .as_str()
                        .unwrap()
                        .contains("WAV")
                );
                continue;
            }
            let output = root.path().join(format!("{codec}-{rate}.{container}"));
            let actual = process_file(&source, &output, &inspection, &review).await;
            assert_eq!(
                actual.audio.as_ref().unwrap().sample_rate,
                Some(u64::from(rate))
            );
            assert_eq!(decode(&output).await, expected, "{codec} into {container}");
        }
        assert_eq!(std::fs::read(source).unwrap(), original);
    }
}

fn amplitude(samples: &[f64], rate: f64, frequency: f64, channel: usize, channels: usize) -> f64 {
    let length = samples.len() / channels;
    let mut real = 0.;
    let mut imaginary = 0.;
    for (index, frame) in samples.chunks_exact(channels).enumerate() {
        let angle = 2. * std::f64::consts::PI * frequency * index as f64 / rate;
        real += frame[channel] * angle.cos();
        imaginary += frame[channel] * angle.sin();
    }
    real.hypot(imaginary) / length as f64
}
#[tokio::test]
async fn opus_preserves_channel_identity_resamples_and_accounts_for_delay() {
    let root = tempfile::tempdir().unwrap();
    let source = audio_source(root.path(), "pcm_s24le", 44100).await;
    let inspection = inspect(&source).await;
    let review = plan(
        &inspection,
        &json!({"container":"opus"}),
        None,
        caps().await.as_ref(),
    );
    let output = root.path().join("result.opus");
    let actual = process_file(&source, &output, &inspection, &review).await;
    assert_eq!(actual.audio.as_ref().unwrap().sample_rate, Some(48000));
    let decoded = decode(&output).await;
    let samples: Vec<f64> = decoded
        .as_chunks::<8>()
        .0
        .iter()
        .map(|c| f64::from_le_bytes(*c))
        .collect();
    assert!(
        (samples.len() as f64 / 2. / 48000. - 2.).abs() <= 0.001,
        "encoder delay must not extend decoded audio"
    );
    assert!(
        amplitude(&samples, 48000., 223., 0, 2) > 10. * amplitude(&samples, 48000., 659., 0, 2)
    );
    assert!(
        amplitude(&samples, 48000., 659., 1, 2) > 10. * amplitude(&samples, 48000., 223., 1, 2)
    );
}

#[tokio::test]
async fn supported_layouts_preserve_channels_and_reject_opus_side_surround() {
    let root = tempfile::tempdir().unwrap();
    let caps = caps().await;
    for (layout, channels) in [
        ("mono", 1),
        ("stereo", 2),
        ("3.0", 3),
        ("quad", 4),
        ("5.0", 5),
        ("5.1", 6),
        ("5.1(side)", 6),
        ("6.1", 7),
        ("7.1", 8),
    ] {
        let source = root.path().join(format!("{layout}.wav"));
        // Channel 3 is LFE in these surround layouts. Test its bass role with
        // a distinct low-frequency marker, not a full-range channel's tone.
        let frequency = |channel: usize| {
            if channels >= 6 && channel == 3 {
                60
            } else {
                200 + channel * 300
            }
        };
        let signal = (0..channels)
            .map(|c| format!("0.1*sin(2*PI*{}*t)", frequency(c)))
            .collect::<Vec<_>>()
            .join("|");
        run([
            "-hide_banner",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            &format!("aevalsrc={signal}:s=48000:d=0.4:c={layout}"),
            "-c:a",
            "pcm_s24le",
        ]
        .map(OsString::from)
        .into_iter()
        .chain([source.as_os_str().into()])
        .collect())
        .await;
        let inspection = inspect(&source).await;
        let original = decode(&source).await;
        let edit = json!({"version":1,"keepRanges":[{"startSeconds":0.05,"endSeconds":0.35}]});
        for container in ["flac", "wav", "opus"] {
            let review = plan(
                &inspection,
                &json!({"container":container}),
                Some(&edit),
                &caps,
            );
            if layout == "5.1(side)" && container == "opus" {
                assert_eq!(review.document()["status"], "unavailable");
                continue;
            }
            let output = root.path().join(format!("{layout}.{container}.out"));
            process_file(&source, &output, &inspection, &review).await;
            let decoded = decode(&output).await;
            if container != "opus" {
                assert_eq!(
                    decoded,
                    &original[2400 * channels * 8..16800 * channels * 8],
                    "{layout} {container}"
                );
            } else {
                let samples: Vec<_> = decoded
                    .as_chunks::<8>()
                    .0
                    .iter()
                    .map(|c| f64::from_le_bytes(*c))
                    .collect();
                assert_eq!(samples.len() / channels, 14400);
                for c in 0..channels {
                    let wanted = amplitude(&samples, 48000., frequency(c) as f64, c, channels);
                    assert!(wanted > 0.03, "{layout} channel {c}");
                    for other in 0..channels {
                        if other != c {
                            assert!(
                                wanted
                                    > 5. * amplitude(
                                        &samples,
                                        48000.,
                                        frequency(other) as f64,
                                        c,
                                        channels
                                    ),
                                "{layout} channel identity"
                            );
                        }
                    }
                }
            }
        }
    }
}

async fn video_source(root: &Path, gaps: bool) -> PathBuf {
    let path = root.join("shifted.mkv");
    let filters = if gaps {
        "[0:v]select='not(between(t,0.8,1.0))',setpts=PTS+3/TB[v];[1:a]aselect='not(between(t,0.5,0.7))',asetpts=PTS+3.2/TB[a]"
    } else {
        "[0:v]setpts=PTS+3/TB[v];[1:a]asetpts=PTS+3.2/TB[a]"
    };
    run([
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=128x72:r=25:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=48000:duration=1.5",
        "-filter_complex",
        filters,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "0",
        "-c:a",
        "pcm_s16le",
        "-fps_mode:v",
        "vfr",
        "-copyts",
    ]
    .map(OsString::from)
    .into_iter()
    .chain([path.as_os_str().into()])
    .collect())
    .await;
    path
}
#[tokio::test]
async fn video_cuts_mkv_audio_extraction_two_pass_and_original_noop_use_rust_policies() {
    let root = tempfile::tempdir().unwrap();
    let source = video_source(root.path(), true).await;
    let original = std::fs::read(&source).unwrap();
    let inspection = inspect(&source).await;
    let caps = caps().await;
    assert!(inspection.time_origin_seconds > 2.9);
    let noop = plan(&inspection, &json!({}), None, &caps);
    assert_eq!(noop.document()["status"], "no-op");
    assert_eq!(noop.document()["preserveSourceInventory"], true);
    assert!(
        processing_command::arguments(
            &source,
            &root.path().join("must-not-exist.mkv"),
            &inspection,
            &noop,
            Attempt::default()
        )
        .is_err()
    );
    let remux = plan(&inspection, &json!({"container":"mov"}), None, &caps);
    assert!(
        remux.document()["streams"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["action"] == "copy")
    );
    let remux_output = root.path().join("remux.mov");
    // MOV cannot represent this PCM packet gap faithfully. Keep the released
    // validator's rejection instead of publishing a shortened audio timeline.
    run(processing_command::arguments(
        &source,
        &remux_output,
        &inspection,
        &remux,
        Attempt::default(),
    )
    .unwrap())
    .await;
    assert!(
        processing_command::validate(&inspect(&remux_output).await, &remux)
            .unwrap_err()
            .message
            .contains("audio endpoint changed")
    );
    let plain_root = tempfile::tempdir().unwrap();
    let plain = video_source(plain_root.path(), false).await;
    let plain_inspection = inspect(&plain).await;
    let plain_plan = plan(&plain_inspection, &json!({"container":"mov"}), None, &caps);
    let plain_output = plain_root.path().join("remux.mov");
    process_file(&plain, &plain_output, &plain_inspection, &plain_plan).await;
    assert_eq!(decode(&plain_output).await, decode(&plain).await);
    // Retain leading silence, internal gaps, and the video-only silent tail.
    let edit = json!({"version":1,"keepRanges":[{"startSeconds":0.1,"endSeconds":1.0},{"startSeconds":1.2,"endSeconds":1.9}]});
    for (index,settings) in [
        json!({"container":"matroska","audio":{"codec":"flac"}}),
        json!({"container":"matroska","audio":{"codec":"opus"}}),
        json!({"container":"mov","audio":{"codec":"aac"},"scale":{"mode":"width","width":96},"frameRate":20}),
        json!({"container":"mp4","audio":{"codec":"aac","bitrateKbps":96},"rate":{"mode":"bitrate","videoKbps":300,"twoPass":true}}),
        json!({"container":"mp4","audio":{"codec":"aac","bitrateKbps":96},"rate":{"mode":"size","maximumMB":0.1}}),
        json!({"container":"wav"}),
    ].iter().enumerate() {
        let review=plan(&inspection,settings,Some(&edit),&caps);
        let output=root.path().join(format!("result-{index}.{}",review.document()["output"]["extension"].as_str().unwrap()));
        process_file(&source,&output,&inspection,&review).await;
        if settings["container"]=="wav" {
            let bytes=decode(&output).await;
            let samples:Vec<_>=bytes.as_chunks::<8>().0.iter().map(|b|f64::from_le_bytes(*b)).collect();
            assert_eq!(samples.len(),76800);
            let energy=|start:f64,end:f64| samples[(start*48000.) as usize..(end*48000.) as usize].iter().map(|v|v.abs()).sum::<f64>()/((end-start)*48000.);
            assert!(energy(0.02,0.08)<1e-8,"leading silence");
            assert!(energy(0.25,0.35)>0.01,"retained tone");
            assert!(energy(0.65,0.75)<1e-8,"internal timestamp gap");
            assert!(energy(1.48,1.58)<1e-8,"silent video-only tail");
        }
        if let Some(max)=review.document()["rateBudget"]["maximumBytes"].as_f64(){assert!(std::fs::metadata(&output).unwrap().len() as f64<=max);}
    }
    for target in ["broad-compatibility-mp4", "m4a-aac", "mp3"] {
        let review = processing_plan::conversion(
            ConversionInput {
                workspace_id: Some("workbench"),
                input_asset_id: Some("edited"),
                input_role: "edited",
                input_filename: Some("edited.mkv"),
                edit_plan_key: Some("committed-edit"),
                inspection: Some(&inspection),
                target_id: target,
            },
            Some(&caps),
        )
        .unwrap();
        let output = root.path().join(format!(
            "legacy-{target}.{}",
            review.document()["output"]["extension"].as_str().unwrap()
        ));
        process_file(&source, &output, &inspection, &review).await;
    }
    assert_eq!(std::fs::read(source).unwrap(), original);
}
