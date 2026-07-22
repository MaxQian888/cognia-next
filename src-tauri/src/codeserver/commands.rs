//! Tauri IPC surface for the optional desktop "Pro IDE" mode (code-server).
//!
//! Every command is desktop-only in effect: `resolve_platform` (via the state)
//! errors on unsupported hosts (Windows / exotic arch), and `codeserver_supported`
//! lets the frontend gate the toggle before attempting a spawn.

use std::path::Path;
use std::time::Duration;

use tauri::State;

use super::download::{self, CodeServerDiskUsage, InstallInfo};
use super::process::{self, CodeServerState, CodeServerStatus};
use crate::cli_bridge::detect;

/// The VS Code launcher on PATH. Probed through the shared binary detector so
/// an app-managed copy and the cache are reused.
const LOCAL_VSCODE_BIN: &str = "code";

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
pub async fn codeserver_download(
    app: tauri::AppHandle,
    state: State<'_, CodeServerState>,
) -> Result<InstallInfo, String> {
    state.download(&app).await
}

/// Install + disk state for the Pro IDE settings card. Walks the install tree,
/// so it runs on the blocking pool.
#[tauri::command]
pub async fn codeserver_disk_usage(app: tauri::AppHandle) -> Result<CodeServerDiskUsage, String> {
    tokio::task::spawn_blocking(move || download::disk_usage(&app).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| format!("code-server disk usage task: {e}"))?
}

/// Reclaim disk: drop non-pinned installs and partial downloads, or — when
/// `everything` — the entire code-server root (install + user data). Returns the
/// bytes freed. Callers must stop running instances first.
#[tauri::command]
pub async fn codeserver_uninstall(
    app: tauri::AppHandle,
    state: State<'_, CodeServerState>,
    everything: bool,
) -> Result<u64, String> {
    state.uninstall(app, everything).await
}

/// Open a project-relative file in an already-running CodeServer window.
#[tauri::command]
pub async fn codeserver_open_file(
    state: State<'_, CodeServerState>,
    root: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    state.open_file(&root, &path, line, column).await
}

/// Current contents of code-server's `settings.json`, or an empty string when
/// it does not exist yet. The renderer owns the merge (it has the JSONC parser
/// the VS Code theme importer already ships).
#[tauri::command]
pub async fn codeserver_read_user_settings(app: tauri::AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let path = process::user_settings_path(&app)?;
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("read {}: {e}", path.display())),
        }
    })
    .await
    .map_err(|e| format!("read code-server settings task: {e}"))?
}

/// Replace code-server's `settings.json`. Written to a sibling temp file and
/// renamed so VS Code's watcher never observes a half-written document.
#[tauri::command]
pub async fn codeserver_write_user_settings(
    app: tauri::AppHandle,
    contents: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = process::user_settings_path(&app)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, contents).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("replace {}: {e}", path.display()))
    })
    .await
    .map_err(|e| format!("write code-server settings task: {e}"))?
}

/// Whether a local VS Code launcher is on PATH. Backs the fallback offered
/// where the embedded Pro IDE cannot run (Windows / exotic arch) — the toggle's
/// tooltip has always told users to "use your local VS Code instead", and this
/// is what makes that a thing they can actually click.
#[tauri::command]
pub async fn codeserver_local_vscode_available() -> bool {
    tokio::task::spawn_blocking(|| detect::detect(LOCAL_VSCODE_BIN, "--version").available)
        .await
        .unwrap_or(false)
}

/// Build the `code` argv for a target. `--goto` addresses a line/column inside a
/// file; a folder (or a bare file) is passed positionally. Pure, so the flag
/// shape is unit-tested without launching anything.
fn local_vscode_args(target: &str, line: Option<u32>, column: Option<u32>) -> Vec<String> {
    match line {
        Some(line) => {
            let column = column.unwrap_or(1).max(1);
            vec![
                "--goto".to_string(),
                format!("{target}:{}:{column}", line.max(1)),
            ]
        }
        None => vec![target.to_string()],
    }
}

/// Open `path` (a project root or a file) in the user's own VS Code.
#[tauri::command]
pub async fn codeserver_open_in_local_vscode(
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let target = tokio::task::spawn_blocking(move || {
        Path::new(&path)
            .canonicalize()
            .map_err(|e| format!("resolve {path}: {e}"))
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("resolve local VS Code target task: {e}"))??;

    let binary = tokio::task::spawn_blocking(|| detect::detect(LOCAL_VSCODE_BIN, "--version"))
        .await
        .map_err(|e| format!("detect local VS Code task: {e}"))?;
    if !binary.available {
        return Err("no local VS Code launcher (`code`) found on PATH".to_string());
    }
    // Prefer the resolved absolute path when detection produced one.
    let program = binary.path.unwrap_or_else(|| LOCAL_VSCODE_BIN.to_string());

    let mut command = tokio::process::Command::new(program);
    command
        .args(local_vscode_args(&target, line, column))
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| "local VS Code launch timed out".to_string())?
        .map_err(|e| format!("launch local VS Code: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "local VS Code launch failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_command_matches_the_download_platform_gate() {
        assert_eq!(codeserver_supported(), download::resolve_platform().is_ok());
    }

    #[test]
    fn local_vscode_args_use_goto_only_when_a_line_is_known() {
        assert_eq!(
            local_vscode_args("/work/proj/src/main.ts", Some(42), Some(7)),
            vec!["--goto", "/work/proj/src/main.ts:42:7"]
        );
        // Column defaults to 1 rather than being dropped, so `--goto` stays well-formed.
        assert_eq!(
            local_vscode_args("/work/proj/src/main.ts", Some(42), None),
            vec!["--goto", "/work/proj/src/main.ts:42:1"]
        );
        // A folder has no line — pass it positionally so VS Code opens it as a workspace.
        assert_eq!(
            local_vscode_args("/work/proj", None, None),
            vec!["/work/proj"]
        );
    }

    #[test]
    fn local_vscode_args_clamp_zero_positions() {
        assert_eq!(
            local_vscode_args("/a.ts", Some(0), Some(0)),
            vec!["--goto", "/a.ts:1:1"]
        );
    }
}
