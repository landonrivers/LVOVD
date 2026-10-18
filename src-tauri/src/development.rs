//! Debug builds can run directly without a script supplying tool paths.
//! This module is excluded from release builds, which use bundled paths only.
use lvovd_core::{AppError, Result, tools::Tools};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

fn resolve(
    bundled: PathBuf,
    override_path: Option<&OsStr>,
    search_path: Option<&OsStr>,
    cached: Option<&Path>,
) -> Result<PathBuf> {
    if let Some(value) = override_path {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(AppError::new(
                "TOOL_PATH",
                "Development tool overrides require absolute paths.",
            ));
        }
        return Ok(path);
    }
    if bundled.is_file() {
        return Ok(bundled);
    }
    if let Some(path) = cached.filter(|path| path.is_absolute() && path.is_file()) {
        return Ok(path.to_owned());
    }
    if let (Some(search), Some(name)) = (search_path, bundled.file_name()) {
        // Ignore relative/empty PATH entries so a changed working directory cannot
        // select an executable from an imported-media folder.
        if let Some(path) = std::env::split_paths(search)
            .filter(|directory| directory.is_absolute())
            .map(|directory| directory.join(name))
            .find(|path| path.is_file())
        {
            return Ok(path);
        }
    }
    // Keep an explicit missing bundled path; health reports the unavailable tool.
    Ok(bundled)
}

pub fn tools(mut tools: Tools) -> Result<Tools> {
    let search = std::env::var_os("PATH");
    let cache_name = if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp_linux"
    };
    let cache = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../.lvovd-bin")
        .join(cache_name);
    for (key, destination, cached) in [
        ("FFPROBE", &mut tools.ffprobe, None),
        ("FFMPEG", &mut tools.ffmpeg, None),
        ("YTDLP", &mut tools.ytdlp, Some(cache.as_path())),
        ("NODE", &mut tools.node, None),
    ] {
        let override_path = std::env::var_os(format!("LVOVD_DESKTOP_{key}"));
        *destination = resolve(
            destination.clone(),
            override_path.as_deref(),
            search.as_deref(),
            cached,
        )?;
    }
    Ok(tools)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_launch_finds_tools_without_a_wrapper_or_working_directory_lookup() {
        let executable = std::env::current_exe().unwrap();
        let missing = executable
            .parent()
            .unwrap()
            .join("absent-tools")
            .join(executable.file_name().unwrap());
        let search =
            std::env::join_paths([Path::new("relative"), executable.parent().unwrap()]).unwrap();
        assert_eq!(
            resolve(missing.clone(), None, Some(&search), None).unwrap(),
            executable
        );
        assert_eq!(
            resolve(missing.clone(), None, Some(OsStr::new(".")), None).unwrap(),
            missing
        );
        assert_eq!(resolve(missing.clone(), None, None, None).unwrap(), missing);
    }

    #[test]
    fn explicit_overrides_and_bundled_tools_have_stable_precedence() {
        let executable = std::env::current_exe().unwrap();
        let missing = executable.with_extension("missing-tool");
        assert!(
            resolve(
                executable.clone(),
                Some(OsStr::new("relative-tool")),
                None,
                None
            )
            .is_err()
        );
        assert_eq!(
            resolve(executable.clone(), Some(missing.as_os_str()), None, None).unwrap(),
            missing
        );
        assert_eq!(
            resolve(executable.clone(), None, None, Some(&missing)).unwrap(),
            executable
        );
        assert_eq!(
            resolve(missing, None, None, Some(&executable)).unwrap(),
            executable
        );
    }
}
