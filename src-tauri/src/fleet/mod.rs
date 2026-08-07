//! Agent Fleet — monitor & control externally-launched coding agents.
//!
//! External Claude Code / Codex / OpenCode processes report lifecycle events
//! through tiny generated hook scripts (see [`install`]) that POST to the
//! companion API's `/api/v1/fleet/*` routes ([`routes`], mounted from
//! `companion_api::server::build_router`). Events fold into the in-memory
//! [`registry::FleetRegistry`] and every change is emitted to the island
//! overlay webview as a full `fleet://update` snapshot (perf-sampler pattern).
//!
//! The runtime is a process-global singleton (like
//! `companion_api::PRE_AUTH_RATE_LIMITER`) rather than Tauri-managed state so
//! the axum handlers — which only get `SharedState` — and the Tauri commands
//! share it without threading an `AppHandle` through the router.

pub mod codex;
pub mod codex_hooks;
pub mod control;
pub mod gitinfo;
pub mod install;
pub mod integrations;
pub mod island_space;
pub mod island_window;
pub mod opencode;
mod outbox;
pub mod registry;
pub mod routes;
pub mod terminal;

use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

use registry::{FleetRegistry, FleetSnapshot};

/// Snapshot event topic (namespaced like `perf://sample`). A pending
/// permission rides inside the snapshot's session row, so there is no separate
/// permission event — the island derives "needs attention" from the snapshot.
pub const UPDATE_EVENT: &str = "fleet://update";

/// How long a parked permission waits for an island answer before falling
/// open. Must stay BELOW the hook script's curl `--max-time` (25 s) and the
/// settings.json hook `timeout` (30 s) so the terminal prompt always returns.
pub const PERMISSION_WAIT_MS: u64 = 20_000;

/// Reaper cadence for ended/stale rows. Must stay well under
/// [`registry::ENDED_LINGER_MS`]: the linger window is the UX contract for how
/// long a finished row stays visible, and the reaper tick is the only thing
/// that actually removes it — a coarse tick (the old 30 s) left ended rows
/// miscounting the island for up to tick+linger.
const REAP_INTERVAL_MS: u64 = 5_000;

/// Test seam: overrides [`PERMISSION_WAIT_MS`] so route tests don't sleep 20 s.
/// `0` means "no override".
static PERMISSION_WAIT_OVERRIDE_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

pub fn permission_wait_ms() -> u64 {
    match PERMISSION_WAIT_OVERRIDE_MS.load(Ordering::SeqCst) {
        0 => PERMISSION_WAIT_MS,
        n => n,
    }
}

#[cfg(test)]
pub fn set_permission_wait_override_ms(ms: Option<u64>) {
    PERMISSION_WAIT_OVERRIDE_MS.store(ms.unwrap_or(0), Ordering::SeqCst);
}

/// Test seam: disables the synchronous `git` shell-out in
/// [`FleetRuntime::ingest`] so unit/route tests never spawn a subprocess.
/// Enabled by default in production, and OFF in `cfg(test)` builds so existing
/// `ingest`/route tests stay subprocess-free — the git-path test opts in
/// explicitly under [`TEST_RUNTIME_LOCK`].
static GIT_CAPTURE_ENABLED: AtomicBool = AtomicBool::new(!cfg!(test));

pub fn git_capture_enabled() -> bool {
    GIT_CAPTURE_ENABLED.load(Ordering::SeqCst)
}

#[cfg(test)]
pub fn set_git_capture_enabled(enabled: bool) {
    GIT_CAPTURE_ENABLED.store(enabled, Ordering::SeqCst);
}

/// How long an OpenCode command poll parks before returning empty. Kept short
/// enough that the plugin re-polls promptly; a queued command wakes it early.
pub const COMMAND_POLL_WAIT_MS: u64 = 20_000;
const COMMAND_LEASE_MS: u64 = 30_000;
const COMMAND_TTL_MS: u64 = 5 * 60_000;
const COMMAND_MAX_ATTEMPTS: u32 = 5;

static COMMAND_POLL_OVERRIDE_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

pub fn command_poll_wait_ms() -> u64 {
    match COMMAND_POLL_OVERRIDE_MS.load(Ordering::SeqCst) {
        0 => COMMAND_POLL_WAIT_MS,
        n => n,
    }
}

#[cfg(test)]
pub fn set_command_poll_override_ms(ms: Option<u64>) {
    COMMAND_POLL_OVERRIDE_MS.store(ms.unwrap_or(0), Ordering::SeqCst);
}

/// Serializes tests that mutate the process-global runtime's token/enabled
/// state (same shared-static trap as `proxy_config` — parallel test threads
/// stomp each other's arm() otherwise). Tokio mutex so async tests can hold
/// the guard across awaits.
#[cfg(test)]
pub(crate) static TEST_RUNTIME_LOCK: Lazy<tokio::sync::Mutex<()>> =
    Lazy::new(|| tokio::sync::Mutex::new(()));

/// A permission decision from the island.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionBehavior {
    Allow,
    Deny,
}

/// A queued "send this prompt to an OpenCode session" command. The OpenCode
/// plugin polls for these and executes them via its bound `client`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeCommand {
    pub id: String,
    pub session_id: String,
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub answers: Vec<Vec<String>>,
    pub attempt: u32,
    #[serde(skip)]
    created_at: u64,
    #[serde(skip)]
    expires_at: u64,
    #[serde(skip)]
    leased_until: u64,
}

/// A parked AskUserQuestion long-poll: the sender delivers the built
/// `updatedInput` answer value, and the raw questions are held so
/// `respond_question` can turn the island's option selections into that value.
struct PendingQuestionPoll {
    tx: tokio::sync::oneshot::Sender<serde_json::Value>,
    raw_questions: serde_json::Value,
}

/// Process-global fleet runtime.
pub struct FleetRuntime {
    registry: Mutex<FleetRegistry>,
    /// Parked permission long-polls keyed by request id. The axum handler
    /// awaits the receiver; `fleet_permission_respond` fires the sender.
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<PermissionBehavior>>>,
    /// Parked AskUserQuestion long-polls keyed by request id. The axum handler
    /// awaits the answer; `fleet_question_respond` builds and fires it.
    question_pending: Mutex<HashMap<String, PendingQuestionPoll>>,
    /// Outbound send-message commands for OpenCode sessions, drained by the
    /// plugin's command poll (`/api/v1/fleet/opencode/commands`).
    opencode_commands: Mutex<Vec<OpencodeCommand>>,
    /// JSON outbox path installed when fleet monitoring starts. Commands are
    /// restored before a fresh ingress token is published.
    outbox_path: RwLock<Option<PathBuf>>,
    /// Wakers for parked command polls, so a queued command is delivered
    /// immediately rather than on the next poll tick.
    command_wakers: Mutex<Vec<tokio::sync::oneshot::Sender<()>>>,
    /// Ingress auth token — regenerated per `fleet_monitor_start`.
    token: RwLock<Option<String>>,
    enabled: AtomicBool,
    /// Emit target. `None` before `init` (and in unit tests).
    app_handle: RwLock<Option<tauri::AppHandle>>,
    reaper_running: AtomicBool,
}

static RUNTIME: Lazy<Arc<FleetRuntime>> = Lazy::new(|| {
    Arc::new(FleetRuntime {
        registry: Mutex::new(FleetRegistry::new()),
        pending: Mutex::new(HashMap::new()),
        question_pending: Mutex::new(HashMap::new()),
        opencode_commands: Mutex::new(Vec::new()),
        outbox_path: RwLock::new(None),
        command_wakers: Mutex::new(Vec::new()),
        token: RwLock::new(None),
        enabled: AtomicBool::new(false),
        app_handle: RwLock::new(None),
        reaper_running: AtomicBool::new(false),
    })
});

pub fn runtime() -> Arc<FleetRuntime> {
    Arc::clone(&RUNTIME)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl FleetRuntime {
    fn configure_outbox(&self, path: PathBuf) -> Result<(), String> {
        let now = now_ms();
        let mut restored = outbox::load(&path)?;
        restored
            .retain(|command| command.expires_at > now && command.attempt < COMMAND_MAX_ATTEMPTS);
        *self.opencode_commands.lock() = restored;
        *self.outbox_path.write() = Some(path);
        self.persist_outbox()
    }

    fn persist_outbox(&self) -> Result<(), String> {
        let Some(path) = self.outbox_path.read().clone() else {
            return Ok(());
        };
        let commands = self.opencode_commands.lock().clone();
        outbox::save(Path::new(&path), &commands)
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Constant-time token check (length leak is fine — the length is public).
    pub fn token_matches(&self, presented: &str) -> bool {
        let guard = self.token.read();
        let Some(expected) = guard.as_deref() else {
            return false;
        };
        if expected.len() != presented.len() {
            return false;
        }
        expected
            .bytes()
            .zip(presented.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
    }

    pub fn snapshot(&self) -> FleetSnapshot {
        self.registry.lock().snapshot(now_ms())
    }

    /// Terminal source for one session (focus-action lookup).
    pub fn session_terminal(
        &self,
        agent: registry::FleetAgent,
        session_id: &str,
    ) -> Option<terminal::TerminalSource> {
        self.registry.lock().session_terminal(agent, session_id)
    }

    /// Agent process id for one session (interrupt-action lookup). `None` when
    /// the session is unknown or never reported a pid — the interrupt path
    /// treats that as "not running" rather than guessing a target.
    pub fn session_agent_pid(&self, agent: registry::FleetAgent, session_id: &str) -> Option<u32> {
        self.registry.lock().session_agent_pid(agent, session_id)
    }

    /// Fold an event, run the terminal parent-chain fallback if the env
    /// carried no terminal marker, then emit the follow-up events.
    pub fn ingest(&self, event: &registry::FleetEvent) -> registry::RegistryEffect {
        let effect = self.registry.lock().apply(event, now_ms());

        // If the env classifier came up empty but we have the agent pid,
        // walk its parent chain to name the terminal. Done here (not in the
        // pure registry) because it does live sysinfo I/O.
        if let Some(session_id) = integrations::manifest_for(event.agent).session_id(&event.payload)
        {
            let pid = self
                .registry
                .lock()
                .needs_terminal_fallback(event.agent, &session_id);
            if let Some(pid) = pid {
                if let Some(terminal) = terminal::classify_from_pid(pid) {
                    self.registry
                        .lock()
                        .set_terminal(event.agent, &session_id, terminal);
                }
            }
        }

        match &effect {
            registry::RegistryEffect::Updated
            | registry::RegistryEffect::PermissionRequested { .. }
            | registry::RegistryEffect::QuestionRequested { .. } => self.emit_update(),
            registry::RegistryEffect::Ignored => {}
        }
        effect
    }

    /// Capture the working directory's git branch once per turn, OFF the async
    /// runtime: the `git rev-parse` shell-out runs on a blocking pool via
    /// `spawn_blocking`, so it never blocks a tokio worker (unlike the pure
    /// [`ingest`], which is synchronous). Guarded by `needs_git_capture` so it
    /// runs at most once per turn; re-emits the snapshot when the branch
    /// changed. No-op when the test seam disables capture.
    pub async fn capture_git_branch(&self, event: &registry::FleetEvent) {
        if !git_capture_enabled() {
            return;
        }
        let Some(session_id) = integrations::manifest_for(event.agent).session_id(&event.payload)
        else {
            return;
        };
        // Lock only to read the cwd; the guard drops before the shell-out.
        let cwd = self
            .registry
            .lock()
            .needs_git_capture(event.agent, &session_id);
        let Some(cwd) = cwd else {
            return;
        };
        let branch = tauri::async_runtime::spawn_blocking(move || gitinfo::current_branch(&cwd))
            .await
            .ok()
            .flatten();
        if self
            .registry
            .lock()
            .set_git_branch(event.agent, &session_id, branch)
        {
            self.emit_update();
        }
    }

    /// Park a permission long-poll and await the island's decision. `None`
    /// on timeout (the caller answers the hook with an empty body so the
    /// agent's own terminal prompt takes over — fail-open, never stuck).
    pub async fn wait_for_permission(
        &self,
        request_id: &str,
        wait_ms: u64,
    ) -> Option<PermissionBehavior> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().insert(request_id.to_string(), tx);

        let decision =
            match tokio::time::timeout(std::time::Duration::from_millis(wait_ms), rx).await {
                Ok(Ok(behavior)) => Some(behavior),
                // Timeout or dropped sender → fail open.
                _ => None,
            };

        // Cleanup regardless of outcome: drop the pending entry and clear the
        // registry row so the island stops showing a dead countdown.
        self.pending.lock().remove(request_id);
        if self.registry.lock().resolve_permission(request_id) {
            self.emit_update();
        }
        decision
    }

    /// Resolve a parked permission from the island. Returns false when the
    /// request already timed out (island shows "expired" via the snapshot).
    pub fn respond_permission(&self, request_id: &str, behavior: PermissionBehavior) -> bool {
        let sender = self.pending.lock().remove(request_id);
        match sender {
            Some(tx) => tx.send(behavior).is_ok(),
            None => false,
        }
    }

    /// Park an AskUserQuestion long-poll and await the island's answer. `None`
    /// on timeout — the caller answers the hook with an empty body so the
    /// agent's own terminal picker takes over (fail-open, never stuck). The
    /// resolved value is the hook decision's `updatedInput` (questions +
    /// answers), built by [`respond_question`] from the raw questions held here.
    pub async fn wait_for_question(
        &self,
        request_id: &str,
        raw_questions: serde_json::Value,
        wait_ms: u64,
    ) -> Option<serde_json::Value> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.question_pending.lock().insert(
            request_id.to_string(),
            PendingQuestionPoll { tx, raw_questions },
        );

        let answer = match tokio::time::timeout(std::time::Duration::from_millis(wait_ms), rx).await
        {
            Ok(Ok(updated_input)) => Some(updated_input),
            // Timeout or dropped sender → fail open.
            _ => None,
        };

        // Cleanup regardless of outcome: drop the pending entry and clear the
        // answerable handle so the island stops showing a dead countdown.
        self.question_pending.lock().remove(request_id);
        if self.registry.lock().resolve_question(request_id) {
            self.emit_update();
        }
        answer
    }

    /// Resolve a parked AskUserQuestion from the island. `selections[i]` is the
    /// selected option indices for question `i`. Builds the answer's
    /// `updatedInput` from the raw questions held on the parked poll and fires
    /// it. Returns false when the request already timed out.
    pub fn respond_question(&self, request_id: &str, selections: Vec<Vec<u32>>) -> bool {
        let poll = self.question_pending.lock().remove(request_id);
        match poll {
            Some(PendingQuestionPoll { tx, raw_questions }) => {
                let updated_input =
                    registry::build_ask_user_answer_input(&raw_questions, &selections);
                tx.send(updated_input).is_ok()
            }
            None => {
                let target = self.registry.lock().question_target(request_id);
                let Some((agent, session_id, questions)) = target else {
                    return false;
                };
                if agent != registry::FleetAgent::Opencode {
                    return false;
                }
                let answers = questions
                    .iter()
                    .enumerate()
                    .map(|(question_index, question)| {
                        selections
                            .get(question_index)
                            .into_iter()
                            .flatten()
                            .filter_map(|index| question.options.get(*index as usize).cloned())
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>();
                if self
                    .queue_opencode_control(
                        session_id,
                        "question-reply",
                        String::new(),
                        Some(request_id.to_string()),
                        answers,
                    )
                    .is_err()
                {
                    return false;
                }
                if self.registry.lock().resolve_question(request_id) {
                    self.emit_update();
                }
                true
            }
        }
    }

    /// Queue an OpenCode send-message command and wake any parked poll so the
    /// plugin picks it up immediately.
    pub fn queue_opencode_command(
        &self,
        session_id: String,
        text: String,
    ) -> Result<String, String> {
        self.queue_opencode_control(session_id, "prompt", text, None, Vec::new())
    }

    pub fn queue_opencode_interrupt(&self, session_id: String) -> Result<String, String> {
        self.queue_opencode_control(session_id, "interrupt", String::new(), None, Vec::new())
    }

    fn queue_opencode_control(
        &self,
        session_id: String,
        kind: &str,
        text: String,
        request_id: Option<String>,
        answers: Vec<Vec<String>>,
    ) -> Result<String, String> {
        let id = mint_token();
        self.opencode_commands.lock().push(OpencodeCommand {
            id: id.clone(),
            session_id,
            kind: kind.to_string(),
            text,
            request_id,
            answers,
            attempt: 0,
            created_at: now_ms(),
            expires_at: now_ms().saturating_add(COMMAND_TTL_MS),
            leased_until: 0,
        });
        if let Err(error) = self.persist_outbox() {
            self.opencode_commands
                .lock()
                .retain(|command| command.id != id);
            return Err(error);
        }
        for waker in self.command_wakers.lock().drain(..) {
            let _ = waker.send(());
        }
        Ok(id)
    }

    /// Lease commands whose session is in `session_ids`. Commands remain in the
    /// outbox until acknowledged; a crashed plugin can receive them again after
    /// the lease expires.
    fn take_opencode_commands(&self, session_ids: &[String]) -> Vec<OpencodeCommand> {
        let mut queue = self.opencode_commands.lock();
        let now = now_ms();
        queue.retain(|cmd| cmd.expires_at > now && cmd.attempt < COMMAND_MAX_ATTEMPTS);
        let mut taken = Vec::new();
        for cmd in queue.iter_mut() {
            if cmd.leased_until <= now && session_ids.iter().any(|s| s == &cmd.session_id) {
                cmd.attempt = cmd.attempt.saturating_add(1);
                cmd.leased_until = now.saturating_add(COMMAND_LEASE_MS);
                taken.push(cmd.clone());
            }
        }
        drop(queue);
        if let Err(error) = self.persist_outbox() {
            log::error!("failed to persist fleet command lease: {error}");
        }
        taken
    }

    pub fn ack_opencode_commands(&self, command_ids: &[String]) -> Result<usize, String> {
        let mut queue = self.opencode_commands.lock();
        let prior = queue.clone();
        let acked_ids = queue
            .iter()
            .filter(|command| command_ids.iter().any(|id| id == &command.id))
            .map(|command| command.id.clone())
            .collect::<Vec<_>>();
        let before = queue.len();
        queue.retain(|command| !command_ids.iter().any(|id| id == &command.id));
        let acked = before.saturating_sub(queue.len());
        drop(queue);
        if let Err(error) = self.persist_outbox() {
            *self.opencode_commands.lock() = prior;
            return Err(error);
        }
        crate::companion_api::audit::record(
            "fleet.command.acknowledged",
            "opencode-plugin",
            "fleet.control",
            "acknowledged",
            serde_json::json!({ "command_ids": acked_ids, "acked": acked }),
        );
        Ok(acked)
    }

    /// Long-poll for OpenCode commands: return immediately if any match, else
    /// park until one is queued or the wait budget lapses (empty on timeout).
    pub async fn poll_opencode_commands(
        &self,
        session_ids: &[String],
        wait_ms: u64,
    ) -> Vec<OpencodeCommand> {
        let immediate = self.take_opencode_commands(session_ids);
        if !immediate.is_empty() {
            return immediate;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.command_wakers.lock().push(tx);
        let _ = tokio::time::timeout(std::time::Duration::from_millis(wait_ms), rx).await;
        self.take_opencode_commands(session_ids)
    }

    fn set_app_handle(&self, app: tauri::AppHandle) -> Result<(), String> {
        let outbox_path = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("resolve fleet command outbox directory: {error}"))?
            .join("fleet-command-outbox.json");
        self.configure_outbox(outbox_path)?;
        *self.app_handle.write() = Some(app);
        Ok(())
    }

    fn emit_update(&self) {
        let snapshot = self.snapshot();
        if let Some(app) = self.app_handle.read().as_ref() {
            let _ = app.emit(UPDATE_EVENT, &snapshot);
        }
    }

    fn start_reaper(self: &Arc<Self>) {
        if self.reaper_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(REAP_INTERVAL_MS)).await;
                if !runtime.is_enabled() {
                    // Keep looping cheaply; monitoring may be re-enabled.
                    continue;
                }
                let changed = {
                    let mut reg = runtime.registry.lock();
                    reg.reap(now_ms(), pid_alive)
                };
                if changed {
                    runtime.emit_update();
                }
            }
        });
    }
}

/// Liveness probe for the reaper — `sysinfo` refresh scoped to one pid.
fn pid_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    let target = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[target]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system.process(target).is_some()
}

/// Status DTO for the settings card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMonitorStatus {
    pub enabled: bool,
    /// Companion API port the ingress listens on (None while stopped).
    pub port: Option<u16>,
    pub config_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Enable fleet monitoring: ensure the companion server is running (loopback,
/// default port), mint a fresh ingress token, publish
/// `~/.cognia/agent-monitor.json` for the hook scripts, and start the reaper.
#[tauri::command]
pub async fn fleet_monitor_start(
    app: tauri::AppHandle,
    companion: tauri::State<'_, crate::companion_api::CompanionServerState>,
) -> Result<FleetMonitorStatus, String> {
    let runtime = runtime();
    runtime.set_app_handle(app.clone())?;

    // Reuse the companion server as the ingress listener (user decision: no
    // second HTTP server). Already-running → keeps its current port/bind.
    let port = match companion.bound_port() {
        Some(p) => p,
        None => crate::companion_api::commands::companion_server_start(
            companion.clone(),
            app.clone(),
            crate::companion_api::server::DEFAULT_PORT,
            true,
        )
        .await
        .map_err(|e| e.to_string())?,
    };

    let token = mint_token();
    *runtime.token.write() = Some(token.clone());
    let config_path = install::write_monitor_config(port, &token).map_err(|e| e.to_string())?;

    runtime.enabled.store(true, Ordering::SeqCst);
    runtime.start_reaper();
    runtime.emit_update();

    Ok(FleetMonitorStatus {
        enabled: true,
        port: Some(port),
        config_path: Some(config_path.to_string_lossy().into_owned()),
    })
}

/// Boot-time restore: if `agent-monitor.json` is present the user had
/// monitoring enabled before the last quit (stop deletes the file), so
/// re-arm it — a fresh token is minted and the file rewritten, replacing the
/// stale token the persisted hook scripts would otherwise present to a dead
/// ingress. No-op (and reports disabled) when the file is absent.
#[tauri::command]
pub async fn fleet_monitor_restore(
    app: tauri::AppHandle,
    companion: tauri::State<'_, crate::companion_api::CompanionServerState>,
) -> Result<FleetMonitorStatus, String> {
    let was_enabled = install::monitor_config_path().is_some_and(|p| p.exists());
    if was_enabled {
        fleet_monitor_start(app, companion).await
    } else {
        Ok(FleetMonitorStatus {
            enabled: false,
            port: None,
            config_path: None,
        })
    }
}

/// Disable fleet monitoring. Removes the monitor config file so installed
/// hook scripts fast-exit (they no-op when the file is missing); the
/// companion server is left as-is (other features may be using it).
#[tauri::command]
pub async fn fleet_monitor_stop() -> Result<FleetMonitorStatus, String> {
    let runtime = runtime();
    runtime.enabled.store(false, Ordering::SeqCst);
    *runtime.token.write() = None;
    runtime.registry.lock().clear_observed_sessions();
    runtime.pending.lock().clear();
    runtime.question_pending.lock().clear();
    runtime.opencode_commands.lock().clear();
    runtime.persist_outbox()?;
    runtime.command_wakers.lock().clear();
    install::remove_monitor_config().map_err(|e| e.to_string())?;
    runtime.emit_update();
    Ok(FleetMonitorStatus {
        enabled: false,
        port: None,
        config_path: None,
    })
}

/// Current monitor status for the settings card.
#[tauri::command]
pub async fn fleet_monitor_status(
    companion: tauri::State<'_, crate::companion_api::CompanionServerState>,
) -> Result<FleetMonitorStatus, String> {
    let runtime = runtime();
    let enabled = runtime.is_enabled();
    Ok(FleetMonitorStatus {
        enabled,
        port: if enabled {
            companion.bound_port()
        } else {
            None
        },
        config_path: install::monitor_config_path()
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned()),
    })
}

/// Full snapshot for island mount (before the first `fleet://update`).
#[tauri::command]
pub async fn fleet_get_snapshot() -> Result<FleetSnapshot, String> {
    Ok(runtime().snapshot())
}

/// Island → queue a prompt for an OpenCode session (the plugin executes it via
/// its bound `client.session.promptAsync`). Returns the command id.
#[tauri::command]
pub async fn fleet_opencode_send_message(
    session_id: String,
    text: String,
) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("message is empty".to_string());
    }
    runtime().queue_opencode_command(session_id, trimmed.to_string())
}

/// Island Approve/Deny → resolves the parked hook long-poll.
#[tauri::command]
pub async fn fleet_permission_respond(
    request_id: String,
    behavior: PermissionBehavior,
) -> Result<bool, String> {
    Ok(runtime().respond_permission(&request_id, behavior))
}

/// Island question answer → resolves the parked AskUserQuestion long-poll.
/// `selections[i]` carries the option indices the user picked for question `i`
/// (one for single-select, one or more for multi-select). Returns false when
/// the answer window already lapsed (the island shows "answered in terminal").
#[tauri::command]
pub async fn fleet_question_respond(
    request_id: String,
    selections: Vec<Vec<u32>>,
) -> Result<bool, String> {
    Ok(runtime().respond_question(&request_id, selections))
}

fn mint_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: RUNTIME is process-global; tests that mutate it use distinct
    // request ids / tokens so they can't collide across threads.

    #[test]
    fn mint_token_is_64_hex_chars_and_unique() {
        let a = mint_token();
        let b = mint_token();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn token_matches_only_exact_value() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        let rt = runtime();
        *rt.token.write() = Some("aa".repeat(32));
        assert!(rt.token_matches(&"aa".repeat(32)));
        assert!(!rt.token_matches(&"ab".repeat(32)));
        assert!(!rt.token_matches("short"));
        *rt.token.write() = None;
        assert!(!rt.token_matches(&"aa".repeat(32)));
    }

    #[tokio::test]
    async fn permission_round_trip_allow() {
        let rt = runtime();
        let request_id = "test-perm-allow";
        let waiter = {
            let rt = Arc::clone(&rt);
            tokio::spawn(async move { rt.wait_for_permission(request_id, 5_000).await })
        };
        // Let the waiter park its sender.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(rt.respond_permission(request_id, PermissionBehavior::Allow));
        assert_eq!(waiter.await.unwrap(), Some(PermissionBehavior::Allow));
    }

    #[tokio::test]
    async fn respond_without_waiter_returns_false() {
        assert!(!runtime().respond_permission("ghost-request", PermissionBehavior::Deny));
    }

    #[tokio::test]
    async fn question_round_trip_builds_updated_input() {
        let rt = runtime();
        let request_id = "test-question-answer";
        let raw = serde_json::json!([
            { "question": "Which auth method?", "multiSelect": false,
              "options": [{"label": "OAuth"}, {"label": "API key"}] }
        ]);
        let waiter = {
            let rt = Arc::clone(&rt);
            let raw = raw.clone();
            tokio::spawn(async move { rt.wait_for_question(request_id, raw, 5_000).await })
        };
        // Let the waiter park its sender, then answer with option index 1.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(rt.respond_question(request_id, vec![vec![1]]));

        let updated = waiter.await.unwrap().expect("answer delivered");
        assert_eq!(updated["questions"], raw);
        assert_eq!(updated["answers"]["Which auth method?"], "API key");
    }

    #[tokio::test]
    async fn respond_question_without_waiter_returns_false() {
        assert!(!runtime().respond_question("ghost-question", vec![vec![0]]));
    }

    #[tokio::test]
    async fn opencode_question_response_queues_native_reply_without_long_poll() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        let rt = runtime();
        let session_id = "mod-opencode-question-native";
        let request_id = "mod-opencode-question-request";
        let event = registry::FleetEvent {
            agent: registry::FleetAgent::Opencode,
            event: "question.asked".into(),
            pid: Some(101),
            ppid: None,
            env: Default::default(),
            payload: serde_json::json!({
                "session_id": session_id,
                "request_id": request_id,
                "tool_input": {
                    "questions": [{
                        "question": "Which auth method?",
                        "options": [{"label": "OAuth"}, {"label": "API key"}]
                    }]
                }
            }),
        };
        assert_eq!(rt.ingest(&event), registry::RegistryEffect::Updated);

        assert!(rt.respond_question(request_id, vec![vec![1]]));
        let commands = rt.take_opencode_commands(&[session_id.to_string()]);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].kind, "question-reply");
        assert_eq!(commands[0].request_id.as_deref(), Some(request_id));
        assert_eq!(commands[0].answers, vec![vec!["API key".to_string()]]);
        assert_eq!(
            rt.ack_opencode_commands(&[commands[0].id.clone()]).unwrap(),
            1
        );
        assert!(rt
            .snapshot()
            .sessions
            .iter()
            .find(|session| session.session_id == session_id)
            .is_some_and(|session| session.pending_question_request.is_none()));
    }

    #[test]
    fn ingest_updates_registry_without_app_handle() {
        let rt = runtime();
        let event = registry::FleetEvent {
            agent: registry::FleetAgent::ClaudeCode,
            event: "SessionStart".into(),
            pid: None,
            ppid: Some(4242),
            env: Default::default(),
            payload: serde_json::json!({"session_id": "mod-test-ingest", "cwd": "/tmp/p"}),
        };
        // No app handle in unit tests — emit is a no-op, must not panic.
        assert_eq!(rt.ingest(&event), registry::RegistryEffect::Updated);
        let snap = rt.snapshot();
        assert!(snap
            .sessions
            .iter()
            .any(|s| s.session_id == "mod-test-ingest"));
    }

    #[tokio::test]
    async fn capture_git_branch_runs_off_the_worker_and_marks_the_turn() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        set_git_capture_enabled(true);
        let rt = runtime();
        // Unique session id + pid so the process-global registry can't collide
        // with another (unlocked) test's ingest.
        let sid = "mod-git-capture-codex-001";
        let event = registry::FleetEvent {
            agent: registry::FleetAgent::Codex,
            event: "SessionStart".into(),
            pid: None,
            ppid: Some(31_337),
            env: Default::default(),
            // The crate dir lives inside this repo, so rev-parse resolves.
            payload: serde_json::json!({ "thread-id": sid, "cwd": env!("CARGO_MANIFEST_DIR") }),
        };
        rt.ingest(&event);
        assert!(rt
            .registry
            .lock()
            .needs_git_capture(registry::FleetAgent::Codex, sid)
            .is_some());

        rt.capture_git_branch(&event).await;

        // The shell-out ran (off the async worker) and marked the turn checked;
        // the branch itself may be Some or None (detached CI checkout).
        assert!(rt
            .registry
            .lock()
            .needs_git_capture(registry::FleetAgent::Codex, sid)
            .is_none());
        set_git_capture_enabled(false);
    }

    #[tokio::test]
    async fn opencode_command_queue_routes_by_session() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        let rt = runtime();
        // Drain any leftovers from other tests.
        rt.take_opencode_commands(&["mod-oc-a".into(), "mod-oc-b".into()]);

        let id = rt
            .queue_opencode_command("mod-oc-a".into(), "continue".into())
            .unwrap();
        assert!(!id.is_empty());

        // A poll listing a different session gets nothing (command stays).
        let none = rt.poll_opencode_commands(&["mod-oc-b".into()], 50).await;
        assert!(none.is_empty());

        // A poll listing the right session drains it.
        let got = rt.poll_opencode_commands(&["mod-oc-a".into()], 50).await;
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].session_id, "mod-oc-a");
        assert_eq!(got[0].text, "continue");
        assert_eq!(got[0].kind, "prompt");
        assert_eq!(got[0].attempt, 1);

        // Still queued but hidden behind a lease until the plugin acks it.
        assert!(rt.take_opencode_commands(&["mod-oc-a".into()]).is_empty());
        assert_eq!(rt.ack_opencode_commands(&[id]).unwrap(), 1);
        assert_eq!(rt.ack_opencode_commands(&["missing".into()]).unwrap(), 0);
    }

    #[tokio::test]
    async fn opencode_commands_survive_runtime_memory_loss_and_ack_is_audited() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        let _audit_guard = crate::companion_api::audit::test_guard();
        let tmp = tempfile::tempdir().unwrap();
        let outbox_path = tmp.path().join("fleet-command-outbox.json");
        let audit_path = tmp.path().join("audit.log");
        crate::companion_api::audit::install_at_for_testing(Some(audit_path.clone()));

        let rt = runtime();
        rt.configure_outbox(outbox_path.clone()).unwrap();
        let id = rt
            .queue_opencode_command("durable-session".into(), "continue".into())
            .unwrap();

        rt.opencode_commands.lock().clear();
        rt.configure_outbox(outbox_path).unwrap();
        let restored = rt.take_opencode_commands(&["durable-session".into()]);
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, id);
        assert_eq!(rt.ack_opencode_commands(&[id.clone()]).unwrap(), 1);

        let audit = std::fs::read_to_string(audit_path).unwrap();
        assert!(audit.contains("fleet.command.acknowledged"));
        assert!(audit.contains(&id));

        *rt.outbox_path.write() = None;
        rt.opencode_commands.lock().clear();
        crate::companion_api::audit::install_at_for_testing(None);
    }

    #[tokio::test]
    async fn parked_command_poll_wakes_on_queue() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        let rt = runtime();
        rt.take_opencode_commands(&["mod-oc-wake".into()]);

        let poller = {
            let rt = Arc::clone(&rt);
            tokio::spawn(async move {
                rt.poll_opencode_commands(&["mod-oc-wake".into()], 5_000)
                    .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        rt.queue_opencode_command("mod-oc-wake".into(), "hi".into())
            .unwrap();
        let got = poller.await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "hi");
    }

    #[test]
    fn permission_behavior_deserializes_lowercase() {
        let allow: PermissionBehavior = serde_json::from_str("\"allow\"").unwrap();
        let deny: PermissionBehavior = serde_json::from_str("\"deny\"").unwrap();
        assert_eq!(allow, PermissionBehavior::Allow);
        assert_eq!(deny, PermissionBehavior::Deny);
    }

    #[test]
    fn timeout_budget_stays_below_curl_and_hook_timeouts() {
        // The 20/25/30s ladder from the design — island wait must be the
        // shortest so the shell script and Claude's own hook timeout never
        // fire first (which would strand the terminal prompt).
        assert!(PERMISSION_WAIT_MS < 25_000);
    }
}
