use crate::{
    AppError, Result,
    media_inspection::{self, MediaInspection},
    process::{self, CancellationToken},
};
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, path::Path, time::Duration};

// Keep the 8A playback descriptor stable; media carries the authoritative v2.7 facts.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub format: String,
    pub duration_seconds: Option<f64>,
    pub streams: Vec<Stream>,
    pub mime: Option<String>,
    pub media: Option<MediaInspection>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    pub index: u32,
    pub kind: String,
    pub codec: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub sample_format: Option<String>,
    pub bits_per_sample: Option<u32>,
    pub bits_per_raw_sample: Option<u32>,
    pub channel_layout: Option<String>,
}
fn text(value: &serde_json::Value, max: usize) -> Option<String> {
    value
        .as_str()
        .map(|s| s.chars().filter(|c| !c.is_control()).take(max).collect())
        .filter(|s: &String| !s.is_empty())
}
fn number(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| n.is_finite())
}
fn integer(value: &serde_json::Value) -> Option<u32> {
    number(value)
        .filter(|n| *n >= 0.0 && *n <= u32::MAX as f64 && n.fract() == 0.0)
        .map(|n| n as u32)
}
pub fn normalize(bytes: &[u8]) -> Result<Inspection> {
    normalize_with_size(bytes, None)
}
fn normalize_with_size(bytes: &[u8], source_size: Option<u64>) -> Result<Inspection> {
    let raw = media_inspection::parse(bytes)?;
    let media = media_inspection::normalize_value(&raw, source_size)?;
    let entries = raw["streams"]
        .as_array()
        .filter(|a| a.len() <= 64)
        .ok_or_else(|| {
            AppError::new(
                "INSPECTION_INVALID",
                "Stream metadata is missing or exceeds the inspection limit.",
            )
        })?;
    let streams: Vec<_> = entries
        .iter()
        .filter_map(|s| {
            Some(Stream {
                index: integer(&s["index"])?,
                kind: text(&s["codec_type"], 24)?,
                codec: text(&s["codec_name"], 80),
                sample_rate: integer(&s["sample_rate"]).filter(|v| *v > 0),
                channels: integer(&s["channels"]).filter(|v| *v > 0),
                sample_format: s["sample_fmt"]
                    .as_str()
                    .filter(|s| pattern!(r"\A(?:u8|s16|s32|s64|flt|dbl)p?\z").is_match(s))
                    .map(str::to_owned),
                bits_per_sample: integer(&s["bits_per_sample"]).filter(|v| (1..=64).contains(v)),
                bits_per_raw_sample: integer(&s["bits_per_raw_sample"])
                    .filter(|v| (1..=64).contains(v)),
                channel_layout: text(&s["channel_layout"], 80),
            })
        })
        .collect();
    if !streams
        .iter()
        .any(|s| s.kind == "video" || s.kind == "audio")
    {
        return Err(AppError::new(
            "NO_MEDIA",
            "No audio or video stream was found.",
        ));
    }
    let format = text(&raw["format"]["format_name"], 400).unwrap_or_default();
    let names: Vec<_> = format.split(',').collect();
    let has_video = media.video.is_some();
    let mime = if names.contains(&"mp4") || names.contains(&"mov") {
        Some(if has_video { "video/mp4" } else { "audio/mp4" })
    } else if names.contains(&"webm") {
        Some(if has_video {
            "video/webm"
        } else {
            "audio/webm"
        })
    } else if names.contains(&"wav") {
        Some("audio/wav")
    } else if names.contains(&"mp3") {
        Some("audio/mpeg")
    } else if names.contains(&"flac") {
        Some("audio/flac")
    } else if names.contains(&"ogg") {
        Some(if has_video { "video/ogg" } else { "audio/ogg" })
    } else {
        None
    };
    Ok(Inspection {
        format,
        duration_seconds: media.duration_seconds,
        streams,
        mime: mime.map(str::to_owned),
        media: Some(media),
    })
}

pub async fn inspect(
    ffprobe: &Path,
    source: &Path,
    cancel: &CancellationToken,
) -> Result<Inspection> {
    if !source.is_absolute() {
        return Err(AppError::new(
            "SOURCE_PATH",
            "An owned absolute media path is required.",
        ));
    }
    // Self-contained demuxers only; playlist / concat / network inputs are never followed.
    let args: Vec<OsString> = [
        "-v",
        "warning",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,matroska,avi,asf,flv,mpeg,mpegts,ogg,nut,mp3,aac,flac,wav,aiff,amr,ape,wv,tta,ac3,eac3,dts,au,caf",
        "-enable_drefs",
        "0",
        "-use_absolute_path",
        "0",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        "-of",
        "json",
    ]
    .into_iter()
    .map(Into::into)
    .chain([source.as_os_str().to_owned()])
    .collect();
    let output = process::run(
        ffprobe,
        &args,
        Duration::from_secs(15),
        4 * 1024 * 1024,
        cancel,
    )
    .await?;
    let size = tokio::fs::metadata(source).await.ok().map(|m| m.len());
    finish_probe(&output.stdout, &output.stderr, size)
}
fn finish_probe(stdout: &[u8], stderr: &[u8], size: Option<u64>) -> Result<Inspection> {
    if pattern!(r"(?i)Skipped opening external track").is_match(&String::from_utf8_lossy(stderr)) {
        return Err(AppError::new(
            "LOCAL_INPUT_UNSUPPORTED",
            "This file refers to external media. Choose a self-contained local video or audio file.",
        ));
    }
    normalize_with_size(stdout, size)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_precision_is_not_invented() {
        let i = normalize(br#"{"streams":[{"index":0,"codec_type":"audio","codec_name":"flac","sample_fmt":"s32","bits_per_sample":0,"sample_rate":"96000"}],"format":{"format_name":"flac","duration":"2.5"}}"#).unwrap();
        assert_eq!(i.streams[0].bits_per_sample, None);
        assert_eq!(i.streams[0].bits_per_raw_sample, None);
        assert_eq!(i.streams[0].sample_rate, Some(96000));
        assert_eq!(i.mime.as_deref(), Some("audio/flac"));
    }
    #[test]
    fn malformed_and_non_media_are_rejected() {
        for bytes in [b"{".as_slice(), br#"{"streams":[]}"#] {
            assert!(normalize(bytes).is_err());
        }
    }
    #[test]
    fn external_track_warning_rejects_successful_probe_without_path_disclosure() {
        let raw =
            br#"{"streams":[{"index":0,"codec_type":"audio"}],"format":{"format_name":"mov"}}"#;
        let error = finish_probe(
            raw,
            b"Skipped opening external track: /synthetic/private/audio.wav",
            Some(10),
        )
        .unwrap_err();
        assert_eq!(error.code, "LOCAL_INPUT_UNSUPPORTED");
        assert!(!error.message.contains("private"));
    }
    #[test]
    fn attached_artwork_is_not_video_playback() {
        let raw = br#"{"streams":[{"index":0,"codec_type":"audio"},{"index":1,"codec_type":"video","width":64,"height":64,"disposition":{"attached_pic":1}}],"format":{"format_name":"mov,mp4,m4a"}}"#;
        let result = normalize(raw).unwrap();
        assert_eq!(result.mime.as_deref(), Some("audio/mp4"));
        assert_eq!(result.media.unwrap().media_kind, "audio");
    }
}
