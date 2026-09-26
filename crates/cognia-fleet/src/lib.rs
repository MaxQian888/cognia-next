//! Agent Fleet — monitor & control externally-launched coding agents.
//!
//! External Claude Code / Codex / OpenCode processes report lifecycle events
//! through tiny generated hook scripts (see [`install`]) that POST to the
//! companion API's `/api/fleet/*` routes ([`routes`], mounted from
//! `companion_api::server::build_router`). Events fold into the in-memory
//! [`registry::FleetRegistry`] and every change is emitted to the island
//! overlay webview as a full `fleet://update` snapshot (perf-sampler pattern).
//!
//! The runtime is a process-global singleton (like
//! `companion_api::PRE_AUTH_RATE_LIMITER`) rather than Tauri-managed state so
//! the axum handlers — which only get `SharedState` — and the Tauri commands
//! share it without threading an `AppHandle` through the router.
//!
//! ADR-0196 P6d: moved out of `app_lib`. The island windows and the monitor
//! commands that start the companion listener stay in the desktop, which
//! re-exports this crate as `fleet`, installs a [`FleetUpdateSink`] for the
//! island webview and a [`companion::FleetCompanion`] for tenant projection.

pub mod codex;
pub mod codex_hooks;
pub mod commands;
pub mod companion;
pub mod control;
pub mod gitinfo;
pub mod install;
pub mod integrations;
pub mod opencode;
pub mod outbox;
pub mod recovery;
pub mod registry;
pub mod routes;
pub mod terminal;

use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

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
static PERMISSION_WAIT_OVERRIDE_MS: AtomicU64 = AtomicU64::new(0);

pub fn permission_wait_ms() -> u64 {
    match PERMISSION_WAIT_OVERRIDE_MS.load(Ordering::SeqCst) {
        0 => PERMISSION_WAIT_MS,
        n => n,
    }
}

#[cfg(any(test, feature = "test-support"))]
pub fn set_permission_wait_override_ms(ms: Option<u64>) {
    PERMISSION_WAIT_OVERRIDE_MS.store(ms.unwrap_or(0), Ordering::SeqCst);
}

/// Test seam: disables the synchronous `git` shell-out in
/// [`FleetRuntime::ingest`] so unit/route tests never spawn a subprocess.
/// Enabled by default in production, and OFF in `cfg(test)` builds so existing
/// `ingest`/route tests stay subprocess-free — the git-path test opts in
/// explicitly under [`TEST_RUNTIME_LOCK`].
static GIT_CAPTURE_ENABLED: AtomicBool =
    AtomicBool::new(!cfg!(any(test, feature = "test-support")));

pub fn git_capture_enabled() -> bool {
    GIT_CAPTURE_ENABLED.load(Ordering::SeqCst)
}

#[cfg(any(test, feature = "test-support"))]
pub fn set_git_capture_enabled(enabled: bool) {
    GIT_CAPTURE_ENABLED.store(enabled, Ordering::SeqCst);
}

/// How long an OpenCode command poll parks before returning empty. Kept short
/// enough that the plugin re-polls promptly; a queued command wakes it early.
pub const COMMAND_POLL_WAIT_MS: u64 = 20_000;

static COMMAND_POLL_OVERRIDE_MS: AtomicU64 = AtomicU64::new(0);

pub fn command_poll_wait_ms() -> u64 {
    match COMMAND_POLL_OVERRIDE_MS.load(Ordering::SeqCst) {
        0 => COMMAND_POLL_WAIT_MS,
        n => n,
    }
}

#[cfg(any(test, feature = "test-support"))]
pub fn set_command_poll_override_ms(ms: Option<u64>) {
    COMMAND_POLL_OVERRIDE_MS.store(ms.unwrap_or(0), Ordering::SeqCst);
}

/// Serializes tests that mutate the process-global runtime's token/enabled
/// state (same shared-static trap as `proxy_config` — parallel test threads
/// stomp each other's arm() otherwise). Tokio mutex so async tests can hold
/// the guard across awaits.
#[cfg(any(test, feature = "test-support"))]
pub static TEST_RUNTIME_LOCK: Lazy<tokio::sync::Mutex<()>> =
    Lazy::new(|| tokio::sync::Mutex::new(()));

/// A permission decision from the island.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionBehavior {
    Allow,
    Deny,
}

/// A parked AskUserQuestion long-poll: the sender delivers the built
/// `updatedInput` answer value, and the raw questions are held so
/// `respond_question` can turn the island's option selections into that value.
struct PendingQuestionPoll {
    tx: tokio::sync::oneshot::Sender<QuestionResponse>,
    raw_questions: serde_json::Value,
}

#[derive(Debug)]
pub enum QuestionResponse {
    Answer(serde_json::Value),
    Reject,
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
    opencode_commands: Arc<Mutex<outbox::DurableCommandOutbox>>,
    /// Wakers for parked command polls, so a queued command is delivered
    /// immediately rather than on the next poll tick.
    command_wakers: Mutex<Vec<tokio::sync::oneshot::Sender<()>>>,
    /// Ingress auth token — regenerated per `fleet_monitor_start`.
    token: RwLock<Option<String>>,
    enabled: AtomicBool,
    /// Where snapshots go: the desktop's island webview. `None` until the
    /// monitor starts (and in unit tests).
    update_sink: RwLock<Option<Arc<dyn FleetUpdateSink>>>,
    reaper_running: AtomicBool,
    /// Serializes recovery snapshots so concurrent hook/reaper updates cannot
    /// leave an older snapshot on disk after a newer one.
    #[cfg(not(any(test, feature = "test-support")))]
    recovery_write_lock: Arc<Mutex<()>>,
    #[cfg(not(any(test, feature = "test-support")))]
    recovery_generation: Arc<AtomicU64>,
}

static RUNTIME: Lazy<Arc<FleetRuntime>> = Lazy::new(|| {
    let registry = FleetRegistry::new();
    #[cfg(not(any(test, feature = "test-support")))]
    let registry = {
        let mut registry = registry;
        if let Some(path) = install::fleet_recovery_path() {
            match recovery::load(&path) {
                Ok(rows) => registry.restore_recovery(rows),
                Err(error) => log::warn!("Fleet recovery unavailable: {error}"),
            }
        }
        registry
    };
    Arc::new(FleetRuntime {
        registry: Mutex::new(registry),
        pending: Mutex::new(HashMap::new()),
        question_pending: Mutex::new(HashMap::new()),
        opencode_commands: Arc::new(Mutex::new(match install::opencode_outbox_path() {
            Some(path) => {
                outbox::DurableCommandOutbox::open(path.clone()).unwrap_or_else(|error| {
                    outbox::DurableCommandOutbox::unavailable(Some(path), error)
                })
            }
            None => outbox::DurableCommandOutbox::unavailable(
                None,
                "no Cognia home directory".to_string(),
            ),
        })),
        command_wakers: Mutex::new(Vec::new()),
        token: RwLock::new(None),
        enabled: AtomicBool::new(false),
        update_sink: RwLock::new(None),
        reaper_running: AtomicBool::new(false),
        #[cfg(not(any(test, feature = "test-support")))]
        recovery_write_lock: Arc::new(Mutex::new(())),
        #[cfg(not(any(test, feature = "test-support")))]
        recovery_generation: Arc::new(AtomicU64::new(0)),
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
        self.snapshot_for_tenant(
            &cognia_companion_security::host_identity::current_tenant_or_unbound(),
        )
    }

    /// Test-only view of the local registry before tenant/brain projection.
    /// Parallel bridge tests may temporarily install a process-global brain;
    /// registry tests must still inspect the rows they just ingested.
    #[cfg(any(test, feature = "test-support"))]
    pub fn local_snapshot_for_tests(&self) -> FleetSnapshot {
        self.registry.lock().snapshot(now_ms())
    }

    pub fn snapshot_for_tenant(&self, tenant_id: &str) -> FleetSnapshot {
        // The brain announces itself with a *local account namespace*, while
        // callers here address a *tenant*. Those were the same hardcoded string
        // before the host binding existed, so accept either spelling: the raw
        // match keeps unmigrated installs working, the namespace lookup is what
        // matches once an account has been bound.
        let brain_account = companion::brain_account_id();
        let projects_this_tenant = match brain_account.as_deref() {
            Some(account) => {
                account == tenant_id
                    || cognia_companion_security::host_identity::namespace_for_tenant(tenant_id)
                        .as_deref()
                        == Some(account)
            }
            // No brain has said hello, so the local runtime is the only source
            // there is. Single-user hosts serve exactly one tenant, and the
            // caller's id came from an authenticated principal, so it is that
            // one. Multi-tenant deployments have no local runtime to project.
            None => {
                cognia_companion_security::deployment::deployment_mode()
                    == cognia_companion_security::deployment::DeploymentMode::SingleUser
            }
        };
        let mut snapshot = if projects_this_tenant {
            self.registry.lock().snapshot(now_ms())
        } else {
            registry::FleetRegistry::new().snapshot(now_ms())
        };
        snapshot.hosts = companion::hosts(tenant_id);
        snapshot
    }

    pub fn project_managed_session(&self, input: registry::ManagedFleetSession) {
        self.registry.lock().upsert_managed_session(input, now_ms());
        self.emit_update();
    }

    pub fn remove_managed_session(&self, session_id: &str) -> bool {
        let removed = self.registry.lock().remove_managed_session(session_id);
        if removed {
            self.emit_update();
        }
        removed
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

    pub fn session_capabilities(
        &self,
        agent: registry::FleetAgent,
        session_id: &str,
    ) -> Option<registry::FleetCapabilities> {
        self.registry.lock().session_capabilities(agent, session_id)
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
            if let Some(started_at) = event.ppid.and_then(process_start_time) {
                self.registry
                    .lock()
                    .set_process_started_at(event.agent, &session_id, started_at);
            }
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
        if !matches!(effect, registry::RegistryEffect::Ignored) {
            self.persist_recovery();
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
        let branch = cognia_core::rt::handle()
            .spawn_blocking(move || gitinfo::current_branch(&cwd))
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
    ) -> Option<QuestionResponse> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.question_pending.lock().insert(
            request_id.to_string(),
            PendingQuestionPoll { tx, raw_questions },
        );

        let answer = match tokio::time::timeout(std::time::Duration::from_millis(wait_ms), rx).await
        {
            Ok(Ok(response)) => Some(response),
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
                tx.send(QuestionResponse::Answer(updated_input)).is_ok()
            }
            None => false,
        }
    }

    /// Reject a parked AskUserQuestion through the same wait-mode channel as
    /// answers. Claude/Codex receive a deny decision; OpenCode's plugin maps it
    /// onto its native Question reject API.
    pub fn reject_question(&self, request_id: &str) -> bool {
        let poll = self.question_pending.lock().remove(request_id);
        match poll {
            Some(PendingQuestionPoll { tx, .. }) => tx.send(QuestionResponse::Reject).is_ok(),
            None => false,
        }
    }

    /// Drop every parked response channel when monitoring is disabled. This
    /// wakes hook requests into their fail-open path immediately and prevents a
    /// stale island action from resolving a request after its session detached.
    fn clear_pending_controls(&self) {
        self.pending.lock().clear();
        self.question_pending.lock().clear();
        for waker in self.command_wakers.lock().drain(..) {
            let _ = waker.send(());
        }
    }

    /// Queue an OpenCode send-message command and wake any parked poll so the
    /// plugin picks it up immediately.
    pub async fn queue_opencode_command(
        &self,
        session_id: String,
        text: String,
    ) -> Result<String, String> {
        let id = mint_token();
        let queued_id = id.clone();
        self.mutate_opencode_outbox(move |outbox| {
            outbox.enqueue(
                queued_id,
                outbox::CommandKind::Prompt,
                session_id,
                Some(text),
                now_ms(),
            )
        })
        .await?;
        // Wake every parked poll — they re-check the queue against their own
        // session list, so waking all is safe.
        for waker in self.command_wakers.lock().drain(..) {
            let _ = waker.send(());
        }
        Ok(id)
    }

    pub async fn queue_opencode_interrupt(&self, session_id: String) -> Result<String, String> {
        let id = mint_token();
        let queued_id = id.clone();
        self.mutate_opencode_outbox(move |outbox| {
            outbox.enqueue(
                queued_id,
                outbox::CommandKind::Interrupt,
                session_id,
                None,
                now_ms(),
            )
        })
        .await?;
        for waker in self.command_wakers.lock().drain(..) {
            let _ = waker.send(());
        }
        Ok(id)
    }

    /// Drain commands whose session is in `session_ids`. Non-matching commands
    /// stay queued for the plugin instance that owns those sessions.
    async fn take_opencode_commands(
        &self,
        session_ids: Vec<String>,
    ) -> Result<Vec<outbox::OpencodeCommand>, String> {
        self.mutate_opencode_outbox(move |outbox| outbox.lease(&session_ids, now_ms()))
            .await
    }

    pub async fn ack_opencode_command(
        &self,
        id: String,
        result: Option<serde_json::Value>,
    ) -> Result<bool, String> {
        self.mutate_opencode_outbox(move |outbox| outbox.ack(&id, result, now_ms()))
            .await
    }

    pub async fn nack_opencode_command(&self, id: String, error: String) -> Result<bool, String> {
        self.mutate_opencode_outbox(move |outbox| outbox.nack(&id, error, now_ms()))
            .await
    }

    pub async fn opencode_outbox_status(&self) -> Result<outbox::OutboxStatus, String> {
        self.mutate_opencode_outbox(|outbox| Ok(outbox.status()))
            .await
    }

    pub async fn repair_opencode_outbox(&self) -> Result<outbox::OutboxStatus, String> {
        self.mutate_opencode_outbox(move |outbox| {
            outbox.repair(now_ms())?;
            Ok(outbox.status())
        })
        .await
    }

    async fn mutate_opencode_outbox<T, F>(&self, operation: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut outbox::DurableCommandOutbox) -> Result<T, String> + Send + 'static,
    {
        let outbox = Arc::clone(&self.opencode_commands);
        tokio::task::spawn_blocking(move || {
            let mut guard = outbox.lock();
            operation(&mut guard)
        })
        .await
        .map_err(|error| format!("OpenCode outbox operation panicked: {error}"))?
    }

    #[cfg(test)]
    fn replace_opencode_outbox_for_tests(&self, path: std::path::PathBuf) {
        *self.opencode_commands.lock() =
            outbox::DurableCommandOutbox::open(path).expect("open test outbox");
    }

    /// Long-poll for OpenCode commands: return immediately if any match, else
    /// park until one is queued or the wait budget lapses (empty on timeout).
    pub async fn poll_opencode_commands(
        &self,
        session_ids: &[String],
        wait_ms: u64,
    ) -> Result<Vec<outbox::OpencodeCommand>, String> {
        if !self.is_enabled() {
            return Ok(Vec::new());
        }
        let immediate = self.take_opencode_commands(session_ids.to_vec()).await?;
        if !immediate.is_empty() {
            return Ok(immediate);
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.command_wakers.lock().push(tx);
        let _ = tokio::time::timeout(std::time::Duration::from_millis(wait_ms), rx).await;
        if !self.is_enabled() {
            return Ok(Vec::new());
        }
        self.take_opencode_commands(session_ids.to_vec()).await
    }

    /// Route every `fleet://update` snapshot to `sink`.
    pub fn set_update_sink(&self, sink: Arc<dyn FleetUpdateSink>) {
        *self.update_sink.write() = Some(sink);
    }

    pub fn emit_update(&self) {
        let snapshot = self.snapshot();
        if let Some(sink) = self.update_sink.read().as_ref() {
            sink.emit(&snapshot);
        }
    }

    #[cfg(not(any(test, feature = "test-support")))]
    fn persist_recovery(&self) {
        let Some(path) = install::fleet_recovery_path() else {
            return;
        };
        let generation = self
            .recovery_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        let rows = self.registry.lock().recovery_sessions();
        let latest_generation = Arc::clone(&self.recovery_generation);
        let write_lock = Arc::clone(&self.recovery_write_lock);
        cognia_core::rt::handle().spawn_blocking(move || {
            let _guard = write_lock.lock();
            if latest_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            if let Err(error) = recovery::save(&path, rows) {
                log::warn!("persist Fleet recovery failed: {error}");
            }
        });
    }

    #[cfg(any(test, feature = "test-support"))]
    fn persist_recovery(&self) {}

    fn start_reaper(self: &Arc<Self>) {
        if self.reaper_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let runtime = Arc::clone(self);
        cognia_core::rt::spawn(async move {
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
                    runtime.persist_recovery();
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

fn process_start_time(pid: u32) -> Option<u64> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    let target = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[target]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system.process(target).map(sysinfo::Process::start_time)
}

fn process_identity_matches(pid: u32, expected_start: u64) -> Option<bool> {
    Some(
        process_start_time(pid)
            .map(|actual| actual == expected_start)
            .unwrap_or(false),
    )
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

/// Arm monitoring on the companion listener bound at `port`: mint a fresh
/// ingress token, publish `~/.cognia/agent-monitor.json` for the hook scripts,
/// reconcile rows left detached, start the reaper and emit a snapshot. The
/// desktop's `fleet_monitor_start` calls this once the listener is up.
pub fn start_monitor(port: u16) -> Result<FleetMonitorStatus, String> {
    let runtime = runtime();
    let token = mint_token();
    *runtime.token.write() = Some(token.clone());
    let config_path = install::write_monitor_config(port, &token).map_err(|e| e.to_string())?;

    runtime.enabled.store(true, Ordering::SeqCst);
    if runtime
        .registry
        .lock()
        .reconcile_detached(now_ms(), process_identity_matches)
    {
        runtime.persist_recovery();
    }
    runtime.start_reaper();
    runtime.emit_update();

    Ok(FleetMonitorStatus {
        enabled: true,
        port: Some(port),
        config_path: Some(config_path.to_string_lossy().into_owned()),
    })
}

/// Current monitor status, given the companion listener's bound port.
pub fn monitor_status(bound_port: Option<u16>) -> FleetMonitorStatus {
    let enabled = runtime().is_enabled();
    FleetMonitorStatus {
        enabled,
        port: if enabled { bound_port } else { None },
        config_path: install::monitor_config_path()
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Where [`FleetRuntime::emit_update`] delivers each snapshot. The desktop
/// emits it to the island webview as [`UPDATE_EVENT`].
pub trait FleetUpdateSink: Send + Sync + 'static {
    fn emit(&self, snapshot: &FleetSnapshot);
}

fn mint_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
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
        let _guard = TEST_RUNTIME_LOCK.lock().await;
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
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        assert!(!runtime().respond_permission("ghost-request", PermissionBehavior::Deny));
    }

    #[tokio::test]
    async fn question_round_trip_builds_updated_input() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
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

        let QuestionResponse::Answer(updated) = waiter.await.unwrap().expect("answer delivered")
        else {
            panic!("expected answer response");
        };
        assert_eq!(updated["questions"], raw);
        assert_eq!(updated["answers"]["Which auth method?"], "API key");
    }

    #[tokio::test]
    async fn question_rejection_round_trip() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        let rt = runtime();
        let request_id = "test-question-reject";
        let waiter = {
            let rt = Arc::clone(&rt);
            tokio::spawn(async move {
                rt.wait_for_question(request_id, serde_json::json!([]), 5_000)
                    .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(rt.reject_question(request_id));
        assert!(matches!(
            waiter.await.unwrap(),
            Some(QuestionResponse::Reject)
        ));
    }

    #[tokio::test]
    async fn clearing_pending_controls_releases_waiters_without_a_decision() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        let tmp = tempfile::tempdir().unwrap();
        let rt = runtime();
        rt.replace_opencode_outbox_for_tests(tmp.path().join("commands.json"));
        rt.enabled.store(true, Ordering::SeqCst);
        let permission = {
            let rt = Arc::clone(&rt);
            tokio::spawn(async move { rt.wait_for_permission("clear-permission", 5_000).await })
        };
        let question = {
            let rt = Arc::clone(&rt);
            tokio::spawn(async move {
                rt.wait_for_question("clear-question", serde_json::json!([]), 5_000)
                    .await
            })
        };
        let command_poll = {
            let rt = Arc::clone(&rt);
            tokio::spawn(async move {
                rt.poll_opencode_commands(&["clear-session".into()], 5_000)
                    .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        rt.enabled.store(false, Ordering::SeqCst);
        rt.clear_pending_controls();

        assert_eq!(permission.await.unwrap(), None);
        assert!(question.await.unwrap().is_none());
        assert!(command_poll.await.unwrap().unwrap().is_empty());
    }

    #[tokio::test]
    async fn respond_question_without_waiter_returns_false() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        assert!(!runtime().respond_question("ghost-question", vec![vec![0]]));
        assert!(!runtime().reject_question("ghost-question"));
    }

    #[tokio::test]
    async fn ingest_updates_registry_without_app_handle() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
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
        let snap = rt.local_snapshot_for_tests();
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
        let tmp = tempfile::tempdir().unwrap();
        let rt = runtime();
        rt.enabled.store(true, Ordering::SeqCst);
        rt.replace_opencode_outbox_for_tests(tmp.path().join("commands.json"));

        let id = rt
            .queue_opencode_command("mod-oc-a".into(), "continue".into())
            .await
            .unwrap();
        assert!(!id.is_empty());

        // A poll listing a different session gets nothing (command stays).
        let none = rt.poll_opencode_commands(&["mod-oc-b".into()], 50).await;
        assert!(none.unwrap().is_empty());

        // A poll listing the right session drains it.
        let got = rt
            .poll_opencode_commands(&["mod-oc-a".into()], 50)
            .await
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].session_id, "mod-oc-a");
        assert_eq!(got[0].text.as_deref(), Some("continue"));
        assert!(rt.ack_opencode_command(id, None).await.unwrap());
        assert!(rt
            .take_opencode_commands(vec!["mod-oc-a".into()])
            .await
            .unwrap()
            .is_empty());
        rt.enabled.store(false, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn parked_command_poll_wakes_on_queue() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        let tmp = tempfile::tempdir().unwrap();
        let rt = runtime();
        rt.enabled.store(true, Ordering::SeqCst);
        rt.replace_opencode_outbox_for_tests(tmp.path().join("commands.json"));

        let poller = {
            let rt = Arc::clone(&rt);
            tokio::spawn(async move {
                rt.poll_opencode_commands(&["mod-oc-wake".into()], 5_000)
                    .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        rt.queue_opencode_command("mod-oc-wake".into(), "hi".into())
            .await
            .unwrap();
        let got = poller.await.unwrap().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text.as_deref(), Some("hi"));
        rt.enabled.store(false, Ordering::SeqCst);
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
        const { assert!(PERMISSION_WAIT_MS < 25_000) };
    }
}
