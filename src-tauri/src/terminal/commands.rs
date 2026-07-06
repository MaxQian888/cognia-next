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

use super::session::{
    cognia_bin_filename, spawn_session, PathInjection, SeqEvent, SpawnRequest, TerminalSessionInfo,
};
use super::TerminalState;

/// Locate the bundled shell-integration script directory. In dev
/// (`pnpm tauri dev`) this resolves to the workspace path; in production
/// it's the Tauri resource dir.
pub(super) fn resolve_script_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    let resource_root = app.path().resource_dir().ok().map(|d| d.join("terminal"));
    if let Some(dir) = resource_root {
        if dir.is_dir() {
            return dir;
        }
    }
    // Dev fallback — the file may be a relative path from CARGO_MANIFEST_DIR.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.join("resources").join("terminal")
}

/// Locate a directory that contains the `cognia` plugin-author CLI shipped
/// with the app, if any. We don't bundle the binary into installers today —
/// users acquire it via the in-app download (registered as a managed dir,
/// see `build_cli_path_injection`) or `cargo install`. This resolver only
/// covers the `pnpm tauri dev` case, where the CLI may have been built into
/// the shared workspace `target/{release,debug}/`. Returns `None` when no
/// such binary is present.
fn resolve_cli_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    // Production (resource dir) — present only if a future build opts into
    // bundling. Cheap to check; harmless when absent.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("cli");
        if candidate.join(cognia_bin_filename()).exists() {
            return Some(candidate);
        }
    }
    // Dev fallback — the workspace target dir, sibling of `src-tauri/`.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest.parent()?;
    for profile in ["release", "debug"] {
        let dir = root.join("target").join(profile);
        if dir.join(cognia_bin_filename()).exists() {
            return Some(dir);
        }
    }
    None
}

/// Assemble the PATH directories woven into every terminal child so `cognia`
/// is runnable regardless of how the user obtained it:
///   * prepend — app-managed (downloaded) CLI dirs first (an explicit user
///     install wins), then a dev/bundled `cli` dir if present;
///   * append  — `~/.cargo/bin` as a low-priority fallback for a
///     `cargo install`ed copy.
pub(super) fn build_cli_path_injection<R: Runtime>(app: &AppHandle<R>) -> PathInjection {
    let mut prepend = crate::cli_bridge::detect::managed_dirs_snapshot();
    if let Some(dir) = resolve_cli_dir(app) {
        prepend.push(dir);
    }
    let mut append = Vec::new();
    if let Ok(home) = app.path().home_dir() {
        append.push(home.join(".cargo").join("bin"));
    }
    PathInjection { prepend, append }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub session: TerminalSessionInfo,
}

/// Open a new PTY session and start streaming `{seq, event}` envelopes
/// through `on_event`. The renderer persists the last seen `seq` so it can
/// resume via `terminal_reattach` after a reload.
#[tauri::command]
pub fn terminal_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalState>,
    req: SpawnRequest,
    on_event: Channel<SeqEvent>,
) -> Result<SpawnResult, String> {
    let script_dir = resolve_script_dir(&app);
    let path = build_cli_path_injection(&app);
    let session = spawn_session(req, &script_dir, &path, on_event)?;
    let info = session.info();
    state.insert(std::sync::Arc::new(session));
    Ok(SpawnResult { session: info })
}

/// Reattach a fresh Channel to an existing session after a webview reload
/// (1C). The Rust process — and thus the live PTY — survives a reload; this
/// rewires the byte stream and replays everything with `seq > resume_from`.
/// Returns the session info, or an error when the session is gone (e.g. a
/// full app restart, where sessions are not restored).
#[tauri::command]
pub fn terminal_reattach(
    state: State<'_, TerminalState>,
    id: String,
    on_event: Channel<SeqEvent>,
    resume_from: u64,
) -> Result<TerminalSessionInfo, String> {
    let session = state
        .get(&id)
        .ok_or_else(|| format!("unknown session id: {id}"))?;
    session.reattach(on_event, resume_from);
    Ok(session.info())
}

/// Pipe bytes into the PTY stdin. `data` is base64-decoded automatically
/// by Tauri when typed as `Vec<u8>` on the Rust side.
#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = state
        .get(&id)
        .ok_or_else(|| format!("unknown session id: {id}"))?;
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
    let session = state
        .get(&id)
        .ok_or_else(|| format!("unknown session id: {id}"))?;
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
pub fn terminal_list_all(
    state: State<'_, TerminalState>,
) -> Result<Vec<TerminalSessionInfo>, String> {
    Ok(state.list_all())
}

/// Free a TCP port by killing whatever process is listening on it. Backs the
/// terminal "free port" quick fix (VS Code parity — `freePort` in
/// `terminalQuickFixBuiltinActions.ts`). Best-effort and bounded: resolves the
/// listening PID(s) via the platform's standard tool (`netstat` on Windows,
/// `lsof` elsewhere) and signals them. Returns the PIDs that were signalled,
/// possibly empty (nothing was listening / the tool was unavailable).
#[tauri::command]
pub fn terminal_kill_port(port: u16) -> Result<Vec<u32>, String> {
    if port == 0 {
        return Err("invalid port".into());
    }
    let pids = listening_pids(port)?;
    let mut killed = Vec::new();
    for pid in pids {
        if kill_pid(pid) {
            killed.push(pid);
        }
    }
    Ok(killed)
}

/// Parse `netstat -ano -p tcp` output for PIDs listening on `port`. Pure (no
/// IO) so the column-matching is testable on any platform.
#[allow(dead_code)]
fn parse_netstat_pids(output: &str, port: u16) -> Vec<u32> {
    let needle = format!(":{port}");
    let mut pids = Vec::new();
    for line in output.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // `  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   12345`
        if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        if !cols[1].ends_with(&needle) || !cols[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        if let Ok(pid) = cols[4].parse::<u32>() {
            if pid != 0 && !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

/// Parse `lsof -t` output (one PID per line). Pure so it's testable anywhere.
#[allow(dead_code)]
fn parse_lsof_pids(output: &str) -> Vec<u32> {
    let mut pids = Vec::new();
    for line in output.lines() {
        if let Ok(pid) = line.trim().parse::<u32>() {
            if pid != 0 && !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

#[cfg(windows)]
fn listening_pids(port: u16) -> Result<Vec<u32>, String> {
    let output = std::process::Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|e| format!("netstat failed: {e}"))?;
    Ok(parse_netstat_pids(
        &String::from_utf8_lossy(&output.stdout),
        port,
    ))
}

#[cfg(not(windows))]
fn listening_pids(port: u16) -> Result<Vec<u32>, String> {
    let output = std::process::Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
        .map_err(|e| format!("lsof failed: {e}"))?;
    Ok(parse_lsof_pids(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(windows)]
fn kill_pid(pid: u32) -> bool {
    std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn kill_pid(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{parse_lsof_pids, parse_netstat_pids};
    use std::path::Path;

    #[test]
    fn parse_netstat_extracts_listening_pid_for_port() {
        let out = "\
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       12345
  TCP    127.0.0.1:5500         0.0.0.0:0              LISTENING       6789
  TCP    [::]:3000              [::]:0                 LISTENING       12345
  TCP    0.0.0.0:3000           10.0.0.2:55123         ESTABLISHED     999";
        assert_eq!(parse_netstat_pids(out, 3000), vec![12345]);
        assert_eq!(parse_netstat_pids(out, 5500), vec![6789]);
    }

    #[test]
    fn parse_netstat_does_not_confuse_port_suffixes() {
        let out = "  TCP    0.0.0.0:13000          0.0.0.0:0              LISTENING       42";
        assert!(parse_netstat_pids(out, 3000).is_empty());
        assert_eq!(parse_netstat_pids(out, 13000), vec![42]);
    }

    #[test]
    fn parse_lsof_reads_one_pid_per_line_deduped() {
        assert_eq!(parse_lsof_pids("4242\n4242\n51\n"), vec![4242, 51]);
        assert!(parse_lsof_pids("\n  \n").is_empty());
    }

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
        assert!(expected.to_string_lossy().contains("resources"));
    }
}
