use crate::AppState;
use lvovd_core::{
    AppError, Result,
    processing_operation::{Admission, ReviewRequest},
    workbenches::Snapshot,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{State, ipc::Channel};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkbenchRequest {
    pub workbench_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceRequest {
    pub workbench_id: Uuid,
    pub source_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisRequest {
    workbench_id: Uuid,
    source_id: Uuid,
    operation_id: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WaveformWindow {
    workbench_id: Uuid,
    source_id: Uuid,
    operation_id: Uuid,
    start_seconds: f64,
    end_seconds: f64,
    points: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResultRequest {
    workbench_id: Uuid,
    result_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResultsRequest {
    workbench_id: Uuid,
    result_ids: Vec<Uuid>,
}

#[tauri::command]
pub(crate) async fn save_results(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: ResultsRequest,
) -> Result<Option<Value>> {
    use tauri_plugin_dialog::DialogExt;
    if request.result_ids.is_empty() || request.result_ids.len() > 20 {
        return Err(AppError::new(
            "SAVE_REQUEST",
            "Choose between one and twenty prepared results.",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut results = Vec::new();
    for id in request.result_ids {
        if !seen.insert(id) {
            return Err(AppError::new(
                "SAVE_REQUEST",
                "A prepared result was selected twice.",
            ));
        }
        results.push(state.workbenches.result(request.workbench_id, id)?);
    }
    let _picker = state
        .picker_admission
        .try_lock()
        .map_err(|_| AppError::new("PICKER_BUSY", "Finish the current file dialog first."))?;
    #[cfg(feature = "test-driver")]
    let selected = std::env::var_os("LVOVD_DESKTOP_TEST_SAVE_FOLDER").map(std::path::PathBuf::from);
    #[cfg(not(feature = "test-driver"))]
    let selected: Option<std::path::PathBuf> = None;
    let selected = if selected.is_some() {
        selected
    } else {
        let (send, receive) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .set_title("Save all processed files")
            .pick_folder(move |path| {
                let _ = send.send(path);
            });
        let cancel = state.assets.cancellation();
        tokio::select! {
            _ = cancel.cancelled() => return Err(AppError::new("CLOSING", "The application is closing.")),
            value = receive => value.map_err(|_| AppError::new("SAVE_CANCELLED", "The save dialog closed."))?
                .map(|p| p.into_path().map_err(|_| AppError::new("SAVE_PATH", "Choose a local destination."))).transpose()?
        }
    };
    let Some(folder) = selected else {
        return Ok(None);
    };
    let receipts = tauri::async_runtime::spawn_blocking(move || results.into_iter().map(|result| {
        let name = result.descriptor().filename.clone();
        match lvovd_core::export::save_copy(result, &folder.join(&name)) {
            Ok(saved) => serde_json::json!({"filename": saved.file_name().map(|s| s.to_string_lossy().into_owned()), "saved":true}),
            Err(error) => serde_json::json!({"filename": name,"saved":false,"error":error.message})
        }
    }).collect::<Vec<_>>()).await.map_err(|_| AppError::new("SAVE_FAILED", "Saving ended unexpectedly. Prepared results remain available."))?;
    Ok(Some(serde_json::json!({"files":receipts})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Review {
    workbench_id: Uuid,
    source_id: Uuid,
    draft_revision: u32,
    settings: Option<Value>,
    edit_plan: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Batch {
    workbench_id: Uuid,
    entries: Vec<Admission>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Cancel {
    workbench_id: Uuid,
    job_id: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Subscribe {
    workbench_id: Uuid,
    generation: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Ack {
    connection_id: Uuid,
    revision: u64,
    queue_revision: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Envelope {
    connection_id: Uuid,
    snapshot: Option<Snapshot>,
}
struct Connection {
    id: Uuid,
    workbench: Uuid,
    channel: Channel<Envelope>,
    sent: (u64, u64),
    awaiting_ack: bool,
}
#[derive(Default)]
pub(crate) struct Subscriptions {
    generation: u32,
    current: Option<Connection>,
}
impl Subscriptions {
    pub fn generation(&self) -> u32 {
        self.generation
    }
    pub fn workbench(&self) -> Option<Uuid> {
        self.current.as_ref().map(|c| c.workbench)
    }
    fn acknowledge(&mut self, request: Ack) -> Result<Uuid> {
        let connection = self
            .current
            .as_mut()
            .filter(|c| c.id == request.connection_id)
            .ok_or_else(|| {
                AppError::new(
                    "CONNECTION_STALE",
                    "This workbench connection has been replaced.",
                )
            })?;
        if connection.sent != (request.revision, request.queue_revision) {
            return Err(AppError::new(
                "CONNECTION_STALE",
                "Acknowledge the current workbench snapshot.",
            ));
        }
        connection.awaiting_ack = false;
        Ok(connection.workbench)
    }
    pub fn publish(&mut self, owner: &lvovd_core::workbenches::Workbenches) {
        let Some(connection) = &mut self.current else {
            return;
        };
        if connection.awaiting_ack {
            return;
        }
        let snapshot = owner.snapshot(connection.workbench).ok();
        let version = snapshot.as_ref().map(|s| (s.revision, s.queue_revision));
        if version == Some(connection.sent) {
            return;
        }
        let message = Envelope {
            connection_id: connection.id,
            snapshot,
        };
        match (connection.channel.send(message).is_ok(), version) {
            (true, Some(version)) => {
                connection.sent = version;
                connection.awaiting_ack = true;
            }
            _ => self.current = None,
        }
    }
}

#[tauri::command]
pub(crate) fn create_workbench(state: State<'_, AppState>) -> Result<Snapshot> {
    state.workbenches.open()
}
#[tauri::command]
pub(crate) fn list_workbenches(state: State<'_, AppState>) -> Vec<Snapshot> {
    state.workbenches.list()
}
#[tauri::command]
pub(crate) fn cancel_intake(state: State<'_, AppState>, request: WorkbenchRequest) -> Result<()> {
    state.workbenches.cancel_intake(request.workbench_id)
}
#[tauri::command]
pub(crate) fn subscribe_workbench(
    state: State<'_, AppState>,
    request: Subscribe,
    channel: Channel<Envelope>,
) -> Result<Envelope> {
    let mut subscriptions = state.subscriptions.lock().unwrap();
    if request.generation <= subscriptions.generation {
        return Err(AppError::new(
            "CONNECTION_STALE",
            "This workbench connection has been replaced.",
        ));
    }
    let snapshot = state.workbenches.reopen(request.workbench_id)?;
    let id = Uuid::new_v4();
    subscriptions.generation = request.generation;
    subscriptions.current = Some(Connection {
        id,
        workbench: request.workbench_id,
        channel,
        sent: (snapshot.revision, snapshot.queue_revision),
        awaiting_ack: true,
    });
    Ok(Envelope {
        connection_id: id,
        snapshot: Some(snapshot),
    })
}
#[tauri::command]
pub(crate) fn acknowledge_workbench(state: State<'_, AppState>, request: Ack) -> Result<()> {
    let mut subscriptions = state.subscriptions.lock().unwrap();
    let workbench = subscriptions.acknowledge(request)?;
    // A discarded collection can still have a cleanup subscription.
    let _ = state.workbenches.touch(workbench);
    Ok(())
}
#[tauri::command]
pub(crate) async fn review_processing(
    state: State<'_, AppState>,
    request: Review,
) -> Result<Value> {
    state
        .workbenches
        .review(
            request.workbench_id,
            ReviewRequest {
                source_id: request.source_id,
                draft_revision: request.draft_revision,
                settings: request.settings,
                edit_plan: request.edit_plan,
            },
        )
        .await
        .map(|review| review.public_document())
}
#[tauri::command]
pub(crate) async fn queue_processing(
    state: State<'_, AppState>,
    request: Batch,
) -> Result<Snapshot> {
    state
        .workbenches
        .enqueue(request.workbench_id, request.entries)
        .await
}
#[tauri::command]
pub(crate) fn cancel_processing(state: State<'_, AppState>, request: Cancel) -> Result<Snapshot> {
    state
        .workbenches
        .cancel(request.workbench_id, request.job_id)
}
#[tauri::command]
pub(crate) fn remove_source(
    state: State<'_, AppState>,
    request: SourceRequest,
) -> Result<Snapshot> {
    state
        .workbenches
        .remove(request.workbench_id, request.source_id)
}
#[tauri::command]
pub(crate) fn discard_workbench(
    state: State<'_, AppState>,
    request: WorkbenchRequest,
) -> Result<Snapshot> {
    state.workbenches.discard(request.workbench_id)
}
#[tauri::command]
pub(crate) async fn cleanup_workbench(
    state: State<'_, AppState>,
    request: WorkbenchRequest,
) -> Result<Option<Snapshot>> {
    state.workbenches.snapshot(request.workbench_id)?;
    state.workbenches.cleanup().await?;
    Ok(state.workbenches.snapshot(request.workbench_id).ok())
}

#[tauri::command]
pub(crate) async fn prepare_editor(
    state: State<'_, AppState>,
    request: SourceRequest,
) -> Result<Snapshot> {
    state.workbenches.prepare_analysis(
        request.workbench_id,
        request.source_id,
        lvovd_core::analysis::Kind::Preview,
    )
}
#[tauri::command]
pub(crate) async fn prepare_waveform(
    state: State<'_, AppState>,
    request: SourceRequest,
) -> Result<Snapshot> {
    state.workbenches.prepare_analysis(
        request.workbench_id,
        request.source_id,
        lvovd_core::analysis::Kind::Waveform,
    )
}
#[tauri::command]
pub(crate) fn cancel_waveform(state: State<'_, AppState>, request: AnalysisRequest) -> Result<()> {
    state.workbenches.cancel_analysis(
        request.workbench_id,
        request.source_id,
        lvovd_core::analysis::Kind::Waveform,
        request.operation_id,
    )
}
#[tauri::command]
pub(crate) fn cancel_editor(state: State<'_, AppState>, request: AnalysisRequest) -> Result<()> {
    state.workbenches.cancel_analysis(
        request.workbench_id,
        request.source_id,
        lvovd_core::analysis::Kind::Preview,
        request.operation_id,
    )
}
#[tauri::command]
pub(crate) fn waveform_window(
    state: State<'_, AppState>,
    request: WaveformWindow,
) -> Result<Value> {
    state.workbenches.waveform_window(
        request.workbench_id,
        request.source_id,
        request.operation_id,
        request.start_seconds,
        request.end_seconds,
        request.points,
    )
}

#[tauri::command]
pub(crate) async fn save_result(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: ResultRequest,
) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let result = state
        .workbenches
        .result(request.workbench_id, request.result_id)?;
    let _picker = state
        .picker_admission
        .try_lock()
        .map_err(|_| AppError::new("PICKER_BUSY", "Finish the current file dialog first."))?;
    #[cfg(feature = "test-driver")]
    let selected = std::env::var_os("LVOVD_DESKTOP_TEST_SAVE_FOLDER")
        .map(|path| std::path::PathBuf::from(path).join(&result.descriptor().filename));
    #[cfg(not(feature = "test-driver"))]
    let selected: Option<std::path::PathBuf> = None;
    let selected = if selected.is_some() {
        selected
    } else {
        let (send, receive) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .set_title("Save processed file")
            .set_file_name(&result.descriptor().filename)
            .save_file(move |path| {
                let _ = send.send(path);
            });
        let cancel = state.assets.cancellation();
        tokio::select! {
            _ = cancel.cancelled() => return Err(AppError::new("CLOSING", "The application is closing.")),
            value = receive => value.map_err(|_| AppError::new("SAVE_CANCELLED", "The save dialog closed."))?
                .map(|p| p.into_path().map_err(|_| AppError::new("SAVE_PATH", "Choose a local destination."))).transpose()?
        }
    };
    let Some(path) = selected else {
        return Ok(None);
    };
    let saved =
        tauri::async_runtime::spawn_blocking(move || lvovd_core::export::save_copy(result, &path))
            .await
            .map_err(|_| {
                AppError::new(
                    "SAVE_FAILED",
                    "Saving ended unexpectedly. Retry saving the prepared result.",
                )
            })??;
    Ok(saved.file_name().map(|s| s.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_requests_reject_paths_extra_authority_and_unbounded_identity_shapes() {
        let id = Uuid::new_v4();
        assert!(
            serde_json::from_value::<SourceRequest>(
                serde_json::json!({"workbenchId":id,"sourceId":id,"path":"untrusted"})
            )
            .is_err()
        );
        assert!(serde_json::from_value::<Review>(serde_json::json!({"workbenchId":id,"sourceId":id,"draftRevision":0,"inspection":{}})).is_err());
        assert!(serde_json::from_value::<Batch>(serde_json::json!({"workbenchId":id,"entries":[{"sourceId":id,"key":"x","acknowledgements":[],"arguments":[]}]})).is_err());
        assert!(
            serde_json::from_value::<Cancel>(serde_json::json!({"workbenchId":"../escape"}))
                .is_err()
        );
        assert!(serde_json::from_value::<Ack>(serde_json::json!({"connectionId":id,"revision":0,"queueRevision":0,"workbenchId":id})).is_err());
    }
    #[test]
    fn channel_backpressure_coalesces_updates_and_rejects_replaced_acknowledgements() {
        use lvovd_core::{
            assets::Assets,
            processing_operation::{Limits, Processing},
            workbenches::Workbenches,
        };
        use std::{
            sync::{Arc, Mutex},
            time::Duration,
        };
        let root = tempfile::tempdir().unwrap();
        let assets = Assets::new(root.path()).unwrap();
        let tool = root.path().join("unused-tool");
        let processing = Processing::new(
            assets.clone(),
            root.path(),
            tool.clone(),
            tool.clone(),
            Limits {
                maximum_bytes: 1024,
                worker_deadline: Duration::from_secs(1),
            },
        )
        .unwrap();
        let owner = Workbenches::new(assets, processing, tool.clone(), tool);
        let first = owner.open().unwrap();
        let messages = Arc::new(Mutex::new(Vec::new()));
        let captured = messages.clone();
        let id = Uuid::new_v4();
        let mut subscriptions = Subscriptions {
            generation: 1,
            current: Some(Connection {
                id,
                workbench: first.workbench_id,
                channel: Channel::new(move |message| {
                    captured.lock().unwrap().push(message);
                    Ok(())
                }),
                sent: (first.revision, first.queue_revision),
                awaiting_ack: true,
            }),
        };
        for _ in 0..100 {
            owner.discard(first.workbench_id).unwrap();
            subscriptions.publish(&owner);
        }
        assert!(
            messages.lock().unwrap().is_empty(),
            "unacknowledged snapshots must not accumulate"
        );
        assert!(
            subscriptions
                .acknowledge(Ack {
                    connection_id: Uuid::new_v4(),
                    revision: 1,
                    queue_revision: 0
                })
                .is_err()
        );
        subscriptions
            .acknowledge(Ack {
                connection_id: id,
                revision: 1,
                queue_revision: 0,
            })
            .unwrap();
        subscriptions.publish(&owner);
        assert_eq!(messages.lock().unwrap().len(), 1);
        let latest = owner.snapshot(first.workbench_id).unwrap();
        assert_eq!(
            subscriptions.current.as_ref().unwrap().sent.0,
            latest.revision
        );
        assert!(
            subscriptions
                .acknowledge(Ack {
                    connection_id: id,
                    revision: 1,
                    queue_revision: 0
                })
                .is_err()
        );
        subscriptions.publish(&owner);
        assert_eq!(messages.lock().unwrap().len(), 1);
    }
}
