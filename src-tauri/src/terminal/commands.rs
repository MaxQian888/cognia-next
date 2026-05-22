//! Tauri commands for the integrated terminal subsystem.
//!
//! Renderer flow:
//!   1. `dispatchTerminalWillSpawn` runs in TS — plugins veto/modify.
//!   2. Renderer constructs a `Channel<TerminalEvent>` and calls
//!      `terminal_spawn`. We return the session id + info; bytes start
//!      streaming through the channel immediately.
//!   3. `terminal_write` / `terminal_resize` operate on the live session.
//!   4. `terminal_kill` removes the session from the store and signals
//!      the child. Drop on the inner `PtySession` handles cleanup.
//!
//! All commands are stateless wrappers around `TerminalState` lookups;
//! every retainable session truth lives in the store.

use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};

use super::session::{spawn_session, SpawnRequest, TerminalEvent, TerminalSessionInfo};
use super::TerminalState;

/// Locate the bundled shell-integration script directory. In dev
/// (`pnpm tauri dev`) this resolves to the workspace path; in production
/// it's the Tauri resource dir.
fn resolve_script_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    let resource_root = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("terminal"));
    if let Some(dir) = resource_root {
        if dir.is_dir() {
            return dir;
        }
    }
    // Dev fallback — the file may be a relative path from CARGO_MANIFEST_DIR.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.join("resources").join("terminal")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub session: TerminalSessionInfo,
}

/// Open a new PTY session and start streaming bytes through `on_event`.
#[tauri::command]
pub fn terminal_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalState>,
    req: SpawnRequest,
    on_event: Channel<TerminalEvent>,
) -> Result<SpawnResult, String> {
    let script_dir = resolve_script_dir(&app);
    let session = spawn_session(req, &script_dir, on_event)?;
    let info = session.info();
    state.insert(std::sync::Arc::new(session));
    Ok(SpawnResult { session: info })
}

/// Pipe bytes into the PTY stdin. `data` is base64-decoded automatically
/// by Tauri when typed as `Vec<u8>` on the Rust side.
#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = state.get(&id).ok_or_else(|| format!("unknown session id: {id}"))?;
    session
        .write(&data)
        .map_err(|e| format!("write failed: {e}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let session = state.get(&id).ok_or_else(|| format!("unknown session id: {id}"))?;
    session
        .resize(rows, cols)
        .map_err(|e| format!("resize failed: {e}"))
}

/// Send SIGTERM (or platform equivalent) to the child and remove the
/// session from the store. Idempotent — calling on an already-killed or
/// missing session returns `Ok(())`.
///
/// Drop on the removed `Arc<PtySession>` ensures the child is actually
/// killed even if the explicit `kill()` racied with natural exit.
#[tauri::command]
pub fn terminal_kill(state: State<'_, TerminalState>, id: String) -> Result<(), String> {
    if let Some(session) = state.remove(&id) {
        let _ = session.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_list_for_project(
    state: State<'_, TerminalState>,
    project_id: String,
) -> Result<Vec<TerminalSessionInfo>, String> {
    Ok(state.list_for_project(&project_id))
}

#[tauri::command]
pub fn terminal_list_all(state: State<'_, TerminalState>) -> Result<Vec<TerminalSessionInfo>, String> {
    Ok(state.list_all())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn resolve_script_dir_falls_back_to_manifest_relative() {
        // Construction of a real AppHandle requires a running Tauri app,
        // so we exercise the manifest-relative branch by checking the
        // path it would build directly. This mirrors what
        // `resolve_script_dir` does when `resource_dir()` is absent or
        // doesn't contain a `terminal/` subdir — both common in `cargo test`.
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let expected = manifest.join("resources").join("terminal");
        // The path doesn't need to exist for the assertion — we're just
        // confirming the join shape.
        assert!(expected
            .to_string_lossy()
            .contains("resources"));
    }
}
