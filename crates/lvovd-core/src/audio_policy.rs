//! Encoding decisions over inspected evidence. No tool execution or UI state.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
    pub stream_index: Option<u32>,
    pub codec: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub channel_layout: Option<String>,
    pub sample_format: Option<String>,
    pub bits_per_sample: Option<u32>,
    pub bits_per_raw_sample: Option<u32>,
    pub start_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Representation {
    Integer,
    Float,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Precision {
    pub representation: Option<Representation>,
    pub bit_depth: Option<u32>,
}

fn storage(format: Option<&str>) -> Option<(Representation, u32)> {
    let format = format?;
    match format.strip_suffix('p').unwrap_or(format) {
        "u8" => Some((Representation::Integer, 8)),
        "s16" => Some((Representation::Integer, 16)),
        "s32" => Some((Representation::Integer, 32)),
        "s64" => Some((Representation::Integer, 64)),
        "flt" => Some((Representation::Float, 32)),
        "dbl" => Some((Representation::Float, 64)),
        _ => None,
    }
}

fn pcm_codec_bits(codec: &str) -> Option<u32> {
    let bits = codec
        .strip_prefix("pcm_s")
        .or_else(|| codec.strip_prefix("pcm_u"))?;
    let bits = bits
        .strip_suffix("le")
        .or_else(|| bits.strip_suffix("be"))
        .unwrap_or(bits);
    match bits {
        "8" => Some(8),
        "16" => Some(16),
        "24" => Some(24),
        "32" => Some(32),
        "64" => Some(64),
        _ => None,
    }
}

pub fn precision(audio: &AudioSource) -> Precision {
    let unknown = Precision {
        representation: None,
        bit_depth: None,
    };
    let Some((representation, stored_bits)) = storage(audio.sample_format.as_deref()) else {
        return unknown;
    };
    if representation == Representation::Float {
        return Precision {
            representation: Some(representation),
            bit_depth: Some(stored_bits),
        };
    }
    let bits = audio
        .bits_per_raw_sample
        .filter(|n| *n > 0)
        .or(audio.bits_per_sample.filter(|n| *n > 0))
        .or_else(|| pcm_codec_bits(audio.codec.as_deref().unwrap_or_default()));
    if bits.is_some_and(|n| n > stored_bits) {
        return unknown;
    }
    Precision {
        representation: Some(representation),
        bit_depth: bits,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamPlan {
    pub role: &'static str,
    pub index: u32,
    pub codec: String,
    pub action: &'static str,
    pub sample_rate: u32,
    pub channels: u32,
    pub channel_layout: String,
    pub encoder: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bit_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_format: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub representation: Option<Representation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compression_level: Option<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEncoding {
    pub stream: AudioStreamPlan,
    pub output_codec: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AudioPolicyError {
    pub error: String,
    pub reason: &'static str,
}
fn unavailable(message: impl Into<String>, reason: &'static str) -> AudioPolicyError {
    AudioPolicyError {
        error: message.into(),
        reason,
    }
}
fn unsupported(message: impl Into<String>) -> AudioPolicyError {
    unavailable(message, "unsupported")
}

fn layout_channels(layout: &str) -> Option<u32> {
    match layout {
        "mono" => Some(1),
        "stereo" => Some(2),
        "3.0" => Some(3),
        "quad" => Some(4),
        "5.0" => Some(5),
        "5.1" | "5.1(side)" => Some(6),
        "6.1" => Some(7),
        "7.1" => Some(8),
        _ => None,
    }
}

pub fn encoding_policy(
    audio: &AudioSource,
    codec: &str,
    bitrate_kbps: Option<f64>,
) -> std::result::Result<AudioEncoding, AudioPolicyError> {
    let (Some(index), Some(source_codec), Some(rate), Some(channels)) = (
        audio.stream_index,
        audio.codec.as_deref().filter(|v| !v.is_empty()),
        audio.sample_rate.filter(|n| *n > 0),
        audio.channels.filter(|n| *n > 0),
    ) else {
        return Err(unavailable(
            "Audio codec, stream identity, channels, or sample rate is incomplete.",
            "incomplete",
        ));
    };
    let layout = audio
        .channel_layout
        .as_deref()
        .filter(|v| !v.is_empty())
        .or(match channels {
            1 => Some("mono"),
            2 => Some("stereo"),
            _ => None,
        })
        .ok_or_else(|| {
            unavailable(
                "An audio channel layout is required before encoding.",
                "incomplete",
            )
        })?;
    if layout_channels(layout) != Some(channels) {
        return Err(unsupported(
            "This audio layout cannot be encoded without a channel change. No downmix is performed.",
        ));
    }
    let mut stream = AudioStreamPlan {
        role: "audio",
        index,
        codec: source_codec.into(),
        action: "encode",
        sample_rate: rate,
        channels,
        channel_layout: layout.into(),
        encoder: String::new(),
        bit_rate: None,
        quality: None,
        sample_format: None,
        bit_depth: None,
        representation: None,
        compression_level: None,
    };
    if codec == "aac" || codec == "mp3" {
        if !["mono", "stereo", "5.1", "5.1(side)"].contains(&layout)
            || (codec == "mp3" && channels > 2)
        {
            return Err(unsupported(
                "This audio layout cannot be encoded here without a channel change. No downmix is performed.",
            ));
        }
        if codec == "mp3"
            && bitrate_kbps.is_some_and(|v| {
                ![
                    32., 40., 48., 56., 64., 80., 96., 112., 128., 160., 192., 224., 256., 320.,
                ]
                .contains(&v)
            })
        {
            return Err(unsupported(
                "Choose a supported MP3 bitrate: 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320 kbps.",
            ));
        }
        // Request-level AAC bounds belong to processing settings. Never serialize NaN/Infinity.
        if bitrate_kbps.is_some_and(|v| !v.is_finite() || v <= 0. || !(v * 1000.).is_finite()) {
            return Err(unsupported("Choose a finite positive audio bitrate."));
        }
        stream.encoder = if codec == "aac" { "aac" } else { "libmp3lame" }.into();
        stream.sample_rate = if [44100, 48000].contains(&rate) {
            rate
        } else {
            48000
        };
        stream.bit_rate = bitrate_kbps.map(|v| v * 1000.).or_else(|| {
            if codec == "aac" {
                Some(match channels {
                    1 => 128000.,
                    2 => 256000.,
                    _ => 512000.,
                })
            } else {
                None
            }
        });
        if stream.bit_rate.is_none() {
            stream.quality = Some(0);
        }
    } else if codec == "opus" {
        if layout == "5.1(side)" {
            return Err(unsupported(
                "Opus cannot preserve the 5.1(side) layout here. Choose FLAC or WAV; speakers will not be remapped.",
            ));
        }
        let maximum = 1536.min(256 * channels);
        if bitrate_kbps.is_some_and(|v| !v.is_finite() || v < 8. || v > f64::from(maximum)) {
            return Err(unsupported(format!(
                "Opus bitrate must be between 8 and {maximum} kbps for this channel count."
            )));
        }
        stream.encoder = "libopus".into();
        stream.sample_rate = 48000;
        stream.bit_rate = Some(bitrate_kbps.unwrap_or(f64::from(64 * channels)) * 1000.);
    } else {
        if codec != "flac" && codec != "pcm" {
            return Err(unsupported("Choose a supported audio encoder explicitly."));
        }
        if bitrate_kbps.is_some() {
            return Err(unsupported(
                "FLAC and WAV preserve precision automatically and do not take an audio bitrate.",
            ));
        }
        let evidence = precision(audio);
        if evidence.representation.is_none() || (codec == "flac" && evidence.bit_depth.is_none()) {
            return Err(unsupported(if codec == "flac" {
                "FLAC requires proven integer precision. Choose WAV when the source sample format can be inspected; meaningful precision will not be guessed."
            } else {
                "Audio precision is unknown. Choose another source with usable sample-format metadata."
            }));
        }
        stream.representation = evidence.representation;
        if codec == "flac" {
            if evidence.representation != Some(Representation::Integer)
                || evidence.bit_depth.is_some_and(|v| v > 24)
            {
                return Err(unsupported(
                    "FLAC requires proven integer precision of at most 24 bits here. Choose WAV to preserve this source without reducing precision.",
                ));
            }
            if rate > 655350 {
                return Err(unsupported(
                    "FLAC cannot preserve this sample rate. Choose WAV.",
                ));
            }
            let bits = if evidence.bit_depth.is_some_and(|v| v <= 16) {
                16
            } else {
                24
            };
            stream.encoder = "flac".into();
            stream.bit_depth = Some(bits);
            stream.sample_format = Some(if bits == 16 { "s16" } else { "s32" });
            stream.compression_level = Some(5);
        } else {
            let stored = storage(audio.sample_format.as_deref()).map(|(_, bits)| bits);
            let bits = if evidence.representation == Some(Representation::Float) {
                evidence.bit_depth
            } else {
                evidence
                    .bit_depth
                    .or(stored)
                    .and_then(|needed| [8, 16, 24, 32].into_iter().find(|bits| *bits >= needed))
            }
            .ok_or_else(|| {
                unsupported(
                    "WAV cannot preserve this integer precision with the supported encoders.",
                )
            })?;
            stream.bit_depth = Some(bits);
            stream.encoder = if evidence.representation == Some(Representation::Float) {
                format!("pcm_f{bits}le")
            } else if bits == 8 {
                "pcm_u8".into()
            } else {
                format!("pcm_s{bits}le")
            };
            stream.sample_format =
                Some(if evidence.representation == Some(Representation::Float) {
                    if bits == 64 { "dbl" } else { "flt" }
                } else if bits == 8 {
                    "u8"
                } else if bits <= 16 {
                    "s16"
                } else {
                    "s32"
                });
            stream.bit_rate = Some(f64::from(rate) * f64::from(channels) * f64::from(bits));
        }
    }
    let output_codec = if codec == "pcm" {
        stream.encoder.clone()
    } else {
        codec.into()
    };
    Ok(AudioEncoding {
        stream,
        output_codec,
    })
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub duration_seconds: Option<f64>,
    pub offset_seconds: Option<f64>,
}

pub fn editor_timeline(
    duration: Option<f64>,
    has_video: bool,
    audio: Option<&AudioSource>,
) -> Timeline {
    if has_video {
        return Timeline {
            duration_seconds: duration.filter(|n| n.is_finite()),
            offset_seconds: Some(0.),
        };
    }
    let offset = audio
        .and_then(|a| a.start_seconds)
        .filter(|n| n.is_finite());
    let elapsed = audio
        .and_then(|a| a.duration_seconds)
        .or_else(|| Some(duration? - offset?));
    Timeline {
        duration_seconds: elapsed
            .filter(|n| n.is_finite() && *n > 0.)
            .map(crate::edit_plan::round_milliseconds),
        offset_seconds: offset,
    }
}
