//! Headless terminal execution (unattended workflow path).
//!
//! Runs shell command lines in a *real* shell with OSC 633 integration —
//! exactly like a dock tab — but the PTY lives only in Rust: no
//! `TerminalState` entry, no renderer session row, no visible tab. The
//! renderer's policy layer (`lib/terminal/headless-exec.ts`) gates every
//! call through the command-safety classifier before it reaches here.
//!
//! Two shapes:
//!   * `terminal_headless_exec` — one-shot: spawn, run one line, kill.
//!   * `terminal_headless_spawn` / `_run` / `_kill` — a persistent private
//!     session for multi-step workflow nodes (same shell, same cwd, same
//!     env across steps), tracked in [`HeadlessTerminalState`].
//!
//! Output capture: the OSC 633 `C` (command start) event opens a capture
//! window in the raw byte stream and `D` (command end, with exit code)
//! schedules it to close on the *next* data chunk (the chunk carrying `D`
//! usually also carries the tail of the command's output and the next
//! prompt). The window is then stripped of escape sequences, and a
//! trailing line without a newline (the freshly painted prompt) is
//! dropped. Best-effort by construction — when shell integration is
//! broken the run ends by timeout with the stripped raw tail instead.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tokio::sync::{mpsc, Mutex as TokioMutex};
use uuid::Uuid;

use super::integration::ShellKind;
use super::osc633::IntegrationEvent;
use super::session::{
    detached_desk_channel, spawn_session_with_sink, EventSink, PtySession, SessionOrigin,
    SpawnRequest, TerminalEvent,
};

/// Hard ceiling for one run's wall clock.
const MAX_TIMEOUT_MS: u64 = 600_000;
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// Cap on the raw capture buffer per session (newest bytes kept).
const MAX_RAW_BYTES: usize = 4 * 1024 * 1024;
/// Wide columns so wrapped lines don't litter the captured output.
const HEADLESS_COLS: u16 = 200;
const HEADLESS_ROWS: u16 = 24;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessExecResult {
    pub output: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessSpawnResult {
    pub session_id: String,
    pub shell: String,
}

/// What the sink reports back to a pending `run`.
enum RunSignal {
    /// A command completed (OSC 633 D) and its capture window was drained.
    Done {
        /// Byte offset the window opened at — lets `run` discard
        /// completions for windows that began before its own write (the
        /// startup prompt's D, a previously timed-out command, …).
        start: usize,
        exit_code: Option<i32>,
        output: String,
    },
    /// The shell process itself exited — the session is dead.
    SessionExited { code: Option<u32> },
}

enum Phase {
    Idle,
    /// OSC 633 C seen — output is accumulating from `start`.
    Capturing {
        start: usize,
    },
    /// OSC 633 D seen — close the window after the next data chunk lands.
    Draining {
        start: usize,
        exit_code: Option<i32>,
    },
}

struct CaptureState {
    raw: Vec<u8>,
    truncated: bool,
    phase: Phase,
    /// Write-time anchor installed by `run` — consumed by the next
    /// CommandStart/CommandEnd so a D arriving while the phase is mid-drain
    /// (stale window) still opens *this* run's window at the right offset.
    pending_anchor: Option<usize>,
}

pub struct HeadlessSession {
    pub id: String,
    pub shell: String,
    session: PtySession,
    capture: Arc<StdMutex<CaptureState>>,
    /// Receiver half of the run-completion channel. A `run` holds this
    /// (tokio) lock for its whole duration, which also serializes runs —
    /// the PTY is single-writer.
    signals: TokioMutex<mpsc::UnboundedReceiver<RunSignal>>,
    /// Flips true on the first OSC 633 B (prompt end) — the shell is
    /// interactive and the startup banner/prompt noise is behind us.
    /// `run` waits for this before writing so the startup prompt's D can
    /// never masquerade as a command completion.
    ready: tokio::sync::watch::Receiver<bool>,
    exited: Arc<AtomicBool>,
}

/// Registry of live headless sessions — managed Tauri state alongside
/// (but independent of) `TerminalState`.
#[derive(Default)]
pub struct HeadlessTerminalState {
    sessions: StdMutex<HashMap<String, Arc<HeadlessSession>>>,
}

impl HeadlessTerminalState {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, session: Arc<HeadlessSession>) {
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session.id.clone(), session);
    }

    fn get(&self, id: &str) -> Option<Arc<HeadlessSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
    }

    fn remove(&self, id: &str) -> Option<Arc<HeadlessSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id)
    }
}

/// Strip terminal escape sequences from captured bytes: OSC
/// (`ESC ] … BEL` / `ESC ] … ESC \`), CSI (`ESC [ … <final>`), and other
/// two-byte ESC forms. Lossy-UTF-8 the remainder and normalize CRLF.
fn strip_escapes(bytes: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b != 0x1b {
            out.push(b);
            i += 1;
            continue;
        }
        // ESC sequence — classify by the next byte.
        let Some(&next) = bytes.get(i + 1) else {
            break;
        };
        match next {
            b']' => {
                // OSC — runs to BEL or ESC \.
                i += 2;
                while i < bytes.len() {
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            }
            b'[' => {
                // CSI — runs to a final byte in 0x40..=0x7e.
                i += 2;
                while i < bytes.len() {
                    let c = bytes[i];
                    i += 1;
                    if (0x40..=0x7e).contains(&c) {
                        break;
                    }
                }
            }
            _ => {
                // Two-byte escape (charset selection, keypad modes, …).
                i += 2;
            }
        }
    }
    let text = String::from_utf8_lossy(&out).replace("\r\n", "\n");
    text.replace('\r', "\n")
}

/// Drop a leading line that is just the echoed command (write-time-anchored
/// windows include the echo; C-anchored windows start past it and are
/// unaffected unless the command's first output line literally repeats it).
fn strip_command_echo(output: &str, command: &str) -> String {
    match output.split_once('\n') {
        Some((first, rest)) if first.trim_end().ends_with(command) => rest.to_string(),
        None if output.trim_end().ends_with(command) => String::new(),
        _ => output.to_string(),
    }
}

/// Post-process one capture window into the result text: strip escapes,
/// then drop a trailing line with no newline of its own — that's the next
/// prompt being painted, not command output.
fn finalize_output(window: &[u8]) -> String {
    let text = strip_escapes(window);
    match text.rfind('\n') {
        Some(idx) => text[..=idx].trim_end_matches('\n').to_string(),
        // No newline at all — a no-output command; whatever is here is
        // prompt noise.
        None => String::new(),
    }
}

/// Build the sink that maintains the capture state machine and reports
/// run completions / session exit through `tx`.
fn build_capture_sink(
    capture: Arc<StdMutex<CaptureState>>,
    exited: Arc<AtomicBool>,
    tx: mpsc::UnboundedSender<RunSignal>,
    ready_tx: tokio::sync::watch::Sender<bool>,
) -> EventSink {
    Arc::new(move |_seq, event| {
        let mut state = capture.lock().unwrap_or_else(|p| p.into_inner());
        match event {
            TerminalEvent::Data { bytes } => {
                if state.raw.len() < MAX_RAW_BYTES {
                    let room = MAX_RAW_BYTES - state.raw.len();
                    if bytes.len() > room {
                        state.raw.extend_from_slice(&bytes[..room]);
                        state.truncated = true;
                    } else {
                        state.raw.extend_from_slice(&bytes);
                    }
                } else {
                    state.truncated = true;
                }
                if let Phase::Draining { start, exit_code } = state.phase {
                    let output = finalize_output(&state.raw[start.min(state.raw.len())..]);
                    state.phase = Phase::Idle;
                    let _ = tx.send(RunSignal::Done {
                        start,
                        exit_code,
                        output,
                    });
                }
            }
            TerminalEvent::Integration { event } => match event {
                IntegrationEvent::CommandStart => {
                    // C refines the window start past the echoed command
                    // line. Shells without the C hook (headless pwsh, cmd)
                    // keep the write-time anchor `run` installed instead.
                    state.pending_anchor = None;
                    state.phase = Phase::Capturing {
                        start: state.raw.len(),
                    };
                }
                IntegrationEvent::CommandEnd { exit_code } => {
                    let start = match state.phase {
                        Phase::Capturing { start } => start,
                        // No C seen — fall back to the write-time anchor
                        // (or the whole tail under degraded integration).
                        _ => state.pending_anchor.unwrap_or(0),
                    };
                    state.pending_anchor = None;
                    state.phase = Phase::Draining { start, exit_code };
                }
                IntegrationEvent::PromptEnd => {
                    // First interactive prompt — the session is ready for
                    // scripted input.
                    let _ = ready_tx.send(true);
                }
                _ => {}
            },
            TerminalEvent::Exit { code } => {
                exited.store(true, Ordering::SeqCst);
                let _ = tx.send(RunSignal::SessionExited { code });
            }
        }
    })
}

/// Spawn a private headless PTY session (not registered in the dock).
pub fn spawn_headless(
    shell: Option<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
    script_dir: &std::path::Path,
    path: &super::session::PathInjection,
    sandboxed: bool,
) -> Result<HeadlessSession, String> {
    let shell = shell
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(default_headless_shell);

    let mut env = env;
    // Integration scripts skip interactive-only machinery (PSReadLine key
    // handlers) when this is set; explicit caller env still wins.
    env.entry("COGNIA_TERM_HEADLESS".to_string())
        .or_insert_with(|| "1".to_string());

    let req = SpawnRequest {
        args: no_profile_args(&shell),
        shell,
        cwd: cwd.filter(|s| !s.trim().is_empty()),
        env,
        rows: HEADLESS_ROWS,
        cols: HEADLESS_COLS,
        project_id: None,
        extension_id: None,
        enable_shell_integration: true,
        force_utf8: true,
        origin: SessionOrigin::Local,
        skip_user_profile: true,
        // ADR-0028 Phase 3.3 — honor the caller's sandbox choice. The
        // workflow terminal node and the chat headless-exec path read the
        // global `settings.terminal.sandboxed` toggle and pass it through;
        // spawn_session_with_sink then wraps the shell in bwrap / sandbox-exec.
        sandboxed,
    };

    let capture = Arc::new(StdMutex::new(CaptureState {
        raw: Vec::new(),
        truncated: false,
        phase: Phase::Idle,
        pending_anchor: None,
    }));
    let exited = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
    let sink = build_capture_sink(capture.clone(), exited.clone(), tx, ready_tx);

    let session = spawn_session_with_sink(req, script_dir, path, sink, detached_desk_channel())?;
    Ok(HeadlessSession {
        id: Uuid::new_v4().to_string(),
        shell: session.shell.clone(),
        session,
        capture,
        signals: TokioMutex::new(rx),
        ready: ready_rx,
        exited,
    })
}

/// Skip the user's interactive profile for headless runs. Prompt
/// frameworks and custom PSReadLine key handlers are exactly the kind of
/// interactive machinery that breaks unattended input (and they fight the
/// injected shell-integration hooks, which still load via the
/// integration argv/env on top of these flags).
fn no_profile_args(shell: &str) -> Vec<String> {
    match ShellKind::from_shell_path(shell) {
        ShellKind::Pwsh | ShellKind::PowerShell => {
            vec!["-NoLogo".into(), "-NoProfile".into()]
        }
        ShellKind::Bash => vec!["--noprofile".into()],
        _ => Vec::new(),
    }
}

/// Platform default shell for headless runs (mirrors the dock defaults).
fn default_headless_shell() -> String {
    if cfg!(windows) {
        "pwsh.exe".to_string()
    } else if cfg!(target_os = "macos") {
        "/bin/zsh".to_string()
    } else {
        "/bin/bash".to_string()
    }
}

impl HeadlessSession {
    /// Write one command line and wait for its OSC 633 command-end (or the
    /// timeout). Serializes with other runs on the same session.
    pub async fn run(
        &self,
        command: &str,
        timeout_ms: Option<u64>,
    ) -> Result<HeadlessExecResult, String> {
        let command = command.trim();
        if command.is_empty() {
            return Err("command is required".into());
        }
        if self.exited.load(Ordering::SeqCst) {
            return Err("headless session has exited".into());
        }
        let budget =
            Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS));
        let started = Instant::now();

        // Exclusive run slot.
        let mut rx = self.signals.lock().await;

        // Wait for the first interactive prompt before typing — otherwise
        // the startup prompt's D event is indistinguishable from this
        // command's completion. Degraded integration (no OSC 633) never
        // flips ready; proceed after a bounded wait and rely on timeout.
        if !*self.ready.borrow() {
            let mut ready = self.ready.clone();
            let wait = budget.min(Duration::from_secs(10));
            let _ = tokio::time::timeout(wait, async {
                while !*ready.borrow() {
                    if ready.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;
        }

        // Drain stale completions (the startup prompt's D, an earlier
        // timed-out run) so we never return their results here.
        while let Ok(stale) = rx.try_recv() {
            if let RunSignal::SessionExited { .. } = stale {
                self.exited.store(true, Ordering::SeqCst);
                return Err("headless session has exited".into());
            }
        }

        // Anchor the capture window at the write position so shells whose
        // integration lacks the C (pre-exec) hook still get a window that
        // starts at this command. A later C event narrows it past the echo.
        let write_pos = {
            let mut state = self.capture.lock().unwrap_or_else(|p| p.into_inner());
            let pos = state.raw.len();
            state.pending_anchor = Some(pos);
            if matches!(state.phase, Phase::Idle) {
                state.phase = Phase::Capturing { start: pos };
            }
            pos
        };

        let line = format!("{command}\r");
        self.session
            .write(line.as_bytes())
            .map_err(|e| format!("write failed: {e}"))?;

        loop {
            let remaining = budget.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Ok(self.timeout_result(started));
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(RunSignal::Done {
                    start,
                    exit_code,
                    output,
                })) => {
                    if start < write_pos {
                        // A window that opened before our write — the
                        // startup prompt or a previously timed-out command
                        // completing late. Not ours; keep waiting.
                        continue;
                    }
                    return Ok(HeadlessExecResult {
                        output: strip_command_echo(&output, command),
                        exit_code,
                        timed_out: false,
                        duration_ms: started.elapsed().as_millis() as u64,
                    });
                }
                Ok(Some(RunSignal::SessionExited { code })) => {
                    self.exited.store(true, Ordering::SeqCst);
                    return Ok(HeadlessExecResult {
                        output: self.raw_tail(),
                        exit_code: code.map(|c| c as i32),
                        timed_out: false,
                        duration_ms: started.elapsed().as_millis() as u64,
                    });
                }
                Ok(None) => return Err("headless session event stream closed".into()),
                Err(_) => return Ok(self.timeout_result(started)),
            }
        }
    }

    fn timeout_result(&self, started: Instant) -> HeadlessExecResult {
        HeadlessExecResult {
            output: self.raw_tail(),
            exit_code: None,
            timed_out: true,
            duration_ms: started.elapsed().as_millis() as u64,
        }
    }

    /// Stripped capture-window-so-far (timeout / session-death fallback).
    fn raw_tail(&self) -> String {
        let state = self.capture.lock().unwrap_or_else(|p| p.into_inner());
        let start = match state.phase {
            Phase::Capturing { start } | Phase::Draining { start, .. } => start,
            Phase::Idle => 0,
        };
        strip_escapes(&state.raw[start.min(state.raw.len())..])
            .trim_end()
            .to_string()
    }

    pub fn kill(&self) {
        let _ = self.session.kill();
    }
}

impl Drop for HeadlessSession {
    fn drop(&mut self) {
        // Belt-and-braces: a headless PTY must never outlive its handle.
        let _ = self.session.kill();
    }
}

// --- Tauri commands --------------------------------------------------------

fn resolve_dirs<R: Runtime>(app: &AppHandle<R>) -> (PathBuf, super::session::PathInjection) {
    (
        super::commands::resolve_script_dir(app),
        super::commands::build_cli_path_injection(app),
    )
}

/// One-shot: spawn a private shell, run one line, kill. The workhorse for
/// the unattended workflow terminal node.
#[tauri::command]
pub async fn terminal_headless_exec<R: Runtime>(
    app: AppHandle<R>,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    sandboxed: Option<bool>,
) -> Result<HeadlessExecResult, String> {
    let (script_dir, path) = resolve_dirs(&app);
    let session = spawn_headless(
        shell,
        cwd,
        env.unwrap_or_default(),
        &script_dir,
        &path,
        sandboxed.unwrap_or(false),
    )?;
    let result = session.run(&command, timeout_ms).await;
    session.kill();
    result
}

/// Spawn a persistent headless session for multi-step runs.
#[tauri::command]
pub fn terminal_headless_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, HeadlessTerminalState>,
    cwd: Option<String>,
    shell: Option<String>,
    env: Option<HashMap<String, String>>,
    sandboxed: Option<bool>,
) -> Result<HeadlessSpawnResult, String> {
    let (script_dir, path) = resolve_dirs(&app);
    let session = spawn_headless(
        shell,
        cwd,
        env.unwrap_or_default(),
        &script_dir,
        &path,
        sandboxed.unwrap_or(false),
    )?;
    let result = HeadlessSpawnResult {
        session_id: session.id.clone(),
        shell: session.shell.clone(),
    };
    state.insert(Arc::new(session));
    Ok(result)
}

/// Run one command line in a persistent headless session.
#[tauri::command]
pub async fn terminal_headless_run(
    state: tauri::State<'_, HeadlessTerminalState>,
    session_id: String,
    command: String,
    timeout_ms: Option<u64>,
) -> Result<HeadlessExecResult, String> {
    let session = state
        .get(&session_id)
        .ok_or_else(|| format!("unknown headless session: {session_id}"))?;
    session.run(&command, timeout_ms).await
}

/// Kill + forget a persistent headless session. Idempotent.
#[tauri::command]
pub fn terminal_headless_kill(
    state: tauri::State<'_, HeadlessTerminalState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(session) = state.remove(&session_id) {
        session.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script_dir() -> PathBuf {
        // Mirror `commands::resolve_script_dir`'s dev fallback: the shell
        // integration scripts live under src-tauri/resources/terminal/;
        // CARGO_MANIFEST_DIR is crates/cognia-terminal, two hops below the
        // workspace root (ADR-0067 extraction). Pointing at the crate-local
        // `resources/terminal` (which doesn't exist) silently disables OSC 633
        // integration, so `run` never sees a CommandEnd marker and times out.
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest
            .ancestors()
            .nth(2)
            .map(|root| root.join("src-tauri"))
            .unwrap_or(manifest)
            .join("resources")
            .join("terminal")
    }

    fn test_shell() -> String {
        if cfg!(windows) {
            // resolve_shell_binary falls back to powershell.exe when
            // PowerShell 7 isn't installed.
            "pwsh.exe".to_string()
        } else {
            "/bin/bash".to_string()
        }
    }

    fn spawn_test_session() -> HeadlessSession {
        spawn_headless(
            Some(test_shell()),
            None,
            HashMap::new(),
            &script_dir(),
            &super::super::session::PathInjection::default(),
            false,
        )
        .expect("headless spawn")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn runs_a_command_and_captures_output_and_exit() {
        let session = spawn_test_session();
        let result = session
            .run("echo cognia-headless-ok", Some(60_000))
            .await
            .expect("run ok");
        session.kill();
        assert!(!result.timed_out, "should not time out: {result:?}");
        assert!(
            result.output.contains("cognia-headless-ok"),
            "output: {:?}",
            result.output
        );
        assert_eq!(result.exit_code, Some(0));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reports_a_nonzero_exit_code() {
        let session = spawn_test_session();
        let cmd = if cfg!(windows) { "exit 3" } else { "(exit 3)" };
        let result = session.run(cmd, Some(60_000)).await.expect("run ok");
        session.kill();
        // `exit 3` in pwsh ends the shell itself on some hosts; accept
        // either the captured code or a session-exit with code 3.
        assert_eq!(result.exit_code, Some(3), "result: {result:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sequential_runs_share_the_session_state() {
        let session = spawn_test_session();
        let setvar = if cfg!(windows) {
            "$env:COGNIA_HL_T = 'persisted'"
        } else {
            "COGNIA_HL_T=persisted"
        };
        let readvar = if cfg!(windows) {
            "echo $env:COGNIA_HL_T"
        } else {
            "echo $COGNIA_HL_T"
        };
        session.run(setvar, Some(60_000)).await.expect("set");
        let result = session.run(readvar, Some(60_000)).await.expect("read");
        session.kill();
        assert!(
            result.output.contains("persisted"),
            "output: {:?}",
            result.output
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn times_out_a_hanging_command() {
        let session = spawn_test_session();
        let sleeper = if cfg!(windows) {
            "Start-Sleep -Seconds 30"
        } else {
            "sleep 30"
        };
        let result = session.run(sleeper, Some(1_500)).await.expect("run ok");
        session.kill();
        assert!(result.timed_out, "expected timeout: {result:?}");
        assert!(result.exit_code.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_an_empty_command_and_runs_after_kill_fail() {
        let session = spawn_test_session();
        assert!(session.run("   ", Some(5_000)).await.is_err());
        session.kill();
    }

    #[test]
    fn registry_roundtrip_and_idempotent_remove() {
        let state = HeadlessTerminalState::new();
        let session = Arc::new(spawn_test_session());
        let id = session.id.clone();
        state.insert(session);
        assert!(state.get(&id).is_some());
        let removed = state.remove(&id).expect("removed");
        removed.kill();
        assert!(state.get(&id).is_none());
        assert!(state.remove(&id).is_none());
    }

    #[test]
    fn strip_escapes_removes_osc_and_csi() {
        let bytes = b"\x1b]633;C;nonce\x07hello \x1b[32mgreen\x1b[0m\r\nworld\r\n\x1b]633;D;nonce;0\x07prompt>";
        let text = strip_escapes(bytes);
        assert_eq!(text, "hello green\nworld\nprompt>");
    }

    #[test]
    fn finalize_output_drops_the_trailing_prompt_line() {
        let bytes = b"hello\r\nworld\r\nPS D:\\repo>";
        assert_eq!(finalize_output(bytes), "hello\nworld");
        assert_eq!(finalize_output(b"no-newline-prompt>"), "");
    }
}
