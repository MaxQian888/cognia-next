//! A2UI bridge — local IPC endpoint that forwards `a2ui_dispatch` lines from
//! the stand-alone `sidecar/a2ui-mcp.mjs` process into the renderer.
//!
//! Why a separate transport: external agents (Claude Code CLI, Cursor, …)
//! spawn `a2ui-mcp.mjs` with their *own* stdin/stdout for the MCP protocol.
//! That stdio belongs to the agent, not Tauri, so the bridge needs a
//! side-channel to deliver dispatches back to the cognia-next renderer.
//!
//! Transport: a per-app local socket (Unix domain socket on Linux/macOS,
//! named pipe on Windows). The path is exposed to spawned MCP subprocesses
//! via the `COGNIA_BRIDGE_SOCKET` environment variable, which adapters
//! propagate through `McpServer.config.env`.
//!
//! Wire format: newline-delimited JSON. Every message has `type`; only
//! `a2ui_dispatch` is recognised today (others are ignored with a warn).
//!
//! Error budget: best-effort. If listener bind fails (locked socket file
//! after a crash, sandboxing, …) we log and degrade — `a2ui-mcp.mjs`
//! handles the disconnected case gracefully on its end.

pub mod commands;

use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::claude::sidecar::A2UI_EVENT;

/// Compute the local socket path used by the bridge for this app run.
///
/// Stable per-OS-user but unique per cognia-next install (so two parallel
/// installs on the same machine don't fight over the same socket).
pub fn socket_path(app: &AppHandle) -> Option<PathBuf> {
    let base = app
        .path()
        .app_local_data_dir()
        .ok()
        .or_else(|| app.path().temp_dir().ok())?;
    let _ = std::fs::create_dir_all(&base);

    Some(socket_path_for_base(&base))
}

fn socket_path_for_base(base: &std::path::Path) -> PathBuf {
    // Windows: named pipe path. The file doesn't exist on disk; the OS
    // namespaces it. Include a stable suffix from app data root so parallel
    // installs do not contend for the same pipe name.
    #[cfg(windows)]
    {
        return PathBuf::from(format!(
            r"\\.\pipe\cognia-next-a2ui-bridge-{:016x}",
            stable_path_hash(base)
        ));
    }

    // Unix: socket file inside app local data. Length is well under the
    // 100-byte sun_path limit on Linux / macOS for the default `~/.local/share`
    // root.
    #[cfg(not(windows))]
    {
        base.join("a2ui-bridge.sock")
    }
}

#[cfg(windows)]
fn stable_path_hash(path: &std::path::Path) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let normalized = path.to_string_lossy().to_ascii_lowercase();
    normalized.bytes().fold(FNV_OFFSET, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
    })
}

/// Spawn the bridge listener. Idempotent — running it twice in the same
/// process is harmless because each call creates its own task.
pub async fn spawn(app: AppHandle) {
    let path = match socket_path(&app) {
        Some(p) => p,
        None => {
            log::warn!("a2ui-bridge: could not resolve socket path; bridge disabled");
            return;
        }
    };

    // Best-effort cleanup of a stale socket file from a prior crash.
    #[cfg(not(windows))]
    {
        let _ = std::fs::remove_file(&path);
    }

    let path_str = path.to_string_lossy().to_string();
    log::info!("a2ui-bridge: listening on {}", path_str);
    // Expose the path so the standalone a2ui-mcp.mjs (spawned by external
    // agents) can connect back. Adapters propagate this via env when
    // projecting a2ui-bridge into agent configs.
    std::env::set_var("COGNIA_BRIDGE_SOCKET", &path_str);

    #[cfg(unix)]
    {
        use tokio::net::UnixListener;
        match UnixListener::bind(&path) {
            Ok(listener) => {
                tokio::spawn(async move {
                    loop {
                        match listener.accept().await {
                            Ok((stream, _)) => {
                                let app = app.clone();
                                tokio::spawn(async move {
                                    handle_unix_stream(app, stream).await;
                                });
                            }
                            Err(e) => {
                                log::warn!("a2ui-bridge accept failed: {e}");
                                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            }
                        }
                    }
                });
            }
            Err(e) => {
                log::warn!("a2ui-bridge bind {path_str} failed: {e}");
            }
        }
    }

    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        let path_str_clone = path_str.clone();
        tokio::spawn(async move {
            loop {
                let server = match ServerOptions::new()
                    .first_pipe_instance(false)
                    .create(&path_str_clone)
                {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("a2ui-bridge create pipe failed: {e}");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        continue;
                    }
                };
                if let Err(e) = server.connect().await {
                    log::warn!("a2ui-bridge connect failed: {e}");
                    continue;
                }
                let app = app.clone();
                tokio::spawn(async move {
                    handle_named_pipe(app, server).await;
                });
            }
        });
    }
}

#[cfg(unix)]
async fn handle_unix_stream(app: AppHandle, stream: tokio::net::UnixStream) {
    let mut reader = BufReader::new(stream).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        forward_line(&app, line.trim());
    }
}

#[cfg(windows)]
async fn handle_named_pipe(app: AppHandle, pipe: tokio::net::windows::named_pipe::NamedPipeServer) {
    let mut reader = BufReader::new(pipe).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        forward_line(&app, line.trim());
    }
}

fn forward_line(app: &AppHandle, line: &str) {
    if line.is_empty() {
        return;
    }
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("a2ui-bridge: bad JSON line: {e}");
            return;
        }
    };
    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if kind != "a2ui_dispatch" {
        log::warn!("a2ui-bridge: ignoring unknown payload type {kind}");
        return;
    }
    if let Err(e) = app.emit(A2UI_EVENT, &value) {
        log::error!("a2ui-bridge emit failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn windows_pipe_path_is_unique_per_app_data_root() {
        let first = super::socket_path_for_base(std::path::Path::new(
            r"C:\Users\alice\AppData\Local\com.cognia.one",
        ));
        let second = super::socket_path_for_base(std::path::Path::new(
            r"C:\Users\alice\AppData\Local\com.cognia.two",
        ));

        assert_ne!(first, second);
        assert!(first
            .to_string_lossy()
            .starts_with(r"\\.\pipe\cognia-next-a2ui-bridge-"));
        assert!(second
            .to_string_lossy()
            .starts_with(r"\\.\pipe\cognia-next-a2ui-bridge-"));
    }
}
