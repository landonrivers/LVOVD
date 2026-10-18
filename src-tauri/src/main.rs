#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(all(feature = "test-driver", not(debug_assertions)))]
compile_error!("The test driver is forbidden in release builds.");

use lvovd_core::{
    AppError, Result,
    assets::{Assets, Removal, Source},
    tools::Tools,
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Manager, State, ipc::Channel};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use uuid::Uuid;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    revision: u64,
    sources: Vec<Source>,
    cleanup: Vec<Uuid>,
}
struct Subscriptions {
    revision: u64,
    channel: Option<Channel<Snapshot>>,
}
struct AppState {
    assets: Arc<Assets>,
    tools: Tools,
    subscriptions: Mutex<Subscriptions>,
    closing: AtomicBool,
    media_slots: Arc<tokio::sync::Semaphore>,
    health_admission: tokio::sync::Mutex<()>,
    picker_admission: tokio::sync::Mutex<()>,
}
impl AppState {
    async fn shutdown(&self) -> Result<()> {
        self.assets.cancellation().cancel();
        // Health probes share cancellation with intake. Keep the host alive until
        // their process guards have reaped the tools as well.
        let _health = self.health_admission.lock().await;
        self.assets.shutdown().await
    }
    fn publish(&self) {
        let mut sub = self.subscriptions.lock().unwrap();
        sub.revision += 1;
        if let Some(channel) = &sub.channel {
            let _ = channel.send(Snapshot {
                revision: sub.revision,
                sources: self.assets.list(),
                cleanup: self.assets.pending_cleanup(),
            });
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Handshake {
    protocol_version: u32,
    app_version: &'static str,
    stage: &'static str,
    backend: &'static str,
    webview_version: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetRequest {
    asset_id: Uuid,
}

#[tauri::command]
fn desktop_handshake() -> Handshake {
    Handshake {
        protocol_version: lvovd_core::PROTOCOL_VERSION,
        app_version: env!("CARGO_PKG_VERSION"),
        stage: "8A: native intake and playback",
        backend: "rust",
        webview_version: tauri::webview_version().unwrap_or_else(|_| "Unknown".into()),
    }
}
#[tauri::command]
async fn runtime_health(state: State<'_, AppState>) -> Result<lvovd_core::tools::Health> {
    let _admission = state
        .health_admission
        .try_lock()
        .map_err(|_| AppError::new("HEALTH_BUSY", "A runtime check is already running."))?;
    Ok(state.tools.health(&state.assets.cancellation()).await)
}
#[tauri::command]
fn subscribe_sources(state: State<'_, AppState>, channel: Channel<Snapshot>) {
    state.subscriptions.lock().unwrap().channel = Some(channel);
    state.publish();
}
#[tauri::command]
async fn pick_source(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Option<Source>> {
    let _admission = state
        .picker_admission
        .try_lock()
        .map_err(|_| AppError::new("PICKER_BUSY", "Finish choosing the current file first."))?;
    let cancel = state.assets.cancellation();
    if cancel.is_cancelled() {
        return Err(AppError::new("CLOSING", "The application is closing."));
    }
    #[cfg(feature = "test-driver")]
    let selected = std::env::var_os("LVOVD_DESKTOP_TEST_FILE").map(PathBuf::from);
    #[cfg(not(feature = "test-driver"))]
    let selected: Option<PathBuf> = None;
    let selected = if selected.is_some() {
        selected
    } else {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .set_title("Choose local media")
            .pick_file(move |file| {
                let _ = sender.send(file);
            });
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(AppError::new("CLOSING", "The application is closing.")),
            result = receiver => result,
        }
            .map_err(|_| AppError::new("PICKER_CLOSED", "The file picker closed."))?
            .map(|file| {
                file.into_path()
                    .map_err(|_| AppError::new("PICKER_PATH", "Choose a local file."))
            })
            .transpose()?
    };
    match selected {
        Some(path) => {
            let result = state.assets.import(&path, &state.tools.ffprobe).await;
            state.publish();
            result.map(Some)
        }
        None => Ok(None),
    }
}
#[tauri::command]
async fn remove_source(state: State<'_, AppState>, request: AssetRequest) -> Result<Removal> {
    let result = state.assets.remove(request.asset_id);
    state.publish();
    result
}
#[tauri::command]
async fn shutdown_desktop(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<()> {
    state.shutdown().await?;
    app.exit(0);
    Ok(())
}

fn tools(app: &tauri::AppHandle) -> std::result::Result<Tools, Box<dyn std::error::Error>> {
    let mut tools = Tools::bundled(&app.path().resource_dir()?.join("tools"));
    #[cfg(debug_assertions)]
    for (key, destination) in [
        ("FFPROBE", &mut tools.ffprobe),
        ("FFMPEG", &mut tools.ffmpeg),
        ("YTDLP", &mut tools.ytdlp),
        ("NODE", &mut tools.node),
    ] {
        if let Some(path) = std::env::var_os(format!("LVOVD_DESKTOP_{key}")) {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err(
                    format!("Desktop development tool {key} requires an absolute path").into(),
                );
            }
            *destination = path;
        }
    }
    Ok(tools)
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    #[cfg(feature = "test-driver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .setup(|app| {
            let assets = Arc::new(Assets::new(&app.path().app_cache_dir()?.join("sessions"))?);
            app.manage(AppState {
                assets,
                tools: tools(app.handle())?,
                subscriptions: Mutex::new(Subscriptions {
                    revision: 0,
                    channel: None,
                }),
                closing: AtomicBool::new(false),
                media_slots: Arc::new(tokio::sync::Semaphore::new(4)),
                health_admission: tokio::sync::Mutex::new(()),
                picker_admission: tokio::sync::Mutex::new(()),
            });
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(|url| lvovd_core::media::trusted_navigation(url.as_str()))
                .build()?;
            if let Some(window) = app.get_webview_window("main")
                && let Ok(Some(monitor)) = window.current_monitor()
            {
                let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
                let _ = window.set_size(tauri::LogicalSize::new(
                    1280.0_f64.min(size.width),
                    800.0_f64.min(size.height - 60.0),
                ));
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("lvovd-media", |context, request, responder| {
            let state = context.app_handle().state::<AppState>();
            let assets = state.assets.clone();
            let permit = state.media_slots.clone().try_acquire_owned();
            let Ok(permit) = permit else {
                responder.respond(
                    tauri::http::Response::builder()
                        .status(429)
                        .body(Vec::<u8>::new())
                        .unwrap(),
                );
                return;
            };
            let label = context.webview_label().to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                let _permit = permit;
                #[cfg(feature = "test-driver")]
                let diagnostic = format!(
                    "{} range={:?} origin={:?}",
                    request.method(),
                    request.headers().get("range"),
                    request.headers().get("origin")
                );
                let response = lvovd_core::media::respond(&assets, request, &label);
                #[cfg(feature = "test-driver")]
                eprintln!(
                    "Media protocol: {diagnostic} -> {} bytes={} content-range={:?}",
                    response.status(),
                    response.body().len(),
                    response.headers().get("content-range")
                );
                responder.respond(response);
            });
        })
        .on_page_load(|webview, _| {
            if !webview
                .url()
                .is_ok_and(|url| lvovd_core::media::trusted_navigation(url.as_str()))
            {
                let _ = webview.close();
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let paths = paths.clone();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    for path in paths {
                        if let Err(error) = state.assets.import(&path, &state.tools.ffprobe).await {
                            app.dialog()
                                .message(error.message)
                                .title("Could not import media")
                                .show(|_| {});
                        }
                        state.publish();
                    }
                });
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let state = app.state::<AppState>();
                if state.closing.swap(true, Ordering::AcqRel) {
                    return;
                }
                let busy = state.assets.is_busy();
                tauri::async_runtime::spawn(async move {
                    let allow = if busy {
                        let (sender, receiver) = tokio::sync::oneshot::channel();
                        app.dialog()
                            .message("A file is still importing. Cancel it and quit?")
                            .title("Quit LVOVD")
                            .buttons(MessageDialogButtons::OkCancel)
                            .show(move |answer| {
                                let _ = sender.send(answer);
                            });
                        receiver.await.unwrap_or(false)
                    } else {
                        true
                    };
                    let state = app.state::<AppState>();
                    if allow {
                        match state.shutdown().await {
                            Ok(()) => app.exit(0),
                            Err(error) => app
                                .dialog()
                                .message(error.message)
                                .title("Cleanup pending")
                                .show(|_| {}),
                        }
                    }
                    state.closing.store(false, Ordering::Release);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_handshake,
            runtime_health,
            subscribe_sources,
            pick_source,
            remove_source,
            shutdown_desktop
        ])
        .run(tauri::generate_context!())
        .expect("LVOVD desktop could not start");
}
