//! Immutable version 1 review documents. Only this policy module constructs
//! executable plans; the native transport cannot deserialize one into authority.
use crate::{
    AppError, Result,
    audio_policy::{self, AudioSource},
    capabilities::Capabilities,
    edit_plan::{EditPlan, round_milliseconds},
    media_inspection::MediaInspection,
    processing_settings::{self, MP3_BITRATES, PRESETS, Settings},
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
mod legacy;
mod processing;
pub use legacy::{ConversionInput, conversion};
pub use processing::plan;

#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct ReviewedPlan {
    document: Value,
}
impl ReviewedPlan {
    pub(crate) fn owned_metadata(mut self, fields: Value) -> Self {
        for (key, value) in fields.as_object().expect("owned metadata").iter() {
            self.document[key] = value.clone();
        }
        self.document.as_object_mut().unwrap().remove("key");
        self.document["key"] = json!(hash(&self.document));
        self
    }
    pub fn document(&self) -> &Value {
        &self.document
    }
    pub fn key(&self) -> &str {
        self.document["key"].as_str().expect("review key")
    }
    pub fn is_executable(&self) -> bool {
        self.document["status"] == "executable"
    }
    pub fn check_key(&self, key: &str) -> Result<()> {
        if self.key() != key {
            return Err(AppError::new(
                "PROCESSING_STALE",
                "The processing review has changed. Review the current settings again.",
            ));
        }
        Ok(())
    }
    pub fn public_document(&self) -> Value {
        let mut result = self.document.clone();
        result["streams"] = json!(
            self.document["streams"]
                .as_array()
                .expect("streams")
                .iter()
                .map(|s| json!({"role":s["role"],"index":s["index"],"action":s["action"]}))
                .collect::<Vec<_>>()
        );
        result
    }
}
pub struct Input<'a> {
    pub workspace_id: Option<&'a str>,
    pub source_asset_id: Option<&'a str>,
    pub input_filename: Option<&'a str>,
    pub draft_revision: f64,
    pub inspection: Option<&'a MediaInspection>,
    pub settings: Option<&'a Value>,
    pub edit_plan: Option<&'a Value>,
}
pub(crate) fn hash(value: &Value) -> String {
    // Keys are opaque, session-local SHA-256 review identities. Sorted JSON keys
    // make Rust's review stable independently of serialization insertion order.
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("finite review"))
    )
}
pub(crate) fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub(crate) fn n(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}
pub(crate) fn positive(v: &Value) -> bool {
    n(v).is_some_and(|n| n > 0.)
}
fn has(v: &Value) -> bool {
    !v.is_null()
}
fn integer(v: &Value) -> bool {
    n(v).is_some_and(|v| v.fract() == 0. && v.abs() <= 9_007_199_254_740_991.)
}
fn push(v: &mut Value, item: Value) {
    v.as_array_mut().expect("plan array").push(item);
}
pub(crate) fn merge(v: &mut Value, extra: Value) {
    v.as_object_mut()
        .expect("plan object")
        .extend(extra.as_object().expect("plan object").clone());
}
fn copy_fields(dest: &mut Value, source: &Value, fields: &[&str]) {
    for key in fields {
        if let Some(value) = source.get(key) {
            dest[*key] = value.clone();
        }
    }
}
fn count(v: &Value) -> f64 {
    n(v).unwrap_or(0.)
}
fn end(v: &Value) -> Value {
    json!(
        n(&v["startSeconds"])
            .zip(n(&v["durationSeconds"]))
            .map(|(s, d)| s + d)
    )
}
fn audio(source: &Value) -> AudioSource {
    serde_json::from_value(source.clone()).unwrap_or_default()
}
fn encoded(
    a: &Value,
    codec: &str,
    bitrate: Option<f64>,
) -> std::result::Result<Value, audio_policy::AudioPolicyError> {
    audio_policy::encoding_policy(&audio(a), codec, bitrate)
        .map(|p| serde_json::to_value(p).expect("audio policy"))
}
pub(crate) fn descriptor(container: &str) -> Value {
    let (extension, mime, label, muxer) = match container {
        "mp4" => ("mp4", "video/mp4", "MP4", "mp4"),
        "mov" => ("mov", "video/quicktime", "MOV / QuickTime", "mov"),
        "matroska" => ("mkv", "video/x-matroska", "Matroska / MKV", "matroska"),
        "m4a" => ("m4a", "audio/mp4", "M4A / AAC", "mp4"),
        "mp3" => ("mp3", "audio/mpeg", "MP3", "mp3"),
        "opus" => ("opus", "audio/ogg", "Opus", "ogg"),
        "flac" => ("flac", "audio/flac", "FLAC", "flac"),
        "wav" => ("wav", "audio/wav", "WAV / PCM", "wav"),
        _ => return json!({}),
    };
    json!({"extension":extension,"mime":mime,"label":label,"muxer":muxer})
}
fn copy_codecs(container: &str, role: &str) -> &'static [&'static str] {
    match (container, role) {
        ("mp4", "video") => &["h264", "hevc", "av1", "mpeg4"],
        ("mov", "video") => &["h264", "hevc", "mpeg4", "prores", "mjpeg"],
        ("matroska", "video") => &[
            "h264",
            "hevc",
            "av1",
            "vp8",
            "vp9",
            "mpeg4",
            "mpeg2video",
            "mjpeg",
            "ffv1",
            "prores",
        ],
        ("mp4", "audio") => &["aac", "mp3", "ac3", "eac3", "alac"],
        ("mov", "audio") => &[
            "aac",
            "mp3",
            "ac3",
            "alac",
            "pcm_s16le",
            "pcm_s24le",
            "pcm_s32le",
        ],
        ("matroska", "audio") => &[
            "aac",
            "mp3",
            "opus",
            "vorbis",
            "flac",
            "ac3",
            "eac3",
            "dts",
            "alac",
            "pcm_s16le",
            "pcm_s24le",
            "pcm_s32le",
        ],
        _ => &[],
    }
}
fn muxer(caps: Option<&Capabilities>, name: &str) -> bool {
    caps.is_some_and(|c| c.muxers.iter().any(|v| v == name))
}
fn encoder(caps: Option<&Capabilities>, name: &str) -> bool {
    caps.is_some_and(|c| c.encoders.iter().any(|v| v == name))
}
fn decoder(caps: Option<&Capabilities>, name: &str) -> Option<String> {
    caps.and_then(|c| c.software_decoder(name))
        .map(str::to_owned)
}
fn checked(caps: Option<&Capabilities>) -> bool {
    caps.is_some_and(|c| c.available)
}
pub fn options(inspection: Option<&MediaInspection>, caps: Option<&Capabilities>) -> Value {
    options_value(
        &inspection
            .map(|s| serde_json::to_value(s).unwrap())
            .unwrap_or(json!({})),
        caps,
    )
}
fn options_value(source: &Value, caps: Option<&Capabilities>) -> Value {
    let v = &source["video"];
    let a = &source["audio"];
    let h264 = checked(caps)
        && has(v)
        && v["hdr"] != true
        && v["alpha"] != true
        && v["orientationSupported"] != false
        && encoder(caps, "libx264")
        && decoder(caps, text(&v["codec"])).is_some();
    let audio_available = |codec: &str| {
        has(a)
            && (a["codec"] == codec
                || checked(caps)
                    && encoded(a, codec, None).is_ok_and(|p| {
                        decoder(caps, text(&a["codec"])).is_some()
                            && encoder(caps, text(&p["stream"]["encoder"]))
                    }))
    };
    let mut containers = vec![json!({"value":"source","label":"Keep source"})];
    if has(v) && checked(caps) {
        for value in ["mp4", "mov", "matroska"] {
            let codecs: &[&str] = if value == "matroska" {
                &["aac", "mp3", "opus", "flac"]
            } else {
                &["aac", "mp3"]
            };
            if muxer(caps, value)
                && (h264 || copy_codecs(value, "video").contains(&text(&v["codec"])))
                && (!has(a)
                    || copy_codecs(value, "audio").contains(&text(&a["codec"]))
                    || codecs.iter().any(|c| audio_available(c)))
            {
                containers.push(json!({"value":value,"label":descriptor(value)["label"]}));
            }
        }
    }
    if checked(caps) {
        for (value, codec) in [
            ("m4a", "aac"),
            ("mp3", "mp3"),
            ("opus", "opus"),
            ("flac", "flac"),
            ("wav", "pcm"),
        ] {
            if muxer(caps, text(&descriptor(value)["muxer"])) && audio_available(codec) {
                containers.push(json!({"value":value,"label":descriptor(value)["label"]}));
            }
        }
    }
    let mut video_codecs = vec![json!({"value":"unchanged","label":"Unchanged"})];
    if h264 {
        video_codecs.push(json!({"value":"h264","label":"H.264"}));
    }
    let mut audio_codecs = vec![json!({"value":"unchanged","label":"Unchanged"})];
    for codec in ["aac", "mp3", "opus", "flac", "pcm"] {
        if audio_available(codec) {
            audio_codecs.push(json!({"value":codec,"label":if codec == "pcm" { "PCM (automatic precision)".into() } else { codec.to_uppercase() }}));
        }
    }
    let rates: Vec<_> = [
        1., 5., 10., 12., 15., 20., 23.976, 24., 25., 29.97, 30., 48., 50., 59.94, 60.,
    ]
    .into_iter()
    .filter(|r| h264 && *r < count(&v["frameRate"]))
    .collect();
    json!({"checked":checked(caps),"videoCodecs":video_codecs,"containers":containers,"audioCodecs":audio_codecs,"frameRates":rates,"presets":PRESETS,"mp3Bitrates":MP3_BITRATES})
}
pub(crate) fn ratio(value: &Value) -> Option<f64> {
    let (a, b) = value.as_str()?.split_once(':')?;
    let (a, b) = (a.parse::<f64>().ok()?, b.parse::<f64>().ok()?);
    (a > 0. && b > 0. && a.is_finite() && b.is_finite()).then_some(a / b)
}
fn geometry(v: &Value, scale: &processing_settings::Scale, encode: bool) -> Value {
    let rotation = count(&v["rotationDegrees"]);
    let transpose = encode && [90., 270.].contains(&rotation);
    let (width, height) = if transpose {
        (count(&v["height"]), count(&v["width"]))
    } else {
        (count(&v["width"]), count(&v["height"]))
    };
    let sar = if transpose && has(&v["sampleAspectRatio"]) {
        json!(
            text(&v["sampleAspectRatio"])
                .split(':')
                .rev()
                .collect::<Vec<_>>()
                .join(":")
        )
    } else {
        v["sampleAspectRatio"].clone()
    };
    if !encode {
        return json!({"width":width,"height":height,"rotationDegrees":rotation,"sampleAspectRatio":sar});
    }
    if scale.mode == "unchanged" {
        return json!({"width":(width/2.).ceil()*2.,"height":(height/2.).ceil()*2.,"rotationDegrees":0,"sampleAspectRatio":sar});
    }
    let display_width = width * ratio(&sar).unwrap_or(1.);
    let factor = scale
        .percent
        .map_or(f64::INFINITY, |p| p / 100.)
        .min(scale.width.map_or(f64::INFINITY, |w| w / display_width))
        .min(scale.height.map_or(f64::INFINITY, |h| h / height))
        .min(16384. / display_width)
        .min(16384. / height)
        .min(if scale.allow_upscale {
            f64::INFINITY
        } else {
            1_f64.min(width / display_width)
        });
    let (w, h) = (
        (display_width * factor / 2.)
            .floor()
            .mul_add(2., 0.)
            .max(2.),
        (height * factor / 2.).floor().mul_add(2., 0.).max(2.),
    );
    let (a, b) = text(&sar)
        .split_once(':')
        .and_then(|(a, b)| Some((a.parse::<f64>().ok()?, b.parse::<f64>().ok()?)))
        .unwrap_or((1., 1.));
    let (numerator, denominator) = (width * h * a, height * w * b);
    let (mut x, mut y) = (numerator, denominator);
    while y != 0. {
        let r = x % y;
        x = y;
        y = r;
    }
    json!({"width":w,"height":h,"rotationDegrees":0,"sampleAspectRatio":format!("{}:{}",numerator/x,denominator/x)})
}
pub fn filename(name: Option<&str>, extension: Option<&str>, suffix: &str) -> String {
    let name = name
        .filter(|v| !v.is_empty())
        .unwrap_or("Local media")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let clean: String = stem
        .chars()
        .filter(|c| *c > '\u{1f}' && !"\u{7f}<>:\"|?*".contains(*c))
        .collect();
    let units: Vec<_> = clean.trim().encode_utf16().take(180).collect();
    let stem = String::from_utf16_lossy(&units);
    let stem = if stem.is_empty() {
        "Local media"
    } else {
        &stem
    };
    format!(
        "{stem}{suffix}{}",
        extension
            .filter(|s| !s.is_empty())
            .map(|s| format!(".{s}"))
            .unwrap_or_default()
    )
}
fn estimate(plan: &Value, source: &Value) -> Value {
    let streams = plan["streams"].as_array().unwrap();
    let video = streams.iter().find(|s| s["role"] == "video");
    let audio = streams.iter().find(|s| s["role"] == "audio");
    let video_rate = n(&plan["rateBudget"]["videoBitrate"]).or_else(|| {
        video
            .filter(|v| v["action"] == "copy")
            .and_then(|_| n(&source["video"]["bitRate"]))
    });
    let audio_rate = audio.map_or(Some(0.), |a| {
        n(&a["bitRate"]).or_else(|| {
            (a["action"] == "copy")
                .then(|| n(&source["audio"]["bitRate"]))
                .flatten()
        })
    });
    let mut value = json!({"bytes":null,"exact":false,"videoBitrate":video_rate,"audioBitrate":audio_rate,"explanation":"Size varies with quality and content; measured after processing."});
    if plan["status"] != "executable" && plan["status"] != "no-op" {
        value["explanation"] = json!("Complete a valid review to estimate size.");
    } else if plan["status"] == "no-op" {
        value["bytes"] = source["sourceSize"].clone();
        value["exact"] = json!(has(&source["sourceSize"]));
        value["explanation"] = json!(if has(&source["sourceSize"]) {
            "Exact size: existing original bytes."
        } else {
            "Original file size is unavailable."
        });
    } else if has(&plan["rateBudget"]) {
        value["bytes"] = plan["rateBudget"]["estimatedBytes"].clone();
        value["explanation"] = json!(if value["bytes"].is_null() {
            "Cannot estimate without a known audio bitrate."
        } else {
            "Estimate includes audio and a container reserve; actual bytes are measured before publication."
        });
    } else if (video.is_none() || video_rate.is_some_and(|v| v > 0.))
        && (audio.is_none() || audio_rate.is_some_and(|v| v > 0.))
        && positive(&plan["timing"]["durationSeconds"])
    {
        let duration = count(&plan["timing"]["durationSeconds"]);
        let bytes = (video_rate.unwrap_or(0.) + audio_rate.unwrap_or(0.)) * duration / 8.;
        value["bytes"] = json!(
            (bytes * 1.03
                + 16384.
                + duration
                    * (count(&plan["output"]["frameRate"]) * 24.
                        + if audio.is_some() { 800. } else { 0. }))
            .ceil()
        );
        value["explanation"] = json!(
            "Estimate from selected stream bitrates, retained duration, and container reserve; actual size varies."
        );
    } else if !streams.is_empty()
        && streams.iter().all(|s| s["action"] == "copy")
        && plan["cuts"] != true
        && n(&source["extraStreams"]["total"]) == Some(streams.len() as f64)
        && count(&source["extraStreams"]["chapters"]) == 0.
        && positive(&source["sourceSize"])
    {
        value["bytes"] = json!((count(&source["sourceSize"]) * 1.03 + 16384.).ceil());
        value["explanation"] =
            json!("Approximate remux size from the complete source; container overhead varies.");
    }
    value
}
fn finish(
    mut plan: Value,
    source: &Value,
    status: &str,
    reason: Option<&str>,
    message: &str,
) -> ReviewedPlan {
    plan["status"] = json!(status);
    plan["reason"] = json!(reason);
    plan["message"] = json!(message);
    let extension = if status == "no-op" {
        text(&plan["inputFilename"])
            .rsplit_once('.')
            .map(|(_, e)| e)
            .filter(|e| {
                !e.is_empty() && e.len() <= 12 && e.bytes().all(|b| b.is_ascii_alphanumeric())
            })
            .or_else(|| plan["output"]["extension"].as_str())
    } else {
        plan["output"]["extension"].as_str()
    };
    plan["downloadFilename"] = if extension.is_some() || status == "no-op" {
        json!(filename(
            plan["inputFilename"].as_str(),
            extension,
            text(&plan["settings"]["filenameSuffix"])
        ))
    } else {
        Value::Null
    };
    plan["sizeEstimate"] = estimate(&plan, source);
    plan["key"] = json!(hash(&plan));
    ReviewedPlan { document: plan }
}
