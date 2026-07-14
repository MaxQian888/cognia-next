//! Tauri IPC surface for the optional desktop "Pro IDE" mode (code-server).
//!
//! Every command is desktop-only in effect: `resolve_platform` (via the state)
//! errors on unsupported hosts (Windows / exotic arch), and `codeserver_supported`
//! lets the frontend gate the toggle before attempting a spawn.

use tauri::State;

use super::download::{self, InstallInfo};
use super::process::{CodeServerState, CodeServerStatus};

/// Whether this host has a prebuilt code-server standalone binary (macOS/Linux
/// on amd64/arm64). The frontend disables the Pro IDE toggle when false.
#[tauri::command]
pub fn codeserver_supported() -> bool {
    download::resolve_platform().is_ok()
}

/// Ensure a healthy code-server is serving `root`; returns its loopback port.
/// Downloads + installs code-server on first use (progress on
/// `codeserver://download-progress`).
#[tauri::command]
pub async fn codeserver_ensure(
    app: tauri::AppHandle,
    state: State<'_, CodeServerState>,
    root: String,
) -> Result<CodeServerStatus, String> {
    let port = state.ensure(&app, &root).await?;
    Ok(CodeServerStatus {
        running: true,
        port: Some(port),
        version: download::CODE_SERVER_VERSION.to_string(),
    })
}

/// Current status for a root without spawning anything.
#[tauri::command]
pub async fn codeserver_status(
    state: State<'_, CodeServerState>,
    root: String,
) -> Result<CodeServerStatus, String> {
    let (running, port) = state.status(&root).await;
    Ok(CodeServerStatus {
        running,
        port,
        version: download::CODE_SERVER_VERSION.to_string(),
    })
}

/// Stop the code-server serving `root`. Returns whether one was running.
#[tauri::command]
pub async fn codeserver_stop(
    state: State<'_, CodeServerState>,
    root: String,
) -> Result<bool, String> {
    Ok(state.stop(&root).await)
}

/// Stop every running code-server (global "shut down Pro IDE" / kill switch).
#[tauri::command]
pub async fn codeserver_stop_all(state: State<'_, CodeServerState>) -> Result<(), String> {
    state.stop_all().await;
    Ok(())
}

/// Download + install code-server without spawning it (lets the UI pre-fetch
/// and show the download bar before the first switch).
#[tauri::command]
pub async fn codeserver_download(app: tauri::AppHandle) -> Result<InstallInfo, String> {
    download::ensure_code_server(&app)
        .await
        .map_err(|e| format!("{e:#}"))
}
