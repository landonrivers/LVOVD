use lvovd_core::{
    audio_policy::{self, AudioSource},
    capabilities,
    edit_plan::EditPlan,
    media_inspection,
};
use serde_json::{Value, json};

// Both implementations read the same checked-in outputs. Node is only used to
// deliberately refresh the reference corpus; it is not called by Rust policy.
fn evaluate(case: &Value) -> Value {
    let input = &case["input"];
    match case["operation"].as_str().unwrap() {
        "inspection" => {
            json!({ "value": media_inspection::normalize(&serde_json::to_vec(&input["raw"]).unwrap(), input["sourceSize"].as_u64()).unwrap() })
        }
        "frame-rate" => json!({ "value": media_inspection::frame_rate(input) }),
        "capabilities" => {
            match capabilities::from_listings(
                input["version"].as_str().unwrap(),
                input["encoders"].as_str().unwrap(),
                input["decoders"].as_str().unwrap(),
                input["muxers"].as_str().unwrap(),
            ) {
                Ok(c) => {
                    let mut value = serde_json::to_value(&c).unwrap();
                    value["summary"] = c.public_summary();
                    value["software"] = Value::Object(
                        ["h264", "aac", "av1", "mp3", "hevc", "vp9", "unknown"]
                            .into_iter()
                            .map(|codec| (codec.into(), json!(c.software_decoder(codec).is_some())))
                            .collect(),
                    );
                    json!({ "value": value })
                }
                Err(e) => json!({ "error": { "code": e.code, "message": e.message } }),
            }
        }
        "precision" => {
            json!({ "value": audio_policy::precision(&serde_json::from_value(input.clone()).unwrap()) })
        }
        "audio" => {
            let source = serde_json::from_value(input["audio"].clone()).unwrap();
            let outcome = audio_policy::encoding_policy(
                &source,
                input["codec"].as_str().unwrap(),
                input["bitrateKbps"].as_f64(),
            );
            let value = match outcome {
                Ok(plan) => serde_json::to_value(plan).unwrap(),
                Err(error) => serde_json::to_value(error).unwrap(),
            };
            json!({ "value": value })
        }
        "timeline" => {
            let audio: Option<AudioSource> = input
                .get("audio")
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value(v.clone()).unwrap());
            json!({ "value": audio_policy::editor_timeline(input["durationSeconds"].as_f64(), input.get("video").is_some_and(|v| !v.is_null()), audio.as_ref()) })
        }
        "edit" => {
            let duration = input["durationSeconds"].as_f64().unwrap();
            match EditPlan::normalize(
                &input["plan"],
                duration,
                input["rejectNoop"].as_bool().unwrap_or(false),
            ) {
                Ok(plan) => {
                    json!({ "value": { "durationSeconds": plan.retained_duration(), "fullDuration": plan.is_full_duration(duration), "plan": plan } })
                }
                Err(error) => json!({ "error": { "code": error.code, "message": error.message } }),
            }
        }
        other => panic!("Unknown policy fixture: {other}"),
    }
}

fn equal(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| equal(a, b)))
        }
        _ => actual == expected,
    }
}

#[test]
fn policies_match_released_reference_fixtures() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/desktop-policy-v1.json"
    ))
    .unwrap();
    assert_eq!(fixtures["schemaVersion"], 1);
    let cases = fixtures["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let actual = evaluate(case);
        assert!(
            equal(&actual, &case["expected"]),
            "{}\nactual: {actual}\nreference: {}",
            case["id"],
            case["expected"]
        );
    }
}

#[test]
fn inspection_and_capabilities_match_released_reference() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/desktop-inspection-v1.json"
    ))
    .unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let actual = evaluate(case);
        assert!(
            equal(&actual, &case["expected"]),
            "{}\nactual: {actual}\nreference: {}",
            case["id"],
            case["expected"]
        );
    }
}

#[test]
fn native_numbers_cannot_bypass_finite_bounds() {
    let raw = json!({ "version": 1, "keepRanges": [{ "startSeconds": 0, "endSeconds": 1 }] });
    for duration in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, f64::MAX] {
        assert_eq!(
            EditPlan::normalize(&raw, duration, false).unwrap_err().code,
            "LVOVD_EDIT_PLAN_INVALID"
        );
    }
    let source: AudioSource = serde_json::from_value(
        json!({ "streamIndex": 0, "codec": "aac", "sampleRate": 48000, "channels": 2 }),
    )
    .unwrap();
    for bitrate in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(audio_policy::encoding_policy(&source, "opus", Some(bitrate)).is_err());
        assert!(audio_policy::encoding_policy(&source, "aac", Some(bitrate)).is_err());
    }
    assert!(audio_policy::encoding_policy(&source, "aac", Some(f64::MAX)).is_err());
}

#[test]
fn normalized_ranges_are_immutable_and_duration_is_consistent() {
    let mut raw = json!({ "version": 1, "keepRanges": [{ "startSeconds": 0.1, "endSeconds": 0.5 }, { "startSeconds": 1, "endSeconds": 1.5 }] });
    let plan = EditPlan::normalize(&raw, 2., false).unwrap();
    raw["keepRanges"][0]["startSeconds"] = json!(0.3);
    assert_eq!(plan.ranges()[0].start_seconds, 0.1);
    assert_eq!(plan.retained_duration(), 0.9);
    assert!(!plan.is_full_duration(2.));
}
