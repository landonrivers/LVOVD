//! Replay synthetic extractor metadata through real yt-dlp and FFmpeg. Local
//! HTTP serves only the generated tracks and companions on loopback.
use super::*;
use crate::inspection;
use serde_json::{Value, json};
use std::ffi::OsString;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use std::sync::atomic::{AtomicUsize, Ordering};
async fn fixture_server(root: Arc<TempDir>, sponsor_requests: Arc<AtomicUsize>) -> String {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let root = root.clone();
            let sponsor_requests = sponsor_requests.clone();
            tokio::spawn(async move {
                let (input, mut output) = stream.into_split();
                let mut lines = BufReader::new(input).lines();
                let request = lines.next_line().await.unwrap().unwrap_or_default();
                let mut words = request.split_whitespace();
                let method = words.next();
                let name = words.next().unwrap_or_default().trim_start_matches('/');
                if name.starts_with("api/skipSegments/") {
                    sponsor_requests.fetch_add(1, Ordering::SeqCst);
                    while let Ok(Some(line)) = lines.next_line().await {
                        if line.is_empty() {
                            break;
                        }
                    }
                    let body=br#"[{"videoID":"fixture","segments":[{"category":"sponsor","actionType":"skip","segment":[2,4],"videoDuration":4}]}]"#;
                    let headers = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = output.write_all(headers.as_bytes()).await;
                    let _ = output.write_all(body).await;
                    return;
                }
                if !["v.mp4", "a.m4a", "cover.jpg", "captions.srt"].contains(&name) {
                    let _ = output
                        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                        .await;
                    return;
                }
                let bytes = std::fs::read(root.path().join(name)).unwrap();
                let mut start = 0;
                let mut end = bytes.len() - 1;
                let mut range = false;
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.is_empty() {
                        break;
                    }
                    if let Some((a, b)) = line
                        .to_ascii_lowercase()
                        .strip_prefix("range: bytes=")
                        .and_then(|s| s.split_once('-'))
                    {
                        start = a.parse().unwrap_or(0);
                        end = b.parse::<usize>().unwrap_or(end).min(end);
                        range = true;
                    }
                }
                if start > end {
                    return;
                }
                let status = if range {
                    "206 Partial Content"
                } else {
                    "200 OK"
                };
                let size = bytes.len();
                let content_range = if range {
                    format!("Content-Range: bytes {start}-{end}/{size}\r\n")
                } else {
                    String::new()
                };
                let headers = format!(
                    "HTTP/1.1 {status}\r\n{content_range}Accept-Ranges: bytes\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    end - start + 1
                );
                let _ = output.write_all(headers.as_bytes()).await;
                if method == Some("GET") {
                    let _ = output.write_all(&bytes[start..=end]).await;
                }
            });
        }
    });
    format!("http://{address}")
}

#[tokio::test]
async fn exported_streams_sections_and_companions_from_reviewed_formats() {
    let root = Arc::new(tempfile::tempdir().unwrap());
    let path = |name: &str| root.path().join(name);
    let sponsor_requests = Arc::new(AtomicUsize::new(0));
    let base = fixture_server(root.clone(), sponsor_requests.clone()).await;
    let uri = |name: &str| format!("{base}/{name}");
    let tool =
        |name: &str| PathBuf::from(std::env::var_os(format!("LVOVD_DESKTOP_{name}")).unwrap());
    let tools = Tools {
        ffmpeg: tool("FFMPEG"),
        ffprobe: tool("FFPROBE"),
        node: tool("NODE"),
        ytdlp: tool("YTDLP"),
    };
    let supervisor = Supervisor::default();
    let cancel = CancellationToken::new();
    for (name, flags) in [
        (
            "v.mp4",
            vec![
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=256x144:rate=10",
                "-t",
                "4",
                "-c:v",
                "libx264",
                "-g",
                "10",
            ],
        ),
        (
            "a.m4a",
            vec!["-f", "lavfi", "-i", "sine", "-t", "4", "-c:a", "aac"],
        ),
        (
            "cover.jpg",
            vec!["-f", "lavfi", "-i", "color=size=32x32", "-frames:v", "1"],
        ),
    ] {
        let args: Vec<OsString> = flags
            .into_iter()
            .map(Into::into)
            .chain([path(name).into()])
            .collect();
        supervisor
            .run_owned(
                &tools.ffmpeg,
                &args,
                Duration::from_secs(30),
                65536,
                &cancel,
                root.clone(),
            )
            .await
            .unwrap();
    }
    std::fs::write(
        path("captions.srt"),
        "1\n00:00:00,000 --> 00:00:01,000\nSynthetic subtitle\n",
    )
    .unwrap();
    let info = json!({"id":"fixture","title":"Fixture","extractor":"youtube","extractor_key":"Youtube",
        "webpage_url":"https://example.invalid/fixture","duration":4,"thumbnail":uri("cover.jpg"),
        "thumbnails":[{"url":uri("cover.jpg"),"id":"0","ext":"jpg"}],
        "formats":[
            {"url":uri("a.m4a"),"format_id":"a","ext":"m4a","acodec":"mp4a.40.2","vcodec":"none"},
            {"url":uri("v.mp4"),"format_id":"v","ext":"mp4","vcodec":"avc1","acodec":"none","height":144}],
        "chapters":[{"title":"First","start_time":0,"end_time":1},{"title":"Second","start_time":1,"end_time":3}],
        "subtitles":{"en":[{"url":uri("captions.srt"),"ext":"srt"}]},
        "automatic_captions":{"fr":[{"url":uri("captions.srt"),"ext":"srt"}]}});
    let bytes = serde_json::to_vec(&info).unwrap();
    let fixture = path("fixture.info.json");
    std::fs::write(&fixture, &bytes).unwrap();
    let url = provider::validate_url("https://example.invalid/fixture").unwrap();
    let preview = provider::metadata(&bytes, &url).unwrap().0;
    for (scenario, options) in [
        ("separate", json!({"formatIds":["v","a"],"metadata":true})),
        ("video", json!({"content":"video","maxHeight":144})),
        (
            "chapters",
            json!({"range":{"type":"chapters","indexes":[1,0]}}),
        ),
        (
            "range",
            json!({"range":{"type":"custom","start":1,"end":3}}),
        ),
        (
            "mark",
            json!({"sponsor":{"mode":"mark","categories":["sponsor"]}}),
        ),
        (
            "remove",
            json!({"sponsor":{"mode":"remove","categories":["sponsor"]}}),
        ),
        (
            "source",
            json!({"content":"audio","audioFormat":"source","formatIds":["a"]}),
        ),
        (
            "extras",
            json!({"content":"extras","thumbnail":true,"metadata":true,"subtitles":{"mode":"both","languages":"en,fr"}}),
        ),
    ] {
        let plan = serde_json::from_value::<DownloadOptions>(options)
            .unwrap()
            .plan(&preview)
            .unwrap();
        for (index, section) in plan.sections.iter().enumerate() {
            let task = path(&format!("{scenario}-{index}"));
            std::fs::create_dir(&task).unwrap();
            let mut args = provider::acquire_args(&tools, &url, &plan, section, &task).unwrap();
            args.truncate(args.len() - 2);
            let before = sponsor_requests.load(Ordering::SeqCst);
            args.extend([
                "--sponsorblock-api".into(),
                base.clone().into(),
                "--load-info-json".into(),
                fixture.as_os_str().into(),
            ]);
            supervisor
                .run_provider_owned(
                    Request {
                        executable: &tools.ytdlp,
                        args: &args,
                        deadline: Duration::from_secs(90),
                        diagnostic_limit: 1024 * 1024,
                        cancel: &cancel,
                    },
                    &task,
                    root.clone(),
                )
                .await
                .unwrap_or_else(|e| panic!("{scenario}: {e:?}"));
            assert_eq!(
                sponsor_requests.load(Ordering::SeqCst) - before,
                usize::from(matches!(scenario, "mark" | "remove"))
            );
            let files = outputs::collect(
                &tools,
                &supervisor,
                &plan,
                section,
                &task,
                root.clone(),
                &cancel,
            )
            .await
            .unwrap_or_else(|e| panic!("{scenario}: {e:?}"));
            let names: Vec<_> = files.iter().map(|f| f.name.as_str()).collect();
            if scenario == "extras" {
                assert_eq!(
                    names,
                    [
                        "Fixture [fixture].en.srt",
                        "Fixture [fixture].fr.srt",
                        "Fixture [fixture].info.json",
                        "Fixture [fixture].jpg"
                    ]
                );
                let metadata: Value =
                    serde_json::from_slice(&std::fs::read(&files[2].path).unwrap()).unwrap();
                assert_eq!(metadata["id"], "fixture");
                continue;
            }
            if scenario == "source" {
                assert_eq!(
                    std::fs::read(&files[0].path).unwrap(),
                    std::fs::read(path("a.m4a")).unwrap()
                );
                continue;
            }
            let facts = inspection::inspect(&tools.ffprobe, &files[0].path, &cancel)
                .await
                .unwrap()
                .media
                .unwrap();
            assert_eq!(facts.video.unwrap().codec.as_deref(), Some("h264"));
            assert_eq!(facts.audio.is_some(), scenario != "video");
            if scenario == "mark" {
                let args: Vec<OsString> = ["-v", "error", "-show_chapters", "-of", "json"]
                    .map(Into::into)
                    .into_iter()
                    .chain([files[0].path.as_os_str().into()])
                    .collect();
                let probe = supervisor
                    .run_owned(
                        &tools.ffprobe,
                        &args,
                        Duration::from_secs(30),
                        65536,
                        &cancel,
                        root.clone(),
                    )
                    .await
                    .unwrap();
                assert!(String::from_utf8(probe.stdout).unwrap().contains("Sponsor"));
            }
            if scenario == "remove" {
                assert!((facts.duration_seconds.unwrap() - 2.).abs() < 0.5);
            }
            if scenario == "separate" {
                assert_eq!(
                    names,
                    ["Fixture [fixture].mp4", "Fixture [fixture].info.json"]
                );
            }
            if let Some((start, end)) = section.range {
                assert!((facts.duration_seconds.unwrap() - (end - start)).abs() < 0.5);
            }
            if scenario == "chapters" {
                assert_eq!(
                    names,
                    [format!("Fixture [fixture] - Chapter {}.mp4", 2 - index)]
                );
            }
        }
    }
}
