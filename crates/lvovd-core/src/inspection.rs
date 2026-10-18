use crate::{
    AppError, Result,
    process::{self, CancellationToken},
};
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, path::Path, time::Duration};

// Foundation metadata only. Full v2.7 policy parity is a separate migration gate.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub format: String,
    pub duration_seconds: Option<f64>,
    pub streams: Vec<Stream>,
    pub mime: Option<String>,
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
    let raw: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| AppError::new("INSPECTION_INVALID", "FFprobe returned invalid metadata."))?;
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
                sample_format: text(&s["sample_fmt"], 16),
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
    let has_video = streams.iter().any(|s| s.kind == "video");
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
        duration_seconds: number(&raw["format"]["duration"]).filter(|n| *n > 0.0),
        streams,
        mime: mime.map(str::to_owned),
    })
}

pub async fn inspect(
    ffprobe: &Path,
    source: &Path,
    cancel: &CancellationToken,
) -> Result<Inspection> {
    // Self-contained demuxers only; playlist / concat / network inputs are never followed.
    let args: Vec<OsString> = [
        "-v",
        "error",
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
    normalize(&output.stdout)
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
}
