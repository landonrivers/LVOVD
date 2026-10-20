//! Review decisions only. File admission, execution and publication are separate.
use super::*;

pub fn plan(input: Input<'_>, caps: Option<&Capabilities>) -> Result<ReviewedPlan> {
    let settings = Settings::normalize(input.settings)?;
    processing_settings::number(
        Some(&json!(input.draft_revision)),
        0.,
        9_007_199_254_740_991.,
        "Draft revision",
        true,
    )?;
    let source = input
        .inspection
        .map(|s| serde_json::to_value(s).unwrap())
        .unwrap_or(json!({}));
    let timeline = audio_policy::editor_timeline(
        n(&source["durationSeconds"]),
        has(&source["video"]),
        Some(&audio(&source["audio"])),
    );
    let duration = if has(&source["video"]) {
        n(&source["durationSeconds"])
    } else {
        timeline.duration_seconds
    };
    let raw_edit = input.edit_plan.filter(|v| !v.is_null());
    let edit = if let Some(duration) = duration.filter(|d| *d > 0.) {
        if let Some(raw) = raw_edit {
            processing_settings::object(raw, &["version", "keepRanges"], "Edit plan")?;
            if let Some(ranges) = raw["keepRanges"].as_array() {
                for range in ranges {
                    processing_settings::object(
                        range,
                        &["startSeconds", "endSeconds"],
                        "Retained range",
                    )?;
                }
            }
        }
        let default = json!({"version":1,"keepRanges":[{"startSeconds":0,"endSeconds":round_milliseconds(duration)}]});
        Some(
            EditPlan::normalize(
                raw_edit.unwrap_or(&default),
                round_milliseconds(duration),
                false,
            )
            .map_err(|e| processing_settings::invalid(e.message))?,
        )
    } else {
        if raw_edit.is_some() {
            return Err(processing_settings::invalid(
                "A known source duration is required for cuts.",
            ));
        }
        None
    };
    let cuts = edit
        .as_ref()
        .is_some_and(|e| !e.is_full_duration(duration.unwrap()));
    let default = settings.video_codec == "unchanged"
        && settings.container == "source"
        && settings.scale.mode == "unchanged"
        && settings.frame_rate.is_none()
        && settings.rate.mode == "automatic"
        && settings.audio.codec == "unchanged"
        && settings.audio.bitrate_kbps.is_none()
        && !cuts;
    let mut p = json!({"version":1,"workspaceId":input.workspace_id,"sourceAssetId":input.source_asset_id,"inputAssetId":input.source_asset_id,
        "inputRole":"source","inputFilename":input.input_filename,"draftRevision":input.draft_revision,"inspectionKey":hash(&source),
        "inputDurationSeconds":duration,"settings":settings,"editPlan":edit,"cuts":cuts,"status":"unknown","reason":"incomplete","message":"More source metadata is needed.",
        "streams":[],"changes":[],"warnings":[],"missing":[],"output":{},"passes":1,"rateBudget":null,"options":options_value(&source,caps),
        "timing":{"audioOnly":false,"durationSeconds":edit.as_ref().map(EditPlan::retained_duration).or(duration)}});
    if let Some(origin) = source.get("timeOriginSeconds") {
        p["timing"]["originSeconds"] = origin.clone();
    }
    if input.source_asset_id.is_none_or(str::is_empty) || n(&source["timeOriginSeconds"]).is_none()
    {
        return Ok(finish(
            p,
            &source,
            "unknown",
            Some("incomplete"),
            "The source identity or presentation origin is incomplete.",
        ));
    }
    if default {
        let v = &source["video"];
        let a = &source["audio"];
        p["output"] = descriptor(text(&source["container"]["kind"]));
        p["output"]["container"] = source["container"]["kind"].clone();
        if has(v) {
            copy_fields(
                &mut p["output"],
                v,
                &[
                    "width",
                    "height",
                    "pixelFormat",
                    "sampleAspectRatio",
                    "frameRate",
                ],
            );
            p["output"]["videoCodec"] = v["codec"].clone();
        }
        p["output"]["rotationDegrees"] = json!(count(&v["rotationDegrees"]));
        if has(a) {
            copy_fields(
                &mut p["output"],
                a,
                &["sampleRate", "channels", "channelLayout"],
            );
            p["output"]["audioCodec"] = a["codec"].clone();
        }
        add_precision(&mut p["output"], a);
        for role in ["video", "audio"] {
            if has(&source[role]) {
                push(&mut p["streams"], copy_stream(role, &source[role]));
            }
        }
        p["timing"]["audioOnly"] = json!(!has(v));
        p["preserveSourceInventory"] = json!(true);
        push(
            &mut p["changes"],
            json!("Keep all original bytes, streams, chapters, and metadata."),
        );
        return Ok(finish(
            p,
            &source,
            "no-op",
            None,
            "No processing needed; download the original file.",
        ));
    }
    let Some(edit) = edit else {
        return Ok(finish(
            p,
            &source,
            "unknown",
            Some("incomplete"),
            "A known positive source duration is required for processing.",
        ));
    };
    let audio_only = ["m4a", "mp3", "opus", "flac", "wav"].contains(&settings.container.as_str())
        || !has(&source["video"]) && settings.container == "source";
    p["timing"]["audioOnly"] = json!(audio_only);
    let outcome = if audio_only {
        audio_plan(&mut p, &source, &settings, &edit, cuts, caps, &input)
    } else {
        video_plan(&mut p, &source, &settings, &edit, cuts)
    };
    if let Some((status, reason, message)) = outcome? {
        return Ok(finish(p, &source, status, reason, &message));
    }
    if !checked(caps) {
        return Ok(finish(
            p,
            &source,
            "unknown",
            Some("capability-check"),
            "Could not check local processing capabilities. Retry after the capability-check cooldown.",
        ));
    }
    let mut missing = Vec::new();
    if !muxer(caps, text(&p["output"]["container"])) {
        missing.push(json!(format!(
            "{} muxer",
            text(&p["output"]["container"]).to_uppercase()
        )));
    }
    if p["passes"] == 2 && !muxer(caps, "null") {
        missing.push(json!("null analysis muxer"));
    }
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
    if !missing.is_empty() {
        let message = format!(
            "Missing: {}.",
            missing.iter().map(text).collect::<Vec<_>>().join(", ")
        );
        p["missing"] = json!(missing);
        return Ok(finish(
            p,
            &source,
            "unavailable",
            Some("missing-capability"),
            &message,
        ));
    }
    let copy = p["streams"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["action"] == "copy");
    Ok(finish(
        p,
        &source,
        "executable",
        None,
        if copy {
            "Remux selected streams without re-encoding."
        } else {
            "Process the original source with the committed cuts and requested settings."
        },
    ))
}

type Outcome = Option<(&'static str, Option<&'static str>, String)>;
fn incomplete(message: impl Into<String>) -> Outcome {
    Some(("unknown", Some("incomplete"), message.into()))
}
fn unsupported(message: impl Into<String>) -> Outcome {
    Some(("unavailable", Some("unsupported"), message.into()))
}
fn noop() -> Outcome {
    Some((
        "no-op",
        None,
        "No processing needed; download the original file.".into(),
    ))
}
fn policy_error(error: audio_policy::AudioPolicyError) -> Outcome {
    if error.reason == "incomplete" {
        incomplete(error.error)
    } else {
        unsupported(error.error)
    }
}
fn copy_stream(role: &str, source: &Value) -> Value {
    json!({"role":role,"index":source["streamIndex"],"action":"copy","codec":source["codec"]})
}
fn add_precision(output: &mut Value, source: &Value) {
    let precision = serde_json::to_value(audio_policy::precision(&audio(source))).unwrap();
    if positive(&precision["bitDepth"]) {
        merge(output, precision);
    }
}
fn inventory_known(source: &Value) -> bool {
    integer(&source["extraStreams"]["total"]) && has(&source["extraStreams"]["chapters"])
}
fn omissions(p: &mut Value, source: &Value, audio_only: bool) {
    let counts = &source["trackCounts"];
    let extra = &source["extraStreams"];
    let omitted = [
        (
            "video",
            (count(&counts["video"]) - if audio_only { 0. } else { 1. }).max(0.),
        ),
        (
            "audio",
            (count(&counts["audio"]) - if has(&source["audio"]) { 1. } else { 0. }).max(0.),
        ),
        ("subtitles", count(&counts["subtitle"])),
        ("artwork", count(&extra["artwork"])),
        ("other", count(&extra["other"])),
        ("chapters", count(&extra["chapters"])),
    ];
    let warning = omitted
        .iter()
        .filter(|(role, n)| *n > 0. && !(*role == "video" && audio_only))
        .map(|(role, n)| format!("{n} {role}"))
        .collect::<Vec<_>>();
    p["omitted"] = Value::Object(
        omitted
            .into_iter()
            .map(|(k, v)| (k.into(), json!(v)))
            .collect(),
    );
    if !warning.is_empty() {
        push(
            &mut p["warnings"],
            json!({"id":"omitted-content","required":true,
        "message":format!("Omit {}. Only the selected {} included.",warning.join(", "),if audio_only {"audio is"}else{"relevant streams are"})}),
        );
    }
}

fn audio_plan(
    p: &mut Value,
    source: &Value,
    s: &Settings,
    edit: &EditPlan,
    cuts: bool,
    caps: Option<&Capabilities>,
    input: &Input<'_>,
) -> Result<Outcome> {
    if s.video_codec != "unchanged"
        || s.scale.mode != "unchanged"
        || s.frame_rate.is_some()
        || s.rate.mode != "automatic"
    {
        return Ok(unsupported(
            "Choose Automatic and unchanged video settings for audio-only output.",
        ));
    }
    let a = &source["audio"];
    if !has(a) {
        return Ok(unsupported("This source has no selected audio to convert."));
    }
    let container = if s.container == "source" {
        match text(&source["container"]["kind"]) {
            "mp4" => "m4a",
            "mp3" => "mp3",
            "flac" => "flac",
            "wav" => "wav",
            "ogg" if a["codec"] == "opus" => "opus",
            _ => {
                return Ok(unsupported(
                    "Keep source cannot encode this audio container. Choose an explicit audio output format.",
                ));
            }
        }
    } else {
        &s.container
    };
    let codec = match container {
        "m4a" => "aac",
        "mp3" => "mp3",
        "opus" => "opus",
        "flac" => "flac",
        "wav" => "pcm",
        _ => return Ok(unsupported("Choose a supported audio output format.")),
    };
    if s.audio.codec != "unchanged" && s.audio.codec != codec {
        return Ok(unsupported(
            "The chosen audio codec does not match this audio container.",
        ));
    }
    if ["aac", "mp3"].contains(&codec) && !cuts && s.audio.bitrate_kbps.is_none() {
        let delegated = legacy::build(
            &ConversionInput {
                workspace_id: input.workspace_id,
                input_asset_id: input.source_asset_id,
                input_role: "source",
                input_filename: input.input_filename,
                edit_plan_key: None,
                inspection: input.inspection,
                target_id: if codec == "aac" { "m4a-aac" } else { "mp3" },
            },
            source,
            caps,
        )?;
        copy_fields(
            p,
            &delegated,
            &[
                "output", "streams", "timing", "changes", "warnings", "missing", "omitted",
            ],
        );
        let status = match text(&delegated["status"]) {
            "executable" => "executable",
            "no-op" => "no-op",
            "unavailable" => "unavailable",
            _ => "unknown",
        };
        let reason = match text(&delegated["reason"]) {
            "incomplete" => Some("incomplete"),
            "unsupported" => Some("unsupported"),
            "capability-check" => Some("capability-check"),
            "missing-capability" => Some("missing-capability"),
            _ => None,
        };
        return Ok(Some((status, reason, text(&delegated["message"]).into())));
    }
    let descriptor = descriptor(container);
    let pcm = regex::Regex::new(r"^pcm_(?:[su](?:8|16|24|32)|f(?:32|64))(?:le)?$").unwrap();
    let copy = !cuts
        && s.audio.bitrate_kbps.is_none()
        && source["container"]["kind"] == descriptor["muxer"]
        && (a["codec"] == codec || codec == "pcm" && pcm.is_match(text(&a["codec"])));
    let policy = if copy {
        json!({"stream":copy_stream("audio",a),"outputCodec":a["codec"]})
    } else {
        match encoded(a, codec, s.audio.bitrate_kbps) {
            Ok(p) => p,
            Err(e) => return Ok(policy_error(e)),
        }
    };
    let stream = &policy["stream"];
    let precision = if copy {
        serde_json::to_value(audio_policy::precision(&audio(a))).unwrap()
    } else {
        stream.clone()
    };
    p["streams"] = json!([stream]);
    p["output"] = descriptor.clone();
    merge(
        &mut p["output"],
        json!({"container":descriptor["muxer"],"audioCodec":policy["outputCodec"],"sampleRate":stream.get("sampleRate").unwrap_or(&a["sampleRate"]),
        "channels":a["channels"],"channelLayout":stream.get("channelLayout").unwrap_or(&a["channelLayout"])}),
    );
    copy_fields(
        &mut p["output"],
        &precision,
        &["bitDepth", "representation"],
    );
    let offset = if !has(&source["video"]) || !cuts {
        n(&a["startSeconds"])
    } else {
        Some(0.)
    };
    let duration = if cuts {
        Some(edit.retained_duration())
    } else {
        n(&a["durationSeconds"]).or_else(|| {
            (!has(&source["video"]))
                .then(|| n(&p["inputDurationSeconds"]))
                .flatten()
        })
    };
    if !duration.is_some_and(|d| d > 0.) || offset.is_none() {
        return Ok(incomplete(
            "Selected-stream timing is incomplete; the audio endpoint cannot be inferred from an unrelated video tail.",
        ));
    }
    p["timing"] = json!({"originSeconds":source["timeOriginSeconds"],"audioOnly":true,"sourceAudioStartSeconds":offset,"durationSeconds":duration,"audioStartSeconds":0,"audioEndSeconds":duration});
    if positive(&stream["sampleRate"]) && stream["sampleRate"] != a["sampleRate"] {
        push(
            &mut p["changes"],
            json!(format!(
                "Resample audio from {} Hz to {} Hz.",
                count(&a["sampleRate"]),
                count(&stream["sampleRate"])
            )),
        );
    }
    let message = if copy {
        "Copy the selected audio with its existing sample rate, channels, and precision.".into()
    } else {
        format!(
            "Encode {}{}; preserve {}{}.",
            codec.to_uppercase(),
            if positive(&stream["bitRate"]) && codec != "pcm" {
                format!(" at {} kbps", count(&stream["bitRate"]) / 1000.)
            } else {
                String::new()
            },
            text(&p["output"]["channelLayout"]),
            if positive(&p["output"]["bitDepth"]) {
                format!(
                    ", {}-bit {}",
                    count(&p["output"]["bitDepth"]),
                    text(&p["output"]["representation"])
                )
            } else {
                String::new()
            }
        )
    };
    push(&mut p["changes"], json!(message));
    if codec == "opus" && !copy {
        push(
            &mut p["changes"],
            json!("Opus is lossy; use 48 kHz playback with variable bitrate."),
        );
    }
    push(
        &mut p["changes"],
        json!(if cuts {
            format!(
                "Apply {} retained range(s) directly to original audio, retaining {} seconds including timestamped silence.",
                edit.ranges().len(),
                duration.unwrap()
            )
        } else {
            "Use a zero-based selected-audio timeline; do not append any video-only tail.".into()
        }),
    );
    if !inventory_known(source) {
        return Ok(incomplete("Stream and chapter inventory is incomplete."));
    }
    omissions(p, source, true);
    if copy
        && source["extraStreams"]["total"] == 1
        && count(&source["extraStreams"]["chapters"]) == 0.
    {
        return Ok(noop());
    }
    Ok(None)
}

fn mapped(time: &Value, edit: &EditPlan) -> Value {
    json!(n(time).map(|t| {
        round_milliseconds(
            edit.ranges()
                .iter()
                .map(|r| (t.min(r.end_seconds) - r.start_seconds).max(0.))
                .sum(),
        )
    }))
}
fn video_plan(
    p: &mut Value,
    source: &Value,
    s: &Settings,
    edit: &EditPlan,
    cuts: bool,
) -> Result<Outcome> {
    let v = &source["video"];
    let a = &source["audio"];
    if !has(v) || source["mediaKind"] != "video" {
        return Ok(incomplete("The selected timed video is incomplete."));
    }
    let container = if s.container == "source" {
        text(&source["container"]["kind"])
    } else {
        &s.container
    };
    if !["mp4", "mov", "matroska"].contains(&container) {
        return Ok(unsupported(
            "Keep source cannot encode this container. Choose MP4, MOV, or Matroska explicitly.",
        ));
    }
    if v["hdr"] == true {
        return Ok(unsupported(
            "Known HDR video is not supported for processed video. Audio-only conversion remains available.",
        ));
    }
    if v["alpha"] == true {
        return Ok(unsupported(
            "Known alpha-bearing video cannot be processed without losing transparency.",
        ));
    }
    if v["orientationSupported"] == false {
        return Ok(unsupported(
            "This display transform is not a supported standard rotation.",
        ));
    }
    if text(&v["codec"]).is_empty()
        || text(&v["pixelFormat"]).is_empty()
        || !integer(&v["streamIndex"])
        || !positive(&v["width"])
        || !positive(&v["height"])
    {
        return Ok(incomplete(
            "Video codec, pixel format, stream identity, or geometry is incomplete.",
        ));
    }
    if !has(&source["trackCounts"]["audio"]) || positive(&source["trackCounts"]["audio"]) && !has(a)
    {
        return Ok(incomplete("The selected audio inventory is incomplete."));
    }
    if s.frame_rate
        .is_some_and(|r| !positive(&v["frameRate"]) || r > count(&v["frameRate"]) + 0.000001)
    {
        return Ok(unsupported(
            "Choose a frame rate no higher than the known source frame rate.",
        ));
    }
    let encode = cuts
        || s.scale.mode != "unchanged"
        || s.frame_rate.is_some()
        || s.rate.mode != "automatic"
        || s.video_codec == "h264" && (v["codec"] != "h264" || v["pixelFormat"] != "yuv420p");
    let codec = if s.video_codec == "unchanged" {
        text(&v["codec"])
    } else {
        &s.video_codec
    };
    if encode && codec != "h264" {
        return Ok(unsupported(
            "These cuts or encoding changes require a supported encoder. Choose H.264 explicitly; the source codec will not be changed automatically.",
        ));
    }
    if !copy_codecs(container, "video").contains(&codec) {
        return Ok(unsupported(
            "This video codec cannot be copied to the selected container. Choose H.264 explicitly.",
        ));
    }
    let resolved = geometry(v, &s.scale, encode);
    p["output"] = descriptor(container);
    merge(&mut p["output"], resolved.clone());
    merge(
        &mut p["output"],
        json!({"container":container,"videoCodec":codec,"pixelFormat":if encode {json!("yuv420p")}else{v["pixelFormat"].clone()},"frameRate":s.frame_rate.or(n(&v["frameRate"]))}),
    );
    let mut stream = copy_stream("video", v);
    if encode {
        merge(
            &mut stream,
            json!({"action":"encode","encoder":"libx264","crf":s.rate.crf,"preset":s.rate.preset,"pixelFormat":"yuv420p"}),
        );
    }
    push(&mut p["streams"], stream);
    push(
        &mut p["changes"],
        json!(if encode {
            format!(
                "Encode H.264 with {}.",
                match s.rate.mode.as_str() {
                    "automatic" | "quality" => format!("CRF {}; final size varies", s.rate.crf),
                    "size" => "a maximum-size two-pass bitrate budget".into(),
                    _ => format!("{} kbps average video bitrate", s.rate.video_kbps.unwrap()),
                }
            )
        } else {
            "Copy the selected video without re-encoding.".into()
        }),
    );
    if s.scale.mode != "unchanged" {
        push(
            &mut p["changes"],
            json!(format!(
                "Scale to {} × {}, adjusted to fit display aspect{}; even encoder dimensions, no cropping.",
                count(&resolved["width"]),
                count(&resolved["height"]),
                if s.scale.allow_upscale {
                    ""
                } else {
                    " without upscaling"
                }
            )),
        );
    } else if encode && (count(&v["width"]) % 2. != 0. || count(&v["height"]) % 2. != 0.) {
        push(
            &mut p["changes"],
            json!(format!(
                "Pad coded dimensions minimally to {} × {}; no source pixels are cropped.",
                count(&resolved["width"]),
                count(&resolved["height"])
            )),
        );
    }
    if encode && count(&v["rotationDegrees"]) != 0. {
        push(
            &mut p["changes"],
            json!(format!(
                "Apply the {}° display rotation once.",
                count(&v["rotationDegrees"])
            )),
        );
    }
    if let Some(rate) = s.frame_rate {
        push(
            &mut p["changes"],
            json!(format!(
                "Reduce frame rate to {rate} fps without changing playback duration."
            )),
        );
    }
    if cuts {
        let message = format!(
            "Apply {} retained range(s) directly to the original source, keeping {} seconds.",
            edit.ranges().len(),
            count(&p["timing"]["durationSeconds"])
        );
        push(&mut p["changes"], json!(message));
    }
    let video_end = end(v);
    p["timing"]["videoStartSeconds"] = if cuts {
        mapped(&v["startSeconds"], edit)
    } else {
        v["startSeconds"].clone()
    };
    p["timing"]["videoEndSeconds"] = if cuts {
        mapped(&video_end, edit)
    } else {
        video_end.clone()
    };
    if cuts
        && n(&video_end).is_some_and(|end| {
            !edit
                .ranges()
                .iter()
                .any(|r| r.start_seconds < end && r.end_seconds > count(&v["startSeconds"]))
        })
    {
        return Ok(unsupported("The retained ranges contain no video frames."));
    }
    if has(a) {
        if text(&a["codec"]).is_empty()
            || !integer(&a["streamIndex"])
            || !positive(&a["channels"])
            || !positive(&a["sampleRate"])
        {
            return Ok(incomplete(
                "Audio codec, stream identity, channels, or sample rate is incomplete.",
            ));
        }
        let codec = if s.audio.codec == "unchanged" {
            text(&a["codec"])
        } else {
            &s.audio.codec
        };
        let encode = cuts || codec != text(&a["codec"]) || s.audio.bitrate_kbps.is_some();
        let encodable: &[&str] = if container == "matroska" {
            &["aac", "mp3", "opus", "flac"]
        } else {
            &["aac", "mp3"]
        };
        if encode && !encodable.contains(&codec) {
            return Ok(unsupported(
                "These cuts or audio changes require a compatible audio encoder. Choose AAC, MP3, or an MKV audio encoder explicitly.",
            ));
        }
        if !copy_codecs(container, "audio").contains(&codec) {
            return Ok(unsupported(
                "This audio codec is incompatible with the selected container. Choose a compatible codec explicitly; audio will not be removed.",
            ));
        }
        let stream = if encode {
            match encoded(a, codec, s.audio.bitrate_kbps) {
                Ok(policy) => policy["stream"].clone(),
                Err(e) => return Ok(policy_error(e)),
            }
        } else {
            copy_stream("audio", a)
        };
        if encode {
            if stream["sampleRate"] != a["sampleRate"] {
                push(
                    &mut p["changes"],
                    json!(format!(
                        "Resample audio from {} Hz to {} Hz.",
                        count(&a["sampleRate"]),
                        count(&stream["sampleRate"])
                    )),
                );
            }
            push(
                &mut p["changes"],
                json!(format!(
                    "Encode {}{}; preserve {}.",
                    codec.to_uppercase(),
                    if positive(&stream["bitRate"]) {
                        format!(" at {} kbps", count(&stream["bitRate"]) / 1000.)
                    } else if has(&stream["quality"]) {
                        format!(" at quality {}", count(&stream["quality"]))
                    } else {
                        String::new()
                    },
                    text(&stream["channelLayout"])
                )),
            );
        } else {
            push(
                &mut p["changes"],
                json!(
                    "Copy the selected audio with its existing bitrate, channels, and sample rate."
                ),
            );
        }
        merge(
            &mut p["output"],
            json!({"audioCodec":codec,"sampleRate":stream.get("sampleRate").unwrap_or(&a["sampleRate"]),"channels":a["channels"],"channelLayout":stream.get("channelLayout").unwrap_or(&a["channelLayout"])}),
        );
        if encode && positive(&stream["bitDepth"]) {
            copy_fields(&mut p["output"], &stream, &["bitDepth", "representation"]);
        }
        if !encode {
            add_precision(&mut p["output"], a);
        }
        push(&mut p["streams"], stream);
        p["timing"]["audioStartSeconds"] = if cuts {
            json!(0)
        } else {
            a["startSeconds"].clone()
        };
        p["timing"]["audioEndSeconds"] = if cuts {
            p["timing"]["durationSeconds"].clone()
        } else {
            end(a)
        };
    } else if s.audio.codec != "unchanged" || s.audio.bitrate_kbps.is_some() {
        return Ok(unsupported(
            "This source has no audio; choose unchanged audio settings.",
        ));
    }
    if !inventory_known(source) {
        return Ok(incomplete("Stream and chapter inventory is incomplete."));
    }
    omissions(p, source, false);
    let streams = p["streams"].as_array().unwrap();
    if streams.iter().all(|s| s["action"] == "copy")
        && source["container"]["kind"] == container
        && count(&source["extraStreams"]["total"]) == streams.len() as f64
        && count(&source["extraStreams"]["chapters"]) == 0.
    {
        return Ok(noop());
    }
    p["passes"] = json!(if s.rate.two_pass { 2 } else { 1 });
    Ok(rate_budget(p, source, s))
}
fn rate_budget(p: &mut Value, source: &Value, s: &Settings) -> Outcome {
    if !["bitrate", "size"].contains(&s.rate.mode.as_str()) {
        return None;
    }
    let duration = count(&p["timing"]["durationSeconds"]);
    let audio = &source["audio"];
    let stream = p["streams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["role"] == "audio");
    let audio_bits = stream.map_or(Some(0.), |s| {
        n(&s["bitRate"]).filter(|v| *v > 0.).or_else(|| {
            (s["action"] == "copy" && positive(&audio["bitRate"]))
                .then(|| (count(&audio["bitRate"]) * 1.15).ceil())
        })
    });
    if s.rate.mode == "size" && audio_bits.is_none() {
        return unsupported(
            "The unchanged audio cannot be budgeted honestly. Choose AAC with an explicit audio bitrate, or use an average video bitrate.",
        );
    }
    let maximum = s.rate.maximum_mb.map(|v| (v * 1e6).floor());
    let audio_bytes = audio_bits.map(|b| (b * duration / 8.).ceil());
    let packets = duration
        * (n(&p["output"]["frameRate"])
            .filter(|r| *r > 0.)
            .unwrap_or(60.)
            * 24.
            + if has(audio) { 800. } else { 0. });
    let overhead = (16384.
        + packets
        + maximum.unwrap_or(
            s.rate.video_kbps.unwrap_or(0.) * 1000. * duration / 8. + audio_bytes.unwrap_or(0.),
        ) * 0.03)
        .ceil();
    let video_bitrate = maximum.map_or_else(
        || (s.rate.video_kbps.unwrap() * 1000.).round(),
        |m| {
            ((m - overhead - audio_bytes.unwrap()) * 8. / duration)
                .floor()
                .min(1e9)
        },
    );
    p["rateBudget"] = json!({"maximumBytes":maximum,"overheadBytes":overhead,"audioBitsPerSecond":audio_bits,"audioBytes":audio_bytes,"videoBitrate":video_bitrate,"minimumVideoBitrate":16000,"estimatedBytes":audio_bytes.map(|a|(video_bitrate*duration/8.+a+overhead).ceil())});
    if maximum.is_some() && video_bitrate < 16000. {
        return unsupported(
            "This maximum file size cannot fit the retained duration, selected audio, and container reserve. Increase the size limit or explicitly change the audio bitrate or cuts.",
        );
    }
    None
}
