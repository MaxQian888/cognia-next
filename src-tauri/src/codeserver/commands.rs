//! Tauri IPC surface for the optional desktop "Pro IDE" mode (code-server).
//!
//! Every command is desktop-only in effect: `resolve_platform` (via the state)
//! errors on unsupported hosts (Windows / exotic arch), and `codeserver_supported`
//! lets the frontend gate the toggle before attempting a spawn.

use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use tauri::State;

use super::download::{self, CodeServerDiskUsage, InstallInfo};
use super::process::{self, CodeServerState, CodeServerStatus};
use super::profile::IdeProfile;
use super::proxy::{ProxyArtifact, ProxyBuildRequest};
use super::relay::{DesktopRelayState, DesktopRelayStatus};
use crate::cli_bridge::detect;

/// The VS Code launcher on PATH. Probed through the shared binary detector so
/// an app-managed copy and the cache are reused.
const LOCAL_VSCODE_BIN: &str = "code";

pub fn read_text_or_empty(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
}

pub fn atomic_write_text(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("write {}: path has no parent", path.display()))?;
    let mut staged = tempfile::Builder::new()
        .prefix(".cognia-code-server-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    staged
        .write_all(contents.as_bytes())
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|error| format!("write {}: {error}", staged.path().display()))?;
    staged
        .persist(path)
        .map(|_| ())
        .map_err(|error| format!("replace {}: {}", path.display(), error.error))
}

/// Whether this host has a prebuilt code-server standalone binary (macOS/Linux
/// on amd64/arm64). The frontend disables the Pro IDE toggle when false.
#[tauri::command]
pub fn codeserver_supported() -> bool {
    download::resolve_platform().is_ok()
}

/// Bind/reuse the desktop's ephemeral loopback relay for a remote-owned IDE.
/// Certificate pinning completes before the existing device JWT is sent.
#[tauri::command]
pub async fn codeserver_remote_relay_ensure(
    state: State<'_, DesktopRelayState>,
    base_url: String,
    device_jwt: String,
    server_fingerprint: String,
    relay_path: String,
) -> Result<DesktopRelayStatus, String> {
    state
        .ensure(base_url, device_jwt, server_fingerprint, relay_path)
        .await
}

#[tauri::command]
pub async fn codeserver_remote_relay_stop(
    state: State<'_, DesktopRelayState>,
) -> Result<bool, String> {
    Ok(state.stop().await)
}

/// Build and sign a deterministic managed proxy VSIX from normalized IDE IR.
#[tauri::command]
pub async fn codeserver_build_proxy(
    app: tauri::AppHandle,
    request: ProxyBuildRequest,
) -> Result<ProxyArtifact, String> {
    if !super::managed_platform_enabled() {
        return Err("IDE_PLATFORM_DISABLED".to_string());
    }
    let build_app = app.clone();
    let artifact =
        tokio::task::spawn_blocking(move || super::proxy::build_proxy(&build_app, request))
            .await
            .map_err(|error| format!("build managed proxy task: {error}"))??;
    Ok(artifact)
}

/// Promote a staged proxy into live managed profiles. The process layer owns
/// handshake verification and restores the prior extension on failure.
#[tauri::command]
pub async fn codeserver_activate_proxy(
    app: tauri::AppHandle,
    state: State<'_, CodeServerState>,
    artifact: ProxyArtifact,
) -> Result<bool, String> {
    if !super::managed_platform_enabled() {
        return Err("IDE_PLATFORM_DISABLED".to_string());
    }
    state.install_proxy_artifact(&app, &artifact).await
}

/// List locally signed proxy artifacts that pass hash/signature verification.
#[tauri::command]
pub async fn codeserver_list_proxies(app: tauri::AppHandle) -> Result<Vec<ProxyArtifact>, String> {
    tokio::task::spawn_blocking(move || super::proxy::list_artifacts(&app))
        .await
        .map_err(|error| format!("list managed proxies task: {error}"))?
}

/// Ensure a healthy code-server is serving `root`; returns its loopback port.
/// Downloads + installs code-server on first use (progress on
/// `codeserver://download-progress`).
#[tauri::command]
pub async fn codeserver_ensure(
    app: tauri::AppHandle,
    state: State<'_, CodeServerState>,
    root: String,
    profile: Option<IdeProfile>,
) -> Result<CodeServerStatus, String> {
    let profile = profile.unwrap_or_default();
    let port = state.ensure_profile(&app, &root, profile).await?;
    Ok(CodeServerStatus {
        running: true,
        port: Some(port),
        version: download::CODE_SERVER_VERSION.to_string(),
        profile: Some(profile),
    })
}

/// Current status for a root without spawning anything.
#[tauri::command]
pub async fn codeserver_status(
    state: State<'_, CodeServerState>,
    root: String,
) -> Result<CodeServerStatus, String> {
    let (running, port, profile) = state.status(&root).await;
    Ok(CodeServerStatus {
        running,
        port,
        version: download::CODE_SERVER_VERSION.to_string(),
        profile,
    })
}

/// Answer a provider callback from the current managed broker generation.
#[tauri::command]
pub async fn codeserver_broker_respond(
    root: String,
    generation: u64,
    id: serde_json::Value,
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
) -> Result<(), String> {
    if !super::managed_platform_enabled() {
        return Err("IDE_PLATFORM_DISABLED".to_string());
    }
    super::agent_channel::global()
        .respond(&root, generation, id, result, error)
        .await
}

/// Deliver a validated provider state-change notification to the current
/// managed extension-host generation. Notifications are never queued or replayed.
#[tauri::command]
pub async fn codeserver_broker_notify(
    root: String,
    generation: u64,
    params: serde_json::Value,
) -> Result<(), String> {
    if !super::managed_platform_enabled() {
        return Err("IDE_PLATFORM_DISABLED".to_string());
    }
    super::agent_channel::global()
        .notify_provider(&root, generation, params)
        .await
}

/// Canonicalize every file path on the IDE host and reject symlink/traversal
/// escapes before provider arguments enter a plugin runtime.
#[tauri::command]
pub async fn codeserver_broker_validate_paths(
    root: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    if !super::managed_platform_enabled() {
        return Err("IDE_PLATFORM_DISABLED".to_string());
    }
    tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .map(|path| {
                crate::files::validate_confined_path(path, std::slice::from_ref(&root))
                    .map(|value| value.to_string_lossy().into_owned())
            })
            .collect()
    })
    .await
    .map_err(|error| format!("validate managed IDE paths task: {error}"))?
}

#[tauri::command]
pub async fn codeserver_broker_content_create(
    root: String,
    generation: u64,
    plugin_id: String,
    provider_id: String,
    permission: Option<String>,
    media_type: String,
    bytes: Vec<u8>,
) -> Result<super::agent_channel::ContentHandle, String> {
    if !super::managed_platform_enabled() {
        return Err("IDE_PLATFORM_DISABLED".to_string());
    }
    super::agent_channel::global().create_content_handle(
        &root,
        generation,
        &plugin_id,
        &provider_id,
        permission,
        media_type,
        bytes,
    )
}

#[tauri::command]
pub async fn codeserver_broker_content_redeem(
    root: String,
    generation: u64,
    plugin_id: String,
    provider_id: String,
    permission: Option<String>,
    handle_id: String,
) -> Result<Vec<u8>, String> {
    if !super::managed_platform_enabled() {
        return Err("IDE_PLATFORM_DISABLED".to_string());
    }
    super::agent_channel::global().redeem_content_handle(
        &root,
        generation,
        &plugin_id,
        &provider_id,
        permission.as_deref(),
        &handle_id,
    )
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

/// Abort an in-flight first-run download. The first run pulls 100–200MB and
/// used to be uninterruptible — a mis-click committed the user to the whole
/// transfer. Safe to call when nothing is downloading.
#[tauri::command]
pub fn codeserver_cancel_download(state: State<'_, CodeServerState>) -> Result<(), String> {
    state.cancel_download();
    Ok(())
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

/// Ask the companion extension (Pro IDE Phase 2) to open + reveal an absolute
/// path in the live VS Code, over the loopback agent channel. Preferred over the
/// CLI `codeserver_open_file` when the extension is connected; the frontend
/// degrades to the CLI path on error.
#[tauri::command]
pub async fn codeserver_agent_open(
    state: State<'_, CodeServerState>,
    root: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    state.agent_open(&root, &path, line, column).await
}

/// Ask the companion extension to reflect an agent's on-disk write as an
/// undo-able `WorkspaceEdit` (live diff) rather than a bare external reload.
/// Disk stays the source of truth — the extension reconciles from it.
#[tauri::command]
pub async fn codeserver_agent_apply_edit(
    state: State<'_, CodeServerState>,
    root: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    state.agent_apply_edit(&root, &path, line, column).await
}

/// Read the live VS Code active-editor context (path / selection / selected text
/// / diagnostics / open editors) back to the agent. The renderer PII-gates the
/// payload before it reaches the model.
#[tauri::command]
pub async fn codeserver_agent_read_active(
    state: State<'_, CodeServerState>,
    root: String,
) -> Result<serde_json::Value, String> {
    state.agent_read_active(&root).await
}

/// Current contents of code-server's `settings.json`, or an empty string when
/// it does not exist yet. The renderer owns the merge (it has the JSONC parser
/// the VS Code theme importer already ships).
#[tauri::command]
pub async fn codeserver_read_user_settings(
    app: tauri::AppHandle,
    profile: Option<IdeProfile>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let path = process::user_settings_path_for_profile(&app, profile.unwrap_or_default())?;
        read_text_or_empty(&path)
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
    profile: Option<IdeProfile>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = process::user_settings_path_for_profile(&app, profile.unwrap_or_default())?;
        atomic_write_text(&path, &contents)
    })
    .await
    .map_err(|e| format!("write code-server settings task: {e}"))?
}

/// Flush dirty editor buffers to disk so the agent's file tools read what the user
/// is actually looking at. `path` narrows it to one absolute file.
#[tauri::command]
pub async fn codeserver_agent_save_all(
    state: State<'_, CodeServerState>,
    root: String,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    state.agent_save_all(&root, path.as_deref()).await
}

/// Show `content` beside `path` in the editor's native diff view, for review before
/// an agent change is written. The proposal is served from memory, never disk.
#[tauri::command]
pub async fn codeserver_agent_show_diff(
    state: State<'_, CodeServerState>,
    root: String,
    path: String,
    content: String,
    title: Option<String>,
) -> Result<serde_json::Value, String> {
    state
        .agent_show_diff(&root, &path, &content, title.as_deref())
        .await
}

/// Reveal an absolute path in the editor's file explorer.
#[tauri::command]
pub async fn codeserver_agent_reveal(
    state: State<'_, CodeServerState>,
    root: String,
    path: String,
) -> Result<serde_json::Value, String> {
    state.agent_reveal(&root, &path).await
}

/// Run a command in the editor's integrated terminal (visible to the user; output
/// is not readable back — the agent's own shell tool covers that).
#[tauri::command]
pub async fn codeserver_agent_run_in_terminal(
    state: State<'_, CodeServerState>,
    root: String,
    command: String,
    cwd: Option<String>,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    state
        .agent_run_in_terminal(&root, &command, cwd.as_deref(), name.as_deref())
        .await
}

/// Push the app's workspace snapshot (issues / plans / agent runs) to the
/// companion extension for its status bar item and side-bar trees.
#[tauri::command]
pub async fn codeserver_agent_workspace_snapshot(
    state: State<'_, CodeServerState>,
    root: String,
    snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.agent_workspace_snapshot(&root, snapshot).await
}

/// Surface an app-side notification inside the editor.
#[tauri::command]
pub async fn codeserver_agent_notify(
    state: State<'_, CodeServerState>,
    root: String,
    message: String,
    kind: Option<String>,
) -> Result<serde_json::Value, String> {
    state.agent_notify(&root, &message, kind.as_deref()).await
}

/// Current contents of code-server's `argv.json` (runtime arguments — where the
/// display language lives), or an empty string when it does not exist yet.
#[tauri::command]
pub async fn codeserver_read_runtime_args(
    app: tauri::AppHandle,
    profile: Option<IdeProfile>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let path = process::runtime_args_path_for_profile(&app, profile.unwrap_or_default())?;
        read_text_or_empty(&path)
    })
    .await
    .map_err(|e| format!("read code-server runtime args task: {e}"))?
}

/// Replace code-server's `argv.json`. Written to a sibling temp file and renamed,
/// like the settings writer, so a partially-written document is never observable.
///
/// Unlike `settings.json`, VS Code reads this only at startup: the caller must
/// restart the instance for a locale change to take effect.
#[tauri::command]
pub async fn codeserver_write_runtime_args(
    app: tauri::AppHandle,
    contents: String,
    profile: Option<IdeProfile>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = process::runtime_args_path_for_profile(&app, profile.unwrap_or_default())?;
        atomic_write_text(&path, &contents)
    })
    .await
    .map_err(|e| format!("write code-server runtime args task: {e}"))?
}

/// Whether a display-language pack is published for `locale` (and therefore
/// whether asking for it can do anything). Lets the UI say "Chinese isn't
/// available for the editor" instead of silently leaving it in English.
#[tauri::command]
pub fn codeserver_language_pack_available(locale: String) -> bool {
    process::language_pack_extension_id(&locale).is_some()
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

    #[test]
    fn text_file_helpers_read_missing_as_empty_and_replace_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        assert_eq!(read_text_or_empty(&path).unwrap(), "");

        atomic_write_text(&path, "first").unwrap();
        atomic_write_text(&path, "second").unwrap();

        assert_eq!(read_text_or_empty(&path).unwrap(), "second");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_text_writes_use_independent_staging_files() {
        const WRITERS: usize = 16;
        let dir = tempfile::tempdir().unwrap();
        let path = std::sync::Arc::new(dir.path().join("settings.json"));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(WRITERS));
        let payloads: Vec<String> = (0..WRITERS)
            .map(|index| format!("writer-{index}-{}", "x".repeat(1024)))
            .collect();

        let handles: Vec<_> = payloads
            .iter()
            .cloned()
            .map(|payload| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    atomic_write_text(&path, &payload)
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let final_contents = read_text_or_empty(&path).unwrap();
        assert!(payloads.contains(&final_contents));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn language_pack_availability_matches_supported_locales() {
        assert!(codeserver_language_pack_available("zh-CN".to_string()));
        assert!(codeserver_language_pack_available("  ja  ".to_string()));
        assert!(!codeserver_language_pack_available(
            "xx-unknown".to_string()
        ));
    }
}
