use super::*;
use crate::{audio_policy, processing_plan::ratio};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ValidationFailure {
    pub message: String,
    #[serde(rename = "workspaceFailure")]
    pub failure: Failure,
}
#[derive(Debug, Serialize)]
pub struct Failure {
    pub category: &'static str,
    pub title: &'static str,
    pub explanation: String,
    pub help: &'static str,
}

pub(super) fn failure(reason: &str, legacy: bool) -> ValidationFailure {
    ValidationFailure {
        message: format!(
            "{} output validation failed: {reason}",
            if legacy { "Converted" } else { "Processed" }
        ),
        failure: Failure {
            category: if legacy {
                "local_conversion_validation"
            } else {
                "local_processing_validation"
            },
            title: if legacy {
                "The converted result did not preserve the requested output"
            } else {
                "The processed result did not preserve the requested output"
            },
            explanation: format!(
                "Validation rejected the result: {reason}. The original source and previous outputs remain available."
            ),
            help: if legacy {
                "Check the installed FFmpeg build or choose a different supported target. No rejected result is offered for download."
            } else {
                "Check the installed FFmpeg build or choose different supported settings. No rejected result is offered for download."
            },
        },
    }
}
pub fn validate(
    output: &MediaInspection,
    review: &ReviewedPlan,
) -> std::result::Result<(), ValidationFailure> {
    let p = review.document();
    let legacy = p.get("targetId").is_some();
    let o = serde_json::to_value(output).unwrap();
    macro_rules! fail {
        ($reason:expr) => {
            return Err(failure($reason, legacy))
        };
    }
    if !review.is_executable() {
        fail!("an executable reviewed plan is required");
    }
    let video = stream(p, "video");
    let audio = stream(p, "audio");
    if o["container"]["kind"] != p["output"]["container"] {
        fail!("unexpected container");
    }
    if output.extra_streams.as_ref().map(|e| e.total)
        != Some(p["streams"].as_array().unwrap().len())
        || output.track_counts.video != Some(usize::from(video.is_some()))
        || output.track_counts.audio != Some(usize::from(audio.is_some()))
        || output.track_counts.subtitle != Some(0)
        || !legacy && output.extra_streams.as_ref().and_then(|e| e.chapters) != Some(0)
    {
        fail!(if legacy {
            "unexpected stream roles"
        } else {
            "unexpected stream roles or chapters"
        });
    }
    let tolerance = 0.06_f64.max(
        1. / (if legacy {
            None
        } else {
            n(&p["output"]["frameRate"])
        })
        .filter(|n| *n > 0.)
        .or_else(|| {
            output
                .video
                .as_ref()
                .and_then(|v| v.frame_rate)
                .filter(|n| *n > 0.)
        })
        .unwrap_or(25.)
            + 0.01,
    );
    if output.duration_seconds.is_none_or(|duration| {
        !duration.is_finite()
            || (duration - n(&p["timing"]["durationSeconds"]).unwrap()).abs() > tolerance
    }) {
        fail!(if legacy {
            "duration differs from selected presentation"
        } else {
            "duration differs from the retained presentation"
        });
    }
    let differs = |a: &Value, b: &Value, tolerance: f64| {
        n(a).zip(n(b))
            .is_some_and(|(a, b)| (a - b).abs() > tolerance)
    };
    let equal = |a: &Value, b: &Value| n(a).zip(n(b)).map_or(a == b, |(a, b)| a == b);
    if video.is_some() {
        let v = &o["video"];
        let expected = &p["output"];
        if v["codec"] != expected["videoCodec"]
            || v["pixelFormat"] != expected["pixelFormat"]
            || !equal(&v["width"], &expected["width"])
            || !equal(&v["height"], &expected["height"])
            || n(&v["rotationDegrees"]).unwrap_or(0.)
                != n(&expected["rotationDegrees"]).unwrap_or(0.)
            || v["orientationSupported"] == false
        {
            fail!("video geometry, orientation, or codec");
        }
        if differs(
            &v["startSeconds"],
            &p["timing"]["videoStartSeconds"],
            tolerance,
        ) {
            fail!("video start changed");
        }
        if let Some(aspect) = ratio(&expected["sampleAspectRatio"])
            && ratio(&v["sampleAspectRatio"]).is_none_or(|a| (a - aspect).abs() > 0.001)
        {
            fail!("display aspect changed");
        }
        if let Some(duration) = n(&v["durationSeconds"])
            && n(&p["timing"]["videoEndSeconds"]).is_some_and(|end| {
                (n(&v["startSeconds"]).unwrap_or(0.) + duration - end).abs() > tolerance
            })
        {
            fail!("video endpoint changed");
        }
        if !legacy
            && let Some(rate) = n(&p["settings"]["frameRate"])
            && n(&v["frameRate"]).is_none_or(|actual| {
                actual == 0. || (actual - rate).abs() > 0.01_f64.max(rate * 0.01)
            })
        {
            fail!("requested frame rate changed");
        }
    }
    if let Some(audio) = audio {
        let a = &o["audio"];
        let expected = &p["output"];
        if a["codec"] != expected["audioCodec"]
            || !equal(&a["sampleRate"], &expected["sampleRate"])
            || !equal(&a["channels"], &expected["channels"])
        {
            fail!("audio codec, sample rate, or channels");
        }
        let layout = a["channelLayout"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                if !legacy && expected["container"] == "wav" {
                    match n(&a["channels"]) {
                        Some(1.) => Some("mono"),
                        Some(2.) => Some("stereo"),
                        _ => None,
                    }
                } else {
                    None
                }
            });
        if let Some(wanted) = expected["channelLayout"].as_str().filter(|s| !s.is_empty())
            && layout != Some(wanted)
        {
            fail!("audio channel layout changed");
        }
        if !legacy && n(&expected["bitDepth"]).is_some_and(|n| n > 0.) {
            let precision = serde_json::to_value(audio_policy::precision(
                &output.audio.as_ref().unwrap().into(),
            ))
            .unwrap();
            if !equal(&precision["bitDepth"], &expected["bitDepth"])
                || precision["representation"] != expected["representation"]
            {
                fail!("audio precision changed");
            }
        }
        let zero = serde_json::json!(0);
        let start = if audio["action"] == "encode" {
            &zero
        } else {
            &p["timing"]["audioStartSeconds"]
        };
        if differs(&a["startSeconds"], start, 0.06) {
            fail!("audio start changed");
        }
        if let Some(duration) = n(&a["durationSeconds"])
            && n(&p["timing"]["audioEndSeconds"]).is_some_and(|end| {
                (n(&a["startSeconds"]).unwrap_or(0.) + duration - end).abs() > 0.06
            })
        {
            fail!("audio endpoint changed");
        }
    }
    Ok(())
}
