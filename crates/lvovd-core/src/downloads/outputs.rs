use super::options::{Content, Plan, Section};
use crate::{
    AppError, Result, inspection,
    owned_file::Seal,
    process::{CancellationToken, Supervisor},
    tools::Tools,
};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tempfile::TempDir;

pub(super) struct PreparedFile {
    pub path: PathBuf,
    pub name: String,
    pub seal: Seal,
    pub suffix: String,
}
fn invalid() -> AppError {
    AppError::new(
        "DOWNLOAD_OUTPUT",
        "The provider did not produce the requested files or streams. Preview the source again.",
    )
}
impl Plan {
    pub(super) fn review_name(&self) -> String {
        let suffix = match self.options.content {
            Content::Av | Content::Video => ".mp4".into(),
            Content::Audio => self
                .options
                .audio_format
                .encoding()
                .map_or_else(String::new, |(ext, _, _)| format!(".{ext}")),
            Content::Extras if self.options.metadata => ".info.json".into(),
            Content::Extras if self.options.thumbnail => ".jpg".into(),
            Content::Extras => String::new(),
        };
        format!("{}{}{suffix}", self.stem, self.sections[0].label)
    }
}

pub(super) async fn collect(
    tools: &Tools,
    supervisor: &Supervisor,
    plan: &Plan,
    section: &Section,
    task: &Path,
    directory: Arc<TempDir>,
    cancel: &CancellationToken,
) -> Result<Vec<PreparedFile>> {
    let options = &plan.options;
    let stem = format!("{}{}", plan.stem, section.label);
    let mut files = Vec::new();
    let mut media = None;
    let mut entries = tokio::fs::read_dir(task).await.map_err(|_| invalid())?;
    while let Some(entry) = entries.next_entry().await.map_err(|_| invalid())? {
        let name = entry.file_name().into_string().map_err(|_| invalid())?;
        let suffix = name.strip_prefix("media.").ok_or_else(invalid)?;
        let path = entry.path();
        let seal = Seal::capture(&path)?;
        let companion = match suffix {
            "info.json" => options.metadata,
            "jpg" => options.thumbnail,
            lang if pattern!(r"^[A-Za-z0-9._-]{1,80}\.srt$").is_match(lang) => {
                options.subtitles.is_some()
            }
            _ => false,
        };
        if companion {
            if files.len() >= 512 || entry.metadata().await.map_err(|_| invalid())?.len() == 0 {
                return Err(invalid());
            }
            let prefix = bounded_stem(&stem, suffix);
            files.push(PreparedFile {
                path,
                name: format!("{prefix}.{suffix}"),
                suffix: suffix.to_owned(),
                seal,
            });
        } else {
            let accepted = match options.content {
                Content::Av | Content::Video => suffix == "mp4",
                Content::Audio => matches!(
                    suffix,
                    "m4a"
                        | "mp4"
                        | "webm"
                        | "mka"
                        | "mkv"
                        | "aac"
                        | "flac"
                        | "opus"
                        | "ogg"
                        | "oga"
                        | "wav"
                        | "mp3"
                        | "aiff"
                        | "alac"
                        | "ac3"
                        | "weba"
                        | "m4b"
                        | "ts"
                ),
                Content::Extras => false,
            };
            if !accepted || media.is_some() {
                return Err(invalid());
            }
            media = Some((path, suffix.to_owned(), seal));
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    if options.content == Content::Extras {
        return if files.is_empty() {
            Err(invalid())
        } else {
            Ok(files)
        };
    }
    let (mut path, mut ext, mut seal) = media.ok_or_else(invalid)?;
    let mut facts = inspection::inspect(&tools.ffprobe, &path, cancel)
        .await?
        .media
        .ok_or_else(invalid)?;
    match options.content {
        Content::Av | Content::Video => {
            if facts.container.kind != "mp4" || !plan.matches_video(&facts) {
                return Err(invalid());
            }
        }
        Content::Audio => {
            if facts.audio.is_none() || facts.video.is_some() {
                return Err(invalid());
            }
            if let Some((format, codec, flags)) = options.audio_format.encoding() {
                let converted = task.join(format!("converted.{format}"));
                let mut args: Vec<OsString> = [
                    "-nostdin",
                    "-n",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-i",
                ]
                .map(Into::into)
                .into();
                args.push(path.as_os_str().into());
                args.extend(["-map", "0:a:0", "-vn"].map(Into::into));
                args.extend(flags.iter().map(OsString::from));
                args.push(converted.as_os_str().into());
                seal.check(&path)?;
                supervisor
                    .run_owned(
                        &tools.ffmpeg,
                        &args,
                        Duration::from_secs(86400),
                        256 * 1024,
                        cancel,
                        directory,
                    )
                    .await?;
                path = converted;
                ext = format.into();
                seal = Seal::capture(&path)?;
                facts = inspection::inspect(&tools.ffprobe, &path, cancel)
                    .await?
                    .media
                    .ok_or_else(invalid)?;
                if facts.video.is_some()
                    || facts.audio.and_then(|a| a.codec).as_deref() != Some(codec)
                {
                    return Err(invalid());
                }
            }
        }
        Content::Extras => unreachable!(),
    }
    seal.check(&path)?;
    files.insert(
        0,
        PreparedFile {
            path,
            name: format!("{stem}.{ext}"),
            suffix: ext,
            seal,
        },
    );
    Ok(files)
}
fn bounded_stem<'a>(stem: &'a str, suffix: &str) -> &'a str {
    let mut length = (245 - suffix.len()).min(stem.len());
    while !stem.is_char_boundary(length) {
        length -= 1
    }
    &stem[..length]
}
