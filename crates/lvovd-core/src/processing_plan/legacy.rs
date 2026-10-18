//! The released conversion targets deliberately retain their own AAC/MP3
//! policy, including timestamped MP3 re-encoding and original/edited roles.
use super::*;

pub struct ConversionInput<'a> {
    pub workspace_id: Option<&'a str>,
    pub input_asset_id: Option<&'a str>,
    pub input_role: &'a str,
    pub input_filename: Option<&'a str>,
    pub edit_plan_key: Option<&'a str>,
    pub inspection: Option<&'a MediaInspection>,
    pub target_id: &'a str,
}
pub fn conversion(input: ConversionInput<'_>, caps: Option<&Capabilities>) -> Result<ReviewedPlan> {
    let source = input
        .inspection
        .map(|s| serde_json::to_value(s).unwrap())
        .unwrap_or(json!({}));
    build(&input, &source, caps).map(|document| ReviewedPlan { document })
}
pub(super) fn build(
    input: &ConversionInput<'_>,
    source: &Value,
    caps: Option<&Capabilities>,
) -> Result<Value> {
    let (label, extension, mime, container, with_video, codec) = match input.target_id {
        "broad-compatibility-mp4" => ("Compatible MP4", "mp4", "video/mp4", "mp4", true, "aac"),
        "m4a-aac" => ("M4A / AAC", "m4a", "audio/mp4", "mp4", false, "aac"),
        "mp3" => ("MP3", "mp3", "audio/mpeg", "mp3", false, "mp3"),
        _ => {
            return Err(processing_settings::invalid(
                "Choose a supported conversion target.",
            ));
        }
    };
    let video = if with_video {
        &source["video"]
    } else {
        &Value::Null
    };
    let audio = &source["audio"];
    let counts = &source["trackCounts"];
    let mut p = json!({"version":1,"workspaceId":input.workspace_id,"inputAssetId":input.input_asset_id,
        "inputRole":input.input_role,"inputFilename":input.input_filename,"editPlanKey":input.edit_plan_key,
        "inspectionKey":hash(source),"targetId":input.target_id,"target":label,
        "status":"unknown","reason":"incomplete","message":"More source metadata is needed for this target.",
        "streams":[],"changes":[],"warnings":[],"missing":[],
        "output":{"extension":extension,"mime":mime,"container":container},"timing":{"audioOnly":!with_video}});
    copy_fields(&mut p, source, &["durationSeconds"]);
    if let Some(duration) = p.as_object_mut().unwrap().remove("durationSeconds") {
        p["inputDurationSeconds"] = duration;
    }
    if let Some(origin) = source.get("timeOriginSeconds") {
        p["timing"]["originSeconds"] = origin.clone();
    }
    macro_rules! incomplete {
        ($message:expr) => {
            return Ok(done(p, "unknown", Some("incomplete"), $message))
        };
    }
    macro_rules! unsupported {
        ($message:expr) => {
            return Ok(done(p, "unavailable", Some("unsupported"), $message))
        };
    }
    if input.input_asset_id.is_none_or(|s| s.is_empty())
        || n(&source["timeOriginSeconds"]).is_none()
    {
        incomplete!("The source identity or presentation origin is incomplete.");
    }
    if with_video && (!has(video) || source["mediaKind"] != "video") {
        if counts["video"] == 0 {
            unsupported!(
                "Compatible MP4 requires a timed video. Choose an audio target for this source."
            );
        }
        incomplete!("The reported video does not have enough usable metadata.");
    }
    if !with_video && !has(audio) {
        if counts["audio"] == 0 {
            unsupported!("This source has no audio to extract.");
        }
        incomplete!("The selected audio is unknown.");
    }
    if with_video && !has(&counts["audio"]) {
        incomplete!("The source audio track count is unknown.");
    }
    if with_video && positive(&counts["audio"]) && !has(audio) {
        incomplete!("A reported audio stream cannot be selected safely.");
    }
    if has(video) {
        if video["hdr"] == true {
            unsupported!(
                "Known HDR video is not supported by Compatible MP4. Audio extraction is available when audio exists."
            );
        }
        if video["alpha"] == true {
            unsupported!(
                "Known alpha-bearing video is not supported by Compatible MP4; transparency would be lost."
            );
        }
        if video["orientationSupported"] == false {
            unsupported!("This display transform is not a supported standard rotation.");
        }
        if text(&video["codec"]).is_empty()
            || text(&video["pixelFormat"]).is_empty()
            || !integer(&video["streamIndex"])
        {
            incomplete!("Video codec, pixel format, or stream identity is incomplete.");
        }
        let copy = video["codec"] == "h264" && video["pixelFormat"] == "yuv420p";
        let rotation = count(&video["rotationDegrees"]);
        let transpose = !copy && [90., 270.].contains(&rotation);
        let (width, height) = if transpose {
            (count(&video["height"]), count(&video["width"]))
        } else {
            (count(&video["width"]), count(&video["height"]))
        };
        let aspect = if transpose && has(&video["sampleAspectRatio"]) {
            json!(
                text(&video["sampleAspectRatio"])
                    .split(':')
                    .rev()
                    .collect::<Vec<_>>()
                    .join(":")
            )
        } else {
            video["sampleAspectRatio"].clone()
        };
        merge(
            &mut p["output"],
            json!({"videoCodec":"h264","pixelFormat":"yuv420p","width":if copy {width}else{(width/2.).ceil()*2.},
            "height":if copy {height}else{(height/2.).ceil()*2.},"rotationDegrees":if copy {rotation}else{0.},"sampleAspectRatio":aspect}),
        );
        let mut stream = json!({"role":"video","index":video["streamIndex"],"action":if copy {"copy"}else{"encode"},"codec":video["codec"]});
        if !copy {
            merge(
                &mut stream,
                json!({"encoder":"libx264","crf":18,"preset":"medium","pixelFormat":"yuv420p"}),
            );
        }
        push(&mut p["streams"], stream);
        push(
            &mut p["changes"],
            json!(if copy {
                "Copy the selected video without re-encoding."
            } else {
                "Encode H.264 at CRF 18, medium, yuv420p; preserve source cadence and display aspect."
            }),
        );
        if !copy && (width % 2. != 0. || height % 2. != 0.) {
            let message = format!(
                "Pad the coded image minimally to {} × {}; no source pixels are cropped.",
                count(&p["output"]["width"]),
                count(&p["output"]["height"])
            );
            push(&mut p["changes"], json!(message));
        }
        if !copy && rotation != 0. {
            push(
                &mut p["changes"],
                json!(format!("Apply the {rotation}° display rotation once.")),
            );
        }
    }
    if has(audio) {
        if text(&audio["codec"]).is_empty()
            || !integer(&audio["streamIndex"])
            || !positive(&audio["channels"])
            || !positive(&audio["sampleRate"])
        {
            incomplete!(
                "Audio codec, stream identity, channel count, or sample rate is incomplete."
            );
        }
        let channels = count(&audio["channels"]);
        if codec == "mp3" && ![1., 2.].contains(&channels) {
            unsupported!(
                "MP3 supports suitable mono/stereo audio here. Multichannel audio will not be downmixed."
            );
        }
        let timestamped =
            codec == "mp3" && audio["codec"] == "mp3" && source["container"]["kind"] != "mp3";
        let copy = audio["codec"] == codec && !timestamped;
        if timestamped {
            push(
                &mut p["changes"],
                json!(
                    "MP3 cannot carry container timestamp gaps. Re-encode the selected audio to preserve its timeline, filling gaps with silence."
                ),
            );
        }
        let mut stream = json!({"role":"audio","index":audio["streamIndex"],"action":if copy {"copy"}else{"encode"},"codec":audio["codec"]});
        let mut rate = count(&audio["sampleRate"]);
        if !copy {
            let layout = audio["channelLayout"]
                .as_str()
                .filter(|v| !v.is_empty())
                .or(match channels {
                    1. => Some("mono"),
                    2. => Some("stereo"),
                    _ => None,
                });
            let Some(layout) = layout else {
                incomplete!("The channel layout is required before encoding audio.");
            };
            let expected = match layout {
                "mono" => 1.,
                "stereo" => 2.,
                "5.1" | "5.1(side)" => 6.,
                _ => 0.,
            };
            if channels != expected {
                unsupported!(
                    "This audio layout cannot be encoded without an unsupported channel change. Suitable AAC can still be copied."
                );
            }
            if text(&audio["channelLayout"]).is_empty() {
                push(
                    &mut p["changes"],
                    json!(format!(
                        "Use {layout} output for the reported {channels}-channel audio; the source does not name its layout."
                    )),
                );
            }
            if ![44100., 48000.].contains(&rate) {
                rate = 48000.;
            }
            merge(
                &mut stream,
                json!({"encoder":if codec=="aac" {"aac"}else{"libmp3lame"},"sampleRate":rate,"channels":channels,"channelLayout":layout}),
            );
            if codec == "aac" {
                stream["bitRate"] = json!(match channels {
                    1. => 128000,
                    2. => 256000,
                    _ => 512000,
                });
            } else {
                stream["quality"] = json!(0);
            }
            if rate != count(&audio["sampleRate"]) {
                push(
                    &mut p["changes"],
                    json!(format!(
                        "Resample audio from {} Hz to 48000 Hz.",
                        count(&audio["sampleRate"])
                    )),
                );
            }
        }
        merge(
            &mut p["output"],
            json!({"audioCodec":codec,"sampleRate":rate,"channels":channels,"channelLayout":if copy {&audio["channelLayout"]}else{&stream["channelLayout"]}}),
        );
        let message = if copy {
            "Copy the selected audio with its existing sample rate, channels, and bitrate.".into()
        } else {
            format!(
                "Encode {}; preserve {}.",
                if codec == "aac" {
                    format!("AAC at {} kbps", count(&stream["bitRate"]) / 1000.)
                } else {
                    "MP3 with libmp3lame quality 0".into()
                },
                text(&stream["channelLayout"])
            )
        };
        push(&mut p["streams"], stream);
        push(&mut p["changes"], json!(message));
    }
    let extra = &source["extraStreams"];
    if !has(extra) || !integer(&extra["total"]) || !has(&extra["chapters"]) {
        incomplete!("Stream and chapter inventory is incomplete.");
    }
    let omissions = [
        (
            "video",
            (count(&counts["video"]) - if has(video) { 1. } else { 0. }).max(0.),
        ),
        (
            "audio",
            (count(&counts["audio"]) - if has(audio) { 1. } else { 0. }).max(0.),
        ),
        ("subtitles", count(&counts["subtitle"])),
        ("artwork", count(&extra["artwork"])),
        ("other", count(&extra["other"])),
        ("chapters", count(&extra["chapters"])),
    ];
    if !with_video && positive(&counts["video"]) {
        push(
            &mut p["changes"],
            json!("Extract audio only; the video is omitted."),
        );
    }
    let warning = omissions
        .iter()
        .filter(|(role, n)| *n > 0. && !(*role == "video" && !with_video))
        .map(|(r, n)| format!("{n} {r}"))
        .collect::<Vec<_>>();
    if !warning.is_empty() {
        push(
            &mut p["warnings"],
            json!({"id":"omitted-content","required":true,"message":format!("Omit {}. Only the selected relevant streams are included.",warning.join(", "))}),
        );
    }
    p["omitted"] = Value::Object(
        omissions
            .into_iter()
            .map(|(k, v)| (k.into(), json!(v)))
            .collect(),
    );
    let all_copy = p["streams"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["action"] == "copy");
    let exact = count(&extra["total"]) == p["streams"].as_array().unwrap().len() as f64
        && count(&extra["chapters"]) == 0.;
    if with_video {
        merge(
            &mut p["timing"],
            json!({"durationSeconds":source["durationSeconds"],"videoStartSeconds":video["startSeconds"],"audioStartSeconds":audio["startSeconds"],"audioEndSeconds":end(audio),"videoEndSeconds":end(video)}),
        );
    } else {
        let duration = n(&audio["durationSeconds"]).or_else(|| {
            (counts["video"] == 0)
                .then(|| n(&source["durationSeconds"]))
                .flatten()
        });
        merge(
            &mut p["timing"],
            json!({"audioStartSeconds":0,"sourceAudioStartSeconds":audio["startSeconds"],"durationSeconds":duration,"audioEndSeconds":duration}),
        );
        push(
            &mut p["changes"],
            json!("Use a zero-based selected-audio timeline; do not append any video-only tail."),
        );
    }
    if !positive(&p["timing"]["durationSeconds"]) || !with_video && !has(&audio["startSeconds"]) {
        incomplete!(
            "Selected-stream timing is incomplete; the audio endpoint cannot be inferred from an unrelated video tail."
        );
    }
    if all_copy && exact && source["container"]["kind"] == container {
        return Ok(done(p, "no-op", None, "No conversion needed"));
    }
    if all_copy
        && (text(&source["container"]["kind"]).is_empty()
            || source["container"]["kind"] == "unknown")
    {
        incomplete!("Container identity is unknown.");
    }
    if !checked(caps) {
        return Ok(done(
            p,
            "unknown",
            Some("capability-check"),
            "Could not check local conversion capabilities. Retry after the capability-check cooldown.",
        ));
    }
    if !muxer(caps, container) {
        push(
            &mut p["missing"],
            json!(format!("{} muxer", container.to_uppercase())),
        );
    }
    let mut missing = Vec::new();
    for stream in p["streams"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .filter(|s| s["action"] == "encode")
    {
        stream["decoder"] = json!(decoder(caps, text(&stream["codec"])));
        if stream["decoder"].is_null() {
            missing.push(json!(format!(
                "selected {} software decoder",
                text(&stream["role"])
            )));
        }
        if !encoder(caps, text(&stream["encoder"])) {
            missing.push(json!(format!("{} encoder", text(&stream["encoder"]))));
        }
    }
    p["missing"].as_array_mut().unwrap().extend(missing);
    if !p["missing"].as_array().unwrap().is_empty() {
        let message = format!(
            "Missing: {}.",
            p["missing"]
                .as_array()
                .unwrap()
                .iter()
                .map(text)
                .collect::<Vec<_>>()
                .join(", ")
        );
        return Ok(done(p, "unavailable", Some("missing-capability"), &message));
    }
    Ok(done(
        p,
        "executable",
        None,
        if all_copy {
            "Remux selected streams without re-encoding"
        } else {
            "Convert the selected streams"
        },
    ))
}
fn done(mut p: Value, status: &str, reason: Option<&str>, message: &str) -> Value {
    p["status"] = json!(status);
    p["reason"] = json!(reason);
    p["message"] = json!(message);
    p["key"] = json!(hash(&p));
    p
}
