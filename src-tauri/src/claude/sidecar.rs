use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use super::host::SidecarHost;
use crate::supervision_backoff::CrashBackoff;

/// Tauri event channel name. The frontend subscribes via
/// `listen("claude://message", ...)`.
pub const SIDECAR_EVENT: &str = "claude://message";

/// Dedicated event channel for A2UI dispatches (createSurface,
/// updateComponents, dataModelUpdate, deleteSurface). Kept separate from
/// `SIDECAR_EVENT` so the a2ui store can subscribe without sifting through
/// every sidecar message.
pub const A2UI_EVENT: &str = "a2ui://dispatch";

/// Canonical agent-event channel (ADR-0090 Phase 3). Sessions with a frozen
/// execution spec dual-emit `agent_event` envelopes here; the raw legacy
/// stream on `SIDECAR_EVENT` is unchanged.
pub const AGENT_EVENT: &str = "agent://message";

/// How long a freshly spawned sidecar has to announce `{"type":"ready"}`
/// before the watchdog kills it. Deliberately generous: a tighter bound would
/// kill a healthy-but-slow cold start (large `node_modules`, cold disk) — the
/// same false-positive class that ruled out a blanket reader-inactivity timeout.
const SIDECAR_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Minimum Node.js major version the chat sidecar requires. Matches the repo's
/// `engines.node` (>= 26): the sidecar's native addons (`better-sqlite3` 13.x,
/// `node-pty`) declare Node >= 22, and the `@anthropic-ai/claude-agent-sdk` +
/// undici proxy stack assumes a current runtime. Older runtimes fail late and
/// opaquely deep inside the SDK, so we probe up front and surface an actionable
/// error instead.
const MIN_NODE_MAJOR: u32 = 26;

/// Parse the major version out of `node --version` output (e.g. `"v20.11.0\n"`
/// → `Some(20)`). Tolerates a missing leading `v`. Pure — unit-tested.
fn parse_node_major(version_output: &str) -> Option<u32> {
    let trimmed = version_output.trim();
    let without_v = trimmed.strip_prefix('v').unwrap_or(trimmed);
    without_v.split('.').next()?.parse::<u32>().ok()
}

fn apply_managed_proxy_env(
    cmd: &mut Command,
    proxy_cfg: &crate::proxy_config::ProxyConfig,
) -> Result<(), String> {
    let env = proxy_cfg.env_vars();
    if proxy_cfg.is_active() && env.is_empty() {
        return Err("PROXY_INVALID_CONFIG: sidecar proxy environment is unavailable".to_string());
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    if proxy_cfg.is_active() {
        // Frozen execution specs rebuild the Claude subprocess environment.
        // This marker lets the sidecar distinguish host-managed proxy values
        // from ambient shell variables without sending credentials through
        // the renderer as a per-session env overlay.
        cmd.env("COGNIA_MANAGED_NETWORK_PROXY", "1");
        return Ok(());
    }

    // Explicit direct mode must not inherit stale parent/system proxy env.
    for key in &[
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        cmd.env_remove(key);
    }
    cmd.env_remove("COGNIA_MANAGED_NETWORK_PROXY");
    Ok(())
}

/// Shared, mutable state. Cloned cheaply via `Arc`.
#[derive(Clone, Default)]
pub struct SidecarState {
    inner: Arc<Mutex<Inner>>,
    /// The live child's stdin, kept behind its own lock — separate from
    /// `inner` so a slow control-message write never blocks state reads
    /// (`is_ready`). Mirrors the owned-stdin
    /// shape in `external_agent/process.rs`.
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// Held for the entire `spawn` body so concurrent callers serialize: the
    /// second one blocks, then sees the live child and no-ops. Mirrors the
    /// `materialize_lock` idiom in `plugin_api/python/mod.rs`.
    spawn_lock: Arc<Mutex<()>>,
    /// Monotonic spawn generation, bumped on each `spawn`. The ready watchdog
    /// captures its generation and refuses to act once a newer spawn supersedes
    /// it — otherwise a stale watchdog could adopt (and kill) a *healthy*
    /// successor child after the original crashed and respawned.
    spawn_epoch: Arc<std::sync::atomic::AtomicU64>,
    /// ADR-0028 Phase 14 — incremented every time `spawn` succeeds after
    /// boot. Surfaced through `sidecar_restart_count` for the Diagnostics
    /// → Sidecar card so users can see how often the sidecar has
    /// recovered without restarting the app. `AtomicU64` keeps the
    /// counter lock-free.
    restart_count: Arc<std::sync::atomic::AtomicU64>,
    /// Set once a `node --version` probe confirms Node >= [`MIN_NODE_MAJOR`].
    /// Caches the happy path so we don't fork `node --version` on every spawn;
    /// a failed probe leaves this `false` so a later spawn (after the user
    /// installs/upgrades Node) re-checks.
    node_version_ok: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    ready: bool,
    /// Crash-loop backoff counters (shared shape with the brain supervisor —
    /// `supervision_backoff.rs`). Reset the moment the sidecar announces
    /// `ready`, advanced on every reader exit.
    backoff: CrashBackoff,
    /// Latched by [`kill_sidecar`], consumed by [`SidecarState::note_exit`].
    ///
    /// `CrashBackoff` charges *every* exit, which is right for a backoff that
    /// resets the moment the child announces ready. The recovery restart
    /// budget (ADR-0102 §4) is not so forgiving — it only clears after ten
    /// healthy minutes — so charging a deliberate restart against it would
    /// disable the sidecar and drop the app into safe mode after four ordinary
    /// "restart sidecar" clicks. Only unexpected deaths count.
    intentional_stop: bool,
}

impl SidecarState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of times the sidecar has been spawned (re-spawned counts).
    /// The first boot returns 1; each `kill_sidecar` + subsequent `spawn`
    /// increments the counter.
    pub fn restart_count(&self) -> u64 {
        self.restart_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Increment the restart counter — called by `spawn` after the child
    /// process is in the map.
    pub(crate) fn bump_restart_count(&self) {
        self.restart_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// Probe `node --version` once and verify Node >= [`MIN_NODE_MAJOR`] before
    /// the first spawn. Without this gate a too-old (or missing) Node fails
    /// late and opaquely deep inside the Agent SDK; here we surface a clear,
    /// actionable error. The happy result is cached; a failure re-checks next
    /// time so the user can recover by installing Node without restarting.
    async fn ensure_node_version(&self) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        if self.node_version_ok.load(Ordering::Relaxed) {
            return Ok(());
        }
        let output = Command::new("node")
            .arg("--version")
            .output()
            .await
            .map_err(|e| {
                format!(
                    "Node.js was not found on PATH — install Node.js >= {MIN_NODE_MAJOR}, \
                     which the chat sidecar requires ({e})"
                )
            })?;
        if !output.status.success() {
            return Err(format!(
                "`node --version` failed (exit {:?}) — install Node.js >= {MIN_NODE_MAJOR}",
                output.status.code()
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let major = parse_node_major(&stdout).ok_or_else(|| {
            format!(
                "could not parse Node.js version from {:?} — install Node.js >= {MIN_NODE_MAJOR}",
                stdout.trim()
            )
        })?;
        if major < MIN_NODE_MAJOR {
            return Err(format!(
                "Node.js {} is too old — the chat sidecar requires Node.js >= {MIN_NODE_MAJOR}; \
                 please upgrade Node.js",
                stdout.trim()
            ));
        }
        self.node_version_ok.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// The current spawn generation. The watchdog compares this against the
    /// generation it was armed with to detect that a newer spawn superseded it.
    fn current_epoch(&self) -> u64 {
        self.spawn_epoch.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Bump and return the new spawn generation. Called once per `spawn`, under
    /// `spawn_lock`, so generations are assigned serially.
    fn next_epoch(&self) -> u64 {
        self.spawn_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            .wrapping_add(1)
    }

    /// Send one JSON-line command to the running sidecar. Locks only `stdin`
    /// (not the shared `inner` state) so a slow write never blocks hook-state
    /// reads; the `stdin` lock still serializes concurrent writers, preserving
    /// line ordering.
    pub async fn write_command(&self, msg: &Value) -> Result<(), String> {
        let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "sidecar not running".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Mark the sidecar ready and reset the crash-loop counter. Called when the
    /// reader observes `{"type":"ready"}`.
    async fn note_ready(&self) {
        let mut guard = self.inner.lock().await;
        guard.ready = true;
        guard.backoff.reset();
    }

    /// Single sink for everything that must happen when the sidecar exits
    /// (crash, clean shutdown, or watchdog kill): drop the child + stdin, clear
    /// per-session hook state (R6 — otherwise orphaned on crash), and record the
    /// failure for backoff (R4). Locks `stdin` and `inner` sequentially (never
    /// nested) so there is no lock-ordering hazard.
    ///
    /// Returns whether the exit was *unexpected* — i.e. not preceded by
    /// [`kill_sidecar`]. Only unexpected exits are charged against the recovery
    /// restart budget; see [`Inner::intentional_stop`].
    async fn note_exit(&self, now: Instant) -> bool {
        self.stdin.lock().await.take();
        let mut guard = self.inner.lock().await;
        guard.child = None;
        guard.ready = false;
        guard.backoff.note_failure(now);
        !std::mem::take(&mut guard.intentional_stop)
    }

    /// Latch that the next exit was asked for, so [`note_exit`] does not charge
    /// it against the recovery restart budget.
    ///
    /// [`note_exit`]: Self::note_exit
    async fn note_intentional_stop(&self) {
        self.inner.lock().await.intentional_stop = true;
    }

    /// Remaining crash-backoff window at `now`, or `None` if a respawn may
    /// proceed immediately. Pure over the stored counters — unit-tested by
    /// injecting `now`.
    async fn backoff_remaining(&self, now: Instant) -> Option<Duration> {
        self.inner.lock().await.backoff.remaining(now)
    }

    pub async fn is_ready(&self) -> bool {
        self.inner.lock().await.ready
    }

    /// Liveness snapshot for the unified managed-process registry
    /// (`crate::process_registry`). `Some((pid, ready))` while a child is
    /// alive (`pid` is `None` only if the OS already reaped it), `None` when
    /// no sidecar is running. Locks `inner` briefly and returns owned data —
    /// never held across an `.await`.
    pub async fn managed_snapshot(&self) -> Option<(Option<u32>, bool)> {
        let guard = self.inner.lock().await;
        guard.child.as_ref().map(|c| (c.id(), guard.ready))
    }
}

/// Resolve the absolute path to the bundled `sidecar/` directory in both
/// dev and release builds. Used by:
///   - `resolve_sidecar_script` to locate `claude-host.mjs`
///   - `a2ui_bridge::commands::a2ui_bridge_runtime_paths` so external-agent
///     MCP configs can spawn `node ${sidecarDir}/a2ui-mcp.mjs` with an
///     absolute argv.
pub fn sidecar_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Release: bundled resources directory.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("sidecar");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    // Dev: walk up from the Cargo manifest dir to the repo root.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest
        .parent()
        .map(|p| p.join("sidecar"))
        .ok_or_else(|| "could not locate project root".to_string())?;
    if candidate.exists() {
        return Ok(candidate);
    }
    Err(format!(
        "sidecar directory not found at {}",
        candidate.display()
    ))
}

/// Resolve the absolute path to `sidecar/claude-host.mjs`, in both dev and
/// release builds. `pub(crate)` so `host::TauriSidecarHost` can delegate.
pub(crate) fn resolve_sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = sidecar_dir(app)?;
    // ADR-0090 Phase 3: the host entry is agent-host.mjs; claude-host.mjs
    // remains as a compatibility shim for stale bundles/spawn paths.
    let candidate = dir.join("agent-host.mjs");
    if candidate.exists() {
        return Ok(candidate);
    }
    let candidate = dir.join("claude-host.mjs");
    if candidate.exists() {
        return Ok(candidate);
    }
    Err(format!(
        "sidecar script not found at {}",
        candidate.display()
    ))
}

/// Spawn the Node sidecar and start pumping its stdout into host events
/// (Tauri events on desktop, the companion EventBus headless — see
/// [`super::host`]).
///
/// Safe to call multiple times — subsequent calls become no-ops while the
/// child is alive.
pub async fn spawn(host: Arc<dyn SidecarHost>, state: SidecarState) -> Result<(), String> {
    // Serialize concurrent spawns (mirrors `plugin_api/python` materialize_lock):
    // a second caller blocks here, then sees the live child below and no-ops,
    // so we can never start two Node processes for one slot.
    let _spawn_guard = state.spawn_lock.lock().await;

    if state.inner.lock().await.child.is_some() {
        return Ok(());
    }

    // Recovery is holding the sidecar back — either its restart budget ran out
    // or the operator chose "keep off" in the diagnostics shell. Both are
    // cleared by `recovery_retry`, so the shell's Retry button is what makes
    // this path reachable again. Checked before backoff: a held-back subsystem
    // is a decision, not a delay, and the caller deserves to be told which.
    if crate::recovery::is_subsystem_disabled(
        cognia_observability::recovery::RecoverySubsystem::Sidecar,
    ) {
        return Err(
            "sidecar is disabled by recovery; retry it from the diagnostics screen".to_string(),
        );
    }

    // Crash-loop backoff: don't hot-respawn a sidecar that keeps dying before it
    // can announce ready. A single transient death maps to a zero delay, so this
    // never penalizes a normal restart.
    if let Some(remaining) = state.backoff_remaining(Instant::now()).await {
        return Err(format!(
            "sidecar in crash-backoff ({} ms remaining); retry shortly",
            remaining.as_millis()
        ));
    }

    // Fail fast with an actionable message if Node is missing or too old,
    // rather than letting the spawn (or the SDK) blow up later and opaquely.
    state.ensure_node_version().await?;

    let script = host.resolve_script()?;
    let cwd = script
        .parent()
        .ok_or_else(|| "sidecar script has no parent dir".to_string())?
        .to_path_buf();

    // On Windows, `node` is typically `node.exe` and discoverable via PATH.
    let mut cmd = Command::new("node");
    cmd.arg(&script)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cognia_external_agent::proc_group::apply_process_group(&mut cmd);

    // Inject the host-resolved provider credentials (OAuth bearer → API key;
    // base URL orthogonal). See `host::inject_provider_env` for the precedence
    // rationale.
    host.inject_env(&mut cmd).await;

    match crate::telemetry::sidecar_env() {
        Ok(env) => {
            for (key, value) in env {
                cmd.env(key, value);
            }
        }
        Err(error) => log::warn!("sidecar telemetry configuration unavailable: {error}"),
    }

    // Inject the user's network proxy config so the Node sidecar's outbound
    // HTTP (Anthropic SDK + any provider relays) routes through the same
    // proxy as the rest of the app. The interceptor at
    // `sidecar/fetch-interceptor.mjs` reads HTTPS_PROXY at boot and wraps
    // the global undici dispatcher.
    let proxy_cfg = crate::proxy_config::current().map_err(|error| error.to_string())?;
    apply_managed_proxy_env(&mut cmd, &proxy_cfg)?;

    // On Windows, prevent a console window from popping up when the parent app
    // has no console (e.g. a release build). tokio::process::Command exposes
    // `creation_flags` directly on Windows, so no extra import is needed.
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar (is Node >= 20 on PATH?): {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child has no stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "child has no stderr".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "child has no stdin".to_string())?;

    // Claim this spawn's generation (under `spawn_lock`, so it's serial). The
    // watchdog below captures it to avoid acting on a superseded child.
    let my_epoch = state.next_epoch();

    // stdin lives behind its own lock (see `write_command`); child + ready stay
    // in the shared state.
    *state.stdin.lock().await = Some(stdin);
    {
        let mut guard = state.inner.lock().await;
        guard.child = Some(child);
        guard.ready = false;
    }
    // ADR-0028 Phase 14 — surface the spawn so Diagnostics can show
    // "Sidecar restarted N times this session".
    state.bump_restart_count();

    // Pipe stdout: each line is one JSON event we forward through the host.
    {
        let host = Arc::clone(&host);
        let state = state.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(value) => {
                                // Track the sidecar's "ready" announcement so we can short-circuit
                                // status checks before it has fully booted (also resets the
                                // crash-loop counter and disarms the ready watchdog).
                                if value.get("type").and_then(|t| t.as_str()) == Some("ready") {
                                    state.note_ready().await;
                                }
                                // PreToolUse hook: when the sidecar emits a permission_request
                                // we may need to short-circuit it with an automatic deny.
                                // Spawn the hook eval as a task so the reader keeps draining
                                // — concurrent permission_request events are evaluated in
                                // parallel.
                                if value.get("type").and_then(|t| t.as_str())
                                    == Some("permission_request")
                                {
                                    let host = Arc::clone(&host);
                                    tokio::spawn(async move {
                                        handle_permission_request(host, value).await;
                                    });
                                    continue;
                                }
                                // `host_rpc` is answered HERE, in Rust, and never
                                // forwarded to the renderer. That is the whole
                                // point of the frame: background-job calls have
                                // to work on a headless host (no renderer at
                                // all) and must not pay an extra network hop
                                // when a remote client is driving the desktop.
                                // Spawned so the reader keeps draining — a
                                // long-polling `jobs.wait` would otherwise block
                                // every other event behind it.
                                if value.get("type").and_then(|t| t.as_str()) == Some("host_rpc") {
                                    let state = state.clone();
                                    tokio::spawn(async move {
                                        answer_host_rpc(state, value).await;
                                    });
                                    continue;
                                }
                                // A2UI bridge dispatches go on a dedicated channel so the
                                // a2ui store can listen without filtering every sidecar event.
                                if value.get("type").and_then(|t| t.as_str())
                                    == Some("a2ui_dispatch")
                                {
                                    host.emit(A2UI_EVENT, &value);
                                    continue;
                                }
                                // Canonical envelopes (ADR-0090) ride their own
                                // channel; they are additive alongside the raw
                                // stream and never re-enter SIDECAR_EVENT.
                                if value.get("type").and_then(|t| t.as_str()) == Some("agent_event")
                                {
                                    host.emit(AGENT_EVENT, &value);
                                    continue;
                                }
                                // Built-in lifecycle execution is SDK-native.
                                // Rust only owns external-agent compatibility
                                // hooks; reclassifying this stream would execute
                                // SessionStart/Stop/Task handlers twice.
                                host.emit(SIDECAR_EVENT, &value);
                            }
                            Err(e) => {
                                log::warn!("sidecar emitted non-JSON line: {e}: {trimmed}");
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        log::error!("sidecar stdout read error: {e}");
                        break;
                    }
                }
            }
            // The sidecar exited. Clear state (incl. orphaned per-session hook
            // state) and record the failure so the next spawn can back off a
            // crash loop. `note_exit` is the single sink for all of that.
            let unexpected = state.note_exit(Instant::now()).await;
            if unexpected {
                // ADR-0102 §4 — three automatic restarts per subsystem, then
                // the subsystem is held back and the app enters safe mode. The
                // local `CrashBackoff` above paces the *next* respawn; this
                // budget is what stops an unpaceable loop.
                report_sidecar_failure();
            }
            log::warn!("sidecar process ended");
            host.emit(
                SIDECAR_EVENT,
                &serde_json::json!({ "type": "sidecar_exited" }),
            );
        });
    }

    // Forward stderr to the parent log so users can debug install issues.
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::warn!("[sidecar.stderr] {line}");
        }
    });

    // Ready watchdog: a child that never announces `ready` (e.g. Node hung on a
    // bad install) would otherwise sit forever while sends silently queue. Wait
    // up to SIDECAR_READY_TIMEOUT (reusing tokio::time::timeout + the existing
    // kill_sidecar) and kill it if it never boots, so the failure surfaces and
    // the next spawn can back off.
    {
        let host = Arc::clone(&host);
        let state = state.clone();
        tokio::spawn(async move {
            let outcome = tokio::time::timeout(SIDECAR_READY_TIMEOUT, async {
                loop {
                    // A newer spawn superseded us — our child is gone; stop
                    // watching so we never kill a healthy successor.
                    if state.current_epoch() != my_epoch {
                        return false;
                    }
                    {
                        let guard = state.inner.lock().await;
                        if guard.ready {
                            return true; // became ready
                        }
                        if guard.child.is_none() {
                            return false; // already exited; the reader handled it
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await;
            // Only act on a timeout, and only if we're still the current
            // generation (the child we armed against is the live one).
            if outcome.is_err() && state.current_epoch() == my_epoch {
                // Still pending at the deadline — kill so the reader records the
                // failure (feeding backoff). The reader's EOF handler emits the
                // `sidecar_exited` event; we add a `log` line so the user sees
                // *why* (avoids a duplicate `sidecar_exited`).
                //
                // A child that never announced ready is a genuine failure, so
                // report it here: `kill_sidecar` latches the exit as
                // intentional, which would otherwise let a boot that hangs
                // forever escape the recovery restart budget entirely.
                report_sidecar_failure();
                kill_sidecar(state.clone()).await;
                host.emit(
                    SIDECAR_EVENT,
                    &serde_json::json!({
                        "type": "log",
                        "level": "error",
                        "message": format!(
                            "sidecar did not become ready within {}s; restarting",
                            SIDECAR_READY_TIMEOUT.as_secs()
                        ),
                    }),
                );
            }
        });
    }

    Ok(())
}

/// Answer one `host_rpc` frame and write the result back down the sidecar's
/// stdin.
///
/// Deliberately terminal: unlike `plugin_tool_exec`, this frame is never
/// emitted onward to the renderer. Background jobs are owned by Rust, so the
/// renderer has nothing to contribute and a headless host has no renderer to
/// ask.
///
/// A failed dispatch still writes a frame — an unanswered `rpcId` would leave
/// the sidecar's caller hanging until its own timeout, turning a clean error
/// into a stall.
async fn answer_host_rpc(state: SidecarState, value: Value) {
    let Some(rpc_id) = value.get("rpcId").and_then(|v| v.as_str()) else {
        log::warn!("host_rpc frame without an rpcId; dropping");
        return;
    };
    let method = value.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = value.get("params").cloned().unwrap_or(Value::Null);

    // Session-store calls are routed FIRST and never reach the jobs dispatcher:
    // that one opens with `require_supervisor()?`, so on a host without
    // background jobs every session-store call would fail with a message about
    // jobs — a confusing way to learn that transcript mirroring is unavailable.
    let dispatched = if host_rpc_uses_session_store(method) {
        crate::agent_session_store::dispatch_host_rpc(method, &params).await
    } else {
        crate::jobs::dispatch_host_rpc(method, &params).await
    };

    let reply = match dispatched {
        Ok(result) => serde_json::json!({
            "type": "host_rpc_result",
            "rpcId": rpc_id,
            "ok": true,
            "result": result,
        }),
        Err(error) => {
            log::warn!("host_rpc {method} failed: {error}");
            serde_json::json!({
                "type": "host_rpc_result",
                "rpcId": rpc_id,
                "ok": false,
                "error": error,
            })
        }
    };
    if let Err(e) = state.write_command(&reply).await {
        // The sidecar is gone; its pending calls are rejected on its own side
        // when stdin closes, so there is nothing further to do here.
        log::warn!("could not deliver host_rpc_result for {method}: {e}");
    }
}

fn host_rpc_uses_session_store(method: &str) -> bool {
    crate::agent_session_store::is_session_store_method(method)
}

/// Forward a `permission_request` event from the sidecar. Both PreToolUse and
/// PermissionRequest hooks run in the SDK-native sidecar callback pipeline;
/// Rust must not execute either event again.
///
/// The forward at the bottom is load-bearing on headless hosts: it MUST reach
/// the EventBus (→ `/ws/v1/events`) or every gated tool call deadlocks
/// waiting for an approval nobody saw.
async fn handle_permission_request(host: Arc<dyn SidecarHost>, value: Value) {
    // Forward so the normal approval flow can run (WebView approval store on
    // desktop; `/ws/v1/events` subscribers headless).
    host.emit(SIDECAR_EVENT, &value);
}

/// Charge one unexpected sidecar death against the recovery restart budget and
/// log what recovery decided.
///
/// The returned delay is deliberately *not* applied here: the sidecar has no
/// respawn loop to delay (it is spawned lazily by the next `claude_send`), and
/// `CrashBackoff` already paces that path. What this adds is the ceiling —
/// after the fourth death `spawn` refuses, the subsystem is held back, and the
/// app enters safe mode so the user is told rather than left with a chat box
/// that silently never answers.
fn report_sidecar_failure() {
    use cognia_observability::recovery::{ChildAction, RecoverySubsystem};

    match crate::recovery::report_child_failure(RecoverySubsystem::Sidecar) {
        Some(ChildAction::Restart { attempt, .. }) => {
            log::warn!("recovery: sidecar death {attempt} of 3 before the subsystem is held back");
        }
        Some(ChildAction::Disable { .. }) => {
            log::error!(
                "recovery: sidecar restart budget exhausted; holding the subsystem back \
                 and entering the diagnostics shell"
            );
        }
        // Recovery is not running (headless tests, no data dir). `CrashBackoff`
        // still paces respawns, so supervision degrades rather than stops.
        None => {}
    }
}

/// Stop the running sidecar (drop stdin, kill the child). The next
/// `claude_send` will respawn it. Safe to call when no sidecar is running.
///
/// Deliberate by definition — the resulting exit is latched as intentional so
/// it is not charged against the recovery restart budget. The one caller that
/// kills because of a *genuine* failure (the ready watchdog) reports that
/// failure itself before calling this.
pub async fn shutdown_sidecar(state: SidecarState) -> Result<(), String> {
    state.note_intentional_stop().await;
    // Closing stdin first lets the sidecar exit cleanly (its stdin EOF handler
    // tears down active sessions). stdin lives behind its own lock; take it
    // before touching `inner` (stdin→inner order, never nested).
    state.stdin.lock().await.take();
    let child = {
        let mut guard = state.inner.lock().await;
        guard.ready = false;
        guard.child.take()
    };
    let Some(mut child) = child else {
        return Ok(());
    };

    // Give the stdin-EOF handler a bounded opportunity to close active SDK
    // sessions and their descendants before escalating. A credential boundary
    // must not report success while the old process is still alive.
    match tokio::time::timeout(Duration::from_millis(750), child.wait()).await {
        Ok(Ok(_)) => return Ok(()),
        Ok(Err(error)) => return Err(format!("failed waiting for sidecar shutdown: {error}")),
        Err(_) => {}
    }

    let pid = child.id();
    cognia_external_agent::proc_group::kill_process_group(pid);
    child
        .start_kill()
        .map_err(|error| format!("failed to kill sidecar: {error}"))?;
    tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .map_err(|_| "timed out waiting for sidecar process to exit".to_string())?
        .map_err(|error| format!("failed reaping sidecar process: {error}"))?;
    Ok(())
}

pub async fn kill_sidecar(state: SidecarState) {
    if let Err(error) = shutdown_sidecar(state).await {
        log::warn!("sidecar shutdown failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn host_rpc_routes_session_store_before_the_jobs_dispatcher() {
        assert!(host_rpc_uses_session_store("sessionStore.append"));
        assert!(host_rpc_uses_session_store("sessionStore.listSessions"));
        assert!(!host_rpc_uses_session_store("jobs.spawn"));
        assert!(!host_rpc_uses_session_store("jobs.sessionStore"));
    }

    #[test]
    fn parse_node_major_handles_all_forms() {
        // Canonical `node --version` output.
        assert_eq!(parse_node_major("v20.11.0\n"), Some(20));
        assert_eq!(parse_node_major("v18.19.0"), Some(18));
        // Missing leading `v` is tolerated.
        assert_eq!(parse_node_major("22.1.0"), Some(22));
        // Surrounding whitespace is trimmed.
        assert_eq!(parse_node_major("  v24.0.0  "), Some(24));
        // Garbage / empty input yields None (caller treats as "unknown").
        assert_eq!(parse_node_major(""), None);
        assert_eq!(parse_node_major("vX.Y.Z"), None);
        assert_eq!(parse_node_major("not a version"), None);
    }

    fn command_env(cmd: &Command, key: &str) -> Option<Option<String>> {
        cmd.as_std()
            .get_envs()
            .find(|(name, _)| *name == std::ffi::OsStr::new(key))
            .map(|(_, value)| value.map(|item| item.to_string_lossy().into_owned()))
    }

    #[test]
    fn active_proxy_env_is_marked_as_host_managed() {
        let mut cmd = Command::new("node");
        let cfg = crate::proxy_config::ProxyConfig {
            mode: crate::proxy_config::ProxyMode::Manual,
            protocol: crate::proxy_config::ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port: 7890,
            ..crate::proxy_config::ProxyConfig::default()
        };

        apply_managed_proxy_env(&mut cmd, &cfg).unwrap();

        assert_eq!(
            command_env(&cmd, "HTTPS_PROXY"),
            Some(Some("http://127.0.0.1:7890".to_string()))
        );
        assert_eq!(
            command_env(&cmd, "COGNIA_MANAGED_NETWORK_PROXY"),
            Some(Some("1".to_string()))
        );
    }

    #[test]
    fn direct_proxy_policy_removes_inherited_proxy_env_and_marker() {
        let mut cmd = Command::new("node");

        apply_managed_proxy_env(&mut cmd, &crate::proxy_config::ProxyConfig::default()).unwrap();

        assert_eq!(command_env(&cmd, "HTTPS_PROXY"), Some(None));
        assert_eq!(
            command_env(&cmd, "COGNIA_MANAGED_NETWORK_PROXY"),
            Some(None)
        );
    }

    #[test]
    fn active_proxy_without_a_valid_environment_is_rejected() {
        let mut cmd = Command::new("node");
        let cfg = crate::proxy_config::ProxyConfig {
            mode: crate::proxy_config::ProxyMode::Manual,
            protocol: crate::proxy_config::ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port: 7890,
            username: Some("alice".to_string()),
            password: None,
            ..crate::proxy_config::ProxyConfig::default()
        };

        assert_eq!(
            apply_managed_proxy_env(&mut cmd, &cfg).unwrap_err(),
            "PROXY_INVALID_CONFIG: sidecar proxy environment is unavailable"
        );
        assert_eq!(command_env(&cmd, "HTTPS_PROXY"), None);
    }

    // The pure backoff-table tests moved to `supervision_backoff.rs` with the
    // extraction (R6); the state-level tests below still exercise the
    // SidecarState wiring around `CrashBackoff`.

    #[tokio::test]
    async fn an_unasked_for_exit_is_reported_as_unexpected() {
        let s = SidecarState::new();
        assert!(
            s.note_exit(Instant::now()).await,
            "a crash must be charged against the recovery restart budget"
        );
    }

    #[tokio::test]
    async fn a_deliberate_stop_is_not_charged_to_the_restart_budget() {
        let s = SidecarState::new();
        s.note_intentional_stop().await;
        assert!(!s.note_exit(Instant::now()).await);
    }

    #[tokio::test]
    async fn the_intentional_latch_covers_exactly_one_exit() {
        // Otherwise a single "restart sidecar" click would mask every later
        // crash, and the budget would never fire.
        let s = SidecarState::new();
        s.note_intentional_stop().await;
        assert!(!s.note_exit(Instant::now()).await);
        assert!(s.note_exit(Instant::now()).await);
    }

    #[tokio::test]
    async fn killing_the_sidecar_latches_the_intentional_stop() {
        let s = SidecarState::new();
        // No child is running; the latch must still be set, because the reader
        // task for a child that is already dying will consume it.
        kill_sidecar(s.clone()).await;
        assert!(!s.note_exit(Instant::now()).await);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn strict_shutdown_waits_until_the_sidecar_is_reaped() {
        let state = SidecarState::new();
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("sleep 30")
            .stdin(Stdio::piped())
            .kill_on_drop(true);
        cognia_external_agent::proc_group::apply_process_group(&mut command);
        let child = command.spawn().expect("spawn test sidecar");
        let pid = child.id().expect("child pid");
        state.inner.lock().await.child = Some(child);

        shutdown_sidecar(state.clone())
            .await
            .expect("strict shutdown");

        assert!(state.inner.lock().await.child.is_none());
        let still_alive = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
        assert!(!still_alive, "sidecar process {pid} must be reaped");
    }

    #[tokio::test]
    async fn backoff_remaining_none_before_any_failure() {
        let s = SidecarState::new();
        assert!(s.backoff_remaining(Instant::now()).await.is_none());
    }

    #[tokio::test]
    async fn backoff_remaining_single_failure_is_immediate() {
        let s = SidecarState::new();
        let t0 = Instant::now();
        s.note_exit(t0).await; // failures = 1 → delay 0 → no backoff
        assert!(s.backoff_remaining(t0).await.is_none());
    }

    #[tokio::test]
    async fn backoff_remaining_inside_and_past_window() {
        let s = SidecarState::new();
        let t0 = Instant::now();
        s.note_exit(t0).await; // failures = 1
        s.note_exit(t0).await; // failures = 2 → delay 250ms
        let inside = s.backoff_remaining(t0 + Duration::from_millis(100)).await;
        assert!(inside.is_some());
        assert!(inside.unwrap() <= Duration::from_millis(150));
        assert!(s
            .backoff_remaining(t0 + Duration::from_millis(300))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn note_ready_resets_crash_loop() {
        let s = SidecarState::new();
        let t0 = Instant::now();
        s.note_exit(t0).await;
        s.note_exit(t0).await; // failures = 2
        s.note_ready().await; // a successful boot clears the counter
        assert!(s
            .backoff_remaining(t0 + Duration::from_millis(1))
            .await
            .is_none());
    }

    #[test]
    fn spawn_epoch_advances_monotonically() {
        let s = SidecarState::new();
        assert_eq!(s.current_epoch(), 0);
        let e1 = s.next_epoch();
        let e2 = s.next_epoch();
        assert_eq!(e1, 1);
        assert_eq!(e2, 2);
        assert_eq!(s.current_epoch(), 2);
        // A watchdog armed at generation e1 can detect it has been superseded.
        assert_ne!(e1, s.current_epoch());
    }

    #[tokio::test]
    async fn write_command_errors_when_not_running() {
        let s = SidecarState::new();
        let err = s
            .write_command(&serde_json::json!({ "type": "send" }))
            .await
            .unwrap_err();
        assert!(err.contains("not running"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn managed_snapshot_is_none_when_no_child() {
        let s = SidecarState::new();
        assert!(s.managed_snapshot().await.is_none());
    }
}
