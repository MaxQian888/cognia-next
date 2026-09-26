//! Codex App dispatch on the desktop: the Tauri command shells, and the
//! [`CodexAppHost`] the dispatcher runs against. The dispatcher itself lives in
//! `cognia-codex-app` (ADR-0196 P6b); everything it exports is re-exported
//! here, so the companion's `rpc::codex_app` arms keep their paths.

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

pub use cognia_codex_app::*;

/// The desktop's answers to [`CodexAppHost`]: the app data directory and the
/// sidecar tree resolved from the running app, and the opener plugin.
pub struct TauriCodexAppHost<'a>(pub &'a AppHandle);

impl CodexAppHost for TauriCodexAppHost<'_> {
    fn app_data_dir(&self) -> anyhow::Result<PathBuf> {
        Ok(self.0.path().app_data_dir()?)
    }

    fn sidecar_dir(&self) -> Result<PathBuf, String> {
        crate::claude::sidecar::sidecar_dir(self.0)
    }

    fn open_url(&self, url: &str) -> anyhow::Result<()> {
        self.0.opener().open_url(url, None::<&str>)?;
        Ok(())
    }
}

#[tauri::command]
pub async fn codex_app_runtime_status(app: AppHandle) -> std::result::Result<Value, String> {
    codex_app_runtime_status_impl(&TauriCodexAppHost(&app))
        .await
        .map_err(|error| command_error("Codex App status", error))
}

#[tauri::command]
pub async fn codex_app_task_list(
    app: AppHandle,
    request: CodexAppTaskListRequest,
) -> std::result::Result<Value, String> {
    codex_app_task_list_impl(&TauriCodexAppHost(&app), request)
        .await
        .map_err(|error| command_error("Codex App task list", error))
}

#[tauri::command]
pub async fn codex_app_task_read(
    app: AppHandle,
    request: CodexAppTaskReadRequest,
) -> std::result::Result<Value, String> {
    codex_app_task_read_impl(&TauriCodexAppHost(&app), request)
        .await
        .map_err(|error| command_error("Codex App task read", error))
}

#[tauri::command]
pub async fn codex_app_task_create(
    app: AppHandle,
    request: CodexAppTaskCreateRequest,
) -> std::result::Result<Value, String> {
    codex_app_task_create_impl(&TauriCodexAppHost(&app), request)
        .await
        .map_err(|error| command_error("Codex App task creation", error))
}

#[tauri::command]
pub async fn codex_app_task_send(
    app: AppHandle,
    request: CodexAppTaskSendRequest,
) -> std::result::Result<Value, String> {
    codex_app_task_send_impl(&TauriCodexAppHost(&app), request)
        .await
        .map_err(|error| command_error("Codex App task send", error))
}

#[tauri::command]
pub async fn codex_app_task_interrupt(
    app: AppHandle,
    request: CodexAppTaskInterruptRequest,
) -> std::result::Result<Value, String> {
    codex_app_task_interrupt_impl(&TauriCodexAppHost(&app), request)
        .await
        .map_err(|error| command_error("Codex App task interrupt", error))
}

#[tauri::command]
pub async fn codex_app_inventory(
    app: AppHandle,
    request: CodexAppInventoryRequest,
) -> std::result::Result<CodexAppInventory, String> {
    codex_app_inventory_impl(&TauriCodexAppHost(&app), request)
        .await
        .map_err(|error| command_error("Codex App inventory", error))
}

#[tauri::command]
pub async fn codex_app_task_open(
    app: AppHandle,
    thread_id: String,
) -> std::result::Result<Value, String> {
    codex_app_task_open_impl(&TauriCodexAppHost(&app), thread_id)
        .await
        .map_err(|error| command_error("Codex App task open", error))
}

#[tauri::command]
pub async fn codex_app_dispatch_conversation(
    app: AppHandle,
    request: CodexAppDispatchRequest,
) -> std::result::Result<CodexAppDispatchResult, String> {
    dispatch_conversation(&TauriCodexAppHost(&app), request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tauri polls async commands on a multi-threaded runtime, and the
    /// companion's RPC futures cross threads as well, so the host every shell
    /// and arm builds must be a `Send + Sync` [`CodexAppHost`].
    #[test]
    fn the_desktop_host_is_a_thread_safe_codex_app_host() {
        fn assert_host<T: CodexAppHost + Send + Sync>() {}
        assert_host::<TauriCodexAppHost<'static>>();
    }
}
