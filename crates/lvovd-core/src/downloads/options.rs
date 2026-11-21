use super::{DownloadPreview, Profile};
use crate::{AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeSet, ffi::OsString};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Content {
    #[default]
    Av,
    Video,
    Audio,
    Extras,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AudioFormat {
    Source,
    #[default]
    M4a,
    Mp3,
    Opus,
    Flac,
    Wav,
}
impl AudioFormat {
    pub(super) fn encoding(self) -> Option<(&'static str, &'static str, &'static [&'static str])> {
        match self {
            Self::Source => None,
            Self::M4a => Some((
                "m4a",
                "aac",
                &["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"],
            )),
            Self::Mp3 => Some(("mp3", "mp3", &["-c:a", "libmp3lame", "-q:a", "0"])),
            Self::Opus => Some((
                "opus",
                "opus",
                &["-c:a", "libopus", "-b:a", "192k", "-vbr", "on"],
            )),
            Self::Flac => Some(("flac", "flac", &["-c:a", "flac"])),
            Self::Wav => Some(("wav", "pcm_s16le", &["-c:a", "pcm_s16le"])),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadOptions {
    pub content: Content,
    pub profile: Option<Profile>,
    pub max_height: Option<u32>,
    pub audio_format: AudioFormat,
    pub format_ids: Vec<String>,
    pub range: Range,
    pub thumbnail: bool,
    pub metadata: bool,
    pub subtitles: Option<Subtitles>,
    pub sponsor: Option<Sponsor>,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Range {
    #[default]
    Full,
    Custom {
        start: f64,
        end: f64,
    },
    Chapters {
        indexes: Vec<usize>,
    },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Subtitles {
    pub mode: SubtitleMode,
    pub languages: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubtitleMode {
    Manual,
    Auto,
    Both,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sponsor {
    pub mode: SponsorMode,
    pub categories: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SponsorMode {
    Mark,
    Remove,
}
const CATEGORIES: &[&str] = &[
    "sponsor",
    "intro",
    "outro",
    "selfpromo",
    "interaction",
    "preview",
    "filler",
    "music_offtopic",
    "hook",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Format {
    pub id: String,
    pub kind: &'static str,
    pub selectable: bool,
    pub ext: String,
    pub video: String,
    pub audio: String,
    pub height: Option<u32>,
    pub width: Option<u32>,
    pub note: String,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub fps: Option<f64>,
    pub kbps: Option<f64>,
    pub bytes: Option<u64>,
    pub approximate: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct Chapter {
    pub index: usize,
    pub title: String,
    pub start: f64,
    pub end: f64,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choices {
    pub av: bool,
    pub video: bool,
    pub audio: bool,
    pub available: bool,
    pub compatible_video: bool,
    pub formats: Vec<Format>,
    pub total_formats: usize,
    pub heights: BTreeSet<u32>,
    pub compatible_heights: BTreeSet<u32>,
    pub video_heights: BTreeSet<u32>,
    pub compatible_video_heights: BTreeSet<u32>,
    pub chapters: Vec<Chapter>,
    pub thumbnail: bool,
    pub manual_languages: Vec<String>,
    pub auto_languages: Vec<String>,
    pub sponsor: bool,
}
impl Format {
    pub(super) fn same_stream(&self, other: &Self) -> bool {
        self.id == other.id
            && self.kind == other.kind
            && self.video == other.video
            && self.audio == other.audio
            && self.ext == other.ext
            && self.height == other.height
            && self.fps == other.fps
    }
}
fn label(v: &Value) -> String {
    v.as_str()
        .map(str::trim)
        .filter(|s| {
            !s.to_ascii_lowercase().contains("http://")
                && !s.to_ascii_lowercase().contains("https://")
        })
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect()
}
fn languages(v: &Value) -> Vec<String> {
    v.as_object()
        .into_iter()
        .flatten()
        .map(|(k, _)| k)
        .filter(|k| {
            k.as_str() != "live_chat"
                && k.len() <= 80
                && !k.is_empty()
                && k.as_bytes()
                    .iter()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(c))
        })
        .take(500)
        .cloned()
        .collect()
}
impl Choices {
    pub(super) fn from_info(info: &Value, formats: &[Value]) -> Self {
        let mut result = Choices {
            thumbnail: info["thumbnail"].is_string()
                || info["thumbnails"].as_array().is_some_and(|a| !a.is_empty()),
            sponsor: ["extractor_key", "extractor"]
                .iter()
                .any(|key| label(&info[key]).to_ascii_lowercase().contains("youtube")),
            manual_languages: languages(&info["subtitles"]),
            auto_languages: languages(&info["automatic_captions"]),
            ..Self::default()
        };
        for (index, f) in formats
            .iter()
            .enumerate()
            .filter(|(_, f)| f.is_object() && f["has_drm"] != true)
        {
            let video = label(&f["vcodec"]).to_ascii_lowercase();
            let audio = label(&f["acodec"]).to_ascii_lowercase();
            let ext = label(&f["ext"]);
            if video == "images"
                || ext == "mhtml"
                || label(&f["format_note"])
                    .to_lowercase()
                    .contains("storyboard")
            {
                continue;
            }
            let known = |s: &str| !matches!(s, "none" | "" | "na");
            let positive = |key: &str| super::provider::number(&f[key]).filter(|n| *n > 0.);
            let integer = |key: &str| {
                positive(key)
                    .filter(|n| n.fract() == 0. && *n <= u32::MAX as f64)
                    .map(|n| n as u32)
            };
            let height = integer("height");
            let h264 = video.starts_with("avc1") || video.starts_with("h264");
            if let Some(h) = height.filter(|h| (144..=8640).contains(h)) {
                if video != "none" {
                    result.heights.insert(h);
                }
                if h264 {
                    result.compatible_heights.insert(h);
                }
                if audio == "none" && known(&video) {
                    result.video_heights.insert(h);
                    if h264 {
                        result.compatible_video_heights.insert(h);
                    }
                }
            }
            let note = label(&f["format_note"]);
            let description = format!("{note} {}", label(&f["resolution"])).to_lowercase();
            let unknown = |s: &str| matches!(s, "" | "na");
            let kind = match (known(&video), known(&audio)) {
                (true, true) => "combined",
                (true, false) if audio == "none" => {
                    result.video = true;
                    result.compatible_video |=
                        video.starts_with("avc1") || video.starts_with("h264");
                    "video"
                }
                (false, true) if video == "none" => {
                    result.audio = true;
                    "audio"
                }
                _ if description.contains("audio only") && unknown(&video) && audio != "none" => {
                    "audio"
                }
                _ if description.contains("video only") && unknown(&audio) && video != "none" => {
                    "video"
                }
                _ if known(&video) || known(&audio) || super::provider::visual_evidence(f) => {
                    "unknown"
                }
                _ => continue,
            };
            let id = label(&f["format_id"]);
            let selectable = id.len() == f["format_id"].as_str().map_or(0, str::len)
                && pattern!(r"^[A-Za-z0-9._-]{1,100}$").is_match(&id)
                && kind != "unknown";
            if !f["url"].is_string() && !f["manifest_url"].is_string() {
                continue;
            }
            result.formats.push(Format {
                id: if id.is_empty() {
                    format!("format-{}", index + 1)
                } else {
                    id
                },
                selectable,
                kind,
                ext,
                video,
                audio,
                height,
                width: integer("width"),
                note,
                channels: integer("audio_channels"),
                sample_rate: integer("asr"),
                fps: positive("fps"),
                kbps: f["tbr"]
                    .as_f64()
                    .or(f["abr"].as_f64())
                    .or(f["vbr"].as_f64()),
                bytes: f["filesize"].as_u64().or(f["filesize_approx"].as_u64()),
                approximate: !f["filesize"].is_number(),
            });
        }
        let mut counts = std::collections::HashMap::new();
        for f in &result.formats {
            *counts.entry(f.id.clone()).or_insert(0usize) += 1;
        }
        for f in &mut result.formats {
            f.selectable &= counts[&f.id] == 1;
        }
        result.formats.sort_by_key(|f| {
            (
                match f.kind {
                    "combined" => 0,
                    "video" => 1,
                    _ => 2,
                },
                std::cmp::Reverse(f.height),
                std::cmp::Reverse(f.fps.unwrap_or_default() as u32),
                std::cmp::Reverse(f.kbps.unwrap_or_default() as u32),
                f.id.clone(),
            )
        });
        result.total_formats = result.formats.len();
        result.formats.truncate(100);
        result.chapters = info["chapters"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, c)| {
                let start = c["start_time"].as_f64()?;
                let end = c["end_time"].as_f64()?;
                (end > start && start >= 0.).then(|| Chapter {
                    index,
                    title: c["title"]
                        .as_str()
                        .map(|s| s.chars().take(160).collect())
                        .unwrap_or_else(|| format!("Chapter {}", index + 1)),
                    start,
                    end,
                })
            })
            .collect();
        result
    }
}

fn invalid(message: &str) -> AppError {
    AppError::new("DOWNLOAD_OPTIONS", message)
}
#[derive(Clone, PartialEq)]
pub(super) struct Section {
    pub label: String,
    pub range: Option<(f64, f64)>,
}
#[derive(Clone)]
pub(super) struct Plan {
    pub options: DownloadOptions,
    pub profile: Profile,
    pub selector: Option<String>,
    pub sections: Vec<Section>,
    pub stem: String,
    pub selected: Vec<Format>,
}
impl DownloadOptions {
    pub(super) fn plan(self, preview: &DownloadPreview) -> Result<Plan> {
        let c = &preview.choices;
        let profile = self.profile.unwrap_or(preview.profile);
        if !c.available
            || !match self.content {
                Content::Av => c.av,
                Content::Video => c.video,
                Content::Audio => c.audio,
                Content::Extras => true,
            }
        {
            return Err(AppError::new(
                "DOWNLOAD_UNAVAILABLE",
                preview
                    .message
                    .as_deref()
                    .unwrap_or("Choose an available content mode."),
            ));
        }
        if self.max_height.is_some_and(|h| !(144..=8640).contains(&h)) {
            return Err(invalid("Choose a valid resolution cap."));
        }
        if self.format_ids.is_empty()
            && profile == Profile::Compatible
            && ((self.content == Content::Av && preview.profile != Profile::Compatible)
                || (self.content == Content::Video && !c.compatible_video))
        {
            return Err(invalid("Choose Maximum Quality for this source."));
        }
        if self.content == Content::Extras
            && (!self.thumbnail && !self.metadata && self.subtitles.is_none()
                || !matches!(self.range, Range::Full)
                || self.sponsor.is_some())
        {
            return Err(invalid(
                "Choose an extra and use full media for Extras Only.",
            ));
        }
        if self.thumbnail && !c.thumbnail {
            return Err(invalid("No thumbnail is available."));
        }
        if let Some(sub) = &self.subtitles
            && (sub.languages.is_empty()
                || sub.languages.len() > 80
                || sub.languages.chars().any(char::is_control)
                || match sub.mode {
                    SubtitleMode::Manual => c.manual_languages.is_empty(),
                    SubtitleMode::Auto => c.auto_languages.is_empty(),
                    SubtitleMode::Both => {
                        c.manual_languages.is_empty() && c.auto_languages.is_empty()
                    }
                })
        {
            return Err(invalid(
                "Choose an available caption mode and subtitle language.",
            ));
        }
        if let Some(s) = &self.sponsor
            && (!c.sponsor
                || s.categories.is_empty()
                || s.categories.len() > CATEGORIES.len()
                || s.categories
                    .iter()
                    .any(|k| !CATEGORIES.contains(&k.as_str())))
        {
            return Err(invalid(
                "Choose available SponsorBlock categories for this source.",
            ));
        }
        let selector = if self.format_ids.is_empty() {
            self.auto_selector(profile)
        } else {
            let expected: &[&str] = match (self.content, self.format_ids.len()) {
                (Content::Av, 1) => &["combined"],
                (Content::Av, 2) => &["video", "audio"],
                (Content::Video, 1) => &["video"],
                (Content::Audio, 1) => &["audio"],
                _ => return Err(invalid("Choose source formats from the current Preview.")),
            };
            for (id, kind) in self.format_ids.iter().zip(expected) {
                if !c
                    .formats
                    .iter()
                    .any(|f| f.selectable && f.id == *id && f.kind == *kind)
                {
                    return Err(invalid(
                        "The selected format is unavailable. Preview again.",
                    ));
                }
            }
            // Bare IDs such as "best", "all" and "mp4" have special meaning in yt-dlp.
            Some(
                self.format_ids
                    .iter()
                    .map(|id| format!("all[format_id='{id}']"))
                    .collect::<Vec<_>>()
                    .join("+"),
            )
        };
        let sections = match &self.range {
            Range::Full => vec![Section {
                label: String::new(),
                range: None,
            }],
            Range::Custom { start, end }
                if start.is_finite() && end.is_finite() && *start >= 0. && end > start =>
            {
                vec![Section {
                    label: String::new(),
                    range: Some((*start, *end)),
                }]
            }
            Range::Chapters { indexes }
                if !indexes.is_empty() && indexes.len() <= c.chapters.len() =>
            {
                let mut seen = BTreeSet::new();
                indexes
                    .iter()
                    .filter(|i| seen.insert(**i))
                    .map(|i| {
                        c.chapters
                            .iter()
                            .find(|x| x.index == *i)
                            .map(|x| Section {
                                label: format!(" - Chapter {}", x.index + 1),
                                range: Some((x.start, x.end)),
                            })
                            .ok_or_else(|| invalid("The chapter is unavailable. Preview again."))
                    })
                    .collect::<Result<_>>()?
            }
            _ => {
                return Err(invalid(
                    "Choose chapters or enter a valid start and end time.",
                ));
            }
        };
        let selected = self
            .format_ids
            .iter()
            .filter_map(|id| c.formats.iter().find(|f| f.id == *id))
            .cloned()
            .collect();
        Ok(Plan {
            selected,
            options: self,
            profile,
            selector,
            sections,
            stem: preview.filename.trim_end_matches(".mp4").to_owned(),
        })
    }
    pub(super) fn auto_selector(&self, profile: Profile) -> Option<String> {
        let h = self
            .max_height
            .map(|n| format!("[height<=?{n}]"))
            .unwrap_or_default();
        Some(match (self.content, profile) {
            (Content::Extras, _) => return None,
            (Content::Audio, _) => "bestaudio".into(),
            (Content::Video, Profile::Compatible) => {
                format!("bestvideo[vcodec^=avc1]{h}/bestvideo[vcodec^=h264]{h}")
            }
            (Content::Video, Profile::Maximum) => format!("bestvideo{h}"),
            (Content::Av, Profile::Maximum) => format!("bestvideo{h}+bestaudio/best{h}"),
            (Content::Av, Profile::Compatible) => format!(
                "bestvideo[vcodec^=avc1]{h}+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=h264]{h}+bestaudio[acodec^=aac]/best[vcodec^=avc1][acodec^=mp4a]{h}/best[vcodec^=h264][acodec^=aac]{h}"
            ),
        })
    }
}
impl Plan {
    pub(super) fn provider_args(&self, section: &Section) -> Vec<OsString> {
        let mut args: Vec<OsString> = Vec::new();
        let mut add = |flags: &[&str]| args.extend(flags.iter().map(OsString::from));
        if let Some(s) = &self.selector {
            add(&["--format", s]);
        } else {
            add(&["--skip-download"]);
        }
        match self.options.content {
            Content::Av => add(&["--merge-output-format", "mp4", "--remux-video", "mp4"]),
            Content::Video => add(&["--remux-video", "mp4"]),
            _ => {}
        }
        if let Some((start, end)) = section.range {
            let time = |v: f64| {
                let s = v as u64;
                format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
            };
            add(&[
                "--download-sections",
                &format!("*{}-{}", time(start), time(end)),
            ]);
        }
        if self.options.metadata {
            add(&["--write-info-json"])
        }
        if self.options.thumbnail {
            add(&["--write-thumbnail", "--convert-thumbnails", "jpg"])
        }
        if let Some(s) = &self.options.subtitles {
            if !matches!(s.mode, SubtitleMode::Auto) {
                add(&["--write-subs"])
            }
            if !matches!(s.mode, SubtitleMode::Manual) {
                add(&["--write-auto-subs"])
            }
            add(&[
                "--sub-langs",
                &s.languages,
                "--sub-format",
                "srt/best",
                "--convert-subs",
                "srt",
            ]);
        }
        if let Some(s) = &self.options.sponsor {
            add(&[
                match s.mode {
                    SponsorMode::Mark => "--sponsorblock-mark",
                    SponsorMode::Remove => "--sponsorblock-remove",
                },
                &s.categories.join(","),
            ]);
        }
        args
    }
}
