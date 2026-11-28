//! A reviewed provider source for one owned Local Media intake.
use super::{DownloadOptions, Downloads, Plan, Profile, options::Content, provider};
use crate::{
    AppError, Result, analysis,
    assets::MAX_SOURCE_BYTES,
    inspection::Inspection,
    owned_file::Seal,
    process::{CancellationToken, Request},
};
use serde::Deserialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use url::Url;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorSourceOptions {
    content: Content,
    profile: Profile,
    #[serde(deserialize_with = "Option::deserialize")]
    max_height: Option<u32>,
    format_ids: Vec<String>,
}

pub struct EditorAcquisition {
    pub(super) url: Url,
    pub(super) plan: Plan,
    title: String,
}

impl EditorAcquisition {
    /// Check the workbench's protected inspection before publishing an editable source.
    pub fn validate_source(&self, inspection: &Inspection) -> Result<()> {
        let media = inspection.media.as_ref().ok_or_else(invalid_source)?;
        if !analysis::eligible(media) || !self.plan.matches_video(media) {
            return Err(invalid_source());
        }
        Ok(())
    }
}

fn invalid_source() -> AppError {
    AppError::new(
        "EDITOR_SOURCE",
        "The source did not produce an editable video matching the reviewed selection. Preview again or choose another format.",
    )
}
pub(super) fn too_large() -> AppError {
    AppError::new(
        "SOURCE_LIMIT",
        "The source and its temporary streams exceed the available Local Media storage. Choose a smaller format or free space in Local Media.",
    )
}
fn staging_error() -> AppError {
    AppError::new(
        "ACQUISITION_STORAGE",
        "Could not read the temporary source files. Check available storage and try again.",
    )
}

impl Downloads {
    pub fn review_editor(
        &self,
        preview_id: Uuid,
        options: EditorSourceOptions,
    ) -> Result<EditorAcquisition> {
        let state = self.state.lock().unwrap();
        let reviewed = state.reviewed(preview_id)?;
        if !matches!(options.content, Content::Av | Content::Video) {
            return Err(AppError::new(
                "EDITOR_CONTENT",
                "Choose Video + Audio or Video Only to edit the source.",
            ));
        }
        let plan = DownloadOptions {
            content: options.content,
            profile: Some(options.profile),
            max_height: options.max_height,
            format_ids: options.format_ids,
            ..Default::default()
        }
        .plan(&reviewed.preview)?;
        Ok(EditorAcquisition {
            url: reviewed.url.clone(),
            plan,
            title: reviewed.preview.title.clone(),
        })
    }

    /// Called by the tracked workbench import while it owns the staging directory
    /// and its byte reservation. No Download row, destination or export is created.
    pub async fn acquire_editor(
        &self,
        acquisition: &EditorAcquisition,
        directory: &Path,
        maximum_bytes: u64,
        cancel: &CancellationToken,
    ) -> Result<(PathBuf, String)> {
        if !(1..=MAX_SOURCE_BYTES).contains(&maximum_bytes) {
            return Err(too_large());
        }
        let permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(super::cancelled()),
            _ = self.cancel.cancelled() => return Err(super::closed()),
            result = self.source.clone().acquire_owned() => Arc::new(result.map_err(|_| super::closed())?),
        };
        self.revalidate_selection(
            &acquisition.url,
            &acquisition.plan,
            cancel,
            self.root.path(),
            permit.clone(),
        )
        .await?;
        let args = provider::editor_args(&self.tools, acquisition, directory, maximum_bytes)?;
        let worker_cancel = cancel.child_token();
        let mut lines = provider::ProgressLines::editor(maximum_bytes);
        let worker = self.supervisor.run_provider_stream_owned(
            Request {
                executable: &self.tools.ytdlp,
                args: &args,
                deadline: Duration::from_secs(86400),
                diagnostic_limit: 256 * 1024,
                cancel: &worker_cancel,
            },
            self.root.path(),
            move |bytes| lines.feed(bytes, |_| {}),
            permit,
        );
        tokio::pin!(worker);
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                outcome = &mut worker => { outcome?; break; }
                _ = interval.tick() => {
                    let staging = directory.to_owned();
                    let scan = tokio::task::spawn_blocking(move || check_staged_bytes(&staging, maximum_bytes)).await;
                    if let Err(error) = scan.map_err(|_| staging_error()).and_then(|result| result) {
                        worker_cancel.cancel();
                        let _ = worker.await;
                        return Err(error);
                    }
                }
            }
        }
        if cancel.is_cancelled() {
            return Err(super::cancelled());
        }
        let staging = directory.to_owned();
        let title = acquisition.title.clone();
        tokio::task::spawn_blocking(move || collect_source(&staging, maximum_bytes, &title))
            .await
            .map_err(|_| staging_error())?
    }
}

/// yt-dlp's per-stream --max-filesize cannot count separate tracks alongside
/// a merge in progress. Bound all staging entries, including transient fragments.
fn check_staged_bytes(root: &Path, limit: u64) -> Result<()> {
    let mut dirs = vec![(root.to_owned(), 0)];
    let mut total = 0_u64;
    let mut entries = 0;
    while let Some((dir, depth)) = dirs.pop() {
        let children = match fs::read_dir(&dir) {
            Err(err) if depth > 0 && err.kind() == io::ErrorKind::NotFound => continue,
            result => result.map_err(|_| staging_error())?,
        };
        for entry in children {
            let path = entry.map_err(|_| staging_error())?.path();
            entries += 1;
            if entries > 1024 {
                return Err(staging_error());
            }
            let metadata = match fs::symlink_metadata(&path) {
                Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                result => result.map_err(|_| staging_error())?,
            };
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err(staging_error());
                }
            }
            if metadata.is_file() {
                total = total.checked_add(metadata.len()).ok_or_else(too_large)?;
                if total > limit {
                    return Err(too_large());
                }
            } else if metadata.is_dir() && depth < 4 {
                dirs.push((path, depth + 1));
            } else {
                return Err(staging_error());
            }
        }
    }
    Ok(())
}

fn collect_source(root: &Path, limit: u64, title: &str) -> Result<(PathBuf, String)> {
    check_staged_bytes(root, limit)?;
    let mut source = None;
    let mut remnants = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| staging_error())? {
        let entry = entry.map_err(|_| staging_error())?;
        let path = entry.path();
        // The provider template produces exactly "media.<extension>".
        // Fragments have additional suffixes and cannot become an original.
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if path.file_stem().and_then(|s| s.to_str()) == Some("media")
            && !ext.is_empty()
            && ext.len() <= 15
            && ext.bytes().all(|b| b.is_ascii_alphanumeric())
            && !matches!(ext, "part" | "temp" | "tmp" | "ytdl")
        {
            if source.is_some() || !entry.file_type().map_err(|_| staging_error())?.is_file() {
                return Err(invalid_source());
            }
            Seal::capture(&path)?;
            let safe = provider::filename_stem(title, None);
            let stem = safe
                .rsplit_once('.')
                .filter(|(_, suffix)| {
                    suffix.eq_ignore_ascii_case(ext)
                        || matches!(
                            suffix.to_ascii_lowercase().as_str(),
                            "mp4"
                                | "m4v"
                                | "mov"
                                | "mkv"
                                | "webm"
                                | "avi"
                                | "wmv"
                                | "flv"
                                | "mpeg"
                                | "mpg"
                                | "ts"
                                | "m2ts"
                                | "ogv"
                                | "3gp"
                                | "3g2"
                        )
                })
                .map_or(safe.as_str(), |(stem, _)| stem);
            source = Some((path.clone(), format!("{stem}.{ext}")));
        } else {
            remnants.push(entry);
        }
    }
    let source = source.ok_or_else(invalid_source)?;
    for entry in remnants {
        if entry.file_type().map_err(|_| staging_error())?.is_dir() {
            fs::remove_dir_all(entry.path())
        } else {
            fs::remove_file(entry.path())
        }
        .map_err(|_| staging_error())?;
    }
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_intake_accounts_for_merge_and_fragments_before_removing_leftovers() {
        let staging = tempfile::tempdir().unwrap();
        let root = staging.path();
        let source = root.join("media.mkv");
        fs::write(&source, [1; 8]).unwrap();
        fs::write(root.join("media.f123.m4a"), [2; 4]).unwrap();
        fs::create_dir(root.join("fragments")).unwrap();
        fs::write(root.join("fragments/frag.part"), [3; 4]).unwrap();
        assert_eq!(
            collect_source(root, 15, "Example.mp4.mp4")
                .unwrap_err()
                .code,
            "SOURCE_LIMIT"
        );
        assert!(root.join("fragments/frag.part").exists());
        fs::write(root.join("media.webm"), [4; 1]).unwrap();
        assert_eq!(
            collect_source(root, 32, "Example").unwrap_err().code,
            "EDITOR_SOURCE"
        );
        fs::remove_file(root.join("media.webm")).unwrap();
        let (path, filename) = collect_source(root, 16, "Example.mp4.mp4").unwrap();
        assert_eq!(path, source);
        assert_eq!(filename, "Example.mp4.mkv");
        assert_eq!(
            collect_source(root, 16, "Part 2.1").unwrap().1,
            "Part 2.1.mkv"
        );
        assert_eq!(fs::read_dir(root).unwrap().count(), 1);
        assert_eq!(fs::read(path).unwrap(), [1; 8]);
    }

    #[test]
    fn editor_byte_guard_detects_measured_and_declared_size_while_streaming() {
        for line in [
            "LVOVD|45|NA|NA|0|0\n",
            "LVOVD|1|48|NA|0|0\n",
            "LVOVD|2|NA|50|0|0\n",
        ] {
            assert_eq!(
                provider::ProgressLines::editor(40)
                    .feed(line.as_bytes(), |_| {})
                    .unwrap_err()
                    .code,
                "SOURCE_LIMIT"
            );
        }
        assert!(
            provider::ProgressLines::editor(40)
                .feed(b"LVOVD|40|40|NA|0|0\n", |_| {})
                .is_ok()
        );
    }
}
