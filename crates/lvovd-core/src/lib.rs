//! Platform-independent application operations. Tauri is only a transport.
pub mod assets;
pub mod inspection;
pub mod media;
pub mod process;
pub mod tools;

use serde::Serialize;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleanup_asset_id: Option<uuid::Uuid>,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cleanup_asset_id: None,
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

pub type Result<T> = std::result::Result<T, AppError>;
#[cfg(unix)]
pub mod playback;
