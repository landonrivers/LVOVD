use crate::{AppState, download_destination::Destination};
use lvovd_core::{
    AppError, Result,
    downloads::{DownloadPreview, DownloadSnapshot},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{State, ipc::Channel};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreviewRequest {
    url: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartRequest {
    preview_id: Uuid,
    destination_id: Uuid,
    #[serde(default)]
    options: lvovd_core::downloads::DownloadOptions,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditSourceRequest {
    workbench_id: Uuid,
    operation_id: Uuid,
    preview_id: Uuid,
    options: lvovd_core::downloads::EditorSourceOptions,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelEditSource {
    workbench_id: Uuid,
    operation_id: Uuid,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditSourceReply {
    source_id: Uuid,
    snapshot: lvovd_core::workbenches::Snapshot,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadJobRequest {
    job_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetrySave {
    job_id: Uuid,
    destination_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubscribeDownloads {
    generation: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadAck {
    connection_id: Uuid,
    revision: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadEnvelope {
    connection_id: Uuid,
    snapshot: DownloadSnapshot,
}

#[derive(Default)]
pub(crate) struct DownloadSubscription {
    pub(crate) generation: u32,
    current: Option<DownloadConnection>,
}
struct DownloadConnection {
    id: Uuid,
    channel: Channel<DownloadEnvelope>,
    sent: u64,
    awaiting_ack: bool,
}
impl DownloadSubscription {
    pub(crate) fn publish(&mut self, snapshot: DownloadSnapshot) {
        let Some(connection) = self.current.as_mut() else {
            return;
        };
        if connection.awaiting_ack {
            return;
        }
        if snapshot.revision <= connection.sent {
            return;
        }
        let revision = snapshot.revision;
        if connection
            .channel
            .send(DownloadEnvelope {
                connection_id: connection.id,
                snapshot,
            })
            .is_err()
        {
            self.current = None;
        } else {
            connection.sent = revision;
            connection.awaiting_ack = true;
        }
    }
}

#[tauri::command]
pub(crate) fn subscribe_downloads(
    state: State<'_, AppState>,
    request: SubscribeDownloads,
    channel: Channel<DownloadEnvelope>,
) -> Result<DownloadEnvelope> {
    let mut subscription = state.download_subscription.lock().unwrap();
    if request.generation <= subscription.generation {
        return Err(AppError::new(
            "CONNECTION_STALE",
            "The download connection was replaced.",
        ));
    }
    let snapshot = state.downloads.snapshot();
    let id = Uuid::new_v4();
    subscription.current = Some(DownloadConnection {
        id,
        channel,
        sent: snapshot.revision,
        awaiting_ack: true,
    });
    subscription.generation = request.generation;
    Ok(DownloadEnvelope {
        connection_id: id,
        snapshot,
    })
}

#[tauri::command]
pub(crate) fn acknowledge_downloads(
    state: State<'_, AppState>,
    request: DownloadAck,
) -> Result<()> {
    let mut subscription = state.download_subscription.lock().unwrap();
    let connection = subscription
        .current
        .as_mut()
        .filter(|c| c.id == request.connection_id && c.sent == request.revision)
        .ok_or_else(|| {
            AppError::new("CONNECTION_STALE", "The download connection was replaced.")
        })?;
    connection.awaiting_ack = false;
    subscription.publish(state.downloads.snapshot());
    Ok(())
}

#[tauri::command]
pub(crate) fn download_destination(state: State<'_, AppState>) -> Option<Destination> {
    state.destinations.selected()
}

#[tauri::command]
pub(crate) async fn choose_download_destination(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Destination>> {
    let _picker = state
        .picker_admission
        .try_lock()
        .map_err(|_| AppError::new("PICKER_BUSY", "Finish the current file dialog first."))?;
    #[cfg(feature = "test-driver")]
    let selected = std::env::var_os("LVOVD_DESKTOP_TEST_DOWNLOAD_FOLDER").map(PathBuf::from);
    #[cfg(not(feature = "test-driver"))]
    let selected: Option<PathBuf> = None;
    let folder = if selected.is_some() {
        selected
    } else {
        let (send, receive) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .set_title("Choose download folder")
            .pick_folder(move |path| {
                let _ = send.send(path);
            });
        let cancel = state.assets.cancellation();
        tokio::select! {
            _ = cancel.cancelled() => return Err(AppError::new("CLOSING", "The application is closing.")),
            value = receive => value.map_err(|_| AppError::new("DESTINATION_UNAVAILABLE", "The folder picker closed."))?
                .map(|p| p.into_path().map_err(|_| AppError::new("DESTINATION_UNAVAILABLE", "Choose a local folder."))).transpose()?
        }
    };
    let Some(folder) = folder else {
        return Ok(None);
    };
    let destinations = state.destinations.clone();
    tauri::async_runtime::spawn_blocking(move || destinations.remember(folder).map(Some))
        .await
        .map_err(|_| AppError::new("SETTINGS_WRITE", "Could not remember the download folder."))?
}

#[tauri::command]
pub(crate) async fn preview_download(
    state: State<'_, AppState>,
    request: PreviewRequest,
) -> Result<DownloadPreview> {
    state.downloads.preview(request.url).await
}

#[tauri::command]
pub(crate) async fn edit_download_source(
    state: State<'_, AppState>,
    request: EditSourceRequest,
) -> Result<EditSourceReply> {
    let acquisition = state
        .downloads
        .review_editor(request.preview_id, request.options)?;
    let result = state
        .workbenches
        .edit_download_source(
            request.workbench_id,
            request.operation_id,
            state.downloads.clone(),
            acquisition,
        )
        .await;
    state.publish();
    result.map(|(source_id, snapshot)| EditSourceReply {
        source_id,
        snapshot,
    })
}
#[tauri::command]
pub(crate) fn cancel_edit_download_source(
    state: State<'_, AppState>,
    request: CancelEditSource,
) -> Result<()> {
    state
        .workbenches
        .cancel_edit_download_source(request.workbench_id, request.operation_id)
}
#[tauri::command]
pub(crate) async fn start_download(
    state: State<'_, AppState>,
    request: StartRequest,
) -> Result<DownloadSnapshot> {
    let folder = state.destinations.capture(request.destination_id)?;
    let owner = state.downloads.clone();
    tauri::async_runtime::spawn_blocking(move || {
        owner.enqueue_options(request.preview_id, folder, request.options)
    })
    .await
    .map_err(|_| AppError::new("DOWNLOAD_START", "Could not add the download. Try again."))?
}
#[tauri::command]
pub(crate) async fn cancel_download(
    state: State<'_, AppState>,
    request: DownloadJobRequest,
) -> Result<DownloadSnapshot> {
    state.downloads.cancel(request.job_id)
}
#[tauri::command]
pub(crate) async fn retry_download_save(
    state: State<'_, AppState>,
    request: RetrySave,
) -> Result<DownloadSnapshot> {
    let folder = state.destinations.capture(request.destination_id)?;
    let owner = state.downloads.clone();
    tauri::async_runtime::spawn_blocking(move || owner.retry_save(request.job_id, folder))
        .await
        .map_err(|_| AppError::new("SAVE_FAILED", "Could not restart saving. Try again."))?
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportRequest {
    job_id: Uuid,
    #[serde(default)]
    index: usize,
}
#[tauri::command]
pub(crate) async fn open_download(
    state: State<'_, AppState>,
    request: ExportRequest,
) -> Result<()> {
    export_action(&state, request.job_id, request.index, false).await
}
#[tauri::command]
pub(crate) async fn reveal_download(
    state: State<'_, AppState>,
    request: ExportRequest,
) -> Result<()> {
    export_action(&state, request.job_id, request.index, true).await
}
async fn export_action(state: &AppState, job: Uuid, index: usize, reveal: bool) -> Result<()> {
    let owner = state.downloads.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::export_actions::show(&owner.exported_file(job, index)?, reveal)
    })
    .await
    .map_err(|_| AppError::new("EXPORT_OPEN", "Could not open the saved file."))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renderer_can_only_reference_reviewed_inputs_and_native_destinations() {
        let id = Uuid::new_v4();
        let value = serde_json::json!({"previewId":id, "destinationId":id});
        assert!(serde_json::from_value::<StartRequest>(value.clone()).is_ok());
        for field in ["path", "url", "filename", "args", "executable"] {
            let mut excess = value.clone();
            excess[field] = "/untrusted".into();
            assert!(serde_json::from_value::<StartRequest>(excess).is_err());
        }
        assert!(
            serde_json::from_value::<DownloadJobRequest>(
                serde_json::json!({"jobId":id,"path":"/untrusted"})
            )
            .is_err()
        );
        let editor = serde_json::json!({
            "workbenchId": id, "operationId": id, "previewId": id,
            "options": {"content":"av", "profile":"compatible", "maxHeight":null, "formatIds":[]}
        });
        serde_json::from_value::<EditSourceRequest>(editor.clone()).expect("reviewed editor input");
        for field in ["url", "path", "filename", "destinationId"] {
            let mut excess = editor.clone();
            excess[field] = "/untrusted".into();
            assert!(serde_json::from_value::<EditSourceRequest>(excess).is_err());
        }
        assert!(
            serde_json::from_value::<CancelEditSource>(serde_json::json!({"workbenchId":id}))
                .is_err()
        );
    }
}
