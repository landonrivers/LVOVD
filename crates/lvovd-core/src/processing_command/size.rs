//! Publication-size decisions. The operation owner must finish cleanup before
//! starting a requested correction, and retain previous results on every error.
use super::validation::Failure;
use super::*;

#[derive(Debug, PartialEq)]
pub enum SizeDecision {
    Accept,
    CorrectVideoBitrate(u64),
}
pub struct SizeControl {
    maximum: Option<f64>,
    fixed: f64,
    minimum: f64,
    bitrate: Option<f64>,
    corrected: bool,
}
impl SizeControl {
    pub fn new(review: &ReviewedPlan) -> Result<Self> {
        if !review.is_executable() {
            return Err(invalid(
                "An executable review is required for size validation.",
            ));
        }
        let budget = &review.document()["rateBudget"];
        Ok(Self {
            maximum: n(&budget["maximumBytes"]),
            fixed: n(&budget["audioBytes"]).unwrap_or(0.)
                + n(&budget["overheadBytes"]).unwrap_or(0.),
            minimum: n(&budget["minimumVideoBitrate"]).unwrap_or(16000.),
            bitrate: n(&budget["videoBitrate"]),
            corrected: false,
        })
    }
    pub fn assess(
        &mut self,
        metadata: &std::fs::Metadata,
        safety_limit: u64,
    ) -> std::result::Result<SizeDecision, ValidationFailure> {
        if !metadata.is_file()
            || metadata.len() == 0
            || safety_limit == 0
            || safety_limit > 100 * 1024 * 1024 * 1024
            || metadata.len() >= safety_limit
        {
            return Err(validation::failure(
                "output is missing, empty, or reached the workspace safety size limit",
                false,
            ));
        }
        let Some(maximum) = self.maximum.filter(|max| metadata.len() as f64 > *max) else {
            return Ok(SizeDecision::Accept);
        };
        let fail = || {
            ValidationFailure {message:"The chosen settings could not produce a complete file within the maximum size.".into(),failure:Failure {
            category:"local_processing_size",title:"The complete output could not meet the maximum size",
            explanation:"The completed file exceeded the requested maximum after the bounded size attempt. No oversized result was published; your previous result remains available.".into(),
            help:"Increase the maximum size or explicitly choose a smaller picture or audio bitrate, then review and process again.",
        }}
        };
        if self.corrected {
            return Err(fail());
        }
        let bitrate = self.bitrate.ok_or_else(fail)?;
        let next = (bitrate * 0.9)
            .min(
                bitrate * (maximum - self.fixed) / (metadata.len() as f64 - self.fixed).max(1.)
                    * 0.9,
            )
            .floor();
        if !next.is_finite() || next < self.minimum || next <= 0. {
            return Err(fail());
        }
        self.corrected = true;
        self.bitrate = Some(next);
        Ok(SizeDecision::CorrectVideoBitrate(next as u64))
    }
}
