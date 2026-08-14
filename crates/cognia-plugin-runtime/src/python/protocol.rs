//! Python host subprocess management + NDJSON RPC.
//!
//! One [`PluginHost`] per loaded plugin: spawns
//! `<interpreter> -u <host.py>` with piped stdio (mirroring the Node
//! sidecar pattern in `src-tauri/src/claude/sidecar.rs`), correlates
//! requests/responses by numeric id through a pending-map of oneshot
//! senders, and forwards the child's stderr into the app log.
//!
//! Failure policy: a timeout or protocol corruption kills the process —
//! a host that stopped answering is unrecoverable by design (state lives
//! in the dead interpreter). Pending calls fail immediately when the
//! child exits.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, Semaphore};

use super::discover::Interpreter;
use super::events::{EventSink, PythonEvent};
use crate::{PluginError, Result};

/// Timeout for cheap control calls (ping, get_tools, get_info).
pub const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);
/// Timeout for plugin code execution (call_tool, call, import_main —
/// imports can be slow on cold caches).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// Per-host in-flight request cap. The interpreter processes requests
/// serially, so this is back-pressure (bounding the queue), not parallelism.
pub const DEFAULT_MAX_CONCURRENT_CALLS: usize = 4;

/// Spawn-time knobs for one host. Grows with host-level settings (env,
/// concurrency) without churning the `spawn` signature.
#[derive(Clone, Default)]
pub struct HostOptions {
    /// Renderer notification sink; `None` keeps log-only behavior.
    pub sink: Option<EventSink>,
    /// Opaque lifecycle generation copied onto every renderer event.
    pub generation: String,
    /// In-flight request cap; `None` → [`DEFAULT_MAX_CONCURRENT_CALLS`].
    pub max_concurrent_calls: Option<usize>,
    /// Extra environment variables forwarded to the host process.
    pub env: HashMap<String, String>,
    /// ADR-0028 Phase 3 — when true, the interpreter is launched under the OS
    /// sandbox (`bwrap` / `sandbox-exec`) on Linux/macOS. Off by default;
    /// Windows is not wrapped (its restricted-token runner captures output to
    /// a temp file and can't host a long-lived stdio JSON-RPC process — a
    /// live-pipe variant is a follow-up). Strict: a sandboxed spawn fails
    /// closed when no backend is available rather than running unsandboxed.
    pub sandboxed: bool,
}

/// Build the launcher scope for a sandboxed Python host. Pure (no I/O) so the
/// bind set is host-unit-testable on every platform.
///
/// Two binds matter beyond the launcher's standard system paths:
///   * the host-script's directory — re-exposed read-only *after* the
///     launcher's `--tmpfs /tmp`, so the embedded `host.py` (written to a temp
///     path by the loader) stays visible inside the sandbox;
///   * the interpreter's prefix — a venv root (covering its
///     `lib/.../site-packages`) or a no-op under `/usr` (already bound).
/// Writes are confined to a scratch tmp dir; network stays on (plugins fetch).
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn python_host_scope(
    host_script: &Path,
    interpreter_program: &str,
) -> cognia_automation::sandbox::launcher::LaunchScope {
    let mut readable: Vec<String> = Vec::new();
    if let Some(dir) = host_script.parent() {
        readable.push(dir.to_string_lossy().into_owned());
    }
    if let Some(prefix) = interpreter_prefix(interpreter_program) {
        readable.push(prefix);
    }
    let scratch = std::env::temp_dir().to_string_lossy().into_owned();
    cognia_automation::sandbox::launcher::LaunchScope {
        cwd: scratch.clone(),
        writable: vec![scratch],
        readable,
        network: true,
    }
}

/// The read-only prefix a non-system interpreter needs so its standard library
/// + `site-packages` resolve. For `/home/u/.venv/bin/python` → `/home/u/.venv`
/// (`bin`'s parent); for a system `/usr/bin/python3` → `None` (the launcher
/// already binds `/usr`); for a bare PATH name → `None`.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn interpreter_prefix(program: &str) -> Option<String> {
    let path = Path::new(program);
    if path.components().count() < 2 {
        return None; // bare name resolved on PATH
    }
    let prefix = path.parent()?.parent()?;
    let s = prefix.to_string_lossy();
    // System prefixes are already bound by the launcher baseline.
    if s == "/usr" || s == "/" || s.is_empty() {
        return None;
    }
    Some(s.into_owned())
}

/// Build the interpreter command, optionally wrapped in the OS sandbox
/// launcher (`bwrap` / `sandbox-exec`). Strict: a sandboxed request that can't
/// resolve a backend fails closed rather than running the host unsandboxed.
fn build_host_command(
    sandboxed: bool,
    program: &str,
    args: &[String],
    host_script: &Path,
) -> Result<Command> {
    if sandboxed {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let prefix = python_launch_prefix(host_script, program).ok_or_else(|| {
                PluginError::PythonHost(
                    "sandboxed python host requested but no sandbox backend \
                     (bwrap / sandbox-exec) is available"
                        .into(),
                )
            })?;
            let mut cmd = Command::new(&prefix[0]);
            for a in &prefix[1..] {
                cmd.arg(a);
            }
            cmd.arg(program).args(args).arg("-u").arg(host_script);
            return Ok(cmd);
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            // The Windows restricted-token runner captures output to a temp
            // file and can't host a long-lived stdio JSON-RPC process; a
            // live-pipe variant is a follow-up.
            return Err(PluginError::PythonHost(
                "sandboxed python host is not yet supported on this platform".into(),
            ));
        }
    }
    let mut cmd = Command::new(program);
    cmd.args(args).arg("-u").arg(host_script);
    Ok(cmd)
}

#[cfg(target_os = "linux")]
fn python_launch_prefix(host_script: &Path, program: &str) -> Option<Vec<String>> {
    let bwrap = which_on_path("bwrap")?;
    // Shared empty read-only dir bound over secret stores so the confined host
    // can't read `~/.ssh` / `~/.aws` / cognia's credential store (mirrors the
    // one-shot Linux backend).
    let empty_dir = std::env::temp_dir().join("cognia-sandbox-empty");
    let _ = std::fs::create_dir_all(&empty_dir);
    Some(cognia_automation::sandbox::launcher::bwrap_prefix(
        &bwrap,
        &python_host_scope(host_script, program),
        &empty_dir,
    ))
}

/// Drop code-injection env vars (`LD_PRELOAD`, `NODE_OPTIONS`, `GIT_SSH_COMMAND`,
/// …) from a sandboxed Python host's forwarded env — mirrors the one-shot
/// backend's `filter_env` so a confined plugin host can't inject code into the
/// child processes it spawns. Unsandboxed hosts are unchanged.
fn scrub_host_env(sandboxed: bool, env: HashMap<String, String>) -> Vec<(String, String)> {
    env.into_iter()
        .filter(|(k, _)| !(sandboxed && cognia_automation::sandbox::env::is_dangerous_env_key(k)))
        .collect()
}

#[cfg(target_os = "macos")]
fn python_launch_prefix(host_script: &Path, program: &str) -> Option<Vec<String>> {
    if !Path::new("/usr/bin/sandbox-exec").exists() {
        return None;
    }
    Some(cognia_automation::sandbox::launcher::sandbox_exec_prefix(
        &python_host_scope(host_script, program),
    ))
}

#[cfg(target_os = "linux")]
fn which_on_path(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(name))
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

type PendingMap = Arc<parking_lot::Mutex<HashMap<u64, oneshot::Sender<HostReply>>>>;

/// Raw host response: `Ok(result)` for `ok: true`, `Err(message)` for
/// `ok: false` or transport-level failures.
type HostReply = std::result::Result<Value, String>;

/// One parsed stdout line, classified. Extracted as a pure function so the
/// frame grammar is unit-testable without a live subprocess or `AppHandle`.
#[derive(Debug)]
pub enum Frame {
    /// Correlated reply — has a numeric `id`.
    Reply(Value),
    /// Un-correlated notification — `{"type":"event","event":...}`.
    Event {
        event: String,
        call_id: Option<u64>,
        data: Value,
    },
    /// Neither a reply nor a well-formed event.
    Malformed(Value),
}

/// Classify one protocol frame. Replies win: a frame carrying a numeric
/// `id` is always a reply, so event frames can never collide with the
/// request-id namespace consumed by the pending map.
pub fn classify_frame(value: Value) -> Frame {
    if value.get("id").and_then(Value::as_u64).is_some() {
        return Frame::Reply(value);
    }
    if value.get("type").and_then(Value::as_str) == Some("event") {
        if let Some(event) = value.get("event").and_then(Value::as_str) {
            return Frame::Event {
                event: event.to_string(),
                call_id: value.get("call_id").and_then(Value::as_u64),
                data: value.get("data").cloned().unwrap_or(Value::Null),
            };
        }
    }
    Frame::Malformed(value)
}

struct HostInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

/// A live Python host subprocess for one plugin.
pub struct PluginHost {
    plugin_id: String,
    inner: Mutex<HostInner>,
    next_id: AtomicU64,
    pending: PendingMap,
    /// Back-pressure: bounds in-flight requests per host.
    semaphore: Semaphore,
    /// Epoch ms of the most recent request activity (for idle shutdown).
    pub last_activity: AtomicU64,
}

impl PluginHost {
    /// Spawn `<interpreter argv> -u <host_script>` and wire the stdio tasks.
    pub async fn spawn(
        plugin_id: &str,
        interpreter: &Interpreter,
        host_script: &Path,
        options: HostOptions,
    ) -> Result<Arc<Self>> {
        let HostOptions {
            sink,
            generation,
            max_concurrent_calls,
            env,
            sandboxed,
        } = options;
        let (program, args) = interpreter
            .argv_prefix
            .split_first()
            .ok_or_else(|| PluginError::PythonHost("empty interpreter argv".into()))?;

        let mut cmd = build_host_command(sandboxed, program, args, host_script)?;
        cmd.envs(scrub_host_env(sandboxed, env))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Mirrors sidecar.rs:272-276 — no console flash in release builds.
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| {
            PluginError::PythonHost(format!(
                "failed to spawn python host ({}): {e}",
                interpreter.argv_prefix.join(" ")
            ))
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| PluginError::PythonHost("child has no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| PluginError::PythonHost("child has no stderr".into()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| PluginError::PythonHost("child has no stdin".into()))?;

        let host = Arc::new(Self {
            plugin_id: plugin_id.to_string(),
            inner: Mutex::new(HostInner {
                child: Some(child),
                stdin: Some(stdin),
            }),
            next_id: AtomicU64::new(1),
            pending: Arc::new(parking_lot::Mutex::new(HashMap::new())),
            semaphore: Semaphore::new(
                max_concurrent_calls
                    .unwrap_or(DEFAULT_MAX_CONCURRENT_CALLS)
                    .max(1),
            ),
            last_activity: AtomicU64::new(now_epoch_ms()),
        });

        // stdout reader: resolve pending requests by id; route notification
        // frames to the renderer sink.
        {
            let pending = Arc::clone(&host.pending);
            let plugin_id = host.plugin_id.clone();
            let generation = generation.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            match serde_json::from_str::<Value>(trimmed) {
                                Ok(value) => match classify_frame(value) {
                                    Frame::Reply(reply) => {
                                        dispatch_reply(&pending, &plugin_id, &reply)
                                    }
                                    Frame::Event {
                                        event,
                                        call_id,
                                        data,
                                    } => {
                                        if let Some(sink) = &sink {
                                            sink(PythonEvent {
                                                plugin_id: plugin_id.clone(),
                                                generation: generation.clone(),
                                                kind: event,
                                                call_id,
                                                data,
                                            });
                                        }
                                    }
                                    Frame::Malformed(value) => log::warn!(
                                        "[python.{plugin_id}] malformed protocol frame: {value}"
                                    ),
                                },
                                Err(e) => log::warn!(
                                    "[python.{plugin_id}] non-JSON protocol line ({e}): {}",
                                    &trimmed[..trimmed.len().min(200)]
                                ),
                            }
                        }
                        Ok(None) => break, // EOF — child exited
                        Err(e) => {
                            log::warn!("[python.{plugin_id}] stdout read error: {e}");
                            break;
                        }
                    }
                }
                // Child is gone: tell the renderer, then fail everything
                // still in flight.
                if let Some(sink) = &sink {
                    sink(PythonEvent {
                        plugin_id: plugin_id.clone(),
                        generation: generation.clone(),
                        kind: "exit".into(),
                        call_id: None,
                        data: Value::Null,
                    });
                }
                let mut map = pending.lock();
                for (_, tx) in map.drain() {
                    let _ = tx.send(Err("python host exited".into()));
                }
            });
        }

        // stderr reader: plugin prints + host diagnostics → app log AND the
        // renderer log surface.
        {
            let plugin_id = host.plugin_id.clone();
            let generation = generation.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::info!("[python.{plugin_id}] {line}");
                    if let Some(sink) = &sink {
                        sink(PythonEvent {
                            plugin_id: plugin_id.clone(),
                            generation: generation.clone(),
                            kind: "log".into(),
                            call_id: None,
                            data: serde_json::json!({ "line": line }),
                        });
                    }
                }
            });
        }

        Ok(host)
    }

    /// Send one request and await its correlated reply.
    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        // Back-pressure: never closed, so acquire only fails on overflow —
        // treat that as a host error rather than panicking.
        let _permit = self
            .semaphore
            .acquire()
            .await
            .map_err(|_| PluginError::PythonHost("host request gate closed".into()))?;
        self.last_activity.store(now_epoch_ms(), Ordering::Relaxed);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);

        let line = serde_json::to_string(&json!({
            "id": id,
            "method": method,
            "params": params,
        }))?;

        {
            let mut guard = self.inner.lock().await;
            let stdin = guard.stdin.as_mut().ok_or_else(|| {
                self.pending.lock().remove(&id);
                PluginError::PythonHost("python host is not running".into())
            })?;
            let write = async {
                stdin.write_all(line.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await?;
                std::io::Result::Ok(())
            };
            if let Err(e) = write.await {
                self.pending.lock().remove(&id);
                return Err(PluginError::PythonHost(format!("stdin write failed: {e}")));
            }
        }

        let outcome = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(PluginError::PythonHost(message)),
            // Sender dropped without a reply — reader task ended abnormally.
            Ok(Err(_)) => Err(PluginError::PythonHost("python host exited".into())),
            Err(_) => {
                self.pending.lock().remove(&id);
                self.kill().await;
                Err(PluginError::PythonHost(format!(
                    "request '{method}' timed out after {}s; host killed",
                    timeout.as_secs()
                )))
            }
        };
        // Completion bump: a long call must not read as idle time.
        self.last_activity.store(now_epoch_ms(), Ordering::Relaxed);
        outcome
    }

    /// Milliseconds since the last request activity on this host.
    pub fn idle_ms(&self) -> u64 {
        now_epoch_ms().saturating_sub(self.last_activity.load(Ordering::Relaxed))
    }

    /// Graceful termination: best-effort `shutdown` RPC (runs the plugin's
    /// `on_shutdown` convention) with a short deadline, then a hard kill.
    /// The timeout path inside [`Self::request`] already kills the host, so
    /// the trailing kill is an idempotent backstop.
    pub async fn shutdown(&self) {
        let _ = self
            .request("shutdown", json!({}), Duration::from_secs(2))
            .await;
        self.kill().await;
    }

    /// Terminate the subprocess. Idempotent.
    pub async fn kill(&self) {
        let mut guard = self.inner.lock().await;
        guard.stdin = None;
        if let Some(mut child) = guard.child.take() {
            if let Err(e) = child.kill().await {
                log::warn!("[python.{}] kill failed: {e}", self.plugin_id);
            }
        }
    }

    /// Liveness probe: protocol-level ping with the control timeout.
    pub async fn ping(&self) -> bool {
        matches!(
            self.request("ping", json!({}), CONTROL_TIMEOUT).await,
            Ok(Value::String(s)) if s == "pong"
        )
    }
}

fn dispatch_reply(pending: &PendingMap, plugin_id: &str, reply: &Value) {
    let Some(id) = reply.get("id").and_then(Value::as_u64) else {
        log::warn!("[python.{plugin_id}] protocol reply without id: {reply}");
        return;
    };
    let Some(tx) = pending.lock().remove(&id) else {
        log::warn!("[python.{plugin_id}] reply for unknown request id {id}");
        return;
    };
    let outcome = if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown host error")
            .to_string())
    };
    let _ = tx.send(outcome);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::python::discover::discover_interpreter;
    use std::path::PathBuf;

    fn host_script() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("python")
            .join("host.py")
    }

    #[test]
    fn build_host_command_unsandboxed_always_ok() {
        assert!(build_host_command(false, "python3", &[], Path::new("/tmp/h.py")).is_ok());
    }

    #[test]
    fn scrub_host_env_drops_injection_vars_only_when_sandboxed() {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/usr/bin".to_string());
        env.insert("LD_PRELOAD".to_string(), "/tmp/evil.so".to_string());
        env.insert(
            "NODE_OPTIONS".to_string(),
            "--require /tmp/x.js".to_string(),
        );

        // Sandboxed: injection vectors stripped, ordinary vars kept.
        let scrubbed: HashMap<_, _> = scrub_host_env(true, env.clone()).into_iter().collect();
        assert!(scrubbed.contains_key("PATH"));
        assert!(!scrubbed.contains_key("LD_PRELOAD"));
        assert!(!scrubbed.contains_key("NODE_OPTIONS"));

        // Unsandboxed: nothing is dropped.
        let untouched: HashMap<_, _> = scrub_host_env(false, env).into_iter().collect();
        assert_eq!(untouched.len(), 3);
    }

    #[test]
    fn build_host_command_sandboxed_is_platform_appropriate() {
        let res = build_host_command(true, "python3", &[], Path::new("/tmp/cognia/host.py"));
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        assert!(res.is_err(), "windows python sandbox must fail closed");
        // On Linux/macOS: Ok when bwrap/sandbox-exec resolves, strict Err
        // otherwise — never an unsandboxed silent fallback.
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let _ = res;
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn interpreter_prefix_handles_venv_system_and_bare() {
        assert_eq!(
            interpreter_prefix("/home/u/.venv/bin/python3"),
            Some("/home/u/.venv".to_string())
        );
        assert_eq!(interpreter_prefix("/usr/bin/python3"), None);
        assert_eq!(interpreter_prefix("python3"), None);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn python_host_scope_rebinds_host_script_dir_and_keeps_network() {
        let scope = python_host_scope(
            Path::new("/tmp/cognia-xyz/host.py"),
            "/home/u/.venv/bin/python3",
        );
        // host-script dir re-exposed (so the tmpfs /tmp can't hide host.py).
        assert!(scope.readable.iter().any(|r| r == "/tmp/cognia-xyz"));
        // venv prefix bound so site-packages resolves.
        assert!(scope.readable.iter().any(|r| r == "/home/u/.venv"));
        assert!(scope.network);
        assert!(!scope.writable.is_empty());
    }

    /// Resolve a real interpreter or skip (mirrors the repo's gated-test
    /// convention — GitHub runners ship Python, so CI exercises these).
    fn interpreter_or_skip(test: &str) -> Option<Interpreter> {
        match discover_interpreter(None) {
            Some(interp) => Some(interp),
            None => {
                eprintln!("skipping {test}: no python >= 3.9 interpreter found");
                None
            }
        }
    }

    /// Collecting sink for event assertions.
    fn collector() -> (EventSink, Arc<parking_lot::Mutex<Vec<PythonEvent>>>) {
        let collected: Arc<parking_lot::Mutex<Vec<PythonEvent>>> =
            Arc::new(parking_lot::Mutex::new(Vec::new()));
        let sink_target = Arc::clone(&collected);
        let sink: EventSink = Arc::new(move |event| sink_target.lock().push(event));
        (sink, collected)
    }

    /// Poll the collector until `pred` matches or the deadline passes.
    async fn wait_for_event(
        collected: &Arc<parking_lot::Mutex<Vec<PythonEvent>>>,
        pred: impl Fn(&PythonEvent) -> bool,
    ) -> bool {
        for _ in 0..100 {
            if collected.lock().iter().any(&pred) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    #[test]
    fn classify_reply_frames_by_numeric_id() {
        match classify_frame(json!({"id": 3, "ok": true, "result": 1})) {
            Frame::Reply(value) => assert_eq!(value["id"], 3),
            other => panic!("expected Reply, got {other:?}"),
        }
        // A frame with an id is ALWAYS a reply, even if it claims type=event.
        match classify_frame(json!({"id": 4, "type": "event", "event": "log"})) {
            Frame::Reply(_) => {}
            other => panic!("id wins over type=event, got {other:?}"),
        }
    }

    #[test]
    fn classify_event_frames_with_and_without_call_id() {
        match classify_frame(json!({"type": "event", "event": "log", "data": {"line": "x"}})) {
            Frame::Event {
                event,
                call_id,
                data,
            } => {
                assert_eq!(event, "log");
                assert_eq!(call_id, None);
                assert_eq!(data["line"], "x");
            }
            other => panic!("expected Event, got {other:?}"),
        }
        match classify_frame(json!({"type": "event", "event": "chunk", "call_id": 9})) {
            Frame::Event {
                event,
                call_id,
                data,
            } => {
                assert_eq!(event, "chunk");
                assert_eq!(call_id, Some(9));
                assert_eq!(data, Value::Null);
            }
            other => panic!("expected Event, got {other:?}"),
        }
    }

    #[test]
    fn classify_malformed_frames() {
        // No id, no type.
        assert!(matches!(
            classify_frame(json!({"ok": true})),
            Frame::Malformed(_)
        ));
        // type=event but no event name.
        assert!(matches!(
            classify_frame(json!({"type": "event", "data": 1})),
            Frame::Malformed(_)
        ));
        // Non-numeric id is not a reply id.
        assert!(matches!(
            classify_frame(json!({"id": "seven"})),
            Frame::Malformed(_)
        ));
    }

    #[tokio::test]
    async fn spawn_and_ping_roundtrips() {
        let Some(interp) = interpreter_or_skip("spawn_and_ping_roundtrips") else {
            return;
        };
        let host = PluginHost::spawn("t-ping", &interp, &host_script(), HostOptions::default())
            .await
            .unwrap();
        assert!(host.ping().await);
        host.kill().await;
    }

    #[tokio::test]
    async fn unknown_method_returns_python_host_error() {
        let Some(interp) = interpreter_or_skip("unknown_method_returns_python_host_error") else {
            return;
        };
        let host = PluginHost::spawn("t-unknown", &interp, &host_script(), HostOptions::default())
            .await
            .unwrap();
        let err = host
            .request("definitely_not_a_method", json!({}), CONTROL_TIMEOUT)
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::PythonHost(_)));
        assert!(err.to_string().contains("unknown method"));
        host.kill().await;
    }

    #[tokio::test]
    async fn concurrent_requests_correlate() {
        let Some(interp) = interpreter_or_skip("concurrent_requests_correlate") else {
            return;
        };
        let host = PluginHost::spawn(
            "t-concurrent",
            &interp,
            &host_script(),
            HostOptions::default(),
        )
        .await
        .unwrap();
        let pings = (0..8).map(|_| host.request("ping", json!({}), CONTROL_TIMEOUT));
        for result in futures_util::future::join_all(pings).await {
            assert_eq!(result.unwrap(), Value::String("pong".into()));
        }
        host.kill().await;
    }

    #[tokio::test]
    async fn timeout_kills_host_and_errors() {
        let Some(interp) = interpreter_or_skip("timeout_kills_host_and_errors") else {
            return;
        };
        // A "host" that reads requests but never answers.
        let tmp = tempfile::TempDir::new().unwrap();
        let silent = tmp.path().join("silent.py");
        std::fs::write(&silent, "import sys\nfor line in sys.stdin:\n    pass\n").unwrap();

        let host = PluginHost::spawn("t-timeout", &interp, &silent, HostOptions::default())
            .await
            .unwrap();
        let err = host
            .request("ping", json!({}), Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("timed out"));
        // Killed: a follow-up request fails fast on the missing stdin.
        let err = host
            .request("ping", json!({}), CONTROL_TIMEOUT)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not running") || err.to_string().contains("exited"));
    }

    #[tokio::test]
    async fn spawn_failure_is_python_host_error() {
        let interp = Interpreter {
            argv_prefix: vec!["cognia-no-such-python".into()],
            version: "3.99.0".into(),
        };
        match PluginHost::spawn(
            "t-spawn-fail",
            &interp,
            &host_script(),
            HostOptions::default(),
        )
        .await
        {
            Ok(_) => panic!("spawn with a bogus interpreter must fail"),
            Err(err) => assert!(matches!(err, PluginError::PythonHost(_))),
        }
    }

    /// max_concurrent_calls=1 forces serial queuing: two overlapping slow
    /// requests must take at least 2× the per-request delay.
    #[tokio::test]
    async fn semaphore_serializes_when_capped_to_one() {
        let Some(interp) = interpreter_or_skip("semaphore_serializes_when_capped_to_one") else {
            return;
        };
        let tmp = tempfile::TempDir::new().unwrap();
        let slow = tmp.path().join("slow.py");
        std::fs::write(
            &slow,
            r#"
import json, sys, time
for line in sys.stdin:
    req = json.loads(line)
    time.sleep(0.2)
    sys.stdout.write(json.dumps({"id": req["id"], "ok": True, "result": "pong"}) + "\n")
    sys.stdout.flush()
"#,
        )
        .unwrap();

        let host = PluginHost::spawn(
            "t-capped",
            &interp,
            &slow,
            HostOptions {
                max_concurrent_calls: Some(1),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let started = std::time::Instant::now();
        let both = futures_util::future::join_all(
            (0..2).map(|_| host.request("ping", json!({}), CONTROL_TIMEOUT)),
        )
        .await;
        for result in both {
            assert_eq!(result.unwrap(), Value::String("pong".into()));
        }
        assert!(
            started.elapsed() >= Duration::from_millis(380),
            "requests overlapped despite a 1-permit cap: {:?}",
            started.elapsed()
        );
        host.kill().await;
    }

    /// HostOptions.env is forwarded into the child process.
    #[tokio::test]
    async fn env_vars_reach_the_host_process() {
        let Some(interp) = interpreter_or_skip("env_vars_reach_the_host_process") else {
            return;
        };
        let tmp = tempfile::TempDir::new().unwrap();
        let echo_env = tmp.path().join("echo_env.py");
        std::fs::write(
            &echo_env,
            r#"
import json, os, sys
for line in sys.stdin:
    req = json.loads(line)
    sys.stdout.write(json.dumps({
        "id": req["id"], "ok": True, "result": os.environ.get("COGNIA_PLUGIN_FLAVOR", ""),
    }) + "\n")
    sys.stdout.flush()
"#,
        )
        .unwrap();

        let mut env = HashMap::new();
        env.insert("COGNIA_PLUGIN_FLAVOR".to_string(), "spicy".to_string());
        let host = PluginHost::spawn(
            "t-env",
            &interp,
            &echo_env,
            HostOptions {
                env,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let result = host
            .request("ping", json!({}), CONTROL_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(result, Value::String("spicy".into()));
        host.kill().await;
    }

    /// idle_ms grows from last_activity and resets on request completion.
    #[tokio::test]
    async fn idle_ms_tracks_request_activity() {
        let Some(interp) = interpreter_or_skip("idle_ms_tracks_request_activity") else {
            return;
        };
        let host = PluginHost::spawn("t-idle", &interp, &host_script(), HostOptions::default())
            .await
            .unwrap();
        // Backdate activity, confirm idle_ms sees it, then a request resets it.
        host.last_activity
            .store(now_epoch_ms() - 60_000, Ordering::Relaxed);
        assert!(host.idle_ms() >= 60_000);
        assert!(host.ping().await);
        assert!(host.idle_ms() < 10_000);
        host.kill().await;
    }

    /// Event frames must reach the sink WITHOUT disturbing reply correlation:
    /// a fake host emits an event before answering each request.
    #[tokio::test]
    async fn event_frames_route_to_sink_and_replies_still_correlate() {
        let Some(interp) = interpreter_or_skip("event_frames_route_to_sink") else {
            return;
        };
        let tmp = tempfile::TempDir::new().unwrap();
        let chatty = tmp.path().join("chatty.py");
        std::fs::write(
            &chatty,
            r#"
import json, sys
for line in sys.stdin:
    req = json.loads(line)
    sys.stdout.write(json.dumps({
        "type": "event", "event": "progress",
        "call_id": req["id"], "data": {"pct": 50},
    }) + "\n")
    sys.stdout.write(json.dumps({"id": req["id"], "ok": True, "result": "pong"}) + "\n")
    sys.stdout.flush()
"#,
        )
        .unwrap();

        let (sink, collected) = collector();
        let host = PluginHost::spawn(
            "t-events",
            &interp,
            &chatty,
            HostOptions {
                sink: Some(sink),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let result = host
            .request("ping", json!({}), CONTROL_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(result, Value::String("pong".into()));

        assert!(
            wait_for_event(&collected, |e| {
                e.kind == "progress" && e.plugin_id == "t-events" && e.data["pct"] == 50
            })
            .await,
            "progress event never reached the sink"
        );
        // The event's call_id mirrors the request id and must NOT have been
        // consumed as a reply (the reply above resolved normally).
        let events = collected.lock();
        let progress = events.iter().find(|e| e.kind == "progress").unwrap();
        assert_eq!(progress.call_id, Some(1));
        drop(events);
        host.kill().await;
    }

    /// stderr lines surface as `log` events; child exit emits `exit`.
    #[tokio::test]
    async fn stderr_logs_and_exit_reach_sink() {
        let Some(interp) = interpreter_or_skip("stderr_logs_and_exit_reach_sink") else {
            return;
        };
        let tmp = tempfile::TempDir::new().unwrap();
        let noisy = tmp.path().join("noisy.py");
        std::fs::write(
            &noisy,
            "import sys\nprint('hello from stderr', file=sys.stderr)\nsys.stderr.flush()\nfor line in sys.stdin:\n    pass\n",
        )
        .unwrap();

        let (sink, collected) = collector();
        let host = PluginHost::spawn(
            "t-stderr",
            &interp,
            &noisy,
            HostOptions {
                sink: Some(sink),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(
            wait_for_event(&collected, |e| {
                e.kind == "log" && e.data["line"] == "hello from stderr"
            })
            .await,
            "stderr line never surfaced as a log event"
        );
        host.kill().await;
        assert!(
            wait_for_event(&collected, |e| e.kind == "exit").await,
            "exit event never reached the sink"
        );
    }
}
