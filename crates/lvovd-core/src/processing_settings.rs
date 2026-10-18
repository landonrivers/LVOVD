//! Version 1 processing controls. Inactive values are validated then normalized
//! so a later mode switch cannot silently change an admitted request.
use crate::{AppError, Result};
use serde::Serialize;
use serde_json::{Map, Value};

pub const PRESETS: [&str; 9] = [
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
];
pub const MP3_BITRATES: [u32; 14] = [
    32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
pub const MAXIMUM_MB: f64 = (100_u64 * 1024 * 1024 * 1024) as f64 / 1_000_000.;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub(crate) video_codec: String,
    pub(crate) container: String,
    pub(crate) filename_suffix: String,
    pub(crate) scale: Scale,
    pub(crate) frame_rate: Option<f64>,
    pub(crate) rate: Rate,
    pub(crate) audio: Audio,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scale {
    pub(crate) mode: String,
    pub(crate) width: Option<f64>,
    pub(crate) height: Option<f64>,
    pub(crate) percent: Option<f64>,
    pub(crate) allow_upscale: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rate {
    pub(crate) mode: String,
    pub(crate) crf: f64,
    pub(crate) preset: String,
    pub(crate) video_kbps: Option<f64>,
    #[serde(rename = "maximumMB")]
    pub(crate) maximum_mb: Option<f64>,
    pub(crate) two_pass: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Audio {
    pub(crate) codec: String,
    pub(crate) bitrate_kbps: Option<f64>,
}

pub(crate) fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("PROCESSING_REQUEST", message)
}
pub(crate) fn object<'a>(
    raw: &'a Value,
    fields: &[&str],
    label: &str,
) -> Result<&'a Map<String, Value>> {
    let values = raw
        .as_object()
        .ok_or_else(|| invalid(format!("{label} must be an object.")))?;
    if values.keys().any(|k| !fields.contains(&k.as_str())) {
        return Err(invalid(format!("{label} contains an unsupported setting.")));
    }
    Ok(values)
}
fn choice(raw: Option<&Value>, default: &str, choices: &[&str], label: &str) -> Result<String> {
    let value = raw
        .map_or(Some(default), Value::as_str)
        .filter(|s| choices.contains(s));
    value
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("Choose a supported {label}.")))
}
pub(crate) fn number(
    raw: Option<&Value>,
    minimum: f64,
    maximum: f64,
    label: &str,
    integer: bool,
) -> Result<f64> {
    raw.and_then(Value::as_f64)
        .filter(|n| {
            n.is_finite()
                && *n >= minimum
                && *n <= maximum
                && (!integer || n.fract() == 0. && n.abs() <= 9_007_199_254_740_991.)
        })
        .ok_or_else(|| {
            invalid(format!(
                "{label} must be {} from {minimum} to {maximum}.",
                if integer {
                    "an integer"
                } else {
                    "a finite number"
                }
            ))
        })
}
fn optional_number(
    raw: Option<&Value>,
    minimum: f64,
    maximum: f64,
    label: &str,
    integer: bool,
) -> Result<Option<f64>> {
    raw.filter(|v| !v.is_null())
        .map(|v| number(Some(v), minimum, maximum, label, integer))
        .transpose()
}
fn boolean(raw: Option<&Value>, label: &str) -> Result<bool> {
    match raw {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(invalid(format!("{label} must be a boolean."))),
    }
}

impl Settings {
    pub fn normalize(raw: Option<&Value>) -> Result<Self> {
        let empty = Value::Object(Map::new());
        let raw = object(
            raw.unwrap_or(&empty),
            &[
                "videoCodec",
                "container",
                "scale",
                "frameRate",
                "rate",
                "audio",
                "filenameSuffix",
            ],
            "Processing settings",
        )?;
        let scale = object(
            raw.get("scale").unwrap_or(&empty),
            &["mode", "width", "height", "percent", "allowUpscale"],
            "Scale",
        )?;
        let rate = object(
            raw.get("rate").unwrap_or(&empty),
            &["mode", "crf", "preset", "videoKbps", "maximumMB", "twoPass"],
            "Encoding rate",
        )?;
        let audio = object(
            raw.get("audio").unwrap_or(&empty),
            &["codec", "bitrateKbps"],
            "Audio",
        )?;
        let scale_mode = choice(
            scale.get("mode"),
            "unchanged",
            &["unchanged", "fit", "width", "height", "percent"],
            "scaling mode",
        )?;
        let rate_mode = choice(
            rate.get("mode"),
            "automatic",
            &["automatic", "quality", "bitrate", "size"],
            "encoding mode",
        )?;
        let upscale = boolean(scale.get("allowUpscale"), "Allow upscale")?;
        let two_pass = boolean(rate.get("twoPass"), "Two pass")?;
        let width = optional_number(scale.get("width"), 2., 16384., "Maximum width", true)?;
        let height = optional_number(scale.get("height"), 2., 16384., "Maximum height", true)?;
        let percent = optional_number(scale.get("percent"), 1., 100., "Scale percentage", false)?;
        let suffix = raw
            .get("filenameSuffix")
            .map_or(Some("-processed"), Value::as_str);
        let suffix = suffix.filter(|s| s.encode_utf16().count() <= 60 && !s.chars().any(|c| c <= '\u{1f}' || "\u{7f}<>:\"/\\|?*".contains(c)))
            .ok_or_else(|| invalid("The filename suffix must be at most 60 characters, without path separators or reserved filename characters."))?;
        let crf = optional_number(rate.get("crf"), 0., 51., "CRF", true)?;
        let preset = if let Some(v) = rate.get("preset").filter(|v| !v.is_null()) {
            choice(Some(v), "medium", &PRESETS, "software preset")?
        } else {
            "medium".into()
        };
        let bitrate = optional_number(
            rate.get("videoKbps"),
            1.,
            1_000_000.,
            "Video bitrate",
            false,
        )?;
        let size = optional_number(
            rate.get("maximumMB"),
            0.001,
            MAXIMUM_MB,
            "Maximum MB",
            false,
        )?;
        // Resolve required active values in the same order as the released parser.
        let video_codec = choice(
            raw.get("videoCodec"),
            "unchanged",
            &["unchanged", "h264"],
            "video codec",
        )?;
        let container = choice(
            raw.get("container"),
            "source",
            &[
                "source", "mp4", "mov", "matroska", "m4a", "mp3", "opus", "flac", "wav",
            ],
            "container",
        )?;
        let width = if ["fit", "width"].contains(&scale_mode.as_str()) {
            Some(
                width
                    .ok_or_else(|| invalid("Maximum width must be an integer from 2 to 16384."))?,
            )
        } else {
            None
        };
        let height = if ["fit", "height"].contains(&scale_mode.as_str()) {
            Some(
                height
                    .ok_or_else(|| invalid("Maximum height must be an integer from 2 to 16384."))?,
            )
        } else {
            None
        };
        let percent = if scale_mode == "percent" {
            Some(percent.ok_or_else(|| {
                invalid("Scale percentage must be a finite number from 1 to 100.")
            })?)
        } else {
            None
        };
        let frame_rate = optional_number(raw.get("frameRate"), 0.1, 120., "Frame rate", false)?;
        let video_kbps = if rate_mode == "bitrate" {
            Some(bitrate.ok_or_else(|| {
                invalid("Video bitrate must be a finite number from 1 to 1000000.")
            })?)
        } else {
            None
        };
        let maximum_mb = if rate_mode == "size" {
            Some(size.ok_or_else(|| {
                invalid(format!(
                    "Maximum MB must be a finite number from 0.001 to {MAXIMUM_MB}."
                ))
            })?)
        } else {
            None
        };
        let codec = choice(
            audio.get("codec"),
            "unchanged",
            &["unchanged", "aac", "mp3", "opus", "flac", "pcm"],
            "audio codec",
        )?;
        let bitrate_kbps =
            optional_number(audio.get("bitrateKbps"), 8., 1536., "Audio bitrate", false)?;
        if codec == "mp3"
            && bitrate_kbps.is_some_and(|b| !MP3_BITRATES.iter().any(|v| *v as f64 == b))
        {
            return Err(invalid(
                "Choose a supported MP3 bitrate: 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320 kbps.",
            ));
        }
        Ok(Self {
            video_codec,
            container,
            filename_suffix: suffix.into(),
            scale: Scale {
                allow_upscale: scale_mode != "unchanged" && upscale,
                mode: scale_mode,
                width,
                height,
                percent,
            },
            frame_rate,
            rate: Rate {
                crf: if rate_mode == "quality" {
                    crf.unwrap_or(18.)
                } else {
                    18.
                },
                preset: if rate_mode == "automatic" {
                    "medium".into()
                } else {
                    preset
                },
                two_pass: rate_mode == "size" || rate_mode == "bitrate" && two_pass,
                mode: rate_mode,
                video_kbps,
                maximum_mb,
            },
            audio: Audio {
                codec,
                bitrate_kbps,
            },
        })
    }
}
