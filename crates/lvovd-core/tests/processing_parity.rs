use lvovd_core::{
    capabilities::{Capabilities, Decoder},
    media_inspection::MediaInspection,
    processing_command::{self, Attempt},
    processing_plan::{self, ConversionInput, Input, ReviewedPlan},
    processing_settings::Settings,
};
use serde_json::{Value, json};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/desktop-processing-v1.json"
    ))
    .unwrap()
}
fn caps(raw: &Value) -> Option<Capabilities> {
    if raw.is_null() {
        return None;
    }
    Some(Capabilities {
        available: raw["available"].as_bool().unwrap(),
        version: Some("fixture".into()),
        encoders: serde_json::from_value(raw["encoders"].clone()).unwrap(),
        decoders: serde_json::from_value(raw["decoders"].clone()).unwrap(),
        muxers: serde_json::from_value(raw["muxers"].clone()).unwrap(),
        decoder_codecs: raw["decoderCodecs"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(codec, ds)| {
                (
                    codec.clone(),
                    ds.as_array()
                        .unwrap()
                        .iter()
                        .map(|d| Decoder {
                            name: d["name"].as_str().unwrap().into(),
                            software: d["software"].as_bool().unwrap(),
                        })
                        .collect(),
                )
            })
            .collect(),
        failure_reason: None,
    })
}
fn string<'a>(value: &'a Value, field: &str, default: &'a str) -> Option<&'a str> {
    value.get(field).map_or(Some(default), Value::as_str)
}
fn review(input: &Value, data: &Value, conversion: bool) -> lvovd_core::Result<ReviewedPlan> {
    let source: Option<MediaInspection> = data["sources"]
        .get(input["source"].as_str().unwrap())
        .map(|s| serde_json::from_value(s.clone()).unwrap());
    let caps = caps(&data["capabilities"][input["capabilities"].as_str().unwrap_or("full")]);
    if conversion {
        processing_plan::conversion(
            ConversionInput {
                workspace_id: string(input, "workspaceId", "workbench"),
                input_asset_id: string(input, "inputAssetId", "source"),
                input_role: input["inputRole"].as_str().unwrap_or("source"),
                input_filename: string(input, "inputFilename", "Example.mp4"),
                edit_plan_key: input["editPlanKey"].as_str(),
                inspection: source.as_ref(),
                target_id: input["targetId"].as_str().unwrap(),
            },
            caps.as_ref(),
        )
    } else {
        processing_plan::plan(
            Input {
                workspace_id: string(input, "workspaceId", "workbench"),
                source_asset_id: string(input, "sourceAssetId", "source"),
                input_filename: string(input, "inputFilename", "Example.mp4"),
                draft_revision: input["draftRevision"].as_f64().unwrap_or(0.),
                inspection: source.as_ref(),
                settings: input.get("settings"),
                edit_plan: input.get("editPlan"),
            },
            caps.as_ref(),
        )
    }
}
fn evaluate(case: &Value, data: &Value) -> Value {
    let input = &case["input"];
    let result = match case["operation"].as_str().unwrap() {
        "settings" => {
            Settings::normalize(input.get("settings")).map(|s| serde_json::to_value(s).unwrap())
        }
        "filename" => Ok(json!(processing_plan::filename(
            input["name"].as_str(),
            input["extension"].as_str(),
            input["suffix"].as_str().unwrap()
        ))),
        "arguments" => {
            let review = review(input, data, input["kind"] == "conversion").unwrap();
            let inspection: MediaInspection =
                serde_json::from_value(data["sources"][input["source"].as_str().unwrap()].clone())
                    .unwrap();
            let root = std::env::current_dir()
                .unwrap()
                .join("synthetic workspace ü");
            let source = root.join("source.mp4");
            let output = root.join("result.partial");
            let log = root.join("pass");
            processing_command::arguments(
                &source,
                &output,
                &inspection,
                &review,
                Attempt {
                    pass: input["attempt"]["pass"].as_u64().map(|p| p as u8),
                    pass_log_prefix: Some(&log),
                    video_bitrate: input["attempt"]["videoBitrate"].as_u64(),
                    conversion_max_bytes: Some(100000000),
                },
            )
            .map(|args| {
                json!(
                    args.into_iter()
                        .map(|s| {
                            if s == source.as_os_str() {
                                "@INPUT@".into()
                            } else if s == output.as_os_str() {
                                "@OUTPUT@".into()
                            } else if s == log.as_os_str() {
                                "@PASSLOG@".into()
                            } else {
                                s.into_string().unwrap()
                            }
                        })
                        .collect::<Vec<String>>()
                )
            })
        }
        "validation" => {
            let review = review(input, data, input["kind"] == "conversion").unwrap();
            let output: MediaInspection = serde_json::from_value(input["output"].clone()).unwrap();
            return match processing_command::validate(&output, &review) {
                Ok(()) => json!({"value":true}),
                Err(e) => json!({"error":e}),
            };
        }
        operation => review(input, data, operation == "conversion").map(|review| {
            let mut value = review.document().clone();
            value.as_object_mut().unwrap().remove("key");
            value.as_object_mut().unwrap().remove("inspectionKey");
            value
        }),
    };
    match result {
        Ok(value) => json!({"value":value}),
        Err(e) => json!({"error":{"code":e.code,"message":e.message}}),
    }
}
fn differences(actual: &Value, expected: &Value, path: &str, out: &mut Vec<String>) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) if a.as_f64() == b.as_f64() => {}
        (Value::Object(a), Value::Object(b)) => {
            for k in a
                .keys()
                .chain(b.keys())
                .collect::<std::collections::BTreeSet<_>>()
            {
                match (a.get(k), b.get(k)) {
                    (Some(a), Some(b)) => differences(a, b, &format!("{path}.{k}"), out),
                    (a, b) => out.push(format!("{path}.{k}: {a:?} != {b:?}")),
                }
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                differences(a, b, &format!("{path}[{i}]"), out);
            }
        }
        (a, b) if a == b => {}
        (a, b) => out.push(format!("{path}: {a} != {b}")),
    }
}
#[test]
fn processing_and_conversion_match_released_reference() {
    let data = corpus();
    let mut failures = Vec::new();
    for case in data["cases"].as_array().unwrap() {
        differences(
            &evaluate(case, &data),
            &case["expected"],
            case["id"].as_str().unwrap(),
            &mut failures,
        );
    }
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn review_keys_bind_owned_settings_source_identity_revision_and_capabilities() {
    let mut data = corpus();
    let mut input = json!({"source":"base","settings":{"rate":{"mode":"quality","crf":20}}});
    let plan = review(&input, &data, false).unwrap();
    let original = plan.document().clone();
    assert!(plan.is_executable());
    assert_eq!(plan.key(), review(&input, &data, false).unwrap().key());
    input["settings"]["rate"]["crf"] = json!(21);
    assert_ne!(plan.key(), review(&input, &data, false).unwrap().key());
    assert_eq!(plan.document(), &original);
    input["settings"]["rate"]["crf"] = json!(20);
    for (field, value) in [
        ("sourceAssetId", json!("different")),
        ("workspaceId", json!("other-workbench")),
        ("draftRevision", json!(2)),
        ("inputFilename", json!("Different.mov")),
        ("capabilities", json!("empty")),
        (
            "editPlan",
            json!({"version":1,"keepRanges":[{"startSeconds":1,"endSeconds":2}]}),
        ),
    ] {
        let mut changed = input.clone();
        changed[field] = value;
        let other = review(&changed, &data, false).unwrap();
        assert_ne!(plan.key(), other.key(), "{field}");
        assert_eq!(
            plan.check_key(other.key()).unwrap_err().code,
            "PROCESSING_STALE"
        );
    }
    data["sources"]["base"]["video"]["frameRate"] = json!(25);
    assert_ne!(plan.key(), review(&input, &data, false).unwrap().key());
    plan.check_key(plan.key()).unwrap();
    let public = plan.public_document();
    assert_eq!(public["key"], plan.key());
    for stream in public["streams"].as_array().unwrap() {
        assert_eq!(stream.as_object().unwrap().len(), 3);
        assert!(stream.get("encoder").is_none());
    }
}

#[test]
fn inactive_controls_do_not_change_review_and_non_finite_revision_is_rejected() {
    let data = corpus();
    let input = json!({"source":"base","settings":{}});
    let first = review(&input, &data, false).unwrap();
    let mut inactive = input.clone();
    inactive["settings"] = json!({"scale":{"width":600,"allowUpscale":true},"rate":{"crf":10,"preset":"slow","videoKbps":300,"twoPass":true}});
    assert_eq!(first.key(), review(&inactive, &data, false).unwrap().key());
    for draft_revision in [
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        -1.,
        0.1,
        9_007_199_254_740_992.,
    ] {
        assert!(
            processing_plan::plan(
                Input {
                    workspace_id: None,
                    source_asset_id: Some("source"),
                    input_filename: None,
                    draft_revision,
                    inspection: None,
                    settings: None,
                    edit_plan: None
                },
                None
            )
            .is_err()
        );
    }
}

#[test]
fn argument_boundaries_and_size_correction_fail_closed() {
    use processing_command::{SizeControl, SizeDecision};
    let data = corpus();
    let input = json!({"source":"base","settings":{"rate":{"mode":"size","maximumMB":2}}});
    let review = review(&input, &data, false).unwrap();
    let mut inspection: MediaInspection =
        serde_json::from_value(data["sources"]["base"].clone()).unwrap();
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.mp4");
    let output = root.path().join("partial.mp4");
    let log = root.path().join("pass");
    let attempt = || Attempt {
        pass: Some(1),
        pass_log_prefix: Some(&log),
        ..Default::default()
    };
    for (i, o) in [
        (std::path::Path::new("relative.mp4"), output.as_path()),
        (source.as_path(), source.as_path()),
    ] {
        assert!(processing_command::arguments(i, o, &inspection, &review, attempt()).is_err());
    }
    assert!(
        processing_command::arguments(&source, &output, &inspection, &review, Attempt::default())
            .is_err()
    );
    assert!(
        processing_command::arguments(
            &source,
            &output,
            &inspection,
            &review,
            Attempt {
                video_bitrate: Some(1_000_000_001),
                ..attempt()
            }
        )
        .is_err()
    );
    inspection.video.as_mut().unwrap().frame_rate = Some(24.);
    assert!(
        processing_command::arguments(&source, &output, &inspection, &review, attempt()).is_err()
    );
    let file = std::fs::File::create(&output).unwrap();
    let mut sizes = SizeControl::new(&review).unwrap();
    assert!(sizes.assess(&file.metadata().unwrap(), 10_000_000).is_err());
    file.set_len(2_100_000).unwrap();
    let correction = sizes.assess(&file.metadata().unwrap(), 10_000_000).unwrap();
    let SizeDecision::CorrectVideoBitrate(bitrate) = correction else {
        panic!("oversized output needs one correction")
    };
    assert!(
        bitrate > 16000
            && (bitrate as f64)
                < review.document()["rateBudget"]["videoBitrate"]
                    .as_f64()
                    .unwrap()
    );
    assert_eq!(
        sizes
            .assess(&file.metadata().unwrap(), 10_000_000)
            .unwrap_err()
            .failure
            .category,
        "local_processing_size"
    );
    file.set_len(2_000_000).unwrap();
    assert_eq!(
        sizes.assess(&file.metadata().unwrap(), 10_000_000).unwrap(),
        SizeDecision::Accept
    );
    assert!(sizes.assess(&file.metadata().unwrap(), 2_000_000).is_err());
    assert!(
        sizes
            .assess(&std::fs::metadata(root.path()).unwrap(), 10_000_000)
            .is_err()
    );
}
