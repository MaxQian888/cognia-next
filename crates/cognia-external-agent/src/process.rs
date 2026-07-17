//! External Agent Process Management
//!
//! Handles spawning and managing external agent processes.
//! Based on patterns from skill_seekers/service.rs and mcp/transport/stdio.rs
//!
//! Stdout/stderr are forwarded **event-driven**: each reader task pushes lines
//! straight to an [`ExternalAgentEventSink`] (the Tauri command layer emits the
//! `external-agent://*` events), and a per-process supervisor task awaits the
//! child and pushes the exit event. There is no polling loop and no per-tick
//! lock on the manager — this mirrors the native Claude sidecar reader in
//! `claude/sidecar.rs` instead of the old 50ms drain loop.

use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, RwLock};

/// Sink for process lifecycle events. The Tauri command layer implements this
/// to emit `external-agent://*` events; unit tests pass a collector.
///
/// Methods are synchronous and must not block — they are invoked from the
/// stdout/stderr reader tasks and the supervisor task on the hot path.
pub trait ExternalAgentEventSink: Send + Sync + 'static {
    /// A single line arrived on the process's stdout.
    fn stdout_line(&self, agent_id: &str, line: &str);
    /// A single line arrived on the process's stderr.
    fn stderr_line(&self, agent_id: &str, line: &str);
    /// The process exited (naturally or via kill). `code`/`signal` mirror the
    /// previous poll-loop payload semantics.
    fn exited(&self, agent_id: &str, code: Option<i32>, signal: Option<String>);
}

/// Whether a forwarded external-agent stderr line is a known-transient,
/// self-healing diagnostic that must not surface as a host-level WARN.
///
/// codex-cli forwards its own `tracing` output to stderr, and the stderr
/// reader would otherwise log *every* line at WARN. Its models-manager cache
/// (`models_cache.json`) is refetched whenever the cache TTL expires or the
/// codex `client_version` changes (openai/codex Models Manager), so a
/// stale-schema cache — e.g. one written by a previous codex version that
/// predates a now-required field like `supports_reasoning_summaries` — logs an
/// ERROR and then heals itself on the very next refetch. That is a
/// codex-internal transient, not an external-agent failure, so it is demoted to
/// DEBUG; every other stderr line stays at WARN. The line is still forwarded to
/// the sink verbatim, so UI events are unaffected.
fn is_transient_codex_noise(line: &str) -> bool {
    line.contains("codex_models_manager")
        && (line.contains("failed to load models cache")
            || line.contains("failed to renew cache"))
}

/// Configuration for spawning an external agent
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct ExternalAgentSpawnConfig {
    /// Unique identifier for this agent
    pub id: String,
    /// Command to execute
    pub command: String,
    /// Command arguments
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Working directory
    pub cwd: Option<String>,
}

/// State of an external agent process
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum ExternalAgentProcessState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

/// Mutable runtime status shared between the process handle and its supervisor
/// task. Kept behind a short-lived `std::sync::Mutex` (never held across an
/// `.await`) so the supervisor can record the exit code without taking the
/// per-process async lock.
#[derive(Debug)]
struct RuntimeStatus {
    state: ExternalAgentProcessState,
    last_exit_code: Option<i32>,
    last_exit_signal: Option<String>,
}

/// Information about a running external agent process
#[derive(Debug)]
pub struct ExternalAgentProcess {
    /// Process ID
    pub pid: Option<u32>,
    /// Configuration used to spawn
    config: ExternalAgentSpawnConfig,
    /// Stdin handle for sending messages
    stdin: ChildStdin,
    /// One-shot kill request channel consumed by the supervisor task. Taken on
    /// `kill()`; dropping it (e.g. the process is removed from the manager)
    /// also triggers the supervisor's kill path.
    kill_tx: Option<oneshot::Sender<()>>,
    /// Shared runtime status, updated by the supervisor task on exit.
    runtime: Arc<StdMutex<RuntimeStatus>>,
}

impl ExternalAgentProcess {
    fn with_runtime<R>(&self, f: impl FnOnce(&mut RuntimeStatus) -> R) -> R {
        let mut guard = self.runtime.lock().expect("runtime status poisoned");
        f(&mut guard)
    }

    /// Get the process ID
    pub fn get_pid(&self) -> Option<u32> {
        self.pid
    }

    /// Get the spawn configuration
    pub fn get_config(&self) -> &ExternalAgentSpawnConfig {
        &self.config
    }

    /// Get the current state
    pub fn get_state(&self) -> ExternalAgentProcessState {
        self.with_runtime(|rt| rt.state.clone())
    }

    /// Transition to Running state
    pub fn set_running(&self) {
        self.with_runtime(|rt| rt.state = ExternalAgentProcessState::Running);
    }

    /// Transition to Failed state with error message
    pub fn set_failed(&self) {
        self.with_runtime(|rt| rt.state = ExternalAgentProcessState::Failed);
    }

    /// Send a message to the process via stdin
    pub async fn send(&mut self, message: &str) -> Result<(), String> {
        self.stdin
            .write_all(message.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;

        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write newline: {}", e))?;

        self.stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        Ok(())
    }

    /// Whether the process is still considered live. The supervisor flips this
    /// to `Stopped` when the child exits, so no `try_wait` syscall is needed.
    pub fn is_running(&self) -> bool {
        self.with_runtime(|rt| {
            matches!(
                rt.state,
                ExternalAgentProcessState::Starting | ExternalAgentProcessState::Running
            )
        })
    }

    /// Request a kill. The supervisor task performs the actual `child.kill()`
    /// and records the exit. Idempotent: a second call is a no-op.
    pub fn kill(&mut self) {
        self.with_runtime(|rt| rt.state = ExternalAgentProcessState::Stopping);
        if let Some(tx) = self.kill_tx.take() {
            let _ = tx.send(());
        }
    }

    /// Get process info as JSON-serializable value
    pub fn get_info(&self) -> serde_json::Value {
        let (state, exit_code, exit_signal) = self.with_runtime(|rt| {
            (
                rt.state.clone(),
                rt.last_exit_code,
                rt.last_exit_signal.clone(),
            )
        });
        let config = self.get_config();
        serde_json::json!({
            "id": config.id,
            "pid": self.get_pid(),
            "state": state,
            "command": config.command,
            "args": config.args,
            "cwd": config.cwd,
            "env": config.env,
            "exitCode": exit_code,
            "exitSignal": exit_signal
        })
    }
}

/// Resolve the exit code + signal from a finished child status.
fn exit_info_from_status(status: std::process::ExitStatus) -> (Option<i32>, Option<String>) {
    let code = status.code();
    #[cfg(unix)]
    let signal = status.signal().map(|s| s.to_string());
    #[cfg(not(unix))]
    let signal = None;
    (code, signal)
}

/// Manager for external agent processes
pub struct ExternalAgentProcessManager {
    processes: RwLock<HashMap<String, Arc<Mutex<ExternalAgentProcess>>>>,
}

impl Default for ExternalAgentProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ExternalAgentProcessManager {
    /// Create a new process manager
    pub fn new() -> Self {
        Self {
            processes: RwLock::new(HashMap::new()),
        }
    }

    /// Spawn a new external agent process.
    ///
    /// `sink` receives stdout/stderr lines and the exit event as they happen.
    pub async fn spawn(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, String> {
        let id = config.id.clone();

        // Check if already running
        {
            let processes = self.processes.read().await;
            if processes.contains_key(&id) {
                return Err(format!("Agent {} is already running", id));
            }
        }

        log::info!(
            "Spawning external agent: id={}, command={}, args={:?}",
            id,
            config.command,
            config.args
        );

        // Build command. Resolve the program against PATH (× PATHEXT on
        // Windows) first, so bare preset commands like `npx` / `opencode` that
        // live as `.cmd` shims actually launch instead of failing with
        // "program not found".
        let program = super::command_resolver::resolve_command(&config.command);
        let mut cmd = Command::new(&program);
        cmd.args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Set environment variables
        for (key, value) in &config.env {
            cmd.env(key, value);
        }

        // Set working directory
        if let Some(cwd) = &config.cwd {
            cmd.current_dir(cwd);
        }

        // On Windows, prevent window from showing
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        // Put the child in its own process group (Unix) so killing it later
        // signals the whole tree — `npx` / `opencode serve` fork grandchildren
        // that would otherwise orphan. No-op on Windows.
        super::proc_group::apply_process_group(&mut cmd);

        // Spawn the process
        let mut child = cmd.spawn().map_err(|e| {
            log::error!("Failed to spawn external agent {}: {}", id, e);
            format!("Failed to spawn process: {}", e)
        })?;

        let pid = child.id();
        log::info!("External agent {} spawned with PID: {:?}", id, pid);

        // Get stdio handles
        let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

        // Spawn stdout reader task — pushes each line to the sink as it arrives.
        let stdout_id = id.clone();
        let stdout_sink = sink.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::trace!("External agent {} stdout: {}", stdout_id, line);
                stdout_sink.stdout_line(&stdout_id, &line);
            }
        });

        // Spawn stderr reader task
        let stderr_id = id.clone();
        let stderr_sink = sink.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if is_transient_codex_noise(&line) {
                    log::debug!("External agent {} stderr (transient): {}", stderr_id, line);
                } else {
                    log::warn!("External agent {} stderr: {}", stderr_id, line);
                }
                stderr_sink.stderr_line(&stderr_id, &line);
            }
        });

        let runtime = Arc::new(StdMutex::new(RuntimeStatus {
            state: ExternalAgentProcessState::Starting,
            last_exit_code: None,
            last_exit_signal: None,
        }));

        let (kill_tx, kill_rx) = oneshot::channel::<()>();

        // Supervisor task: owns the child, awaits its exit (or a kill request),
        // records the final status, and pushes the exit event. This is the
        // single source of exit truth — there is no separate poll loop.
        let supervisor_id = id.clone();
        let supervisor_runtime = runtime.clone();
        let supervisor_sink = sink.clone();
        let supervisor_pid = pid;
        tokio::spawn(async move {
            let (code, signal) = tokio::select! {
                status = child.wait() => match status {
                    Ok(status) => exit_info_from_status(status),
                    Err(_) => (None, None),
                },
                // `kill_rx` resolves on an explicit kill request *or* when the
                // sender is dropped (process removed from the manager).
                _ = kill_rx => {
                    // Signal the whole process group first (Unix) so forked
                    // grandchildren die too, then reap the leader. No-op on
                    // Windows, where `child.kill()` handles the leader.
                    super::proc_group::kill_process_group(supervisor_pid);
                    let _ = child.kill().await;
                    let resolved = child.wait().await.ok();
                    (resolved.and_then(|s| s.code()), Some("killed".to_string()))
                }
            };

            if let Ok(mut rt) = supervisor_runtime.lock() {
                rt.state = ExternalAgentProcessState::Stopped;
                rt.last_exit_code = code;
                rt.last_exit_signal = signal.clone();
            }

            supervisor_sink.exited(&supervisor_id, code, signal);
        });

        // Create process entry
        let process = ExternalAgentProcess {
            pid,
            config,
            stdin,
            kill_tx: Some(kill_tx),
            runtime,
        };

        // Store in manager
        {
            let mut processes = self.processes.write().await;
            processes.insert(id.clone(), Arc::new(Mutex::new(process)));
        }

        Ok(id)
    }

    /// Get a process by ID
    pub async fn get(&self, id: &str) -> Option<Arc<Mutex<ExternalAgentProcess>>> {
        let processes = self.processes.read().await;
        processes.get(id).cloned()
    }

    /// Send a message to a process
    pub async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let mut process = process.lock().await;
        process.send(message).await
    }

    /// Kill a process
    pub async fn kill(&self, id: &str) -> Result<(), String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        {
            let mut process = process.lock().await;
            process.kill();
        }

        // Remove from manager. The supervisor task keeps running off its own
        // clones and still emits the exit event.
        let mut processes = self.processes.write().await;
        processes.remove(id);

        log::info!("External agent {} killed", id);
        Ok(())
    }

    /// Kill all processes
    pub async fn kill_all(&self) -> Result<(), String> {
        let ids: Vec<String> = {
            let processes = self.processes.read().await;
            processes.keys().cloned().collect()
        };

        for id in ids {
            if let Err(e) = self.kill(&id).await {
                log::error!("Failed to kill agent {}: {}", id, e);
            }
        }

        Ok(())
    }

    /// Get list of all running process IDs
    pub async fn list(&self) -> Vec<String> {
        let processes = self.processes.read().await;
        processes.keys().cloned().collect()
    }

    /// Get status of a process
    pub async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
        let process = self.get(id).await?;
        let process = process.lock().await;
        Some(process.get_state())
    }

    /// Check if a process is still running
    pub async fn is_running(&self, id: &str) -> Result<bool, String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let process = process.lock().await;
        Ok(process.is_running())
    }

    /// Get detailed info about a process
    pub async fn get_info(&self, id: &str) -> Result<serde_json::Value, String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let process = process.lock().await;
        Ok(process.get_info())
    }

    /// Transition a process to Running state
    pub async fn set_running(&self, id: &str) -> Result<(), String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let process = process.lock().await;
        process.set_running();
        Ok(())
    }

    /// Transition a process to Failed state
    pub async fn set_failed(&self, id: &str) -> Result<(), String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let process = process.lock().await;
        process.set_failed();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test sink that records everything the process emits. Only the
    /// process-spawning tests (gated to unix, which has `cat`/`true`) use it.
    #[cfg(unix)]
    #[derive(Default)]
    struct CollectorSink {
        stdout: StdMutex<Vec<String>>,
        stderr: StdMutex<Vec<String>>,
        exited: StdMutex<Option<(Option<i32>, Option<String>)>>,
    }

    #[cfg(unix)]
    impl ExternalAgentEventSink for CollectorSink {
        fn stdout_line(&self, _agent_id: &str, line: &str) {
            self.stdout.lock().unwrap().push(line.to_string());
        }
        fn stderr_line(&self, _agent_id: &str, line: &str) {
            self.stderr.lock().unwrap().push(line.to_string());
        }
        fn exited(&self, _agent_id: &str, code: Option<i32>, signal: Option<String>) {
            *self.exited.lock().unwrap() = Some((code, signal));
        }
    }

    #[cfg(unix)]
    fn noop_sink() -> Arc<dyn ExternalAgentEventSink> {
        Arc::new(CollectorSink::default())
    }

    #[test]
    fn transient_codex_cache_noise_is_demoted() {
        // The exact stderr line codex-cli 0.144.4 emits when a stale-schema
        // models_cache.json is loaded before the TTL refetch heals it.
        let missing_field = "2026-07-17T07:54:38.169956Z ERROR codex_models_manager::cache: \
             failed to load models cache: missing field `supports_reasoning_summaries` \
             at line 88 column 5";
        assert!(is_transient_codex_noise(missing_field));

        // The TTL-renewal variant (openai/codex #30864).
        let renew = "ERROR codex_models_manager::manager: failed to renew cache TTL. \
             EOF while parsing a value at line 1 column 0";
        assert!(is_transient_codex_noise(renew));
    }

    #[test]
    fn genuine_stderr_stays_a_warning() {
        // Real agent errors must NOT be demoted.
        assert!(!is_transient_codex_noise(
            "ERROR codex_core::client: 401 Unauthorized: invalid API key"
        ));
        assert!(!is_transient_codex_noise("panicked at 'index out of bounds'"));
        assert!(!is_transient_codex_noise(""));
        // A models-manager line that is not a cache load/renew transient still
        // warns — the two conditions are ANDed, not ORed.
        assert!(!is_transient_codex_noise(
            "ERROR codex_models_manager::foo: something else entirely"
        ));
    }

    #[test]
    fn spawn_config_defaults_args_and_env() {
        let cfg: ExternalAgentSpawnConfig =
            serde_json::from_str(r#"{"id":"a","command":"echo"}"#).expect("parse minimal config");
        assert_eq!(cfg.id, "a");
        assert_eq!(cfg.command, "echo");
        assert!(cfg.args.is_empty());
        assert!(cfg.env.is_empty());
        assert!(cfg.cwd.is_none());
    }

    #[tokio::test]
    async fn unknown_agent_ops_return_not_found() {
        let mgr = ExternalAgentProcessManager::new();
        assert!(mgr.send("ghost", "x").await.is_err());
        assert!(mgr.kill("ghost").await.is_err());
        assert!(mgr.is_running("ghost").await.is_err());
        assert!(mgr.get_info("ghost").await.is_err());
        assert!(mgr.set_running("ghost").await.is_err());
        assert!(mgr.set_failed("ghost").await.is_err());
        assert!(mgr.status("ghost").await.is_none());
        assert!(mgr.get("ghost").await.is_none());
        assert!(mgr.list().await.is_empty());
    }

    #[cfg(unix)]
    fn echo_config(id: &str) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: id.to_string(),
            command: "cat".to_string(), // reads stdin; stays alive until killed
            args: vec![],
            env: HashMap::new(),
            cwd: None,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_registers_then_kill_removes_and_emits_exit() {
        let mgr = ExternalAgentProcessManager::new();
        let sink = Arc::new(CollectorSink::default());
        let id = mgr
            .spawn(echo_config("agent-1"), sink.clone())
            .await
            .expect("spawn");
        assert!(mgr.list().await.contains(&id));
        assert_eq!(
            mgr.status(&id).await,
            Some(ExternalAgentProcessState::Starting)
        );

        mgr.set_running(&id).await.expect("set running");
        assert_eq!(
            mgr.status(&id).await,
            Some(ExternalAgentProcessState::Running)
        );
        assert!(mgr.is_running(&id).await.expect("is running"));

        // get_info reflects the spawn config.
        let info = mgr.get_info(&id).await.expect("info");
        assert_eq!(info["id"], serde_json::json!("agent-1"));
        assert_eq!(info["command"], serde_json::json!("cat"));

        // send writes a line to stdin; `cat` echoes it back on stdout.
        mgr.send(&id, "hello").await.expect("send");

        // The stdout reader pushes the echoed line to the sink.
        let mut echoed = false;
        for _ in 0..50 {
            if sink.stdout.lock().unwrap().iter().any(|l| l == "hello") {
                echoed = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(echoed, "expected stdout line to be forwarded to the sink");

        mgr.kill(&id).await.expect("kill");
        assert!(!mgr.list().await.contains(&id));
        assert!(mgr.get_info(&id).await.is_err());

        // The supervisor records the kill as an exit event.
        let mut got_exit = false;
        for _ in 0..50 {
            if sink.exited.lock().unwrap().is_some() {
                got_exit = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(got_exit, "expected supervisor to emit an exit event");
        let exit = sink.exited.lock().unwrap().clone().unwrap();
        assert_eq!(exit.1.as_deref(), Some("killed"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn natural_exit_emits_exit_event() {
        let mgr = ExternalAgentProcessManager::new();
        let sink = Arc::new(CollectorSink::default());
        let cfg = ExternalAgentSpawnConfig {
            id: "quick".to_string(),
            command: "true".to_string(), // exits 0 immediately
            args: vec![],
            env: HashMap::new(),
            cwd: None,
        };
        mgr.spawn(cfg, sink.clone()).await.expect("spawn");

        let mut got_exit = false;
        for _ in 0..50 {
            if sink.exited.lock().unwrap().is_some() {
                got_exit = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(got_exit, "expected natural exit to emit an exit event");
        let exit = sink.exited.lock().unwrap().clone().unwrap();
        assert_eq!(exit.0, Some(0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn duplicate_spawn_is_rejected() {
        let mgr = ExternalAgentProcessManager::new();
        mgr.spawn(echo_config("dup"), noop_sink())
            .await
            .expect("first spawn");
        let second = mgr.spawn(echo_config("dup"), noop_sink()).await;
        assert!(second.is_err());
        mgr.kill_all().await.expect("cleanup");
        assert!(mgr.list().await.is_empty());
    }
}
