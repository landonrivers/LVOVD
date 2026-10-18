//! v2.7 media facts, independent of playback and processing decisions.
use crate::{AppError, Result, audio_policy::AudioSource, edit_plan::round_milliseconds};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_METADATA_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_STREAMS: usize = 64;
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInspection {
    pub media_kind: String,
    pub duration_seconds: Option<f64>,
    pub time_origin_seconds: f64,
    pub source_size: Option<u64>,
    pub format: String,
    pub container: Container,
    pub format_names: Vec<String>,
    pub video: Option<Video>,
    pub audio: Option<Audio>,
    pub track_counts: TrackCounts,
    pub extra_streams: Option<ExtraStreams>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Container {
    pub kind: String,
    pub evidence: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrackCounts {
    pub video: Option<usize>,
    pub audio: Option<usize>,
    pub subtitle: Option<usize>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExtraStreams {
    pub total: usize,
    pub artwork: usize,
    pub other: usize,
    pub chapters: Option<usize>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub start_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    pub stream_index: u64,
    pub codec: Option<String>,
    pub profile: Option<String>,
    pub width: u64,
    pub height: u64,
    pub frame_rate: Option<f64>,
    pub bit_rate: Option<u64>,
    pub pixel_format: Option<String>,
    #[serde(flatten)]
    pub timing: Timing,
    pub rotation_degrees: Option<f64>,
    pub orientation_supported: bool,
    pub sample_aspect_ratio: Option<String>,
    pub color_transfer: Option<String>,
    pub hdr: Option<bool>,
    pub alpha: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Audio {
    pub stream_index: u64,
    pub codec: Option<String>,
    pub sample_rate: Option<u64>,
    pub channels: Option<u64>,
    pub channel_layout: Option<String>,
    pub bit_rate: Option<u64>,
    pub profile: Option<String>,
    pub sample_format: Option<String>,
    pub bits_per_sample: Option<u32>,
    pub bits_per_raw_sample: Option<u32>,
    #[serde(flatten)]
    pub timing: Timing,
}
impl From<&Audio> for AudioSource {
    fn from(a: &Audio) -> Self {
        Self {
            stream_index: a.stream_index.try_into().ok(),
            codec: a.codec.clone(),
            sample_rate: a.sample_rate.and_then(|v| v.try_into().ok()),
            channels: a.channels.and_then(|v| v.try_into().ok()),
            channel_layout: a.channel_layout.clone(),
            sample_format: a.sample_format.clone(),
            bits_per_sample: a.bits_per_sample,
            bits_per_raw_sample: a.bits_per_raw_sample,
            start_seconds: a.timing.start_seconds,
            duration_seconds: a.timing.duration_seconds,
        }
    }
}
pub(crate) fn number(v: &Value) -> Option<f64> {
    let value = if let Some(s) = v.as_str() {
        let s = s.trim();
        if !pattern!(r"(?i)\A[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?\z").is_match(s) {
            return None;
        }
        s.parse().ok()
    } else {
        v.as_f64()
    };
    value.filter(|v| v.is_finite())
}
pub(crate) fn integer(v: &Value) -> Option<u64> {
    number(v)
        .filter(|v| (0. ..=SAFE_INTEGER).contains(v) && v.fract() == 0.)
        .map(|v| v as u64)
}
fn positive(v: &Value) -> Option<f64> {
    number(v).filter(|v| *v > 0.)
}
fn positive_integer(v: &Value) -> Option<u64> {
    integer(v).filter(|v| *v > 0)
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64() != Some(0.),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
pub(crate) fn text(v: &Value, maximum: usize, lower: bool) -> Option<String> {
    let raw = match v {
        Value::String(v) => v.clone(),
        Value::Number(v) => v.to_string(),
        Value::Bool(v) => v.to_string(),
        _ => return None,
    };
    let cleaned: String = raw
        .chars()
        .filter(|c| !('\0'..='\u{1f}').contains(c) && *c != '\u{7f}')
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return None;
    }
    let normalized = if lower {
        cleaned.to_lowercase()
    } else {
        cleaned.to_owned()
    };
    // FFprobe fields are bounded in UTF-16 units, as in the JS reference. Do not
    // emit a dangling surrogate when a malicious label straddles the boundary.
    let units: Vec<u16> = normalized.encode_utf16().take(maximum).collect();
    Some(String::from_utf16_lossy(&units))
}
fn rounded(v: f64) -> Option<f64> {
    let n = round_milliseconds(v);
    n.is_finite().then_some(n)
}
pub fn frame_rate(v: &Value) -> Option<f64> {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let s = s.trim();
    let rate =
        if let Some(c) = pattern!(r"\A([0-9]+(?:\.[0-9]+)?)/([0-9]+(?:\.[0-9]+)?)\z").captures(s) {
            c[1].parse::<f64>().ok()? / c[2].parse::<f64>().ok()?
        } else {
            number(&Value::String(s.into()))?
        };
    if rate.is_finite() && rate > 0. {
        rounded(rate)
    } else {
        None
    }
}
fn has(names: &[String], candidates: &[&str]) -> bool {
    names.iter().any(|n| candidates.contains(&n.as_str()))
}
fn container(format: &Value, names: &[String]) -> Container {
    let major = text(&format["tags"]["major_brand"], 8, true).unwrap_or_default();
    let compatible = text(&format["tags"]["compatible_brands"], 256, true).unwrap_or_default();
    let mut brands = vec![];
    if pattern!(r"\A[a-z0-9]{2,4}\z").is_match(&major) {
        brands.push(major);
    }
    let chars: Vec<_> = compatible.chars().collect();
    brands.extend(
        chars
            .chunks(4)
            .map(|part| part.iter().collect::<String>().trim().to_owned())
            .filter(|s| !s.is_empty()),
    );
    brands.extend(
        compatible
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    );
    let any = |items: &[&str]| brands.iter().any(|b| items.contains(&b.as_str()));
    let (kind, evidence) = if has(names, &["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]) {
        let kind = if any(&["qt"]) {
            "mov"
        } else if brands
            .iter()
            .any(|b| b.starts_with("3gp") || b.starts_with("3g2"))
        {
            "3gp"
        } else if any(&[
            "avif", "avis", "heic", "heix", "hevc", "hevx", "mif1", "msf1", "mj2s", "mjp2",
        ]) {
            "other-iso"
        } else if any(&[
            "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "mp41", "mp42",
            "avc1", "dash", "mmp4", "m4v", "m4a", "f4v", "f4a",
        ]) {
            "mp4"
        } else {
            "unknown"
        };
        (kind, (kind != "unknown").then_some("brand"))
    } else if let Some(name) = names.iter().find(|n| {
        [
            "matroska", "webm", "avi", "mpegts", "mpeg", "ogg", "flv", "asf", "nut", "mp3", "flac",
            "wav", "aiff", "aac", "ac3", "eac3", "amr", "au",
        ]
        .contains(&n.as_str())
    }) {
        (name.as_str(), Some("demuxer"))
    } else {
        ("unknown", None)
    };
    Container {
        kind: kind.into(),
        evidence: evidence.map(str::to_owned),
    }
}
fn is_video(s: &Value) -> bool {
    let one = |v: &Value| v == &Value::Bool(true) || number(v) == Some(1.);
    s["codec_type"] == "video"
        && !one(&s["disposition"]["attached_pic"])
        && !one(&s["disposition"]["timed_thumbnails"])
}
fn timing(s: &Value, origin: f64, names: &[String]) -> Timing {
    let sample_clock =
        s["codec_type"] == "audio" && has(names, &["wav", "aiff", "flac", "aac", "mp3"]);
    let start = number(&s["start_time"]).or(sample_clock.then_some(origin));
    let tagged = s["tags"]["DURATION"]
        .as_str()
        .and_then(|v| {
            pattern!(r"\A([0-9]{1,8}):([0-9]{2}):([0-9]{2}(?:\.[0-9]{1,9})?)\z").captures(v)
        })
        .and_then(|c| {
            Some(
                c[1].parse::<f64>().ok()? * 3600.
                    + c[2].parse::<f64>().ok()? * 60.
                    + c[3].parse::<f64>().ok()?
                    - start?,
            )
        })
        .filter(|v| v.is_finite() && *v > 0. && has(names, &["matroska", "webm"]));
    Timing {
        start_seconds: start.and_then(|s| rounded(s - origin)),
        duration_seconds: positive(&s["duration"]).or(tagged),
    }
}
fn video(s: &Value, origin: f64, names: &[String]) -> Video {
    let side: Vec<_> = s["side_data_list"]
        .as_array()
        .into_iter()
        .flatten()
        .take(32)
        .collect();
    let matrix = side
        .iter()
        .find(|s| s["side_data_type"] == "Display Matrix");
    let rotation = number(
        matrix
            .map(|s| &s["rotation"])
            .filter(|v| !v.is_null())
            .unwrap_or(&s["tags"]["rotate"]),
    );
    let mut supported = rotation.is_none_or(|r| (r / 90. - (r / 90. + 0.5).floor()).abs() < 0.001);
    if let Some(matrix) = matrix.filter(|m| truthy(&m["displaymatrix"])) {
        let matrix_text = matrix["displaymatrix"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(1000)
            .collect::<String>();
        let entries: Vec<f64> = matrix_text
            .lines()
            .filter_map(|line| line.rsplit_once(':').map(|(_, v)| v))
            .flat_map(|line| {
                line.split_whitespace()
                    .map(|n| n.parse().unwrap_or(f64::NAN))
            })
            .collect();
        supported &= entries.len() == 9
            && entries.iter().all(|n| n.is_finite())
            && rotation.is_some()
            && [2, 5, 6, 7].iter().all(|i| entries[*i] == 0.)
            && entries[8] == 1073741824.
            && (entries[0] * entries[4] - entries[1] * entries[3] - 65536_f64.powi(2)).abs()
                < 65536.
            && [0, 1, 3, 4]
                .iter()
                .all(|i| [0., 65536.].contains(&entries[*i].abs()));
    }
    let transfer = text(&s["color_transfer"], 80, true);
    let pixel = text(&s["pix_fmt"], 80, true);
    let hdr = transfer
        .as_deref()
        .is_some_and(|v| ["smpte2084", "arib-std-b67"].contains(&v))
        || side.iter().any(|s| {
            s["side_data_type"].as_str().is_some_and(|v| {
                pattern!(r"(?i)DOVI|HDR Dynamic|Mastering display|Content light level").is_match(v)
            })
        });
    let alpha = number(&s["tags"]["alpha_mode"]) == Some(1.)
        || pixel.as_deref().is_some_and(|v| {
            pattern!(r"\A(?:yuva|gbrap|rgba|bgra|argb|abgr|ya[0-9]|ayuv|vuya|pal8)").is_match(v)
        });
    Video {
        stream_index: integer(&s["index"]).expect("selected index"),
        codec: text(&s["codec_name"], 80, true),
        profile: text(&s["profile"], 120, false),
        width: positive_integer(&s["width"]).expect("selected width"),
        height: positive_integer(&s["height"]).expect("selected height"),
        frame_rate: frame_rate(if truthy(&s["avg_frame_rate"]) {
            &s["avg_frame_rate"]
        } else {
            &s["r_frame_rate"]
        }),
        bit_rate: integer(&s["bit_rate"]),
        pixel_format: pixel,
        timing: timing(s, origin, names),
        rotation_degrees: rotation.map(|r| (((r + 0.5).floor() % 360.) + 360.) % 360.),
        orientation_supported: supported,
        sample_aspect_ratio: s["sample_aspect_ratio"]
            .as_str()
            .filter(|v| v.len() <= 128 && pattern!(r"\A[0-9]+:[0-9]+\z").is_match(v))
            .map(str::to_owned),
        color_transfer: transfer,
        hdr: hdr.then_some(true),
        alpha: alpha.then_some(true),
    }
}
fn audio(s: &Value, origin: f64, names: &[String]) -> Audio {
    let bits = |v: &Value| positive_integer(v).filter(|n| *n <= 64).map(|n| n as u32);
    Audio {
        stream_index: integer(&s["index"]).expect("selected index"),
        codec: text(&s["codec_name"], 80, true),
        sample_rate: positive_integer(&s["sample_rate"]),
        channels: positive_integer(&s["channels"]),
        channel_layout: text(&s["channel_layout"], 80, false),
        bit_rate: integer(&s["bit_rate"]),
        profile: text(&s["profile"], 80, false),
        sample_format: s["sample_fmt"]
            .as_str()
            .filter(|s| pattern!(r"\A(?:u8|s16|s32|s64|flt|dbl)p?\z").is_match(s))
            .map(str::to_owned),
        bits_per_sample: bits(&s["bits_per_sample"]),
        bits_per_raw_sample: bits(&s["bits_per_raw_sample"]),
        timing: timing(s, origin, names),
    }
}
pub(crate) fn parse(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > MAX_METADATA_BYTES {
        return Err(invalid("FFprobe metadata exceeded the inspection limit."));
    }
    serde_json::from_slice(bytes).map_err(|_| invalid("FFprobe returned invalid metadata."))
}
fn invalid(message: &str) -> AppError {
    AppError::new("INSPECTION_INVALID", message)
}
pub fn normalize(bytes: &[u8], source_size: Option<u64>) -> Result<MediaInspection> {
    normalize_value(&parse(bytes)?, source_size)
}
pub(crate) fn normalize_value(raw: &Value, source_size: Option<u64>) -> Result<MediaInspection> {
    if !raw.is_object() {
        return Err(invalid("FFprobe metadata must be an object."));
    }
    let reported = raw["streams"].as_array();
    let streams = reported.map(Vec::as_slice).unwrap_or_default();
    if streams.len() > MAX_STREAMS
        || streams.iter().any(|s| !s.is_object())
        || raw["chapters"].as_array().is_some_and(|a| a.len() > 10000)
    {
        return Err(invalid(
            "Stream or chapter metadata is malformed or exceeds the inspection limit.",
        ));
    }
    let videos: Vec<_> = streams.iter().filter(|s| is_video(s)).collect();
    let selected_video = videos.iter().copied().find(|s| {
        integer(&s["index"]).is_some()
            && positive_integer(&s["width"]).is_some()
            && positive_integer(&s["height"]).is_some()
    });
    let selected_audio = streams
        .iter()
        .find(|s| s["codec_type"] == "audio" && integer(&s["index"]).is_some());
    let format = &raw["format"];
    let names: Vec<_> = text(&format["format_name"], 400, true)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .take(20)
        .map(str::to_owned)
        .collect();
    let origin = number(&format["start_time"]).unwrap_or(0.);
    let endpoint = [selected_video, selected_audio]
        .into_iter()
        .flatten()
        .filter_map(|s| {
            Some(number(&s["start_time"]).unwrap_or(origin) + positive(&s["duration"])? - origin)
        })
        .filter(|v| v.is_finite() && *v > 0.)
        .reduce(f64::max);
    let duration = endpoint
        .or_else(|| {
            Some(
                number(&format["duration"])?
                    - if has(&names, &["matroska", "webm"]) {
                        origin
                    } else {
                        0.
                    },
            )
        })
        .filter(|v| v.is_finite() && *v > 0.);
    let media_kind = if selected_video.is_some() {
        if duration.is_some() {
            "video"
        } else {
            "unsupported"
        }
    } else if !videos.is_empty() {
        "unknown"
    } else if selected_audio.is_some() {
        "audio"
    } else {
        "unsupported"
    };
    let container = container(format, &names);
    let label = match container.kind.as_str() {
        "mov" => "MOV / QuickTime".into(),
        "mp4" => "MP4".into(),
        _ => text(
            if truthy(&format["format_long_name"]) {
                &format["format_long_name"]
            } else {
                &format["format_name"]
            },
            120,
            false,
        )
        .unwrap_or_else(|| "Unknown container".into()),
    };
    Ok(MediaInspection {
        media_kind: media_kind.into(),
        duration_seconds: duration.and_then(rounded),
        time_origin_seconds: origin,
        source_size: source_size
            .filter(|v| *v <= SAFE_INTEGER as u64)
            .or_else(|| integer(&format["size"])),
        format: label,
        container,
        video: selected_video.map(|s| video(s, origin, &names)),
        audio: selected_audio.map(|s| audio(s, origin, &names)),
        format_names: names,
        track_counts: TrackCounts {
            video: reported.map(|_| videos.len()),
            audio: reported.map(|_| {
                streams
                    .iter()
                    .filter(|s| s["codec_type"] == "audio")
                    .count()
            }),
            subtitle: reported.map(|_| {
                streams
                    .iter()
                    .filter(|s| s["codec_type"] == "subtitle")
                    .count()
            }),
        },
        extra_streams: reported.map(|_| ExtraStreams {
            total: streams.len(),
            artwork: streams
                .iter()
                .filter(|s| s["codec_type"] == "video" && !is_video(s))
                .count(),
            other: streams
                .iter()
                .filter(|s| {
                    !matches!(
                        s["codec_type"].as_str(),
                        Some("video" | "audio" | "subtitle")
                    )
                })
                .count(),
            chapters: raw["chapters"].as_array().map(Vec::len),
        }),
    })
}
