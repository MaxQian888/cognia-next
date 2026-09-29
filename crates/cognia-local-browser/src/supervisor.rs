//! Run the workspace-runtime browser service as a supervised child process.
//!
//! The desktop starts `node <runtime>/src/local-main.mjs` with the bundled,
//! verified Node runtime, writes one JSON config line on its stdin
//! (`{secret, profilesRoot, overlayPath, browsersPath, maxSessions, maxPages}`)
//! and waits for `{"type":"ready","address":{address,port,…}}` on stdout. The
//! secret is 32 fresh random bytes per process and never touches argv or the
//! environment. `PLAYWRIGHT_BROWSERS_PATH` points at Cognia's private Chromium.
//!
//! A crash restarts the process after an exponential backoff (capped); too many
//! crashes in a row park the supervisor in `failed` until an explicit
//! [`Supervisor::start`].
//!
//! Node runs in **its own process group** (Unix: `setpgid(0, 0)` at spawn;
//! Windows: `CREATE_NEW_PROCESS_GROUP`), so Chromium and every helper it
//! spawns share one group the supervisor can signal as a whole.
//! [`Supervisor::stop`] (and dropping the supervisor) stops the tree: stdin
//! closes and SIGTERM goes to the group so the runtime can close Chromium,
//! then after a grace period the whole group is killed (SIGKILL to the group
//! on Unix, `taskkill /T /F` on Windows). A crashed runtime's leftover group
//! is killed too, and a [`Running`] that is dropped without being stopped
//! kills its group, so no Chromium outlives the app.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

use crate::client::RuntimeEndpoint;

/// Files a staged runtime directory must contain.
pub const REQUIRED_RUNTIME_ENTRIES: &[&str] = &[
    "src/local-main.mjs",
    "src/overlay.injected.js",
    "node_modules/playwright-core/cli.js",
    "node_modules/playwright-core/package.json",
];

/// The first required entry `dir` lacks.
pub fn missing_runtime_entry(dir: &Path) -> Option<&'static str> {
    REQUIRED_RUNTIME_ENTRIES
        .iter()
        .copied()
        .find(|entry| !dir.join(entry).exists())
}

/// Candidate runtime directories, in order: the two Tauri resource layouts
/// (`<resources>/resources/browser-runtime`, `<resources>/browser-runtime`),
/// then the checkout's staged copy in debug builds.
pub fn runtime_candidates(resource_dir: Option<&Path>, checkout: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join("resources").join("browser-runtime"));
        candidates.push(resource_dir.join("browser-runtime"));
    }
    if let Some(checkout) = checkout {
        candidates.push(checkout.to_path_buf());
    }
    candidates
}

/// The first complete runtime directory among `candidates`.
pub fn locate_runtime(candidates: &[PathBuf]) -> Result<PathBuf, String> {
    if let Some(found) = candidates
        .iter()
        .find(|candidate| missing_runtime_entry(candidate).is_none())
    {
        return Ok(found.clone());
    }
    let tried = candidates
        .iter()
        .map(|candidate| match missing_runtime_entry(candidate) {
            Some(missing) => format!("{} (missing {missing})", candidate.display()),
            None => candidate.display().to_string(),
        })
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!("the browser runtime is not staged; tried {tried}"))
}

/// Put the child in its own process group (Unix) / new process group
/// without a console window (Windows), so the whole tree can be signalled.
pub fn isolate_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = command;
}

/// The process group of a child spawned with [`isolate_process_group`]: its
/// own pid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessGroup(pub u32);

impl ProcessGroup {
    /// Ask every process in the group to exit (SIGTERM). Windows has no
    /// equivalent for a windowless tree; stdin EOF is the runtime's cue there.
    pub fn terminate(self) {
        #[cfg(unix)]
        signal_group(self.0, libc::SIGTERM);
    }

    /// Kill every process in the group.
    pub fn kill(self) {
        #[cfg(unix)]
        signal_group(self.0, libc::SIGKILL);
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new("taskkill");
            command
                .args(["/PID", &self.0.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            let _ = command.status();
        }
    }
}

#[cfg(unix)]
fn signal_group(pgid: u32, signal: libc::c_int) {
    let Ok(pgid) = libc::pid_t::try_from(pgid) else {
        return;
    };
    if pgid <= 1 {
        return;
    }
    // SAFETY: `killpg(2)` on a process group this supervisor created (the
    // child called `setpgid(0, 0)`); it only sends a signal.
    unsafe {
        libc::killpg(pgid, signal);
    }
}

/// Hide the console window a Windows child would otherwise flash.
pub fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Restart policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BackoffPolicy {
    pub base: Duration,
    pub cap: Duration,
    /// Consecutive crashes after which the supervisor gives up.
    pub max_restarts: u32,
    /// A process that lived this long resets the crash count.
    pub stable_after: Duration,
}

impl Default for BackoffPolicy {
    fn default() -> Self {
        Self {
            base: Duration::from_millis(500),
            cap: Duration::from_secs(30),
            max_restarts: 6,
            stable_after: Duration::from_secs(60),
        }
    }
}

impl BackoffPolicy {
    /// Delay before restart number `attempt` (1-based): `base · 2^(attempt-1)`,
    /// capped.
    pub fn delay(&self, attempt: u32) -> Duration {
        let exponent = attempt.saturating_sub(1).min(20);
        self.base
            .checked_mul(1u32 << exponent)
            .unwrap_or(self.cap)
            .min(self.cap)
    }
}

/// Everything needed to launch the runtime.
#[derive(Clone, Debug)]
pub struct SupervisorConfig {
    pub node: PathBuf,
    pub runtime_dir: PathBuf,
    pub profiles_root: PathBuf,
    pub overlay_path: PathBuf,
    pub browsers_path: PathBuf,
    pub max_sessions: Option<u32>,
    pub max_pages: Option<u32>,
    pub ready_timeout: Duration,
    pub stop_grace: Duration,
    pub backoff: BackoffPolicy,
}

impl SupervisorConfig {
    /// The standard layout under `<app_data>/browser`.
    pub fn new(node: PathBuf, runtime_dir: PathBuf, browser_root: &Path) -> Self {
        Self {
            node,
            overlay_path: runtime_dir.join("src").join("overlay.injected.js"),
            runtime_dir,
            profiles_root: browser_root.join("profiles"),
            browsers_path: browser_root.join("chromium"),
            max_sessions: None,
            max_pages: None,
            ready_timeout: Duration::from_secs(45),
            // The runtime exits cleanly within 10s of stdin EOF / SIGTERM.
            stop_grace: Duration::from_secs(10),
            backoff: BackoffPolicy::default(),
        }
    }

    pub fn entry(&self) -> PathBuf {
        self.runtime_dir.join("src").join("local-main.mjs")
    }

    /// The single stdin config line (without the newline).
    pub fn config_line(&self, secret: &str) -> String {
        let mut value = json!({
            "secret": secret,
            "profilesRoot": self.profiles_root,
            "overlayPath": self.overlay_path,
            "browsersPath": self.browsers_path,
        });
        if let Some(max_sessions) = self.max_sessions {
            value["maxSessions"] = json!(max_sessions);
        }
        if let Some(max_pages) = self.max_pages {
            value["maxPages"] = json!(max_pages);
        }
        value.to_string()
    }
}

/// 32 random bytes, hex-encoded (64 characters; the runtime needs ≥ 32).
pub fn generate_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    hex::encode(bytes)
}

#[derive(Debug, Deserialize)]
struct ReadyLine {
    #[serde(rename = "type")]
    kind: String,
    address: ReadyAddress,
}

#[derive(Debug, Deserialize)]
struct ReadyAddress {
    address: Option<String>,
    port: u16,
}

/// Exit code the runtime uses for a configuration error (`EX_CONFIG`). A
/// restart would fail the same way, so it is never restarted.
pub const CONFIG_ERROR_EXIT_CODE: i32 = 78;

#[derive(Debug, Deserialize)]
struct ErrorLine {
    #[serde(rename = "type")]
    kind: String,
    code: Option<String>,
    message: Option<String>,
}

/// Parse a startup line: the ready line becomes the loopback base URL, an
/// `{"type":"error",code,message}` line an error; anything else is `None`.
/// A listener that is not loopback is refused: the service must never listen
/// elsewhere.
pub fn parse_ready_line(line: &str) -> Option<Result<String, String>> {
    if let Ok(error) = serde_json::from_str::<ErrorLine>(line.trim()) {
        if error.kind == "error" {
            return Some(Err(format!(
                "{}: {}",
                error.code.as_deref().unwrap_or("runtime_error"),
                error.message.as_deref().unwrap_or("the runtime refused to start")
            )));
        }
    }
    let ready: ReadyLine = serde_json::from_str(line.trim()).ok()?;
    if ready.kind != "ready" {
        return None;
    }
    let host = ready.address.address.unwrap_or_else(|| "127.0.0.1".into());
    if ready.address.port == 0 {
        return Some(Err("the runtime reported port 0".into()));
    }
    let base = match host.as_str() {
        "127.0.0.1" | "localhost" => format!("http://127.0.0.1:{}", ready.address.port),
        "::1" => format!("http://[::1]:{}", ready.address.port),
        other => {
            return Some(Err(format!(
                "the runtime listens on {other}, not loopback"
            )))
        }
    };
    Some(Ok(base))
}

/// Supervisor state changes, for the shell to surface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SupervisorEvent {
    Started {
        generation: u64,
    },
    /// The process of `generation` exited on its own.
    Exited {
        generation: u64,
        status: String,
        restart_in: Option<Duration>,
    },
    /// Restarts exhausted (or a restart failed permanently).
    Failed {
        error: String,
    },
    /// Stopped on request.
    Stopped {
        generation: u64,
    },
}

type EventSink = Arc<dyn Fn(SupervisorEvent) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    Stopped,
    Running(RuntimeEndpoint),
    Restarting { attempt: u32 },
    Failed(String),
}

struct Inner {
    phase: Phase,
    generation: u64,
    /// OS pid of the running child; `None` unless `phase` is `Running`.
    pid: Option<u32>,
    monitor: Option<(tokio::task::JoinHandle<()>, tokio::sync::watch::Sender<bool>)>,
}

/// A spawned, ready child.
struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    endpoint: RuntimeEndpoint,
    started: Instant,
    /// The child's process group; `None` once the whole tree was killed.
    group: Option<ProcessGroup>,
}

impl Running {
    /// Kill the whole tree now (the group, then the child itself).
    async fn kill_tree(&mut self) {
        if let Some(group) = self.group.take() {
            tokio::task::spawn_blocking(move || group.kill()).await.ok();
        }
        let _ = self.child.kill().await;
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        // Dropped without `terminate`/`kill_tree` (a runtime shutdown, a
        // cancelled task): `kill_on_drop` only reaps Node, so kill the group.
        if let Some(group) = self.group.take() {
            group.kill();
        }
    }
}

/// The process supervisor. Cheap to share (`Arc`).
pub struct Supervisor {
    config: SupervisorConfig,
    inner: Mutex<Inner>,
    start_lock: tokio::sync::Mutex<()>,
    on_event: EventSink,
}

impl std::fmt::Debug for Supervisor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Supervisor")
            .field("phase", &self.inner.lock().phase)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("runtime_start_failed: {0}")]
pub struct StartError(pub String);

impl Supervisor {
    pub fn new(
        config: SupervisorConfig,
        on_event: impl Fn(SupervisorEvent) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            config,
            inner: Mutex::new(Inner {
                phase: Phase::Stopped,
                generation: 0,
                pid: None,
                monitor: None,
            }),
            start_lock: tokio::sync::Mutex::new(()),
            on_event: Arc::new(on_event),
        })
    }

    pub fn config(&self) -> &SupervisorConfig {
        &self.config
    }

    pub fn phase(&self) -> Phase {
        self.inner.lock().phase.clone()
    }

    /// The live endpoint, if the process is running.
    pub fn endpoint(&self) -> Option<RuntimeEndpoint> {
        match &self.inner.lock().phase {
            Phase::Running(endpoint) => Some(endpoint.clone()),
            _ => None,
        }
    }

    pub fn is_running(&self) -> bool {
        self.endpoint().is_some()
    }

    /// OS pid of the running child, for the managed-process registry. `None`
    /// while stopped, restarting or failed.
    pub fn pid(&self) -> Option<u32> {
        let inner = self.inner.lock();
        match inner.phase {
            Phase::Running(_) => inner.pid,
            _ => None,
        }
    }

    /// The generation of the running process.
    pub fn generation(&self) -> Option<u64> {
        self.endpoint().map(|endpoint| endpoint.generation)
    }

    /// The last failure, if the supervisor gave up.
    pub fn last_error(&self) -> Option<String> {
        match &self.inner.lock().phase {
            Phase::Failed(error) => Some(error.clone()),
            _ => None,
        }
    }

    /// Start the runtime (idempotent) and return its endpoint. A pending
    /// backoff or a failed state is replaced by an immediate start.
    pub async fn start(self: &Arc<Self>) -> Result<RuntimeEndpoint, StartError> {
        let _guard = self.start_lock.lock().await;
        if let Some(endpoint) = self.endpoint() {
            return Ok(endpoint);
        }
        self.halt_monitor().await;
        let generation = {
            let mut inner = self.inner.lock();
            inner.generation += 1;
            inner.generation
        };
        match spawn_runtime(&self.config, generation).await {
            Ok(running) => {
                let endpoint = running.endpoint.clone();
                self.install_monitor(running);
                (self.on_event)(SupervisorEvent::Started { generation });
                Ok(endpoint)
            }
            Err(error) => {
                self.inner.lock().phase = Phase::Failed(error.clone());
                Err(StartError(error))
            }
        }
    }

    /// Stop the runtime and any pending restart.
    pub async fn stop(&self) {
        let _guard = self.start_lock.lock().await;
        self.halt_monitor().await;
    }

    async fn halt_monitor(&self) {
        let monitor = self.inner.lock().monitor.take();
        if let Some((handle, stop)) = monitor {
            let _ = stop.send(true);
            let _ = handle.await;
        }
        let mut inner = self.inner.lock();
        inner.pid = None;
        if !matches!(inner.phase, Phase::Failed(_)) {
            inner.phase = Phase::Stopped;
        }
    }

    fn install_monitor(self: &Arc<Self>, running: Running) {
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let weak = Arc::downgrade(self);
        let config = self.config.clone();
        let on_event = Arc::clone(&self.on_event);
        let mut inner = self.inner.lock();
        inner.phase = Phase::Running(running.endpoint.clone());
        inner.pid = running.child.id();
        let handle = tokio::spawn(monitor(weak, config, on_event, running, stop_rx));
        inner.monitor = Some((handle, stop_tx));
    }

    /// Set a non-running phase; the pid no longer refers to a live child.
    fn set_phase(&self, phase: Phase) {
        let mut inner = self.inner.lock();
        inner.phase = phase;
        inner.pid = None;
    }

    /// A restarted child is up.
    fn set_running(&self, endpoint: RuntimeEndpoint, pid: Option<u32>) {
        let mut inner = self.inner.lock();
        inner.phase = Phase::Running(endpoint);
        inner.pid = pid;
    }

    fn next_generation(&self) -> u64 {
        let mut inner = self.inner.lock();
        inner.generation += 1;
        inner.generation
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        // The monitor holds only a weak reference; signalling it is enough.
        // If no runtime is left to run it, `kill_on_drop` reaps the child.
        if let Some((_, stop)) = self.inner.get_mut().monitor.take() {
            let _ = stop.send(true);
        }
    }
}

/// Watch one child at a time; restart it on crash with backoff.
async fn monitor(
    weak: std::sync::Weak<Supervisor>,
    config: SupervisorConfig,
    on_event: EventSink,
    first: Running,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    let mut current = Some(first);
    let mut crashes: u32 = 0;
    loop {
        let Some(mut running) = current.take() else {
            return;
        };
        let generation = running.endpoint.generation;
        let exit = tokio::select! {
            status = running.child.wait() => status,
            _ = stop.changed() => {
                terminate(running, config.stop_grace).await;
                on_event(SupervisorEvent::Stopped { generation });
                return;
            }
        };
        // Node is gone; Chromium and its helpers may not be.
        running.kill_tree().await;
        let config_error = matches!(&exit, Ok(status) if status.code() == Some(CONFIG_ERROR_EXIT_CODE));
        let status = match exit {
            Ok(status) => status.to_string(),
            Err(error) => error.to_string(),
        };
        if config_error {
            let error = format!("the browser runtime rejected its configuration ({status})");
            if let Some(supervisor) = weak.upgrade() {
                supervisor.set_phase(Phase::Failed(error.clone()));
            }
            on_event(SupervisorEvent::Exited {
                generation,
                status,
                restart_in: None,
            });
            on_event(SupervisorEvent::Failed { error });
            return;
        }
        if running.started.elapsed() >= config.backoff.stable_after {
            crashes = 0;
        }
        loop {
            crashes += 1;
            if crashes > config.backoff.max_restarts {
                let error = format!(
                    "the browser runtime exited {} times in a row (last: {status})",
                    crashes - 1
                );
                if let Some(supervisor) = weak.upgrade() {
                    supervisor.set_phase(Phase::Failed(error.clone()));
                }
                on_event(SupervisorEvent::Exited {
                    generation,
                    status: status.clone(),
                    restart_in: None,
                });
                on_event(SupervisorEvent::Failed { error });
                return;
            }
            let delay = config.backoff.delay(crashes);
            let Some(supervisor) = weak.upgrade() else {
                return;
            };
            supervisor.set_phase(Phase::Restarting { attempt: crashes });
            drop(supervisor);
            on_event(SupervisorEvent::Exited {
                generation,
                status: status.clone(),
                restart_in: Some(delay),
            });
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = stop.changed() => return,
            }
            let Some(supervisor) = weak.upgrade() else {
                return;
            };
            let next = supervisor.next_generation();
            drop(supervisor);
            let spawned = tokio::select! {
                spawned = spawn_runtime(&config, next) => spawned,
                _ = stop.changed() => return,
            };
            match spawned {
                Ok(next_running) => {
                    if let Some(supervisor) = weak.upgrade() {
                        supervisor.set_running(
                            next_running.endpoint.clone(),
                            next_running.child.id(),
                        );
                    }
                    on_event(SupervisorEvent::Started { generation: next });
                    current = Some(next_running);
                    break;
                }
                Err(error) => {
                    tracing::warn!(%error, "browser runtime restart failed");
                }
            }
        }
    }
}

/// Close stdin, ask the whole group to shut down (SIGTERM), wait up to
/// `grace` for Node to exit, then kill whatever is left of the group.
async fn terminate(mut running: Running, grace: Duration) {
    drop(running.stdin.take());
    if let Some(group) = running.group {
        group.terminate();
    }
    let _ = tokio::time::timeout(grace, running.child.wait()).await;
    // Node closes Chromium on SIGTERM; anything still alive in the group
    // after the grace period (or orphaned by a clean exit) is killed.
    running.kill_tree().await;
}

/// Keep the tail of stderr for error messages.
#[derive(Clone, Default)]
struct OutputTail(Arc<Mutex<VecDeque<String>>>);

impl OutputTail {
    fn push(&self, line: String) {
        const MAX: usize = 20;
        let mut lines = self.0.lock();
        if lines.len() == MAX {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    fn text(&self) -> String {
        self.0.lock().iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

/// Spawn one process and wait for its ready line.
async fn spawn_runtime(config: &SupervisorConfig, generation: u64) -> Result<Running, String> {
    let entry = config.entry();
    if !entry.is_file() {
        return Err(format!("{} does not exist", entry.display()));
    }
    for dir in [&config.profiles_root, &config.browsers_path] {
        std::fs::create_dir_all(dir)
            .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    }
    let secret = generate_secret();
    let mut command = Command::new(&config.node);
    command
        .arg(&entry)
        .current_dir(&config.runtime_dir)
        .env("PLAYWRIGHT_BROWSERS_PATH", &config.browsers_path)
        .env_remove("NODE_OPTIONS")
        .env_remove("COGNIA_WORKSPACE_RUNTIME_SECRET")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    isolate_process_group(&mut command);
    let child = command
        .spawn()
        .map_err(|error| format!("cannot start {}: {error}", config.node.display()))?;
    let started = Instant::now();
    let group = child.id().map(ProcessGroup);
    // From here on every early return drops `spawned`, which kills the group.
    let mut spawned = Spawned {
        child: Some(child),
        group,
    };
    let child = spawned.child.as_mut().expect("the child was just spawned");

    let mut stdin = child.stdin.take().expect("stdin is piped");
    let mut line = config.config_line(&secret);
    line.push('\n');
    if let Err(error) = async {
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await
    }
    .await
    {
        spawned.kill_tree().await;
        return Err(format!("cannot hand the runtime its config: {error}"));
    }

    let tail = OutputTail::default();
    let stderr = child.stderr.take().expect("stderr is piped");
    let stderr_tail = tail.clone();
    // Drains until the child closes stderr (it exits or is killed).
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!(target: "cognia_local_browser::runtime", "{line}");
            stderr_tail.push(line);
        }
    });

    let stdout = child.stdout.take().expect("stdout is piped");
    let mut stdout = BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(config.ready_timeout, async {
        loop {
            match stdout.next_line().await {
                Ok(Some(line)) => {
                    if let Some(parsed) = parse_ready_line(&line) {
                        return parsed;
                    }
                    tracing::debug!(target: "cognia_local_browser::runtime", "{line}");
                }
                Ok(None) => return Err("the runtime exited before it was ready".to_string()),
                Err(error) => return Err(format!("cannot read the runtime output: {error}")),
            }
        }
    })
    .await;
    let base_url = match ready {
        Ok(Ok(base_url)) => base_url,
        Ok(Err(error)) => {
            spawned.kill_tree().await;
            // Let the stderr drain catch up with the dying process.
            tokio::time::sleep(Duration::from_millis(50)).await;
            return Err(with_tail(error, &tail));
        }
        Err(_) => {
            spawned.kill_tree().await;
            return Err(with_tail(
                format!(
                    "the runtime was not ready within {}s",
                    config.ready_timeout.as_secs()
                ),
                &tail,
            ));
        }
    };
    // Keep draining stdout so the runtime never blocks on a full pipe.
    tokio::spawn(async move {
        while let Ok(Some(line)) = stdout.next_line().await {
            tracing::debug!(target: "cognia_local_browser::runtime", "{line}");
        }
    });
    let (child, group) = spawned.into_parts();
    Ok(Running {
        child,
        stdin: Some(stdin),
        endpoint: RuntimeEndpoint {
            base_url,
            secret,
            generation,
        },
        started,
        group,
    })
}

/// A child between spawn and ready: dropping it kills its whole group.
struct Spawned {
    child: Option<Child>,
    group: Option<ProcessGroup>,
}

impl Spawned {
    async fn kill_tree(&mut self) {
        if let Some(group) = self.group.take() {
            tokio::task::spawn_blocking(move || group.kill()).await.ok();
        }
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill().await;
        }
    }

    /// Hand the child and its group to a [`Running`] (which then owns the
    /// kill-on-drop duty).
    fn into_parts(mut self) -> (Child, Option<ProcessGroup>) {
        let group = self.group.take();
        let child = self.child.take().expect("the child is present until handed over");
        (child, group)
    }
}

impl Drop for Spawned {
    fn drop(&mut self) {
        if let Some(group) = self.group.take() {
            group.kill();
        }
    }
}

fn with_tail(error: String, tail: &OutputTail) -> String {
    let text = tail.text();
    if text.is_empty() {
        error
    } else {
        format!("{error}\n{text}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_the_cap() {
        let policy = BackoffPolicy {
            base: Duration::from_millis(500),
            cap: Duration::from_secs(5),
            max_restarts: 6,
            stable_after: Duration::from_secs(60),
        };
        let schedule: Vec<u128> = (1..=6).map(|n| policy.delay(n).as_millis()).collect();
        assert_eq!(schedule, vec![500, 1000, 2000, 4000, 5000, 5000]);
        assert_eq!(policy.delay(0), Duration::from_millis(500));
        assert_eq!(policy.delay(u32::MAX), Duration::from_secs(5));
    }

    #[test]
    fn secrets_are_long_and_fresh() {
        let first = generate_secret();
        let second = generate_secret();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn config_line_carries_the_contract_fields() {
        let mut config = SupervisorConfig::new(
            PathBuf::from("/node"),
            PathBuf::from("/rt"),
            Path::new("/data/browser"),
        );
        config.max_sessions = Some(4);
        let value: serde_json::Value =
            serde_json::from_str(&config.config_line("s".repeat(64).as_str())).unwrap();
        assert_eq!(value["secret"], "s".repeat(64));
        assert_eq!(
            value["profilesRoot"],
            Path::new("/data/browser/profiles").to_string_lossy().as_ref()
        );
        assert_eq!(
            value["browsersPath"],
            Path::new("/data/browser/chromium").to_string_lossy().as_ref()
        );
        assert_eq!(
            value["overlayPath"],
            Path::new("/rt/src/overlay.injected.js")
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(value["maxSessions"], 4);
        assert!(value.get("maxPages").is_none());
        assert!(!config.config_line("x").contains('\n'));
    }

    #[test]
    fn ready_line_must_be_loopback() {
        assert_eq!(
            parse_ready_line(r#"{"type":"ready","address":{"address":"127.0.0.1","family":"IPv4","port":51234}}"#),
            Some(Ok("http://127.0.0.1:51234".into()))
        );
        assert_eq!(
            parse_ready_line(r#"{"type":"ready","address":{"address":"::1","port":8}}"#),
            Some(Ok("http://[::1]:8".into()))
        );
        assert!(matches!(
            parse_ready_line(r#"{"type":"ready","address":{"address":"0.0.0.0","port":8}}"#),
            Some(Err(_))
        ));
        assert!(matches!(
            parse_ready_line(r#"{"type":"ready","address":{"address":"127.0.0.1","port":0}}"#),
            Some(Err(_))
        ));
        assert_eq!(
            parse_ready_line(r#"{"type":"error","code":"invalid_config","message":"secret too short"}"#),
            Some(Err("invalid_config: secret too short".into()))
        );
        assert_eq!(
            parse_ready_line(r#"{"type":"ready","mode":"local","address":{"address":"127.0.0.1","family":"IPv4","port":7}}"#),
            Some(Ok("http://127.0.0.1:7".into()))
        );
        assert_eq!(parse_ready_line("Listening…"), None);
        assert_eq!(parse_ready_line(r#"{"type":"log"}"#), None);
    }

    #[test]
    fn locates_a_complete_runtime() {
        let root = tempfile::tempdir().unwrap();
        let resources = root.path().join("res");
        let packaged = resources.join("browser-runtime");
        for entry in REQUIRED_RUNTIME_ENTRIES {
            let path = packaged.join(entry);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
        }
        let candidates = runtime_candidates(Some(&resources), Some(Path::new("/checkout/rt")));
        assert_eq!(candidates[0], resources.join("resources").join("browser-runtime"));
        assert_eq!(candidates[1], packaged);
        assert_eq!(candidates[2], PathBuf::from("/checkout/rt"));
        assert_eq!(locate_runtime(&candidates).unwrap(), packaged);

        std::fs::remove_file(packaged.join("src/local-main.mjs")).unwrap();
        let error = locate_runtime(&candidates).unwrap_err();
        assert!(error.contains("missing src/local-main.mjs"), "{error}");
    }

    #[cfg(unix)]
    mod process {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};

        /// A runtime directory whose `local-main.mjs` is a shell script; the
        /// tests run it with `/bin/sh` standing in for Node.
        fn fake_runtime(script: &str) -> (tempfile::TempDir, SupervisorConfig) {
            let root = tempfile::tempdir().unwrap();
            let runtime = root.path().join("rt");
            std::fs::create_dir_all(runtime.join("src")).unwrap();
            std::fs::write(runtime.join("src/local-main.mjs"), script).unwrap();
            let mut config = SupervisorConfig::new(
                PathBuf::from("/bin/sh"),
                runtime,
                &root.path().join("browser"),
            );
            config.ready_timeout = Duration::from_secs(10);
            config.stop_grace = Duration::from_secs(2);
            config.backoff = BackoffPolicy {
                base: Duration::from_millis(10),
                cap: Duration::from_millis(40),
                max_restarts: 3,
                stable_after: Duration::from_secs(60),
            };
            (root, config)
        }

        const READY: &str = r#"
read config
printf '%s\n' "$config" > "$(dirname "$0")/config.json"
echo "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" > "$(dirname "$0")/env.txt"
echo "booting"
echo '{"type":"ready","address":{"address":"127.0.0.1","family":"IPv4","port":45678}}'
"#;

        #[tokio::test]
        async fn starts_hands_over_the_secret_and_stops() {
            let script = format!("{READY}\ntrap 'exit 0' TERM\nwhile true; do sleep 0.05; done\n");
            let (root, config) = fake_runtime(&script);
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&events);
            let supervisor = Supervisor::new(config.clone(), move |event| sink.lock().push(event));

            let endpoint = supervisor.start().await.unwrap();
            assert_eq!(endpoint.base_url, "http://127.0.0.1:45678");
            assert_eq!(endpoint.generation, 1);
            assert!(supervisor.is_running());
            let pid = supervisor.pid().expect("a running child has a pid");
            assert!(pid > 0);
            // Idempotent while running.
            assert_eq!(supervisor.start().await.unwrap(), endpoint);

            let handed: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(config.runtime_dir.join("src/config.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(handed["secret"], endpoint.secret.as_str());
            let env = std::fs::read_to_string(config.runtime_dir.join("src/env.txt")).unwrap();
            assert!(env.contains(&config.browsers_path.to_string_lossy().into_owned()));
            assert!(config.profiles_root.is_dir());

            supervisor.stop().await;
            assert!(!supervisor.is_running());
            assert_eq!(supervisor.pid(), None, "a stopped runtime has no pid");
            assert_eq!(supervisor.phase(), Phase::Stopped);
            let events = events.lock();
            assert_eq!(events[0], SupervisorEvent::Started { generation: 1 });
            assert_eq!(*events.last().unwrap(), SupervisorEvent::Stopped { generation: 1 });
            drop(root);
        }

        fn alive(pid: i32) -> bool {
            // SAFETY: signal 0 only probes for existence.
            unsafe { libc::kill(pid, 0) == 0 }
        }

        async fn wait_dead(pid: i32) -> bool {
            for _ in 0..300 {
                if !alive(pid) {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            false
        }

        /// A runtime that starts a grandchild (standing in for Chromium) and
        /// records its pid; the grandchild ignores SIGTERM like a wedged
        /// helper would.
        const WITH_GRANDCHILD: &str = r#"
(trap '' TERM; exec sleep 30) &
echo $! > "$(dirname "$0")/grandchild.pid"
"#;

        #[tokio::test]
        async fn the_runtime_runs_in_its_own_process_group() {
            let script = format!("{READY}\nwhile true; do sleep 0.05; done\n");
            let (_root, config) = fake_runtime(&script);
            let supervisor = Supervisor::new(config, |_| {});
            supervisor.start().await.unwrap();
            let pid = supervisor.pid().unwrap() as i32;
            // SAFETY: getpgid only reads process state.
            let pgid = unsafe { libc::getpgid(pid) };
            assert_eq!(pgid, pid, "the child leads its own group");
            // SAFETY: as above, for this process.
            assert_ne!(pgid, unsafe { libc::getpgid(0) });
            supervisor.stop().await;
        }

        #[tokio::test]
        async fn stop_kills_the_whole_process_group() {
            let script = format!(
                "{WITH_GRANDCHILD}\n{READY}\ntrap 'exit 0' TERM\nwhile true; do sleep 0.05; done\n"
            );
            let (_root, config) = fake_runtime(&script);
            let supervisor = Supervisor::new(config.clone(), |_| {});
            supervisor.start().await.unwrap();
            let grandchild: i32 = std::fs::read_to_string(config.runtime_dir.join("src/grandchild.pid"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert!(alive(grandchild));
            supervisor.stop().await;
            assert!(wait_dead(grandchild).await, "the grandchild outlived stop()");
        }

        #[tokio::test]
        async fn a_crash_kills_the_leftover_group() {
            // The runtime exits on its own, leaving its grandchild behind.
            let script = format!("{WITH_GRANDCHILD}\n{READY}\nsleep 0.2\nexit 78\n");
            let (_root, config) = fake_runtime(&script);
            let supervisor = Supervisor::new(config.clone(), |_| {});
            supervisor.start().await.unwrap();
            let grandchild: i32 = std::fs::read_to_string(config.runtime_dir.join("src/grandchild.pid"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert!(wait_dead(grandchild).await, "the crashed runtime's grandchild survived");
            supervisor.stop().await;
        }

        #[tokio::test]
        async fn restarts_after_a_crash_with_a_new_secret() {
            // Exit right after the first ready; stay up on later runs.
            let script = format!(
                "{READY}\nif [ ! -f \"$(dirname \"$0\")/crashed\" ]; then touch \"$(dirname \"$0\")/crashed\"; exit 3; fi\nwhile true; do sleep 0.05; done\n"
            );
            let (_root, config) = fake_runtime(&script);
            let starts = Arc::new(AtomicUsize::new(0));
            let counter = Arc::clone(&starts);
            let supervisor = Supervisor::new(config, move |event| {
                if matches!(event, SupervisorEvent::Started { .. }) {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
            });
            let first = supervisor.start().await.unwrap();
            let first_pid = supervisor.pid();
            let mut second = None;
            for _ in 0..400 {
                if let Some(endpoint) = supervisor.endpoint() {
                    if endpoint.generation != first.generation {
                        second = Some(endpoint);
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let second = second.expect("the supervisor restarts the runtime");
            assert!(second.generation > first.generation);
            assert_ne!(second.secret, first.secret);
            assert_eq!(starts.load(Ordering::SeqCst), 2);
            let second_pid = supervisor.pid().expect("the restarted child has a pid");
            assert_ne!(Some(second_pid), first_pid, "the pid follows the restart");
            supervisor.stop().await;
        }

        #[tokio::test]
        async fn gives_up_after_repeated_crashes() {
            let script = format!("{READY}\nexit 1\n");
            let (_root, config) = fake_runtime(&script);
            let failed = Arc::new(Mutex::new(None));
            let sink = Arc::clone(&failed);
            let supervisor = Supervisor::new(config, move |event| {
                if let SupervisorEvent::Failed { error } = event {
                    *sink.lock() = Some(error);
                }
            });
            supervisor.start().await.unwrap();
            for _ in 0..500 {
                if failed.lock().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(failed.lock().is_some(), "restarts are capped");
            assert!(matches!(supervisor.phase(), Phase::Failed(_)));
            assert!(supervisor.last_error().is_some());
            assert_eq!(supervisor.pid(), None, "a failed runtime has no pid");
            supervisor.stop().await;
        }

        #[tokio::test]
        async fn a_config_error_exit_is_not_restarted() {
            let script = format!("{READY}\nsleep 0.1\nexit 78\n");
            let (_root, config) = fake_runtime(&script);
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&events);
            let supervisor = Supervisor::new(config, move |event| sink.lock().push(event));
            supervisor.start().await.unwrap();
            for _ in 0..300 {
                if matches!(supervisor.phase(), Phase::Failed(_)) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(matches!(supervisor.phase(), Phase::Failed(message) if message.contains("configuration")));
            let starts = events
                .lock()
                .iter()
                .filter(|event| matches!(event, SupervisorEvent::Started { .. }))
                .count();
            assert_eq!(starts, 1, "exit 78 is never restarted");
            supervisor.stop().await;
        }

        #[tokio::test]
        async fn a_startup_error_line_fails_start() {
            let (_root, config) = fake_runtime(
                "read c\necho '{\"type\":\"error\",\"code\":\"invalid_config\",\"message\":\"bad profilesRoot\"}'\nexit 78\n",
            );
            let supervisor = Supervisor::new(config, |_| {});
            let error = supervisor.start().await.unwrap_err();
            assert!(error.0.contains("invalid_config: bad profilesRoot"), "{error}");
        }

        #[tokio::test]
        async fn a_runtime_that_never_gets_ready_fails_start() {
            let (_root, config) = fake_runtime("echo 'fatal: no playwright' >&2\nexit 2\n");
            let supervisor = Supervisor::new(config, |_| {});
            let error = supervisor.start().await.unwrap_err();
            assert!(error.0.contains("exited before it was ready"), "{error}");
            assert!(error.0.contains("fatal: no playwright"), "{error}");
            assert!(matches!(supervisor.phase(), Phase::Failed(_)));
            assert_eq!(supervisor.pid(), None);
        }

        #[tokio::test]
        async fn a_non_loopback_listener_is_refused() {
            let (_root, config) = fake_runtime(
                "read c\necho '{\"type\":\"ready\",\"address\":{\"address\":\"0.0.0.0\",\"port\":9}}'\nsleep 5\n",
            );
            let supervisor = Supervisor::new(config, |_| {});
            let error = supervisor.start().await.unwrap_err();
            assert!(error.0.contains("not loopback"), "{error}");
        }

        #[tokio::test]
        async fn a_missing_entry_is_reported() {
            let root = tempfile::tempdir().unwrap();
            let config = SupervisorConfig::new(
                PathBuf::from("/bin/sh"),
                root.path().join("absent"),
                root.path(),
            );
            let supervisor = Supervisor::new(config, |_| {});
            let error = supervisor.start().await.unwrap_err();
            assert!(error.0.contains("does not exist"));
        }
    }
}
