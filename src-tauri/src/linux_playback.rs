//! Set up the decoder's private IPC and explicit plugin search before GTK starts
//! any threads. Media files stay in the Rust owner's separate session directory.
use std::{
    fs, io,
    os::unix::{fs::PermissionsExt, net::UnixListener},
};

pub struct Environment {
    _session: tempfile::TempDir,
    pub listener: UnixListener,
    pub token: [u8; 32],
}

impl Environment {
    /// Call once, from main, before constructing Tauri or starting any threads.
    pub fn prepare() -> io::Result<Self> {
        let binary = std::env::current_exe()?;
        let plugin = binary
            .parent()
            .ok_or_else(|| io::Error::other("Missing application directory"))?
            .join("gstreamer/libgstlvovd.so");
        let metadata = fs::symlink_metadata(&plugin).map_err(|_| {
            io::Error::other("Missing LVOVD playback helper. Rebuild using npm run build:desktop.")
        })?;
        if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
            return Err(io::Error::other("Invalid LVOVD playback helper"));
        }
        let session = tempfile::Builder::new()
            .prefix("lvovd-playback-")
            .tempdir()?;
        fs::set_permissions(session.path(), fs::Permissions::from_mode(0o700))?;
        let plugins = session.path().join("plugins");
        fs::create_dir(&plugins)?;
        fs::copy(plugin, plugins.join("libgstlvovd.so"))?;
        fs::set_permissions(
            plugins.join("libgstlvovd.so"),
            fs::Permissions::from_mode(0o400),
        )?;
        fs::set_permissions(&plugins, fs::Permissions::from_mode(0o700))?;
        let socket = session.path().join("media.sock");
        let listener = UnixListener::bind(&socket)?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
        let mut token = [0; 32];
        token[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        token[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        let secret: String = token.iter().map(|byte| format!("{byte:02x}")).collect();
        let registry = session.path().join("registry.bin");
        let keys: Vec<_> = std::env::vars_os()
            .filter(|(key, _)| key.to_string_lossy().starts_with("GST_"))
            .map(|(key, _)| key)
            .collect();
        // SAFETY: main calls this before Tauri/GTK/Tokio or any worker thread.
        // Keep plugin discovery independent of user-provided GStreamer settings.
        unsafe {
            for key in keys {
                if cfg!(debug_assertions) && key == "GST_DEBUG" {
                    continue;
                }
                std::env::remove_var(key);
            }
            std::env::set_var("GST_PLUGIN_PATH_1_0", &plugins);
            // WebKit 2.50 restricts media schemes before consulting GStreamer.
            // Extend its built-in list only with our authenticated source; do
            // not inherit an ambient list of additional protocols.
            std::env::set_var("WEBKIT_GST_ALLOWED_URI_PROTOCOLS", "lvovd-media");
            std::env::set_var(
                "GST_PLUGIN_SYSTEM_PATH_1_0",
                env!("LVOVD_SYSTEM_GST_PLUGINS"),
            );
            // WebKit's sandbox mounts the registry's parent. That private path
            // contains only IPC/registry/plugin data, never imported media.
            std::env::set_var("GST_REGISTRY", &registry);
            std::env::set_var("GST_REGISTRY_1_0", &registry);
            std::env::set_var("LVOVD_MEDIA_SOCKET", &socket);
            std::env::set_var("LVOVD_MEDIA_TOKEN", &secret);
        }
        Ok(Self {
            _session: session,
            listener,
            token,
        })
    }
}
