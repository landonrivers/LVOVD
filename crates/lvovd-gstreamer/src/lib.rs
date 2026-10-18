//! This library is loaded by WebKit's media process on Linux, not by JavaScript.
#[cfg(target_os = "linux")]
mod source;
