use crate::{
    Result,
    process::{self, CancellationToken},
};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone)]
pub struct Tools {
    pub ffprobe: PathBuf,
    pub ffmpeg: PathBuf,
    pub ytdlp: PathBuf,
    pub node: PathBuf,
}

#[derive(Serialize)]
pub struct ToolStatus {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub backend: &'static str,
    pub version: &'static str,
    pub ffmpeg: ToolStatus,
    pub ffprobe: ToolStatus,
    pub ytdlp: ToolStatus,
    pub provider_runtime: ToolStatus,
}

impl Tools {
    pub fn bundled(directory: &Path) -> Self {
        let binary = |name: &str| directory.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        Self {
            ffmpeg: binary("ffmpeg"),
            ffprobe: binary("ffprobe"),
            ytdlp: binary("yt-dlp"),
            node: binary("node"),
        }
    }

    pub async fn health(&self, cancel: &CancellationToken) -> Health {
        let (ffmpeg, ffprobe, ytdlp, provider_runtime) = tokio::join!(
            probe(&self.ffmpeg, "-version", cancel),
            probe(&self.ffprobe, "-version", cancel),
            probe(&self.ytdlp, "--version", cancel),
            probe(&self.node, "--version", cancel)
        );
        Health {
            backend: "rust",
            version: env!("CARGO_PKG_VERSION"),
            ffmpeg,
            ffprobe,
            ytdlp,
            provider_runtime,
        }
    }
}

async fn probe(path: &Path, argument: &str, cancel: &CancellationToken) -> ToolStatus {
    let result: Result<_> = process::run(
        path,
        &[argument.into()],
        Duration::from_secs(3),
        16 * 1024,
        cancel,
    )
    .await;
    match result {
        Ok(output) => {
            let text = if output.stdout.is_empty() {
                &output.stderr
            } else {
                &output.stdout
            };
            let version: String = String::from_utf8_lossy(text)
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .filter(|c| !c.is_control())
                .take(240)
                .collect();
            if version.is_empty() {
                ToolStatus {
                    installed: false,
                    version: None,
                    error: Some("Tool returned no version.".into()),
                }
            } else {
                ToolStatus {
                    installed: true,
                    version: Some(version),
                    error: None,
                }
            }
        }
        Err(error) => ToolStatus {
            installed: false,
            version: None,
            error: Some(error.message),
        },
    }
}
