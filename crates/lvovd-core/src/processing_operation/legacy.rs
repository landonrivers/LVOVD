//! Retained legacy targets use explicit source/edited identities, never proxies
//! or arbitrary conversion outputs. The same operation owner executes them.
use super::*;
use serde_json::json;

pub struct ConversionReview {
    pub source_id: Uuid,
    pub input_asset_id: Uuid,
    pub draft_revision: u32,
    pub target_id: String,
    pub edit_plan: Option<Value>,
}
impl Output {
    pub(super) fn path(&self) -> Result<&Path> {
        match &self.bytes {
            Bytes::Original(source) => source.processing_path(),
            Bytes::Retained(output) => output.path(),
            Bytes::Encoded { path, seal, .. } => {
                seal.check(path)?;
                Ok(path)
            }
        }
    }
}
impl Prepared {
    pub(super) fn input_path(&self) -> Result<&Path> {
        match &self.input {
            Some(input) => input.path(),
            None => self.source.processing_path(),
        }
    }
    pub(super) fn inspection(&self) -> Result<&MediaInspection> {
        match &self.input {
            Some(input) => Ok(&input.descriptor.inspection),
            None => self
                .source
                .source
                .inspection
                .media
                .as_ref()
                .ok_or_else(stale),
        }
    }
}
impl Processing {
    pub async fn review_render(
        &self,
        source_id: Uuid,
        revision: u32,
        edit_plan: Value,
        caps: Arc<Capabilities>,
    ) -> Result<ReviewedPlan> {
        let owner = self.clone();
        blocking(move || {
            let source = owner.0.assets.lease(source_id)?;
            let media = source.source.inspection.media.as_ref().ok_or_else(stale)?;
            if media.video.is_none() { return Err(AppError::new("RENDER_INPUT", "The legacy render requires a video source. Use audio processing for this file.")); }
            let mut settings = json!({"videoCodec":"h264","container":"mp4","filenameSuffix":" - edited",
                "rate":{"mode":"quality","crf":18,"preset":"medium"}});
            if media.audio.is_some() { settings["audio"] = json!({"codec":"aac","bitrateKbps":256}); }
            owner.review_sync(ReviewRequest { source_id, draft_revision:revision, settings:Some(settings), edit_plan:Some(edit_plan) },Some(&caps),"edited-output")
        }).await
    }
    pub async fn review_conversion(
        &self,
        request: ConversionReview,
        caps: Arc<Capabilities>,
    ) -> Result<ReviewedPlan> {
        let owner = self.clone();
        blocking(move || owner.conversion_sync(request, &caps)).await
    }
    fn conversion_sync(
        &self,
        request: ConversionReview,
        caps: &Capabilities,
    ) -> Result<ReviewedPlan> {
        if request.draft_revision > i32::MAX as u32 || request.target_id.len() > 64 {
            return Err(stale());
        }
        let source = self.0.assets.lease(request.source_id)?;
        source.processing_path()?;
        let mut registry = self.0.registry.lock().unwrap();
        if registry.closing {
            return Err(cancelled());
        }
        let input = if request.input_asset_id == request.source_id {
            if request.edit_plan.is_some() {
                return Err(AppError::new(
                    "CONVERSION_INPUT",
                    "An original input does not take an edited-plan assertion.",
                ));
            }
            None
        } else {
            if registry
                .slots
                .get(&request.source_id)
                .is_some_and(|slot| slot.active.is_some())
            {
                return Err(AppError::new(
                    "PROCESSING_BUSY",
                    "The edited input is not ready or a workspace operation is running.",
                ));
            }
            let input = registry.slots.get(&request.source_id).and_then(|slot|slot.edited.as_ref())
                .filter(|output| output.descriptor.result_id == request.input_asset_id).ok_or_else(|| AppError::new("CONVERSION_INPUT", "Choose the original or its current edited result; previews and converted files are not conversion inputs."))?;
            input.path()?;
            let original = source.source.inspection.media.as_ref().ok_or_else(stale)?;
            let duration = original.duration_seconds.ok_or_else(stale)?;
            let edit = crate::edit_plan::EditPlan::normalize(
                request.edit_plan.as_ref().ok_or_else(stale)?,
                duration,
                false,
            )?;
            if serde_json::to_value(edit).map_err(|_| stale())?
                != input.descriptor.review["editPlan"]
            {
                return Err(stale());
            }
            Some(input.clone())
        };
        let (media, filename, role) = input.as_ref().map_or_else(
            || {
                (
                    source.source.inspection.media.as_ref(),
                    source.source.name.as_str(),
                    "source",
                )
            },
            |input| {
                (
                    Some(&input.descriptor.inspection),
                    input.descriptor.filename.as_str(),
                    "edited-output",
                )
            },
        );
        let edit_key = input
            .as_ref()
            .map(|input| processing_plan::hash(&input.descriptor.review["editPlan"]));
        let plan = processing_plan::conversion(
            processing_plan::ConversionInput {
                workspace_id: Some(&self.0.id.to_string()),
                input_asset_id: Some(&request.input_asset_id.to_string()),
                input_role: role,
                input_filename: Some(filename),
                edit_plan_key: edit_key.as_deref(),
                inspection: media,
                target_id: &request.target_id,
            },
            Some(caps),
        )?;
        let extension = plan.document()["output"]["extension"]
            .as_str()
            .ok_or_else(stale)?;
        let stem = Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("media");
        let filename = format!("{stem} - converted.{extension}");
        let plan = plan.owned_metadata(
            json!({"downloadFilename":filename,"draftRevision":request.draft_revision}),
        );
        let intent = processing_plan::hash(
            &json!({"input":request.input_asset_id,"target":request.target_id,"edit":edit_key}),
        );
        self.0.assets.with_current(&source, || {
            let slot = registry.slots.entry(request.source_id).or_default();
            if slot.review.as_ref().is_some_and(|old| {
                request.draft_revision < old.revision
                    || request.draft_revision == old.revision && old.intent != intent
            }) {
                return Err(stale());
            }
            slot.review = Some(Review {
                plan: plan.clone(),
                intent,
                revision: request.draft_revision,
                input,
                role: "converted-output",
            });
            Ok(plan)
        })?
    }
}
