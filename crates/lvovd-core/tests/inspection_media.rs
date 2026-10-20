use lvovd_core::{
    capabilities::CapabilityDiscovery,
    inspection, media_inspection,
    process::{self, CancellationToken},
};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};
fn tool(name: &str) -> PathBuf {
    PathBuf::from(
        std::env::var_os(format!("LVOVD_DESKTOP_{name}"))
            .expect("explicit fixture tool path; tools are never skipped"),
    )
}
async fn run(name: &str, args: Vec<OsString>) -> process::Output {
    process::run(
        &tool(name),
        &args,
        Duration::from_secs(20),
        4 * 1024 * 1024,
        &CancellationToken::new(),
    )
    .await
    .unwrap()
}
fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(k, a)| b.get(k).is_some_and(|b| equal(a, b)))
        }
        _ => a == b,
    }
}
async fn reference(root: &Path, case: Value) -> Value {
    let path = root.join("reference.json");
    std::fs::write(&path, serde_json::to_vec(&case).unwrap()).unwrap();
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/desktop-inspection-fixtures.cjs");
    let output = run("NODE",vec!["-e".into(),"const fs=require('node:fs');const {evaluate}=require(process.argv[1]);process.stdout.write(JSON.stringify(evaluate(JSON.parse(fs.readFileSync(process.argv[2],'utf8')))))".into(),script.into_os_string(),path.into_os_string()]).await;
    serde_json::from_slice(&output.stdout).unwrap()
}
async fn compare_source(root: &Path, path: &Path) {
    let raw = run(
        "FFPROBE",
        [
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-show_chapters",
            "-of",
            "json",
        ]
        .map(OsString::from)
        .into_iter()
        .chain([path.as_os_str().into()])
        .collect(),
    )
    .await;
    let raw: Value = serde_json::from_slice(&raw.stdout).unwrap();
    let size = std::fs::metadata(path).unwrap().len();
    let expected = reference(
        root,
        json!({ "operation": "inspection", "input": { "raw": raw, "sourceSize": size } }),
    )
    .await;
    let actual = inspection::inspect(&tool("FFPROBE"), path, &CancellationToken::new())
        .await
        .unwrap();
    let actual = serde_json::to_value(actual.media.unwrap()).unwrap();
    assert!(
        equal(&actual, &expected["value"]),
        "generated source {:?}\nactual {actual}\nexpected {}",
        path.file_name(),
        expected["value"]
    );
    assert!(!actual.to_string().contains("filename"));
}
#[tokio::test]
async fn generated_precision_and_shifted_media_match_javascript_inspection() {
    let root = tempfile::tempdir().unwrap();
    for (codec, rate) in [
        ("pcm_s16le", "44100"),
        ("pcm_s24le", "96000"),
        ("pcm_s32le", "48000"),
        ("pcm_f32le", "44100"),
        ("pcm_f64le", "48000"),
    ] {
        let path = root.path().join(format!("synthetic audio ü {codec}.wav"));
        run(
            "FFMPEG",
            [
                "-hide_banner",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:duration=0.2",
                "-ar",
                rate,
                "-c:a",
                codec,
            ]
            .map(OsString::from)
            .into_iter()
            .chain([path.as_os_str().into()])
            .collect(),
        )
        .await;
        compare_source(root.path(), &path).await;
    }
    for extension in ["mkv", "mp4"] {
        let path = root.path().join(format!("shifted.{extension}"));
        run(
            "FFMPEG",
            [
                "-hide_banner",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=64x64:r=10:d=1",
                "-itsoffset",
                "0.25",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=0.5",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-threads",
                "1",
                "-c:a",
                "aac",
                "-output_ts_offset",
                "2",
            ]
            .map(OsString::from)
            .into_iter()
            .chain([path.as_os_str().into()])
            .collect(),
        )
        .await;
        compare_source(root.path(), &path).await;
    }
}
#[tokio::test]
async fn real_ffmpeg_discovery_matches_reference_and_is_cached() {
    let root = tempfile::tempdir().unwrap();
    let discovery = CapabilityDiscovery::new(tool("FFMPEG"));
    let cancel = CancellationToken::new();
    let actual = discovery.get(&cancel).await.unwrap();
    assert!(actual.available);
    assert!(std::sync::Arc::ptr_eq(
        &actual,
        &discovery.get(&cancel).await.unwrap()
    ));
    let mut input = json!({});
    for (key, args) in [
        ("version", vec!["-version"]),
        ("encoders", vec!["-hide_banner", "-encoders"]),
        ("decoders", vec!["-hide_banner", "-decoders"]),
        ("muxers", vec!["-hide_banner", "-muxers"]),
    ] {
        let output = run("FFMPEG", args.iter().map(Into::into).collect()).await;
        input[key] = json!(format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let expected = reference(
        root.path(),
        json!({ "operation": "capabilities", "input": input }),
    )
    .await;
    let mut actual_json = serde_json::to_value(&*actual).unwrap();
    actual_json["summary"] = actual.public_summary();
    actual_json["software"] = Value::Object(
        ["h264", "aac", "av1", "mp3", "hevc", "vp9", "unknown"]
            .into_iter()
            .map(|codec| {
                (
                    codec.into(),
                    json!(actual.software_decoder(codec).is_some()),
                )
            })
            .collect(),
    );
    assert!(
        equal(&actual_json, &expected["value"]),
        "real capability parity failed\nactual {actual_json}\nexpected {}",
        expected["value"]
    );
}
#[tokio::test]
async fn dependency_resolving_inputs_are_rejected_and_originals_survive() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("synthetic.m3u8");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let contents = format!(
        "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://{}/never-request.ts\n#EXT-X-ENDLIST\n",
        listener.local_addr().unwrap()
    );
    std::fs::write(&input, &contents).unwrap();
    let result = inspection::inspect(&tool("FFPROBE"), &input, &CancellationToken::new()).await;
    assert!(result.is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err(),
        "FFprobe attempted a forbidden dependency request"
    );
    assert_eq!(std::fs::read_to_string(input).unwrap(), contents);
}
#[tokio::test]
async fn real_mov_external_references_never_publish_ready_metadata() {
    fn atom(kind: &[u8], body: &[u8]) -> Vec<u8> {
        let mut result = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        result.extend(kind);
        result.extend(body);
        result
    }
    fn rewrite(bytes: &[u8], alias: &[u8]) -> Vec<u8> {
        let mut offset = 0;
        let mut output = vec![];
        while offset < bytes.len() {
            let size = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            assert!(size >= 8 && offset + size <= bytes.len());
            let kind = &bytes[offset + 4..offset + 8];
            let body = &bytes[offset + 8..offset + size];
            let changed = if [b"moov", b"trak", b"mdia", b"minf", b"dinf"]
                .iter()
                .any(|k| kind == *k)
            {
                rewrite(body, alias)
            } else if kind == b"dref" {
                [vec![0, 0, 0, 0, 0, 0, 0, 1], alias.to_vec()].concat()
            } else {
                body.to_vec()
            };
            output.extend(atom(kind, &changed));
            offset += size;
        }
        output
    }
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("generated.mp4");
    run(
        "FFMPEG",
        [
            "-hide_banner",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=64x64:r=10:d=0.2",
            "-c:v",
            "libx264",
            "-threads",
            "1",
        ]
        .map(OsString::from)
        .into_iter()
        .chain([source.as_os_str().into()])
        .collect(),
    )
    .await;
    let original = std::fs::read(&source).unwrap();
    let target = b"generated-dependencies:fixture.mp4\0";
    let mut alias = vec![0; 4 + 10 + 28 + 12 + 64 + 16 + 4 + 16];
    alias.extend(2u16.to_be_bytes());
    alias.extend((target.len() as u16).to_be_bytes());
    alias.extend(target);
    if !target.len().is_multiple_of(2) {
        alias.push(0);
    }
    alias.extend([255, 255, 0, 0]);
    let input = root.path().join("external-tracks.mov");
    std::fs::write(&input, rewrite(&original, &atom(b"alis", &alias))).unwrap();
    let error = inspection::inspect(&tool("FFPROBE"), &input, &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, "LOCAL_INPUT_UNSUPPORTED");
    assert_eq!(std::fs::read(source).unwrap(), original);
}
#[test]
fn malformed_and_oversized_metadata_is_bounded_before_use() {
    for raw in [
        json!([]),
        json!({"streams":[null]}),
        json!({"streams":vec![json!({});65]}),
        json!({"chapters":vec![json!({});10001]}),
    ] {
        assert_eq!(
            media_inspection::normalize(&serde_json::to_vec(&raw).unwrap(), None)
                .unwrap_err()
                .code,
            "INSPECTION_INVALID"
        );
    }
    assert!(
        media_inspection::normalize(&vec![b' '; media_inspection::MAX_METADATA_BYTES + 1], None)
            .is_err()
    );
    let raw = json!({ "format": {"filename":"/synthetic/private","tags":{"comment":"not exposed"}},"streams":[{"index":0,"codec_type":"audio","sample_fmt":"s32;filter","bits_per_raw_sample":"0x10"}] });
    let data = media_inspection::normalize(&serde_json::to_vec(&raw).unwrap(), None).unwrap();
    assert_eq!(data.audio.as_ref().unwrap().sample_format, None);
    assert_eq!(data.audio.as_ref().unwrap().bits_per_raw_sample, None);
    assert!(!serde_json::to_string(&data).unwrap().contains("private"));
}
