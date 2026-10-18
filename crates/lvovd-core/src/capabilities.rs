//! Fixed, bounded FFmpeg discovery. Listings describe implementations, not working hardware.
use crate::{
    AppError, Result,
    process::{self, CancellationToken, Output},
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
#[cfg(test)]
#[path = "capabilities_tests.rs"]
mod tests;
const DEADLINE: Duration = Duration::from_secs(5);
const FAILURE_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum FailureReason {
    Timeout,
    OutputLimit,
    CommandFailed,
    Unparseable,
    SpawnFailed,
}
#[derive(Clone, Debug, Serialize)]
pub struct Decoder {
    pub name: String,
    pub software: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub available: bool,
    pub version: Option<String>,
    pub encoders: Vec<String>,
    pub decoders: Vec<String>,
    pub decoder_codecs: BTreeMap<String, Vec<Decoder>>,
    pub muxers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<FailureReason>,
}
impl Capabilities {
    fn unavailable(reason: FailureReason) -> Self {
        Self {
            available: false,
            version: None,
            encoders: vec![],
            decoders: vec![],
            decoder_codecs: BTreeMap::new(),
            muxers: vec![],
            failure_reason: Some(reason),
        }
    }
    pub fn software_decoder(&self, codec: &str) -> Option<&str> {
        if !self.available {
            return None;
        }
        self.decoder_codecs
            .get(codec)?
            .iter()
            .find(|d| d.software && pattern!(r"\A[a-z0-9_][a-z0-9_.-]{0,79}\z").is_match(&d.name))
            .map(|d| d.name.as_str())
    }
    pub fn public_summary(&self) -> serde_json::Value {
        use serde_json::json;
        if !self.available {
            return json!({ "available": false, "version": null,
            "broadMp4": { "h264SoftwareEncoder": null, "aacEncoder": null, "mp4Muxer": null },
            "failure": { "category": "local_capability_discovery_failed", "title": "Could not check local conversion capabilities",
                "explanation": if self.failure_reason == Some(FailureReason::Timeout) { "The local FFmpeg capability check exceeded its time limit." } else { "LVOVD could not read usable capability information from the local FFmpeg installation." },
                "help": "Check the local FFmpeg installation, then try inspecting again shortly." } });
        }
        json!({ "available": true, "version": self.version, "broadMp4": { "h264SoftwareEncoder": self.encoders.iter().any(|v| v == "libx264"), "aacEncoder": self.encoders.iter().any(|v| v == "aac"), "mp4Muxer": self.muxers.iter().any(|v| v == "mp4") } })
    }
}
fn unparseable() -> AppError {
    AppError::new(
        "CAPABILITY_UNPARSEABLE",
        "FFmpeg capability listings could not be recognized.",
    )
}
fn lines(output: &str) -> Result<Vec<&str>> {
    if output.len() > MAX_OUTPUT_BYTES {
        return Err(unparseable());
    }
    let lines: Vec<_> = output
        .split('\n')
        .take(10001)
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    if lines.len() > 10000 || lines.iter().any(|line| line.encode_utf16().count() > 4096) {
        return Err(unparseable());
    }
    Ok(lines)
}
fn entries(output: &str) -> Result<Vec<(String, String, String)>> {
    let mut entries = vec![];
    for line in lines(output)? {
        if let Some(c) =
            pattern!(r"\A\s*([VAS][A-Z.]{5})\s+([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,79})\s+(.+)\z")
                .captures(line)
        {
            let name = c[2].to_ascii_lowercase();
            let codec = pattern!(r"\(codec ([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,79})\)\s*\z")
                .captures(&c[3])
                .map(|c| c[1].to_ascii_lowercase())
                .unwrap_or_else(|| name.clone());
            entries.push((name, codec, c[3].into()));
        }
    }
    Ok(entries)
}
fn insert_unique(names: &mut Vec<String>, name: String) {
    if !names.contains(&name) {
        names.push(name);
    }
}
pub fn parse_codecs(output: &str) -> Result<Vec<String>> {
    let mut names = vec![];
    for (name, _, _) in entries(output)? {
        insert_unique(&mut names, name);
    }
    Ok(names)
}
pub fn parse_decoders(output: &str) -> Result<BTreeMap<String, Vec<Decoder>>> {
    let mut result: BTreeMap<String, Vec<Decoder>> = BTreeMap::new();
    for (name, codec, description) in entries(output)? {
        let software = name != "av1" && !pattern!(r"(?i)(?:\A|_)(?:nvenc|nvdec|cuvid|qsv|amf|vaapi|vdpau|videotoolbox|mediacodec|v4l2m2m|mmal|omx|rkmpp|vulkan|d3d11va|d3d12va)(?:_|\z)").is_match(&name)
            && !pattern!(r"(?i)hardware|acceleration|cuvid|quick sync|nvdec|cuda").is_match(&description);
        result
            .entry(codec)
            .or_default()
            .push(Decoder { name, software });
    }
    Ok(result)
}
pub fn parse_muxers(output: &str) -> Result<Vec<String>> {
    let mut names = vec![];
    for line in lines(output)? {
        let mut parts = line.split_whitespace();
        let flags = parts.next().unwrap_or_default();
        let Some(name) = parts.next().filter(|v| *v != "=") else {
            continue;
        };
        if flags.contains('E') && pattern!(r"\A[D.E]{1,3}\z").is_match(flags) {
            for name in name
                .to_ascii_lowercase()
                .split(',')
                .filter(|n| !n.is_empty())
            {
                insert_unique(&mut names, name.into());
            }
        }
    }
    Ok(names)
}
pub fn parse_version(output: &str) -> Option<String> {
    if output.len() > MAX_OUTPUT_BYTES {
        return None;
    }
    pattern!(r"(?im)^ffmpeg version\s+([a-z0-9][a-z0-9._+~-]{0,119})(?:\s|$)")
        .captures(output)
        .map(|c| c[1].into())
}
pub fn from_listings(
    version: &str,
    encoders: &str,
    decoders: &str,
    muxers: &str,
) -> Result<Capabilities> {
    let result = Capabilities {
        available: true,
        version: parse_version(version),
        encoders: parse_codecs(encoders)?,
        decoders: parse_codecs(decoders)?,
        decoder_codecs: parse_decoders(decoders)?,
        muxers: parse_muxers(muxers)?,
        failure_reason: None,
    };
    if result.version.is_none()
        || result.encoders.is_empty()
        || result.decoders.is_empty()
        || result.muxers.is_empty()
    {
        return Err(unparseable());
    }
    Ok(result)
}

type Run<'a> = Pin<Box<dyn Future<Output = Result<Output>> + Send + 'a>>;
trait Runner: Send + Sync {
    fn run<'a>(&'a self, args: &'a [&'a str], cancel: &'a CancellationToken) -> Run<'a>;
}
struct Ffmpeg(PathBuf);
impl Runner for Ffmpeg {
    fn run<'a>(&'a self, args: &'a [&'a str], cancel: &'a CancellationToken) -> Run<'a> {
        Box::pin(async move {
            process::run(
                &self.0,
                &args.iter().map(Into::into).collect::<Vec<_>>(),
                DEADLINE,
                MAX_OUTPUT_BYTES,
                cancel,
            )
            .await
        })
    }
}
struct Cached {
    value: Arc<Capabilities>,
    retry_after: Option<Instant>,
}
pub struct CapabilityDiscovery {
    runner: Box<dyn Runner>,
    cached: Mutex<Option<Cached>>,
}
impl CapabilityDiscovery {
    /// Keep one instance per immutable tool path. Replacing a verified binary
    /// requires a new discovery instance after its active operations finish.
    pub fn new(ffmpeg: PathBuf) -> Self {
        Self {
            runner: Box::new(Ffmpeg(ffmpeg)),
            cached: Mutex::new(None),
        }
    }
    pub async fn get(&self, cancel: &CancellationToken) -> Result<Arc<Capabilities>> {
        let mut cached = tokio::select! { biased; _ = cancel.cancelled() => return Err(AppError::new("CANCELLED", "Operation cancelled.")), c = self.cached.lock() => c };
        if cancel.is_cancelled() {
            return Err(AppError::new("CANCELLED", "Operation cancelled."));
        }
        if let Some(c) = cached
            .as_ref()
            .filter(|c| c.retry_after.is_none_or(|after| Instant::now() < after))
        {
            return Ok(c.value.clone());
        }
        let result = self.discover(cancel).await;
        let value = match result {
            Ok(value) => value,
            Err(e) if e.code == "CANCELLED" => return Err(e),
            Err(e) => Capabilities::unavailable(match e.code {
                "TOOL_TIMEOUT" => FailureReason::Timeout,
                "TOOL_OUTPUT_LIMIT" => FailureReason::OutputLimit,
                "CAPABILITY_UNPARSEABLE" => FailureReason::Unparseable,
                "TOOL_MISSING" | "TOOL_START" | "TOOL_PATH" => FailureReason::SpawnFailed,
                _ => FailureReason::CommandFailed,
            }),
        };
        let retry_after = (!value.available).then(|| Instant::now() + FAILURE_COOLDOWN);
        let value = Arc::new(value);
        *cached = Some(Cached {
            value: value.clone(),
            retry_after,
        });
        Ok(value)
    }
    async fn discover(&self, cancel: &CancellationToken) -> Result<Capabilities> {
        let mut outputs = vec![];
        for args in [
            &["-version"][..],
            &["-hide_banner", "-encoders"],
            &["-hide_banner", "-decoders"],
            &["-hide_banner", "-muxers"],
        ] {
            let output = self.runner.run(args, cancel).await?;
            if output.stdout.len().saturating_add(output.stderr.len()) > MAX_OUTPUT_BYTES {
                return Err(AppError::new(
                    "TOOL_OUTPUT_LIMIT",
                    "Tool output exceeded its limit.",
                ));
            }
            // Match Node's bounded UTF-8 decoding. Never publish raw diagnostics.
            outputs.push(format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        from_listings(&outputs[0], &outputs[1], &outputs[2], &outputs[3])
    }
}
