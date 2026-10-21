#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
#[cfg(all(feature = "test-driver", not(debug_assertions)))]
compile_error!("The test driver is forbidden in release builds.");

#[cfg(debug_assertions)]
mod development;
#[cfg(target_os = "linux")]
mod linux_playback;
mod workbench_commands;
use workbench_commands::*;

use lvovd_core::{
    AppError, Result,
    assets::Assets,
    processing_operation::{Limits, Processing},
    tools::Tools,
    workbenches::{Intake, Workbenches},
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
struct AppState {
    #[cfg(target_os = "linux")]
    playback: lvovd_core::playback::Broker,
    assets: Arc<Assets>,
    workbenches: Workbenches,
    tools: Tools,
    subscriptions: Mutex<Subscriptions>,
    closing: AtomicBool,
    media_admission: lvovd_core::media_admission::MediaAdmission,
    health_admission: tokio::sync::Mutex<()>,
    picker_admission: tokio::sync::Mutex<()>,
}
impl AppState {
    async fn shutdown(&self) -> Result<()> {
        self.assets.cancellation().cancel();
        self.media_admission.shutdown().await;
        lvovd_core::process::shutdown().await?;
        #[cfg(target_os = "linux")]
        self.playback.shutdown().await;
        // Health probes share cancellation with intake. Keep the host alive until
        // their process guards have reaped the tools as well.
        let _health = self.health_admission.lock().await;
        // Saving owns its result lease until its destination file is closed.
        let _picker = self.picker_admission.lock().await;
        self.workbenches.shutdown().await
    }
    fn publish(&self) {
        self.subscriptions
            .lock()
            .unwrap()
            .publish(&self.workbenches);
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
    connection_generation: u32,
}

#[tauri::command]
fn desktop_handshake(state: State<'_, AppState>) -> Handshake {
    Handshake {
        protocol_version: lvovd_core::PROTOCOL_VERSION,
        app_version: env!("CARGO_PKG_VERSION"),
        stage: "8C: workbench integration",
        backend: "rust",
        webview_version: tauri::webview_version().unwrap_or_else(|_| "Unknown".into()),
        connection_generation: state.subscriptions.lock().unwrap().generation(),
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
async fn pick_source(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: WorkbenchRequest,
) -> Result<Option<Intake>> {
    state.workbenches.touch(request.workbench_id)?;
    let _admission = state
        .picker_admission
        .try_lock()
        .map_err(|_| AppError::new("PICKER_BUSY", "Finish choosing the current file first."))?;
    let cancel = state.assets.cancellation();
    if cancel.is_cancelled() {
        return Err(AppError::new("CLOSING", "The application is closing."));
    }
    #[cfg(feature = "test-driver")]
    let selected =
        std::env::var_os("LVOVD_DESKTOP_TEST_FILE").map(|path| vec![PathBuf::from(path)]);
    #[cfg(not(feature = "test-driver"))]
    let selected: Option<Vec<PathBuf>> = None;
    let selected = if selected.is_some() {
        selected
    } else {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .set_title("Choose local media")
            .pick_files(move |file| {
                let _ = sender.send(file);
            });
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(AppError::new("CLOSING", "The application is closing.")),
            result = receiver => result,
        }
            .map_err(|_| AppError::new("PICKER_CLOSED", "The file picker closed."))?
            .map(|files| files.into_iter().map(|file| file.into_path()
                    .map_err(|_| AppError::new("PICKER_PATH", "Choose local files."))).collect::<Result<Vec<_>>>())
            .transpose()?
    };
    match selected {
        Some(paths) => {
            let result = state.workbenches.import(request.workbench_id, paths).await;
            state.publish();
            result.map(Some)
        }
        None => Ok(None),
    }
}
#[tauri::command]
async fn shutdown_desktop(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<()> {
    state.shutdown().await?;
    app.exit(0);
    Ok(())
}

fn tools(app: &tauri::AppHandle) -> std::result::Result<Tools, Box<dyn std::error::Error>> {
    let tools = Tools::bundled(&app.path().resource_dir()?.join("tools"));
    #[cfg(debug_assertions)]
    let tools = development::tools(tools)?;
    Ok(tools)
}

fn main() {
    #[cfg(target_os = "linux")]
    let playback_environment =
        linux_playback::Environment::prepare().expect("Could not prepare Linux playback");
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
        .setup(move |app| {
            let parent = app.path().app_cache_dir()?.join("sessions");
            let assets = Arc::new(Assets::new(&parent)?);
            let tools = tools(app.handle())?;
            let processing = Processing::new(
                (*assets).clone(),
                &parent,
                tools.ffmpeg.clone(),
                tools.ffprobe.clone(),
                Limits {
                    maximum_bytes: lvovd_core::assets::MAX_SOURCE_BYTES,
                    worker_deadline: std::time::Duration::from_secs(24 * 60 * 60),
                },
            )?;
            let workbenches = Workbenches::new(
                (*assets).clone(),
                processing,
                tools.ffmpeg.clone(),
                tools.ffprobe.clone(),
            );
            #[cfg(target_os = "linux")]
            let playback = {
                let handle = app.handle().clone();
                let listener = playback_environment.listener.try_clone()?;
                let broker = tauri::async_runtime::block_on(async {
                    lvovd_core::playback::Broker::start(
                        listener,
                        playback_environment.token,
                        Arc::new(workbenches.clone()),
                        Arc::new(move || {
                            if let Some(state) = handle.try_state::<AppState>() {
                                state.publish();
                            }
                        }),
                    )
                })?;
                app.manage(playback_environment);
                broker
            };
            app.manage(AppState {
                #[cfg(target_os = "linux")]
                playback,
                media_admission: lvovd_core::media_admission::MediaAdmission::new(
                    assets.cancellation(),
                ),
                assets,
                workbenches,
                tools,
                subscriptions: Mutex::new(Subscriptions::default()),
                closing: AtomicBool::new(false),
                health_admission: tokio::sync::Mutex::new(()),
                picker_admission: tokio::sync::Mutex::new(()),
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
                loop {
                    interval.tick().await;
                    let state = handle.state::<AppState>();
                    if state.assets.cancellation().is_cancelled() {
                        break;
                    }
                    state.workbenches.expire();
                    let _ = state.workbenches.reconcile().await;
                    state.publish();
                }
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
            let library = Arc::new(state.workbenches.clone());
            let ticket = state.media_admission.admit();
            let Ok(ticket) = ticket else {
                let error = ticket.err().unwrap();
                #[cfg(feature = "test-driver")]
                eprintln!("Media admission rejected: {}", error.code);
                responder.respond(
                    tauri::http::Response::builder()
                        .status(if error.code == "MEDIA_BUSY" { 429 } else { 503 })
                        .body(Vec::<u8>::new())
                        .unwrap(),
                );
                return;
            };
            let label = context.webview_label().to_owned();
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let active = match ticket.wait().await {
                    Ok(active) => active,
                    Err(error) => {
                        #[cfg(feature = "test-driver")]
                        eprintln!("Media admission stopped: {}", error.code);
                        let _ = error;
                        responder.respond(
                            tauri::http::Response::builder()
                                .status(503)
                                .body(Vec::<u8>::new())
                                .unwrap(),
                        );
                        return;
                    }
                };
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    let _active = active;
                    // Test builds can hold a distinctive range long enough to
                    // reproduce decoder contention during a second file selection.
                    #[cfg(feature = "test-driver")]
                    if request
                        .headers()
                        .get("range")
                        .is_some_and(|range| range == "bytes=128-255")
                        && std::env::var_os("LVOVD_DESKTOP_TEST_MEDIA_CONTENTION").is_some()
                    {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                    }
                    #[cfg(feature = "test-driver")]
                    let diagnostic = format!(
                        "{} range={:?} origin={:?}",
                        request.method(),
                        request.headers().get("range"),
                        request.headers().get("origin")
                    );
                    let response = lvovd_core::media::respond(&library, request, &label);
                    #[cfg(feature = "test-driver")]
                    eprintln!(
                        "Media protocol: {diagnostic} -> {} bytes={} content-range={:?}",
                        response.status(),
                        response.body().len(),
                        response.headers().get("content-range")
                    );
                    responder.respond(response);
                    // Removal can arrive while the bounded read holds a lease.
                    // respond has now released it, so finish eligible cleanup and
                    // publish the authoritative result without another user click.
                    if assets.retry_pending_cleanup() {
                        app.state::<AppState>().publish();
                    }
                })
                .await;
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
                let (workbench, generation) = {
                    let state = app.state::<AppState>();
                    let subscription = state.subscriptions.lock().unwrap();
                    (subscription.workbench(), subscription.generation())
                };
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    if let Some(id) = workbench {
                        // Admitted failures belong to the workbench snapshot,
                        // including after switching away and reopening it.
                        let error = state.workbenches.import(id, paths).await.err();
                        let still_selected = {
                            let subscription = state.subscriptions.lock().unwrap();
                            subscription.workbench() == Some(id)
                                && subscription.generation() == generation
                        };
                        if let Some(error) = error.filter(|_| still_selected) {
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
                let busy = state.workbenches.busy();
                tauri::async_runtime::spawn(async move {
                    let allow = if busy {
                        let (sender, receiver) = tokio::sync::oneshot::channel();
                        app.dialog()
                            .message("Media work is still running. Cancel it and quit?")
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
            cancel_intake,
            prepare_editor,
            save_result,
            save_results,
            prepare_waveform,
            cancel_editor,
            cancel_waveform,
            waveform_window,
            desktop_handshake,
            runtime_health,
            create_workbench,
            list_workbenches,
            subscribe_workbench,
            acknowledge_workbench,
            review_render,
            review_conversion,
            review_processing,
            queue_processing,
            cancel_processing,
            discard_workbench,
            cleanup_workbench,
            pick_source,
            remove_source,
            shutdown_desktop
        ])
        .run(tauri::generate_context!())
        .expect("LVOVD desktop could not start");
}
