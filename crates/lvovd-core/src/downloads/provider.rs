use super::{DownloadPreview, DownloadProgress, Profile};
use crate::{AppError, Result, tools::Tools};
use serde_json::Value;
use std::{ffi::OsString, path::Path};
use url::Url;
use uuid::Uuid;

const COMPATIBLE: &str = "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=h264]+bestaudio[acodec^=aac]/best[vcodec^=avc1][acodec^=mp4a]/best[vcodec^=h264][acodec^=aac]";
const MAXIMUM: &str = "bestvideo+bestaudio/best";

pub(super) fn validate_url(input: &str) -> Result<Url> {
    let invalid = || AppError::new("INVALID_URL", "Enter a complete HTTP or HTTPS media URL.");
    let input = input.trim();
    if input.len() > 8192
        || input
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return Err(invalid());
    }
    let url = Url::parse(input).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    Ok(url)
}

fn args(tools: &Tools) -> Result<Vec<OsString>> {
    if [&tools.ytdlp, &tools.ffmpeg, &tools.ffprobe, &tools.node]
        .iter()
        .any(|p| !p.is_absolute())
    {
        return Err(AppError::new(
            "TOOL_PATH",
            "Check the provider tools in Runtime status.",
        ));
    }
    let mut node: OsString = "node:".into();
    node.push(&tools.node);
    let mut args: Vec<_> = [
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-remote-components",
        "--no-cache-dir",
        "--no-js-runtimes",
        "--js-runtimes",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    args.extend([
        node,
        "--ffmpeg-location".into(),
        tools.ffmpeg.clone().into_os_string(),
    ]);
    args.extend(["--no-colors", "--no-warnings", "--socket-timeout", "30"].map(Into::into));
    Ok(args)
}

pub(super) fn preview_args(tools: &Tools, url: &Url) -> Result<Vec<OsString>> {
    let mut args = args(tools)?;
    args.extend(
        [
            "--dump-single-json",
            "--skip-download",
            "--flat-playlist",
            "--playlist-end",
            "1",
            "--",
            url.as_str(),
        ]
        .map(Into::into),
    );
    Ok(args)
}

pub(super) fn acquire_args(
    tools: &Tools,
    url: &Url,
    profile: Profile,
    directory: &Path,
) -> Result<Vec<OsString>> {
    let mut args = args(tools)?;
    args.extend(["--no-playlist", "--playlist-end", "1", "--match-filter", "!is_live & !has_drm",
        "--newline", "--progress", "--progress-delta", "0.25", "--no-simulate", "--quiet",
        "--progress-template", "download:LVOVD|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
        "--progress-template", "postprocess:LVOVD_POST", "--format",
        match profile { Profile::Compatible => COMPATIBLE, Profile::Maximum => MAXIMUM },
        "--merge-output-format", "mp4", "--remux-video", "mp4", "--paths",
    ].map(Into::into));
    // Provider metadata never decides the path to write or publish.
    args.push(directory.as_os_str().into());
    args.extend(["--output", "media.%(ext)s", "--", url.as_str()].map(Into::into));
    Ok(args)
}

fn text(v: &Value, max: usize) -> Option<String> {
    v.as_str()
        .map(|s| {
            s.trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(max)
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
}
fn codec(v: &Value) -> Option<String> {
    text(v, 80)
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| s != "na")
}
fn number(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|v| v.is_finite())
}

fn visual_evidence(format: &Value) -> bool {
    if format["url"]
        .as_str()
        .or(format["manifest_url"].as_str())
        .is_none_or(str::is_empty)
    {
        return false;
    }
    ["height", "width", "fps", "aspect_ratio"]
        .iter()
        .any(|key| number(&format[*key]).is_some_and(|v| v > 0.0))
}

fn filename(title: &str, id: Option<&str>) -> String {
    // Bound UTF-8 bytes, including on filesystems with a 255-byte component limit.
    fn component(value: &str, max: usize) -> String {
        let mut out = String::new();
        for c in value.chars() {
            let c = if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            };
            if out.len() + c.len_utf8() > max {
                break;
            }
            out.push(c);
        }
        out.trim_matches([' ', '.']).to_owned()
    }
    let mut stem = component(title, 160);
    if stem.is_empty() {
        stem.push_str("Download");
    }
    if let Some(id) = id.map(|s| component(s, 50)).filter(|s| !s.is_empty()) {
        stem.push_str(&format!(" [{id}]"));
    }
    if pattern!(r"(?i)^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])([. ]|$)").is_match(&stem) {
        stem.insert(0, '_');
    }
    format!("{stem}.mp4")
}

pub(super) fn metadata(bytes: &[u8], url: &Url) -> Result<(DownloadPreview, Option<String>)> {
    let info: Value = serde_json::from_slice(bytes).map_err(|_| {
        AppError::new(
            "PREVIEW_METADATA",
            "The provider returned unreadable metadata. Try Preview again.",
        )
    })?;
    if !info.is_object() {
        return Err(AppError::new(
            "PREVIEW_METADATA",
            "The provider returned no media details.",
        ));
    }
    let mut compatible_combined = false;
    let mut compatible_video = false;
    let mut compatible_audio = false;
    let mut possible_audio = false;
    let mut possible_video = false;
    let formats = info["formats"]
        .as_array()
        .filter(|list| !list.is_empty())
        .map(Vec::as_slice)
        .unwrap_or(std::slice::from_ref(&info));
    for f in formats {
        if !f.is_object() || f["has_drm"] == true {
            continue;
        }
        let video = codec(&f["vcodec"]);
        let audio = codec(&f["acodec"]);
        let h264 = video
            .as_ref()
            .is_some_and(|s| s.starts_with("h264") || s.starts_with("avc1"));
        let aac = audio
            .as_ref()
            .is_some_and(|s| s.starts_with("aac") || s.starts_with("mp4a"));
        compatible_combined |= h264 && aac;
        compatible_video |= h264 && audio.as_deref() == Some("none");
        compatible_audio |= aac && video.as_deref() == Some("none");
        // The generic extractor can report a direct MP4 with only an HTTP URL
        // and video extension. Treat it as eligible for an attempt; FFprobe must
        // still confirm both actual streams before we publish anything.
        let direct_container = info["extractor_key"]
            .as_str()
            .or(info["extractor"].as_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("generic"))
            && f["url"].as_str().is_some_and(|s| validate_url(s).is_ok())
            && matches!(
                f["ext"]
                    .as_str()
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_str(),
                "mp4" | "webm" | "mov" | "mkv" | "m4v"
            );
        let audio_container = matches!(
            f["ext"]
                .as_str()
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
            "mp3" | "m4a" | "aac" | "flac" | "wav" | "opus" | "oga" | "aiff"
        );
        let visual = !audio_container
            && video.as_deref() != Some("none")
            && (visual_evidence(f) || direct_container);
        possible_video |= video.as_deref().is_some_and(|s| s != "none") || visual;
        possible_audio |=
            audio.as_deref().is_some_and(|s| s != "none") || (audio.is_none() && visual);
    }
    let profile = if compatible_combined || (compatible_video && compatible_audio) {
        Profile::Compatible
    } else {
        Profile::Maximum
    };
    let message = if info["entries"].is_array()
        || matches!(info["_type"].as_str(), Some("playlist" | "multi_video"))
    {
        Some("Choose a single media URL. Playlist downloads are unavailable in this build.")
    } else if info["is_live"] == true
        || matches!(
            info["live_status"].as_str(),
            Some("is_live" | "is_upcoming")
        )
    {
        Some("Choose a completed recording. Live or upcoming media cannot be downloaded here.")
    } else if info["has_drm"] == true
        || matches!(
            info["availability"].as_str(),
            Some("private" | "premium_only" | "subscriber_only" | "needs_auth" | "unavailable")
        )
    {
        Some("This source is protected or requires access. Choose publicly available media.")
    } else if !possible_audio || !possible_video {
        Some("This source does not offer the Video + Audio output available in this build.")
    } else {
        None
    };
    let title = text(&info["title"], 240).unwrap_or_else(|| "Untitled media".into());
    let raw_source = text(&info["extractor_key"], 120)
        .or_else(|| text(&info["extractor"], 120))
        .filter(|s| !s.eq_ignore_ascii_case("generic"));
    let source = raw_source
        .map(|name| {
            let key = name.to_ascii_lowercase();
            [
                ("youtube", "YouTube"),
                ("instagram", "Instagram"),
                ("facebook", "Facebook"),
                ("tiktok", "TikTok"),
                ("vimeo", "Vimeo"),
                ("dailymotion", "Dailymotion"),
                ("twitch", "Twitch"),
                ("twitter", "Twitter / X"),
                ("reddit", "Reddit"),
                ("soundcloud", "SoundCloud"),
            ]
            .into_iter()
            .find(|(prefix, _)| key.starts_with(prefix))
            .map_or(name, |(_, brand)| brand.into())
        })
        .unwrap_or_else(|| {
            url.host_str()
                .unwrap_or("Generic web source")
                .trim_start_matches("www.")
                .to_owned()
        });
    let thumbnail = text(&info["thumbnail"], 8192).or_else(|| {
        info["thumbnails"]
            .as_array()?
            .iter()
            .rev()
            .find_map(|entry| text(&entry["url"], 8192))
    });
    Ok((
        DownloadPreview {
            preview_id: Uuid::new_v4(),
            filename: filename(&title, info["id"].as_str()),
            title,
            source,
            profile,
            duration: number(&info["duration"]).filter(|n| n.is_finite() && *n >= 0.0),
            can_download: message.is_none(),
            message: message.map(Into::into),
            artwork: None,
        },
        thumbnail,
    ))
}

#[derive(Default)]
pub(super) struct ProgressLines(Vec<u8>);
impl ProgressLines {
    pub(super) fn feed(
        &mut self,
        bytes: &[u8],
        mut report: impl FnMut(Option<DownloadProgress>),
    ) -> Result<()> {
        for &byte in bytes {
            if byte == b'\n' {
                let line = String::from_utf8_lossy(&self.0);
                if let Some(values) = line.trim().strip_prefix("LVOVD|") {
                    let mut values = values
                        .split('|')
                        .map(|v| v.parse::<f64>().ok().filter(|n| n.is_finite() && *n >= 0.0));
                    let downloaded = values.next().flatten();
                    let total = values.next().flatten();
                    let estimated = values.next().flatten();
                    report(Some(DownloadProgress {
                        percent: downloaded
                            .zip(total.or(estimated))
                            .filter(|(_, total)| *total > 0.0)
                            .map(|(n, total)| (100.0 * n / total).min(100.0)),
                        speed: values.next().flatten(),
                        eta: values.next().flatten(),
                    }));
                } else if line.trim() == "LVOVD_POST" {
                    report(None);
                }
                self.0.clear();
            } else if self.0.len() < 8192 {
                self.0.push(byte);
            } else {
                return Err(AppError::new(
                    "TOOL_OUTPUT",
                    "The provider returned an oversized progress line.",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn released_source_capability_evidence_and_default_selectors() {
        let url = validate_url("https://example.org/watch/1").unwrap();
        // v2.7 test/options.test.js combined-only, direct Twitch, and unknown audio examples.
        for (info, eligible, profile) in [
            (
                json!({"formats":[{"format_id":"sd","url":"https://cdn.example/reel.mp4","height":720,"vcodec":"avc1.4d401f","acodec":"mp4a.40.2"}]}),
                true,
                Profile::Compatible,
            ),
            (
                json!({"formats":[{"vcodec":"H264","acodec":"none"},{"vcodec":"NONE","acodec":"AAC"}]}),
                true,
                Profile::Compatible,
            ),
            (
                json!({"extractor_key":"TwitchClips","formats":[{"format_id":"1080","url":"https://cdn.example/1080.mp4","height":1080,"fps":30}]}),
                true,
                Profile::Maximum,
            ),
            (
                json!({"formats":[{"url":"https://cdn.example/media.mp4","height":720,"vcodec":"avc1.4d401f"}]}),
                true,
                Profile::Maximum,
            ),
            (
                json!({"formats":[{"vcodec":"vp9","acodec":"opus"}]}),
                true,
                Profile::Maximum,
            ),
            (
                json!({"formats":[{"url":"https://cdn.example/audio","ext":"M4A","width":200,"height":200}]}),
                false,
                Profile::Maximum,
            ),
            (
                json!({"formats":[{"vcodec":"none","acodec":"opus"}]}),
                false,
                Profile::Maximum,
            ),
            (
                json!({"_type":"playlist","entries":[]}),
                false,
                Profile::Maximum,
            ),
            (
                json!({"formats":[{"vcodec":"h264","acodec":"aac","has_drm":true}]}),
                false,
                Profile::Maximum,
            ),
            (json!({"formats":[null,{}]}), false, Profile::Maximum),
            (json!({}), false, Profile::Maximum),
            (
                json!({"extractor":"generic","url":"https://cdn.example/movie.mp4","ext":"mp4"}),
                true,
                Profile::Maximum,
            ),
            (
                json!({"is_live":true,"vcodec":"h264","acodec":"aac"}),
                false,
                Profile::Compatible,
            ),
        ] {
            let (view, _) = metadata(&serde_json::to_vec(&info).unwrap(), &url).unwrap();
            assert_eq!(
                (view.can_download, view.profile),
                (eligible, profile),
                "metadata {info}"
            );
        }
        assert_eq!(
            COMPATIBLE,
            "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=h264]+bestaudio[acodec^=aac]/best[vcodec^=avc1][acodec^=mp4a]/best[vcodec^=h264][acodec^=aac]"
        );
        assert_eq!(MAXIMUM, "bestvideo+bestaudio/best");
    }
    #[test]
    fn source_paths_and_provider_options_cannot_be_injected_by_metadata_or_urls() {
        let dir = tempfile::tempdir().unwrap();
        let tools = Tools::bundled(dir.path());
        let url = validate_url("https://example.org/watch?token=test&format=abc").unwrap();
        let args = acquire_args(&tools, &url, Profile::Compatible, dir.path()).unwrap();
        let preview = preview_args(&tools, &url).unwrap();
        for args in [args, preview] {
            assert!(args.ends_with(&["--".into(), url.as_str().into()]));
            for flag in [
                "--ignore-config",
                "--no-plugin-dirs",
                "--no-js-runtimes",
                "--no-remote-components",
                "--ffmpeg-location",
            ] {
                assert!(args.iter().any(|s| s == flag), "{flag}");
            }
            assert!(
                args.windows(2)
                    .any(|w| w[0] == "--ffmpeg-location" && w[1] == tools.ffmpeg)
            );
        }
        for invalid in [
            "file:///tmp/test",
            "--exec",
            "https://name:password@example.org/x",
            "ftp://foo.invalid",
            "https://example.org/\n--exec",
        ] {
            assert!(validate_url(invalid).is_err());
        }
        let name = filename("../CON:trail\\test", Some("../../exploit.exe"));
        assert_eq!(Path::new(&name).components().count(), 1);
        assert!(name.ends_with(".mp4"));
        assert!(filename("CON.txt", None).starts_with('_'));
        assert!(filename(&"中".repeat(400), Some(&"🌽".repeat(70))).len() < 245);
    }
    #[test]
    fn progress_is_streamed_across_pipe_boundaries_with_bounded_lines_and_redacted_failures() {
        let mut lines = ProgressLines::default();
        let mut updates = vec![];
        for part in [&b"LVOVD|50|NA|"[..], &b"100|10.5|5\r\nLVOVD_POST\n"[..]] {
            lines.feed(part, |v| updates.push(v)).unwrap();
        }
        let progress = updates[0].as_ref().unwrap();
        assert_eq!(
            (progress.percent, progress.speed, progress.eta),
            (Some(50.0), Some(10.5), Some(5.0))
        );
        assert!(updates[1].is_none());
        assert!(lines.feed(&vec![b'x'; 9000], |_| {}).is_err());
        let message =
            super::super::provider_error(b"HTTP 429 https://private.invalid/?token=sensitive");
        assert_eq!(message.code, "PROVIDER_LIMIT");
        assert!(!message.message.contains("sensitive"));
    }
}
