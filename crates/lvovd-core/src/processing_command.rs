//! Argument construction from core-owned reviews. Paths come from the workspace
//! owner, never from native command payloads. This module does not run a tool.
use crate::{
    AppError, Result,
    edit_plan::round_milliseconds,
    media_inspection::MediaInspection,
    processing_plan::{ReviewedPlan, n, text},
};
use serde_json::Value;
use std::{
    ffi::OsString,
    path::{Component, Path},
};
mod validation;
pub use validation::{ValidationFailure, validate};
mod size;
pub use size::{SizeControl, SizeDecision};

const LOCAL_FORMATS: &str = "mov,matroska,avi,asf,flv,mpeg,mpegts,ogg,nut,mp3,aac,flac,wav,aiff,amr,ape,wv,tta,ac3,eac3,dts,au,caf";
const CLOCK: &str = "aresample=async=1:first_pts=0:min_hard_comp=0.001";

#[derive(Default)]
pub struct Attempt<'a> {
    pub pass: Option<u8>,
    pub pass_log_prefix: Option<&'a Path>,
    pub video_bitrate: Option<u64>,
    /// Legacy conversion's independent safety cap, not a requested file size.
    pub conversion_max_bytes: Option<u64>,
}
fn invalid(message: &str) -> AppError {
    AppError::new("PROCESSING_COMMAND", message)
}
fn number(value: &Value) -> String {
    n(value).unwrap_or(0.).to_string()
}
fn add(args: &mut Vec<OsString>, values: &[&str]) {
    args.extend(values.iter().map(OsString::from));
}
fn pair(args: &mut Vec<OsString>, key: &str, value: impl Into<OsString>) {
    args.push(key.into());
    args.push(value.into());
}
fn absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
}
fn stream<'a>(plan: &'a Value, role: &str) -> Option<&'a Value> {
    plan["streams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["role"] == role)
}
fn encoded(s: Option<&Value>) -> Option<&Value> {
    s.filter(|s| s["action"] == "encode")
}
pub(crate) fn local_input(args: &mut Vec<OsString>, inspection: &MediaInspection) -> Result<()> {
    let format = inspection
        .format_names
        .iter()
        .find(|f| {
            LOCAL_FORMATS
                .split(',')
                .any(|allowed| allowed == f.as_str())
        })
        .ok_or_else(|| invalid("Unsupported local media container."))?;
    add(
        args,
        &[
            "-format_whitelist",
            LOCAL_FORMATS,
            "-protocol_whitelist",
            "file",
            "-f",
            format,
        ],
    );
    if format == "mov" {
        add(args, &["-enable_drefs", "0", "-use_absolute_path", "0"]);
    }
    Ok(())
}
fn video_filter(p: &Value) -> Option<String> {
    let v = encoded(stream(p, "video"))?;
    let mut filters = Vec::new();
    if p["cuts"] == true {
        let ranges = p["editPlan"]["keepRanges"].as_array().unwrap();
        let micros = |v: &Value| (n(v).unwrap() * 1e6).round().to_string();
        let selection = ranges
            .iter()
            .map(|r| {
                format!(
                    "gte(pts,{})*lt(pts,{})",
                    micros(&r["startSeconds"]),
                    micros(&r["endSeconds"])
                )
            })
            .collect::<Vec<_>>()
            .join("+");
        let removed = ranges
            .iter()
            .enumerate()
            .map(|(i, r)| {
                if i == 0 {
                    micros(&r["startSeconds"])
                } else {
                    format!(
                        "gte(PTS,{})*{}",
                        micros(&r["startSeconds"]),
                        (round_milliseconds(
                            n(&r["startSeconds"]).unwrap()
                                - n(&ranges[i - 1]["endSeconds"]).unwrap()
                        ) * 1e6)
                            .round()
                    )
                }
            })
            .collect::<Vec<_>>()
            .join("+");
        filters.extend([
            "settb=AVTB".into(),
            format!(
                "trim=end_pts={}",
                micros(&ranges.last().unwrap()["endSeconds"])
            ),
            format!("select='{selection}'"),
            format!("setpts='PTS-({removed})'"),
        ]);
    }
    filters.push(if p["settings"]["scale"]["mode"] != "unchanged" {
        format!(
            "scale={}:{}",
            number(&p["output"]["width"]),
            number(&p["output"]["height"])
        )
    } else {
        "pad=ceil(iw/2)*2:ceil(ih/2)*2".into()
    });
    if !p["settings"]["frameRate"].is_null() {
        filters.push(format!(
            "fps=fps={}:round=near:eof_action=pass",
            number(&p["settings"]["frameRate"])
        ));
    }
    Some(format!(
        "[0:{}]{}[vout]",
        number(&v["index"]),
        filters.join(",")
    ))
}
fn audio_filters(p: &Value) -> Vec<String> {
    let Some(a) = encoded(stream(p, "audio")) else {
        return vec![];
    };
    if p["cuts"] != true {
        return vec![format!("[0:{}]{CLOCK}[aout]", number(&a["index"]))];
    }
    let ranges = p["editPlan"]["keepRanges"].as_array().unwrap();
    let end = number(&ranges.last().unwrap()["endSeconds"]);
    let mut result = vec![format!(
        "[0:{}]{CLOCK},apad=whole_dur={end},atrim=end={end},asplit={}{}",
        number(&a["index"]),
        ranges.len(),
        (0..ranges.len())
            .map(|i| format!("[as{i}]"))
            .collect::<String>()
    )];
    result.extend(ranges.iter().enumerate().map(|(i, r)| {
        format!(
            "[as{i}]atrim=start={}:end={},asetpts=PTS-{}/TB[a{i}]",
            number(&r["startSeconds"]),
            number(&r["endSeconds"]),
            number(&r["startSeconds"])
        )
    }));
    result.push(format!(
        "{}concat=n={}:v=0:a=1[aout]",
        (0..ranges.len())
            .map(|i| format!("[a{i}]"))
            .collect::<String>(),
        ranges.len()
    ));
    result
}

pub fn arguments(
    input: &Path,
    output: &Path,
    inspection: &MediaInspection,
    review: &ReviewedPlan,
    attempt: Attempt<'_>,
) -> Result<Vec<OsString>> {
    let p = review.document();
    let legacy = p.get("targetId").is_some();
    if !review.is_executable() || !absolute(input) || !absolute(output) || input == output {
        return Err(invalid(
            "An executable owned processing plan and a separate absolute output are required.",
        ));
    }
    // A review is meaningful only for the inspection it captured.
    if p["inspectionKey"]
        != crate::processing_plan::hash(&serde_json::to_value(inspection).unwrap())
    {
        return Err(invalid("The inspected source changed after review."));
    }
    let first = attempt.pass == Some(1);
    if p["passes"] == 2 {
        if !matches!(attempt.pass, Some(1 | 2)) || !attempt.pass_log_prefix.is_some_and(absolute) {
            return Err(invalid(
                "Two-pass processing requires an attempt-owned pass log and an explicit pass.",
            ));
        }
        if attempt
            .pass_log_prefix
            .is_some_and(|log| log == input || log == output)
        {
            return Err(invalid("Pass logs must be separate from media files."));
        }
    } else if attempt.pass.is_some() {
        return Err(invalid("This processing plan does not use two passes."));
    }
    let max_bytes = if legacy {
        Some(
            attempt
                .conversion_max_bytes
                .filter(|n| *n > 0 && *n <= 100 * 1024 * 1024 * 1024)
                .ok_or_else(|| invalid("A bounded conversion safety limit is required."))?,
        )
    } else {
        None
    };
    let video = stream(p, "video");
    let audio = if first { None } else { stream(p, "audio") };
    let mut args = Vec::new();
    add(
        &mut args,
        &[
            "-hide_banner",
            "-nostdin",
            "-y",
            "-copyts",
            "-start_at_zero",
        ],
    );
    if p["timing"]["audioOnly"] == true
        && let Some(offset) = n(&p["timing"]["sourceAudioStartSeconds"])
        && (legacy || p["cuts"] != true || offset != 0.)
    {
        pair(
            &mut args,
            "-itsoffset",
            if offset == 0. {
                "0".into()
            } else {
                (-offset).to_string()
            },
        );
    }
    for s in p["streams"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["action"] == "encode" && (!first || s["role"] == "video"))
    {
        if !pattern!(r"\A[a-z0-9_][a-z0-9_.-]{0,79}\z").is_match(text(&s["decoder"])) {
            return Err(invalid("The admitted software decoder is missing."));
        }
        pair(
            &mut args,
            &format!("-c:{}", number(&s["index"])),
            text(&s["decoder"]),
        );
    }
    if video.is_none_or(|v| v["action"] == "copy") {
        args.push("-noautorotate".into());
    }
    local_input(&mut args, inspection)?;
    pair(&mut args, "-i", input.as_os_str());
    if legacy {
        for s in p["streams"].as_array().unwrap() {
            pair(&mut args, "-map", format!("0:{}", number(&s["index"])));
        }
    } else {
        let mut filters = video_filter(p).into_iter().collect::<Vec<_>>();
        if !first {
            filters.extend(audio_filters(p));
        }
        if !filters.is_empty() {
            pair(&mut args, "-filter_complex", filters.join(";"));
        }
        for (s, label) in [(video, "[vout]"), (audio, "[aout]")] {
            if let Some(s) = s {
                pair(
                    &mut args,
                    "-map",
                    if s["action"] == "encode" {
                        label.into()
                    } else {
                        format!("0:{}", number(&s["index"]))
                    },
                );
            }
        }
    }
    add(
        &mut args,
        &["-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn"],
    );
    if let Some(v) = video {
        if v["action"] == "copy" {
            add(&mut args, &["-c:v", "copy"]);
        } else if legacy {
            add(
                &mut args,
                &[
                    "-c:v",
                    "libx264",
                    "-crf",
                    "18",
                    "-preset",
                    "medium",
                    "-pix_fmt",
                    "yuv420p",
                    "-vf",
                    "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                    "-fps_mode:v",
                    "vfr",
                    "-enc_time_base:v",
                    "1:1000000",
                    "-metadata:s:v:0",
                    "rotate=0",
                ],
            );
        } else {
            add(
                &mut args,
                &[
                    "-c:v",
                    "libx264",
                    "-preset",
                    text(&v["preset"]),
                    "-pix_fmt",
                    "yuv420p",
                    "-fps_mode:v",
                    "vfr",
                    "-enc_time_base:v",
                    "1:1000000",
                    "-metadata:s:v:0",
                    "rotate=0",
                ],
            );
            if ["bitrate", "size"].contains(&text(&p["settings"]["rate"]["mode"])) {
                let bitrate = attempt
                    .video_bitrate
                    .map(|n| n as f64)
                    .or_else(|| n(&p["rateBudget"]["videoBitrate"]))
                    .filter(|v| *v > 0. && *v <= 1e9 && v.fract() == 0.)
                    .ok_or_else(|| invalid("A bounded video bitrate is required."))?;
                pair(&mut args, "-b:v", bitrate.to_string());
            } else {
                pair(&mut args, "-crf", number(&v["crf"]));
            }
            if let Some(pass) = attempt.pass {
                pair(&mut args, "-pass", pass.to_string());
                pair(
                    &mut args,
                    "-passlogfile",
                    attempt.pass_log_prefix.unwrap().as_os_str(),
                );
            }
        }
        if v["action"] == "encode" {
            if let Some(cadence) = n(&p["settings"]["frameRate"])
                .or_else(|| inspection.video.as_ref().and_then(|v| v.frame_rate))
                .filter(|n| *n > 0.)
            {
                pair(&mut args, "-x264-params", format!("fps={cadence}"));
            }
            if !legacy && p["cuts"] == true {
                pair(
                    &mut args,
                    "-bsf:v",
                    format!(
                        "setts=pts=PTS:dts=DTS:duration='if(gt(DURATION,0),DURATION,if(gt(NEXT_DTS,DTS),NEXT_DTS-DTS,if(eq(N,0),{}/TB-PTS,DTS-PREV_OUTDTS)))'",
                        number(&p["timing"]["durationSeconds"])
                    ),
                );
            }
        }
    } else {
        args.push("-vn".into());
    }
    if let Some(a) = audio {
        if a["action"] == "copy" {
            add(&mut args, &["-c:a", "copy"]);
        } else {
            add(
                &mut args,
                &[
                    "-c:a",
                    text(&a["encoder"]),
                    "-ar",
                    &number(&a["sampleRate"]),
                    "-ac",
                    &number(&a["channels"]),
                    "-channel_layout",
                    text(&a["channelLayout"]),
                ],
            );
            if legacy {
                pair(&mut args, "-af", CLOCK);
            } else if let Some(format) = a["sampleFormat"].as_str() {
                pair(&mut args, "-sample_fmt:a", format);
            }
            if !legacy && a["encoder"] == "flac" {
                add(
                    &mut args,
                    &[
                        "-compression_level:a",
                        "5",
                        "-bits_per_raw_sample:a",
                        &number(&a["bitDepth"]),
                    ],
                );
            } else if n(&a["bitRate"]).is_some_and(|n| n > 0.)
                && (legacy || !text(&a["encoder"]).starts_with("pcm_"))
            {
                pair(&mut args, "-b:a", number(&a["bitRate"]));
            } else if !a["quality"].is_null() {
                pair(&mut args, "-q:a", number(&a["quality"]));
            }
            if !legacy && a["encoder"] == "libopus" {
                add(
                    &mut args,
                    &[
                        "-vbr:a",
                        "on",
                        "-application:a",
                        "audio",
                        "-mapping_family:a",
                        if n(&a["channels"]).unwrap() > 2. {
                            "1"
                        } else {
                            "0"
                        },
                    ],
                );
            }
        }
    } else {
        args.push("-an".into());
    }
    if !first && (p["output"]["container"] == "mp4" || !legacy && p["output"]["container"] == "mov")
    {
        add(&mut args, &["-movflags", "+faststart"]);
    }
    if !first && !legacy && p["output"]["container"] == "wav" {
        add(&mut args, &["-rf64", "auto"]);
    }
    add(&mut args, &["-avoid_negative_ts", "disabled"]);
    if let Some(max) = max_bytes {
        pair(&mut args, "-fs", max.to_string());
    }
    add(
        &mut args,
        &[
            "-f",
            if first {
                "null"
            } else {
                text(&p["output"]["container"])
            },
            "-progress",
            "pipe:1",
            "-nostats",
        ],
    );
    args.push(if first {
        "-".into()
    } else {
        output.as_os_str().into()
    });
    Ok(args)
}
