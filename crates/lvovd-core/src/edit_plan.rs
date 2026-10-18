//! Validate retained ranges before any worker may use them. Version 1 semantics.
use crate::{AppError, Result};
use serde::Serialize;
use serde_json::Value;

pub const MAX_KEEP_RANGES: usize = 50;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepRange {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPlan {
    version: u8,
    keep_ranges: Vec<KeepRange>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("LVOVD_EDIT_PLAN_INVALID", message)
}

// JavaScript Math.round resolves ties toward +infinity, including negative times.
pub fn round_milliseconds(value: f64) -> f64 {
    let scaled = value * 1000.;
    let floor = scaled.floor();
    let rounded = if scaled - floor >= 0.5 {
        floor + 1.
    } else {
        floor
    };
    rounded / 1000.
}

impl EditPlan {
    pub fn normalize(raw: &Value, duration_seconds: f64, reject_noop: bool) -> Result<Self> {
        let duration = round_milliseconds(duration_seconds);
        if !raw.is_object() {
            return Err(invalid("Edit plan must be an object."));
        }
        if raw["version"].as_f64() != Some(1.) {
            return Err(invalid("Edit plan version 1 is required."));
        }
        let ranges = raw["keepRanges"]
            .as_array()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| invalid("Edit plan must retain at least one range."))?;
        if ranges.len() > MAX_KEEP_RANGES {
            return Err(invalid(
                "Edit plan cannot contain more than 50 retained ranges.",
            ));
        }
        if !duration.is_finite() || duration <= 0. {
            return Err(invalid(
                "The inspected media duration must be a finite positive number.",
            ));
        }
        let mut normalized: Vec<KeepRange> = Vec::with_capacity(ranges.len());
        let mut previous_raw: Option<(f64, f64)> = None;
        for (index, range) in ranges.iter().enumerate() {
            let (Some(raw_start), Some(raw_end)) =
                (range["startSeconds"].as_f64(), range["endSeconds"].as_f64())
            else {
                return Err(invalid(format!(
                    "Retained range {} must contain numeric start and end times.",
                    index + 1
                )));
            };
            if !raw_start.is_finite() || !raw_end.is_finite() {
                return Err(invalid(format!(
                    "Retained range {} must contain finite start and end times.",
                    index + 1
                )));
            }
            let start = round_milliseconds(raw_start);
            let end = round_milliseconds(raw_end);
            if raw_start < 0. || raw_end > duration_seconds {
                return Err(invalid(format!(
                    "Retained range {} must stay within the inspected media duration.",
                    index + 1
                )));
            }
            if raw_start >= raw_end || start >= end {
                return Err(invalid(format!(
                    "Retained range {} end must be after its start.",
                    index + 1
                )));
            }
            if let Some((prev_start, prev_end)) = previous_raw {
                if raw_start < prev_start {
                    return Err(invalid(
                        "Retained ranges must be sorted in ascending chronological order.",
                    ));
                }
                if raw_start < prev_end {
                    return Err(invalid("Retained ranges must not overlap."));
                }
            }
            previous_raw = Some((raw_start, raw_end));
            if let Some(previous) = normalized.last_mut().filter(|v| start <= v.end_seconds) {
                previous.end_seconds = previous.end_seconds.max(end);
            } else {
                normalized.push(KeepRange {
                    start_seconds: start,
                    end_seconds: end,
                });
            }
        }
        let plan = Self {
            version: 1,
            keep_ranges: normalized,
        };
        if reject_noop && plan.is_full_duration(duration) {
            return Err(invalid(
                "Move an outer boundary or remove a section before creating an edited file.",
            ));
        }
        Ok(plan)
    }

    pub fn ranges(&self) -> &[KeepRange] {
        &self.keep_ranges
    }

    pub fn is_full_duration(&self, duration: f64) -> bool {
        self.keep_ranges.len() == 1
            && self.keep_ranges[0].start_seconds == 0.
            && self.keep_ranges[0].end_seconds == round_milliseconds(duration)
    }

    pub fn retained_duration(&self) -> f64 {
        round_milliseconds(self.keep_ranges.iter().fold(0., |sum, range| {
            sum + range.end_seconds - range.start_seconds
        }))
    }
}
