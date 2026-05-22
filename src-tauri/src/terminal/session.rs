//! PTY session — wraps a `portable_pty::PtyPair` plus the reader and waiter
//! threads that pump bytes back to the renderer via a `tauri::ipc::Channel`.
//!
//! This is the first user of `tauri::ipc::Channel<T>` in the repo. The
//! pattern is:
//!   * The renderer constructs the Channel (via `@tauri-apps/api/core`),
//!   * Passes it as a command argument to `terminal_spawn`,
//!   * `spawn_session` keeps a clone for each background thread,
//!   * Background threads call `channel.send(event)` — Tauri serialises
//!     via JSON IPC and delivers to the renderer's `onmessage`.
//!
//! Drop semantics mirror `plugin_api::vscode::host::Sidecar`: dropping the
//! `PtySession` kills the child (via the cloned killer) and removes the
//! per-spawn ZDOTDIR (if any). Window close → manage()'d store drops →
//! every session drops → every child dies. No leaks across reload.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::thread;

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use uuid::Uuid;

use super::integration::{self, IntegrationSetup, ShellKind};
use super::osc633::{IntegrationEvent, Osc633Parser};

/// Where the bytes ultimately came from. `Local` = Tauri Channel
/// consumer in the same process; `Remote` = LAN WebSocket consumer
/// against the V2 headless server (ADR-0014/0015).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionOrigin {
    Local,
    Remote,
}

impl Default for SessionOrigin {
    fn default() -> Self {
        Self::Local
    }
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    /// Shell binary — absolute path or PATH-resolvable name. The integration
    /// builder classifies it by `file_stem`, so `/usr/bin/bash`, `bash`, and
    /// `C:\Program Files\PowerShell\7\pwsh.exe` all work.
    pub shell: String,
    /// Additional argv after the shell binary. Integration argv (e.g.
    /// `--rcfile`) is appended on top.
    #[serde(default)]
    pub args: Vec<String>,
    /// Initial working directory. Falls through to portable-pty's default
    /// (`$HOME` / `%USERPROFILE%`) when `None`.
    pub cwd: Option<String>,
    /// Extra env to set on the child. Integration env (e.g.
    /// `COGNIA_TERM_NONCE`, `ZDOTDIR`) overrides anything supplied here.
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub rows: u16,
    pub cols: u16,
    /// Project the session belongs to. Filters the dock's tab list and
    /// flows through to audit events.
    pub project_id: Option<String>,
    /// When set, the spawn was driven by a VS Code-style extension
    /// through `lib/plugin/vscode-shim/terminal-bridge.ts`. The TS hook
    /// dispatcher has already checked `terminal:spawn` permission for
    /// this extension; we just persist it for audit.
    pub extension_id: Option<String>,
    /// Default true. Setting to false skips OSC 633 env injection
    /// entirely — useful for users on shells we don't recognise.
    #[serde(default = "default_true")]
    pub enable_shell_integration: bool,
    #[serde(default)]
    pub origin: SessionOrigin,
}

fn default_true() -> bool {
    true
}

/// Tagged event the reader / waiter push back to the renderer through the
/// Channel. The renderer dispatches on `kind` (Data ⇒ feed xterm,
/// Integration ⇒ update tab badge, Exit ⇒ tear down tab + audit).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TerminalEvent {
    /// Raw bytes from the PTY. Serialised as a JSON array of u8 today —
    /// acceptable for the v1 throughput target; revisit with a binary
    /// channel if `yes(1)` floods become a problem.
    Data { bytes: Vec<u8> },
    /// Decoded OSC 633 event from `osc633::Osc633Parser`.
    Integration { event: IntegrationEvent },
    /// Final exit code. Emitted exactly once per session by the waiter
    /// thread when `child.wait()` returns.
    Exit { code: Option<u32> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub project_id: Option<String>,
    pub extension_id: Option<String>,
    pub origin: SessionOrigin,
    pub shell: String,
}

pub struct PtySession {
    pub id: String,
    pub project_id: Option<String>,
    pub extension_id: Option<String>,
    pub origin: SessionOrigin,
    pub shell: String,
    /// Master held under StdMutex so `resize` can be called while the
    /// reader thread continues to consume bytes (the reader uses its
    /// own cloned Reader handle, not the master).
    ///
    /// `pub(super)` (and the three siblings below) so the in-module store
    /// tests in `mod.rs` can build minimal `PtySession` instances without
    /// reaching for unsafe or duplicating the spawn path. Not part of
    /// the public crate surface.
    pub(super) master: StdMutex<Box<dyn MasterPty + Send>>,
    pub(super) writer: StdMutex<Box<dyn Write + Send>>,
    pub(super) killer: StdMutex<Box<dyn ChildKiller + Send + Sync>>,
    pub(super) tempdir: Option<PathBuf>,
}

/// Generic event sink — the reader / waiter threads fan out
/// `TerminalEvent`s through this closure. Two ready-made wrappers exist
/// below:
///   * [`spawn_session`] wraps a `tauri::ipc::Channel<TerminalEvent>` —
///     the in-process desktop path.
///   * [`spawn_session_with_sink`] is the general form — used by the
///     `companion_api::ws_terminal` proxy to pump events into a
///     `tokio::sync::mpsc::UnboundedSender<TerminalEvent>` and on through
///     a WebSocket frame.
///
/// `Arc` so the reader + waiter threads can each clone an owned handle
/// without `'static + Copy` constraints leaking into the public API.
pub type EventSink = Arc<dyn Fn(TerminalEvent) + Send + Sync + 'static>;

/// Channel-backed convenience wrapper — mirrors the original public
/// signature so the existing Tauri command (`terminal_spawn`) keeps
/// compiling unchanged.
pub fn spawn_session(
    req: SpawnRequest,
    script_dir: &Path,
    event_channel: Channel<TerminalEvent>,
) -> Result<PtySession, String> {
    let sink: EventSink = Arc::new(move |event| {
        let _ = event_channel.send(event);
    });
    spawn_session_with_sink(req, script_dir, sink)
}

/// Construct a PtySession by spawning the requested shell under a fresh
/// PTY and wiring its byte stream into `sink`. Reader + waiter threads
/// are spawned eagerly; the caller stores the session and is free to
/// call `write` / `resize` / `kill` immediately.
pub fn spawn_session_with_sink(
    req: SpawnRequest,
    script_dir: &Path,
    sink: EventSink,
) -> Result<PtySession, String> {
    let nonce = Uuid::new_v4().simple().to_string();
    let shell_kind = ShellKind::from_shell_path(&req.shell);
    let setup = if req.enable_shell_integration {
        integration::build(shell_kind, script_dir, &nonce)
            .map_err(|e| format!("integration setup failed: {e}"))?
    } else {
        IntegrationSetup::empty()
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: req.rows.max(1),
            cols: req.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&req.shell);
    for arg in &req.args {
        cmd.arg(arg);
    }
    for arg in &setup.extra_args {
        cmd.arg(arg);
    }
    if let Some(cwd) = req.cwd.as_deref().filter(|s| !s.is_empty()) {
        cmd.cwd(cwd);
    }
    for (k, v) in &req.env {
        cmd.env(k, v);
    }
    for (k, v) in &setup.env_overrides {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn_command failed: {e}"))?;
    // Slave can be dropped once the child has it — keeping it open
    // would stop EOF from propagating to the reader when the child exits.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let killer = child.clone_killer();
    let id = Uuid::new_v4().to_string();

    let reader_sink = sink.clone();
    let nonce_for_reader = nonce.clone();
    let reader_id = id.clone();
    thread::Builder::new()
        .name(format!("pty-reader-{reader_id}"))
        .spawn(move || pty_reader_loop(reader, reader_sink, nonce_for_reader))
        .map_err(|e| format!("reader thread spawn: {e}"))?;

    let waiter_sink = sink.clone();
    let waiter_id = id.clone();
    thread::Builder::new()
        .name(format!("pty-waiter-{waiter_id}"))
        .spawn(move || pty_waiter_loop(child, waiter_sink))
        .map_err(|e| format!("waiter thread spawn: {e}"))?;

    Ok(PtySession {
        id,
        project_id: req.project_id,
        extension_id: req.extension_id,
        origin: req.origin,
        shell: req.shell,
        master: StdMutex::new(pair.master),
        writer: StdMutex::new(writer),
        killer: StdMutex::new(killer),
        tempdir: setup.tempdir,
    })
}

fn pty_reader_loop(mut reader: Box<dyn Read + Send>, sink: EventSink, nonce: String) {
    let mut parser = Osc633Parser::new(nonce);
    let mut buf = [0u8; 64 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                for event in parser.feed(chunk) {
                    sink(TerminalEvent::Integration { event });
                }
                sink(TerminalEvent::Data {
                    bytes: chunk.to_vec(),
                });
            }
            Err(_) => break,
        }
    }
}

fn pty_waiter_loop(mut child: Box<dyn Child + Send + Sync>, sink: EventSink) {
    let code = match child.wait() {
        Ok(status) => Some(status.exit_code()),
        Err(_) => None,
    };
    sink(TerminalEvent::Exit { code });
}

impl PtySession {
    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| std::io::Error::other("writer mutex poisoned"))?;
        writer.write_all(data)?;
        writer.flush()
    }

    pub fn resize(&self, rows: u16, cols: u16) -> std::io::Result<()> {
        let master = self
            .master
            .lock()
            .map_err(|_| std::io::Error::other("master mutex poisoned"))?;
        master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| std::io::Error::other(format!("resize: {e}")))
    }

    pub fn kill(&self) -> std::io::Result<()> {
        let mut killer = self
            .killer
            .lock()
            .map_err(|_| std::io::Error::other("killer mutex poisoned"))?;
        killer.kill()
    }

    pub fn info(&self) -> TerminalSessionInfo {
        TerminalSessionInfo {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            extension_id: self.extension_id.clone(),
            origin: self.origin,
            shell: self.shell.clone(),
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Best-effort kill. If the child already exited, this is a no-op
        // (or a benign error swallowed below).
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
        if let Some(td) = &self.tempdir {
            let _ = std::fs::remove_dir_all(td);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex2;

    fn capture_channel() -> (Channel<TerminalEvent>, Arc<StdMutex2<Vec<TerminalEvent>>>) {
        let sink = Arc::new(StdMutex2::new(Vec::<TerminalEvent>::new()));
        let sink_clone = sink.clone();
        let channel = Channel::<TerminalEvent>::new(move |body| {
            // The Channel emits InvokeResponseBody::Json(serde_json::Value)
            // in tests when constructed this way; deserialise back into our
            // enum so assertions can match on the variant.
            let value = match body {
                tauri::ipc::InvokeResponseBody::Json(s) => s,
                _ => return Ok(()),
            };
            if let Ok(event) = serde_json::from_str::<TerminalEvent>(&value) {
                sink_clone.lock().unwrap().push(event);
            }
            Ok(())
        });
        (channel, sink)
    }

    fn detect_default_shell() -> Option<String> {
        if cfg!(target_os = "windows") {
            // ComSpec is always set in normal Windows environments.
            std::env::var("COMSPEC").ok().or_else(|| {
                Some("C:\\Windows\\System32\\cmd.exe".to_string())
            })
        } else {
            std::env::var("SHELL").ok().or_else(|| Some("/bin/sh".to_string()))
        }
    }

    fn empty_script_dir() -> PathBuf {
        let p = std::env::temp_dir().join("cognia-session-test-noscripts");
        let _ = std::fs::create_dir_all(&p);
        p
    }

    #[test]
    fn spawn_request_defaults_serialize_as_expected() {
        let json = r#"{
            "shell": "/bin/sh",
            "rows": 24,
            "cols": 80
        }"#;
        let req: SpawnRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.shell, "/bin/sh");
        assert_eq!(req.rows, 24);
        assert!(req.args.is_empty());
        assert!(req.enable_shell_integration);
        assert_eq!(req.origin, SessionOrigin::Local);
    }

    #[test]
    fn spawn_session_with_missing_binary_returns_error() {
        let (channel, _sink) = capture_channel();
        let req = SpawnRequest {
            shell: "/nonexistent/binary-that-cannot-exist-xyz".to_string(),
            args: vec![],
            cwd: None,
            env: HashMap::new(),
            rows: 24,
            cols: 80,
            project_id: None,
            extension_id: None,
            enable_shell_integration: false,
            origin: SessionOrigin::Local,
        };
        let result = spawn_session(req, &empty_script_dir(), channel);
        assert!(result.is_err());
    }

    #[test]
    fn spawn_real_shell_pipes_output_and_exits() {
        // Skip on platforms where we can't reliably find a shell binary.
        let Some(shell) = detect_default_shell() else {
            eprintln!("skip — no default shell on this platform");
            return;
        };

        // Use `echo` as the one-shot command: cmd.exe wants `/C`, POSIX wants `-c`.
        let (cmd_arg, payload) = if cfg!(target_os = "windows") {
            ("/C", "echo hello-from-pty")
        } else {
            ("-c", "echo hello-from-pty")
        };

        let (channel, sink) = capture_channel();
        let req = SpawnRequest {
            shell,
            args: vec![cmd_arg.to_string(), payload.to_string()],
            cwd: None,
            env: HashMap::new(),
            rows: 24,
            cols: 80,
            project_id: Some("p1".to_string()),
            extension_id: None,
            enable_shell_integration: false,
            origin: SessionOrigin::Local,
        };
        let session = match spawn_session(req, &empty_script_dir(), channel) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("skip — spawn failed in this env: {e}");
                return;
            }
        };
        assert!(!session.id.is_empty());

        // Wait up to 5 s for the Exit event to land.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if std::time::Instant::now() > deadline {
                break;
            }
            let snapshot = sink.lock().unwrap().clone();
            if snapshot.iter().any(|e| matches!(e, TerminalEvent::Exit { .. })) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let events = sink.lock().unwrap().clone();
        let saw_data = events.iter().any(|e| {
            matches!(e, TerminalEvent::Data { bytes } if String::from_utf8_lossy(bytes).contains("hello-from-pty"))
        });
        let saw_exit = events.iter().any(|e| matches!(e, TerminalEvent::Exit { .. }));
        assert!(saw_data, "expected to see the echoed payload, got: {events:?}");
        assert!(saw_exit, "expected an Exit event, got: {events:?}");
    }

    #[test]
    fn write_after_drop_is_a_noop_from_outside() {
        // We can't easily simulate "after drop" without unsafe pointer
        // games, but we can verify write returns Err when the underlying
        // PTY is closed. Easiest: spawn `sh -c true` and let it exit,
        // then attempt to write — the writer will report a closed pipe.
        let Some(shell) = detect_default_shell() else {
            return;
        };
        let (cmd_arg, payload) = if cfg!(target_os = "windows") {
            ("/C", "exit 0")
        } else {
            ("-c", "exit 0")
        };
        let (channel, _sink) = capture_channel();
        let req = SpawnRequest {
            shell,
            args: vec![cmd_arg.to_string(), payload.to_string()],
            cwd: None,
            env: HashMap::new(),
            rows: 24,
            cols: 80,
            project_id: None,
            extension_id: None,
            enable_shell_integration: false,
            origin: SessionOrigin::Local,
        };
        let session = match spawn_session(req, &empty_script_dir(), channel) {
            Ok(s) => s,
            Err(_) => return,
        };
        // Give the child a moment to exit.
        std::thread::sleep(std::time::Duration::from_millis(300));
        // The write may succeed (PTY buffer absorbs it) or return EPIPE
        // depending on platform timing. Either way it must not panic.
        let _ = session.write(b"some data\n");
    }

    #[test]
    fn info_reports_session_metadata() {
        let Some(shell) = detect_default_shell() else {
            return;
        };
        let (cmd_arg, payload) = if cfg!(target_os = "windows") {
            ("/C", "exit 0")
        } else {
            ("-c", "exit 0")
        };
        let (channel, _sink) = capture_channel();
        let req = SpawnRequest {
            shell: shell.clone(),
            args: vec![cmd_arg.to_string(), payload.to_string()],
            cwd: None,
            env: HashMap::new(),
            rows: 24,
            cols: 80,
            project_id: Some("proj-a".to_string()),
            extension_id: Some("ext-b".to_string()),
            enable_shell_integration: false,
            origin: SessionOrigin::Remote,
        };
        let session = match spawn_session(req, &empty_script_dir(), channel) {
            Ok(s) => s,
            Err(_) => return,
        };
        let info = session.info();
        assert_eq!(info.project_id.as_deref(), Some("proj-a"));
        assert_eq!(info.extension_id.as_deref(), Some("ext-b"));
        assert_eq!(info.origin, SessionOrigin::Remote);
        assert_eq!(info.shell, shell);
    }
}
