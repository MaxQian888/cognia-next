//! Pure in-memory registry of externally-launched agent sessions.
//!
//! The registry is the fleet feature's single source of truth: hook events
//! POSTed by external Claude Code / Codex / OpenCode processes (see
//! `fleet/routes.rs`) are folded into per-session rows here, and every change
//! produces a full [`FleetSnapshot`] that the caller emits to the island
//! webview (`fleet://update` — snapshot semantics mirror `perf://sample`, so
//! the frontend never reconciles deltas).
//!
//! Deliberately free of Tauri/axum types so every transition is unit-testable
//! with plain structs. Time is passed in as epoch milliseconds for the same
//! reason.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::integrations::NormalizedEvent;
use super::terminal::TerminalSource;

/// How long an `Ended` row keeps lingering in the snapshot so the island can
/// show a brief "finished" state before the row disappears.
pub const ENDED_LINGER_MS: u64 = 10_000;

/// Sessions with no event for this long get liveness-checked by the reaper
/// (and dropped when their agent pid is gone).
pub const STALE_AFTER_MS: u64 = 5 * 60 * 1000;

/// Which external agent produced a session. Serialized in DTOs and used in
/// registry keys — keep the string forms stable (they appear in hook
/// envelopes and the TS mirror `lib/fleet/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FleetAgent {
    ClaudeCode,
    Codex,
    Opencode,
    Cognia,
}

impl FleetAgent {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "claude-code" => Some(Self::ClaudeCode),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::Opencode),
            "cognia" => Some(Self::Cognia),
            _ => None,
        }
    }
}

/// Lifecycle state of one monitored session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FleetStatus {
    Idle,
    Working,
    WaitingInput,
    WaitingPermission,
    PlanPending,
    Detached,
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifecycleConfidence {
    Native,
    Inferred,
}

/// What the island may do with a session — drives which row buttons render
/// (pattern borrowed from `ExternalAgentManager` capability flags).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetCapabilities {
    pub approve_permission: bool,
    pub send_message: bool,
    pub focus_terminal: bool,
    pub open_transcript: bool,
    /// Whether the island may interrupt this session's current turn. Needs a
    /// known agent pid AND a platform where a single `SIGINT` means "cancel the
    /// turn" (see `control::interrupt_session`), so it is narrowed hard at
    /// runtime rather than trusted from the manifest.
    pub interrupt: bool,
}

/// Agent-wide runtime feature probe, intersected with the integration
/// manifest before any control is exposed. OpenCode SDK surfaces vary by
/// installed runtime version, so static provider identity is not proof that a
/// native API is callable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeCapabilities {
    pub agent: FleetAgent,
    pub send_message: bool,
    pub interrupt: bool,
    pub answers_questions: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupt_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_mode: Option<String>,
    pub observed_at: u64,
}

/// A permission request currently parked on this session (Claude
/// `PermissionRequest` hook long-poll, or an OpenCode `permission.ask`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermission {
    /// Correlation id the responder passes back to `fleet_permission_respond`.
    pub request_id: String,
    pub tool_name: Option<String>,
    /// Compact human-readable summary of the tool input (command, file path…).
    pub detail: Option<String>,
    /// Epoch ms when the request arrived — the island renders the countdown
    /// off this plus the timeout budget.
    pub requested_at: u64,
}

/// Current activity line ("Bash: pnpm test") for a working session.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetActivity {
    pub tool_name: String,
    pub detail: Option<String>,
}

/// A parked AskUserQuestion. Rendered while the session sits in `WaitingInput`.
/// When [`FleetSession::pending_question_request`] is also set the island lets
/// the user pick options and answers it over the hook long-poll; otherwise it
/// is display-only (a bare `PreToolUse` with no parked `PermissionRequest`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    pub question: String,
    /// Short chip label ("Auth method") when the tool provided one.
    pub header: Option<String>,
    /// Option labels in tool order (capped — the island shows chips).
    pub options: Vec<String>,
    pub multi_select: bool,
}

/// The answerable handle for a parked AskUserQuestion. Present only while the
/// tool's `PermissionRequest` long-poll is waiting (Claude/Codex fire both
/// `PreToolUse` and `PermissionRequest` for AskUserQuestion — the latter is the
/// wait-mode hook we can answer). The island posts the user's option
/// selections to `fleet_question_respond` with `request_id`; the answer rides
/// back as the hook's `allow` + `updatedInput.answers` decision.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestionRequest {
    /// Correlation id the island passes back to `fleet_question_respond`.
    pub request_id: String,
    /// Epoch ms the request arrived — the island renders the answer-window
    /// countdown off this plus the (shared) permission wait budget.
    pub requested_at: u64,
}

/// One live subagent spawned by the session's Task tool. Correlation is
/// best-effort: the hook payloads carry no tool_use id, so entries are matched
/// by description on completion and retired FIFO on `SubagentStop`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSubagent {
    /// Short task description from the Task tool input.
    pub description: String,
    /// Subagent type ("Explore", "general-purpose", …) when provided.
    pub agent_type: Option<String>,
    /// True for `run_in_background` tasks, which outlive their tool call.
    pub background: bool,
    pub started_at: u64,
    pub lifecycle_confidence: LifecycleConfidence,
}

/// Whether a captured error came from a single tool call or from the turn
/// ending in failure (Claude's `StopFailure`). Serialized on `FleetError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FleetErrorKind {
    Tool,
    Turn,
}

/// The most recent error observed on a session. Orthogonal to `FleetStatus`
/// (a failed tool doesn't change what the user must *do*), so the island keeps
/// its status colour and paints a separate error banner. A later successful
/// tool clears a `Tool` error; a new turn clears any error.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetError {
    pub kind: FleetErrorKind,
    /// Compact human-readable summary (tool error text / turn failure reason).
    pub detail: Option<String>,
    /// Epoch ms when the error was observed.
    pub at: u64,
}

/// One monitored external session — the island row DTO.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSession {
    pub agent: FleetAgent,
    pub session_id: String,
    pub status: FleetStatus,
    pub lifecycle_confidence: LifecycleConfidence,
    pub cwd: Option<String>,
    /// Basename of `cwd` — precomputed so the row never needs path logic.
    pub project_name: Option<String>,
    /// Last user prompt (verbatim, truncation is the frontend's job).
    pub last_prompt: Option<String>,
    pub activity: Option<FleetActivity>,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    pub terminal: Option<TerminalSource>,
    pub transcript_path: Option<String>,
    pub agent_pid: Option<u32>,
    pub pending_permission: Option<PendingPermission>,
    /// Plan text parked by ExitPlanMode while the session is `PlanPending`.
    pub pending_plan: Option<String>,
    /// Questions parked by AskUserQuestion while the session is `WaitingInput`.
    pub pending_questions: Vec<PendingQuestion>,
    /// Answerable handle for the parked questions — present only while the
    /// AskUserQuestion `PermissionRequest` long-poll is waiting for the island.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_question_request: Option<PendingQuestionRequest>,
    /// Live subagents (Task tool), foreground and background.
    pub subagents: Vec<FleetSubagent>,
    pub capabilities: FleetCapabilities,
    /// Manifest version/source that produced `capabilities`.
    pub capability_descriptor_version: u32,
    pub capability_descriptor_source: String,
    /// Epoch ms of the first event seen for this session.
    pub started_at: u64,
    /// Epoch ms of the most recent event.
    pub last_event_at: u64,
    /// Set when the session transitions to `Ended`; used for linger cleanup.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    /// Most recent tool/turn error, cleared on a new turn or a later success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<FleetError>,
    /// Tool invocations seen this session (incremented on `PreToolUse`).
    pub tool_use_count: u32,
    /// User turns seen this session (`UserPromptSubmit` / Codex turn-complete).
    pub turn_count: u32,
    /// How the session began: `startup` | `resume` | `clear` | `compact`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_source: Option<String>,
    /// Current git branch of `cwd`, captured once per turn in the runtime
    /// (never in the pure fold — see `FleetRuntime::ingest`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    /// Authenticated placement and existing authority lineage for managed runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_team_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_team_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_team_child_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_evidence_ref: Option<String>,
    /// Internal guard: has the branch been captured for the current turn?
    /// Never serialized — the frontend has no use for it.
    #[serde(skip)]
    pub git_checked: bool,
    /// Process start time captured with the pid, used to reject PID reuse when
    /// reconciling a durable session after app restart.
    #[serde(skip)]
    pub process_started_at: Option<u64>,
    /// Live status preserved while monitoring is detached. Never serialized
    /// to the renderer; the recovery file owns its durable copy.
    #[serde(skip)]
    pub status_before_detach: Option<FleetStatus>,
}

impl FleetSession {
    /// Drop any parked AskUserQuestion — both the display DTOs and the
    /// answerable handle — so the two never drift apart. Called wherever a turn
    /// boundary or completion supersedes the question.
    fn clear_questions(&mut self) {
        self.pending_questions.clear();
        self.pending_question_request = None;
    }

    /// Recompute this row's capabilities as the agent manifest's declared
    /// ceiling AND-narrowed by the runtime facts the row has actually observed.
    ///
    /// The direction is the whole point: narrowing only ever turns a capability
    /// **off**. A capability the manifest declares `false` stays `false` no
    /// matter what a payload carries — an OpenCode event that happens to ship a
    /// `transcript_path` used to switch `open_transcript` on and hand the island
    /// a button with nothing behind it. Conversely a declared `true` still needs
    /// its evidence: no transcript file means nothing to open, and a terminal
    /// this OS cannot raise means no focus button.
    fn refresh_capabilities(&mut self, runtime: Option<&AgentRuntimeCapabilities>) {
        let manifest = super::integrations::manifest_for(self.agent);
        let declared = manifest.capabilities;
        self.capability_descriptor_version = manifest.descriptor_version;
        self.capability_descriptor_source = manifest.descriptor_source.to_string();
        let runtime_send_message = runtime.is_some_and(|probe| probe.send_message);
        let runtime_interrupt = runtime.is_some_and(|probe| probe.interrupt);
        let needs_runtime_probe = self.agent == FleetAgent::Opencode;
        let controllable = !matches!(self.status, FleetStatus::Detached | FleetStatus::Ended);
        self.capabilities = FleetCapabilities {
            // No runtime probe: whether the agent's ingress can carry an
            // approval back is a property of its hook contract, not of any
            // single payload.
            approve_permission: declared.approve_permission && controllable,
            // Same — the reverse command channel exists (or not) per agent.
            send_message: declared.send_message
                && (!needs_runtime_probe || runtime_send_message)
                && controllable,
            focus_terminal: declared.focus_terminal
                && controllable
                && self
                    .terminal
                    .as_ref()
                    .is_some_and(|t| super::control::can_focus(t.app)),
            open_transcript: declared.open_transcript && self.transcript_path.is_some(),
            // Process-backed agents need an observed pid and a platform with a
            // reliable signal path. OpenCode is different: its runtime probe
            // proves a per-session SDK interrupt, which is platform-neutral and
            // deliberately never signals the shared server process.
            interrupt: declared.interrupt
                && if needs_runtime_probe {
                    runtime_interrupt
                } else {
                    self.agent_pid.is_some()
                }
                && controllable
                && (needs_runtime_probe || super::control::can_interrupt()),
        };
    }
}

/// Full snapshot emitted to the frontend on every change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSnapshot {
    pub sessions: Vec<FleetSession>,
    /// Authenticated execution workers. Additive for older Fleet consumers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<FleetHost>,
    /// Per-agent ingress liveness — present for every agent that has ever sent
    /// an event this process lifetime, absent for the rest. See
    /// [`AgentLiveness`].
    pub liveness: Vec<AgentLivenessRow>,
    /// Runtime-proven native controls. Missing means unproven, never
    /// "optimistically supported".
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub runtime_capabilities: Vec<AgentRuntimeCapabilities>,
    pub generated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetHost {
    pub host_ref: String,
    pub online: bool,
    pub max_active_turns: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_slots: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement_ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement_reason: Option<String>,
    pub runtime: String,
    pub workspace_binding_ready: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspace_binding_refs: Vec<String>,
    pub last_seen_at: u64,
}

/// One hook event after envelope parsing — the registry's sole input shape.
/// `payload` carries the agent's raw hook JSON (snake_case for Claude/Codex
/// hooks, kebab-case for the Codex notify program).
#[derive(Debug, Clone, Deserialize)]
pub struct FleetEvent {
    pub agent: FleetAgent,
    /// Hook event name (`SessionStart`, `PreToolUse`, `agent-turn-complete`…).
    pub event: String,
    /// Pid of the hook process itself (unused today, kept for diagnostics).
    #[serde(default)]
    pub pid: Option<u32>,
    /// Parent pid of the hook process — this IS the agent process pid.
    #[serde(default)]
    pub ppid: Option<u32>,
    /// Whitelisted env vars captured by the hook script (terminal identity).
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// Side effect the caller must perform after folding an event.
#[derive(Debug, Clone, PartialEq)]
pub enum RegistryEffect {
    /// Snapshot changed — emit `fleet://update`.
    Updated,
    /// A new permission request was parked — emit `fleet://permission` too.
    PermissionRequested { request_id: String },
    /// An AskUserQuestion is parked and answerable — the caller long-polls for
    /// the island's option selections, then answers the hook with an `allow` +
    /// `updatedInput.answers` decision.
    QuestionRequested { request_id: String },
    /// Event was unusable (no session id, unknown shape) — nothing to emit.
    Ignored,
}

/// The registry proper. Owned by `FleetRuntime` behind a mutex.
#[derive(Debug, Default)]
pub struct FleetRegistry {
    sessions: HashMap<(FleetAgent, String), FleetSession>,
    liveness: HashMap<FleetAgent, AgentLiveness>,
    runtime_capabilities: HashMap<FleetAgent, AgentRuntimeCapabilities>,
}

/// Per-agent ingress liveness, so the settings card can say whether an
/// integration is actually working rather than merely installed.
///
/// Two clocks, because "not working" has two very different shapes and the UI
/// must not conflate them:
///
///   * `last_seen_at` — the last event that reached the ingress at all,
///     including ones we dropped. Nothing here means the hooks never fired:
///     not installed, or (for Codex) installed but never granted trust in its
///     TUI, which is not readable from disk.
///   * `last_accepted_at` — the last event that actually folded into a row.
///     Seen-but-never-accepted is the contract-mismatch shape: this is exactly
///     how the Codex `notify` integration failed for its entire life (its
///     payload names the session `thread-id`, never `session_id`, so every POST
///     was dropped at the door while the settings card reported a healthy
///     install).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLiveness {
    pub last_seen_at: Option<u64>,
    pub last_accepted_at: Option<u64>,
    pub seen_count: u64,
    pub accepted_count: u64,
}

/// One agent's liveness, flattened for the snapshot DTO.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLivenessRow {
    pub agent: FleetAgent,
    #[serde(flatten)]
    pub liveness: AgentLiveness,
}

impl FleetRegistry {
    /// Drop the volatile observation projection without claiming the external
    /// processes ended. The durable history sink interprets their absence as
    /// `detached` and can reconcile them when monitoring resumes.
    pub fn clear_observed_sessions(&mut self) {
        self.sessions.clear();
    }

    pub fn new() -> Self {
        Self::default()
    }

    /// Merge a managed AgentTeam session into the existing Fleet projection.
    /// The durable child and ExecutionRun remain authoritative; this row is a
    /// disposable read model consumed only through FleetSnapshot.
    pub fn upsert_managed_session(&mut self, input: ManagedFleetSession, now_ms: u64) {
        let key = (FleetAgent::Cognia, input.session_id.clone());
        let ev = FleetEvent {
            agent: FleetAgent::Cognia,
            event: String::new(),
            pid: None,
            ppid: None,
            env: HashMap::new(),
            payload: serde_json::Value::Null,
        };
        let entry = self.sessions.entry(key).or_insert_with(|| {
            new_session(FleetAgent::Cognia, input.session_id.clone(), &ev, now_ms)
        });
        entry.status = input.status;
        entry.host_ref = Some(input.host_ref);
        entry.origin = Some("managed-team".to_string());
        entry.agent_team_id = Some(input.agent_team_id);
        entry.agent_team_run_id = Some(input.agent_team_run_id);
        entry.agent_team_child_run_id = Some(input.agent_team_child_run_id);
        entry.execution_run_id = Some(input.execution_run_id);
        entry.review_evidence_ref = input.review_evidence_ref;
        entry.model = input.model;
        entry.project_name = input.project_name;
        entry.started_at = input.started_at.unwrap_or(entry.started_at);
        entry.last_event_at = now_ms;
        entry.ended_at = (input.status == FleetStatus::Ended).then_some(now_ms);
    }

    pub fn remove_managed_session(&mut self, session_id: &str) -> bool {
        self.sessions
            .remove(&(FleetAgent::Cognia, session_id.to_string()))
            .is_some()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// Fold one hook event into the registry.
    pub fn apply(&mut self, ev: &FleetEvent, now_ms: u64) -> RegistryEffect {
        // Recorded before any validation: an event we drop still proves the
        // agent's hooks fired and reached us, which is the fact that separates
        // "never installed / never trusted" from "installed but the payload
        // contract doesn't match".
        {
            let live = self.liveness.entry(ev.agent).or_default();
            live.last_seen_at = Some(now_ms);
            live.seen_count = live.seen_count.saturating_add(1);
        }
        // An event outside this agent's declared vocabulary is dropped at the
        // door. It used to fall through the fold's `_ => {}` arm and still
        // return `Updated`, which *created a session row* out of an
        // unrecognized payload — a typo'd hook name or a foreign program
        // POSTing to the ingress would materialize a phantom agent.
        let manifest = super::integrations::manifest_for(ev.agent);
        let Some(event) = manifest.normalize(&ev.event) else {
            return RegistryEffect::Ignored;
        };

        if event == NormalizedEvent::Capabilities {
            let probe = runtime_capability_probe(ev.agent, &ev.payload, now_ms);
            self.runtime_capabilities.insert(ev.agent, probe);
            let runtime = self.runtime_capabilities.get(&ev.agent);
            for session in self
                .sessions
                .values_mut()
                .filter(|session| session.agent == ev.agent)
            {
                session.refresh_capabilities(runtime);
            }
            let live = self.liveness.entry(ev.agent).or_default();
            live.last_accepted_at = Some(now_ms);
            live.accepted_count = live.accepted_count.saturating_add(1);
            return RegistryEffect::Updated;
        }

        let Some(session_id) = extract_session_id(ev) else {
            return RegistryEffect::Ignored;
        };

        // Past every drop gate: this event is one the agent and the fleet agree
        // on, so the integration is genuinely working.
        {
            let live = self.liveness.entry(ev.agent).or_default();
            live.last_accepted_at = Some(now_ms);
            live.accepted_count = live.accepted_count.saturating_add(1);
        }

        let key = (ev.agent, session_id.clone());
        let answers_questions = manifest.answers_questions
            && (ev.agent != FleetAgent::Opencode
                || self
                    .runtime_capabilities
                    .get(&ev.agent)
                    .is_some_and(|probe| probe.answers_questions));

        // One Claude Code / Codex process runs one interactive session at a
        // time, but `/clear` (and `--resume`) mint a NEW session id inside the
        // same pid — and the old session's `SessionEnd` hook is fail-open
        // (0.4 s curl), so it can simply be lost. Without eviction the stale
        // row survives forever: the reaper keeps any row whose agent pid is
        // alive, and the pid IS alive — it's now running the new session. So
        // when a new session id shows up for a pid we already track, drop that
        // pid's other rows. Agents whose manifest declares `multi_session_host`
        // are exempt: one OpenCode server process can legitimately host several
        // concurrent sessions.
        if !self.sessions.contains_key(&key) && !manifest.multi_session_host {
            if let Some(ppid) = ev.ppid {
                self.sessions.retain(|(agent, sid), s| {
                    *agent != ev.agent || sid == &session_id || s.agent_pid != Some(ppid)
                });
            }
        }

        let entry = self
            .sessions
            .entry(key)
            .or_insert_with(|| new_session(ev.agent, session_id.clone(), ev, now_ms));

        if entry.status == FleetStatus::Detached {
            entry.status_before_detach = None;
        }
        entry.last_event_at = now_ms;
        if let Some(ppid) = ev.ppid {
            entry.agent_pid = Some(ppid);
        }
        // cwd / transcript / mode can appear on any event — keep them fresh.
        if let Some(cwd) = payload_str(&ev.payload, "cwd") {
            entry.project_name = project_name_of(&cwd);
            entry.cwd = Some(cwd);
        }
        if let Some(t) = payload_str(&ev.payload, "transcript_path") {
            entry.transcript_path = Some(t);
        }
        if let Some(mode) = payload_str(&ev.payload, "permission_mode") {
            entry.permission_mode = Some(mode);
        }
        if let Some(model) = payload_str(&ev.payload, "model") {
            entry.model = Some(model);
        }
        if entry.terminal.is_none() && !ev.env.is_empty() {
            entry.terminal = super::terminal::classify_terminal(&ev.env);
        }
        // Capabilities are the manifest's ceiling narrowed by whatever the row
        // now knows (transcript path, focusable terminal). Recomputed here, once,
        // so every arm below — including the ones that return early — sees the
        // same rule and no arm can widen a capability the manifest denies.
        entry.refresh_capabilities(self.runtime_capabilities.get(&ev.agent));

        // The fold matches only on the normalized vocabulary — no vendor
        // event names reach it, and the exhaustive match makes a new
        // `NormalizedEvent` variant a compile error rather than a silent drop.
        match event {
            NormalizedEvent::Capabilities => unreachable!("handled before session extraction"),
            NormalizedEvent::SessionStart => {
                entry.status = FleetStatus::Idle;
                entry.ended_at = None;
                // `startup` | `resume` | `clear` | `compact` — distinguishes a
                // fresh run from a resumed/cleared one on the detail panel.
                if let Some(source) = payload_str(&ev.payload, "source") {
                    entry.start_source = Some(source);
                }
                entry.last_error = None;
            }
            NormalizedEvent::UserPromptSubmit => {
                entry.status = FleetStatus::Working;
                if let Some(prompt) = payload_str(&ev.payload, "prompt") {
                    entry.last_prompt = Some(prompt);
                }
                entry.activity = None;
                entry.turn_count = entry.turn_count.saturating_add(1);
                // A new turn supersedes anything parked for the previous one;
                // background subagents keep running across turns.
                entry.pending_plan = None;
                entry.clear_questions();
                entry.subagents.retain(|s| s.background);
                // A new turn clears a stale error and re-arms the per-turn git
                // branch refresh (catches a mid-session checkout).
                entry.last_error = None;
                entry.git_checked = false;
            }
            NormalizedEvent::PreToolUse => {
                // Count on Pre (not Post) so a tool that never returns still
                // counts once; PostToolUse handles error/success bookkeeping.
                entry.tool_use_count = entry.tool_use_count.saturating_add(1);
                let tool = payload_str(&ev.payload, "tool_name");
                if tool.as_deref().is_some_and(is_exit_plan_tool) {
                    entry.status = FleetStatus::PlanPending;
                    entry.activity = None;
                    entry.pending_plan = extract_plan(&ev.payload);
                } else if tool.as_deref().is_some_and(is_ask_user_question_tool) {
                    // The agent is blocked on the user — surface the question(s)
                    // instead of a generic "working" line. Display-only for now:
                    // the paired `PermissionRequest` (wait-mode hook) arrives
                    // next and attaches the answerable handle. Drop any stale
                    // handle so a re-fired Pre never leaves a dead answer window.
                    entry.status = FleetStatus::WaitingInput;
                    entry.activity = None;
                    entry.pending_questions = extract_questions(&ev.payload);
                    entry.pending_question_request = None;
                } else {
                    entry.status = FleetStatus::Working;
                    // Another tool running means the plan/question moment passed.
                    entry.pending_plan = None;
                    entry.clear_questions();
                    if tool.as_deref().is_some_and(is_task_tool) {
                        push_subagent(entry, &ev.payload, now_ms);
                    }
                    entry.activity = tool.map(|tool_name| FleetActivity {
                        detail: tool_detail(&ev.payload, &tool_name),
                        tool_name,
                    });
                }
            }
            NormalizedEvent::PostToolUse => {
                // Keep Working; the activity line stays until the next tool
                // or Stop so slow model turns still show the last action.
                entry.status = FleetStatus::Working;
                // The tool returned — a parked plan approval / question was
                // answered in the terminal.
                entry.pending_plan = None;
                entry.clear_questions();
                // Surface a failed tool as a `Tool` error; a clean result
                // clears a prior tool error but leaves a turn error standing.
                match extract_tool_error(&ev.payload) {
                    Some(detail) => {
                        entry.last_error = Some(FleetError {
                            kind: FleetErrorKind::Tool,
                            detail,
                            at: now_ms,
                        });
                    }
                    None => {
                        if matches!(
                            entry.last_error,
                            Some(FleetError {
                                kind: FleetErrorKind::Tool,
                                ..
                            })
                        ) {
                            entry.last_error = None;
                        }
                    }
                }
                if payload_str(&ev.payload, "tool_name")
                    .as_deref()
                    .is_some_and(is_task_tool)
                {
                    finish_task_subagent(entry, &ev.payload);
                }
            }
            NormalizedEvent::Notification => {
                // Notifications are display hints, and they only mean "the
                // agent is blocked mid-turn". Claude Code also fires an
                // `idle_prompt` notification ~60 s after a turn ends cleanly
                // (it is idle at the prompt) — honoring that flipped a
                // finished (Idle/Ended) session back to "needs input" forever,
                // which pinned the island on screen. Mid-turn statuses only.
                let mid_turn = matches!(
                    entry.status,
                    FleetStatus::Working
                        | FleetStatus::WaitingInput
                        | FleetStatus::WaitingPermission
                        | FleetStatus::PlanPending
                );
                // A row already parked on something the user must act on — a
                // plan review or a question, whether answerable or still
                // display-only — owns its pose. A notification is only a display
                // hint, and the authoritative event (PreToolUse / PermissionRequest)
                // has already set the right status; letting a generic
                // permission/idle hint overwrite it would drop the plan text or
                // question card (the same "special tool treated as a generic
                // event" class of bug as ExitPlanMode).
                let parked_on_user = entry.pending_plan.is_some()
                    || !entry.pending_questions.is_empty()
                    || entry.pending_question_request.is_some();
                match payload_str(&ev.payload, "notification_type").as_deref() {
                    Some("idle_prompt") if mid_turn && !parked_on_user => {
                        entry.status = FleetStatus::WaitingInput
                    }
                    Some("permission_prompt") if mid_turn && !parked_on_user => {
                        // Only a display hint — the real approval flow arrives
                        // via the PermissionRequest long-poll (P3).
                        if entry.pending_permission.is_none() {
                            entry.status = FleetStatus::WaitingPermission;
                        }
                    }
                    _ => {}
                }
            }
            NormalizedEvent::PermissionRequest => {
                let request_id = permission_request_id(&ev.agent, &session_id, now_ms);
                let tool_name = payload_str(&ev.payload, "tool_name");
                // AskUserQuestion fires BOTH PreToolUse and PermissionRequest.
                // Its request is not a yes/no permission — it is a question the
                // user must answer. Park it as an *answerable* question (not a
                // generic Approve/Deny) so the island shows the options and the
                // selection rides back as the hook's `allow` + `updatedInput`
                // answer decision. Scoped by the manifest's
                // `answers_questions`; OpenCode additionally requires its
                // native Question API capability probe before entering here.
                if answers_questions && tool_name.as_deref().is_some_and(is_ask_user_question_tool)
                {
                    entry.status = FleetStatus::WaitingInput;
                    entry.activity = None;
                    entry.pending_permission = None;
                    entry.pending_questions = extract_questions(&ev.payload);
                    entry.pending_question_request = Some(PendingQuestionRequest {
                        request_id: request_id.clone(),
                        requested_at: now_ms,
                    });
                    return RegistryEffect::QuestionRequested { request_id };
                }
                // ExitPlanMode also fires BOTH PreToolUse and PermissionRequest.
                // The Pre parked the plan preview (`PlanPending`); the paired
                // request must NOT collapse that into a generic "ExitPlanMode"
                // Approve/Deny card — that would treat a plan review like any
                // other tool permission and drop the plan text. Keep the plan
                // pose while staying answerable: approving the request is how
                // the user accepts the plan and lets the agent proceed.
                if tool_name.as_deref().is_some_and(is_exit_plan_tool) {
                    entry.status = FleetStatus::PlanPending;
                    entry.activity = None;
                    entry.pending_plan = extract_plan(&ev.payload);
                    entry.pending_permission = Some(PendingPermission {
                        request_id: request_id.clone(),
                        tool_name,
                        detail: None,
                        requested_at: now_ms,
                    });
                    return RegistryEffect::PermissionRequested { request_id };
                }
                entry.status = FleetStatus::WaitingPermission;
                entry.pending_permission = Some(PendingPermission {
                    request_id: request_id.clone(),
                    detail: tool_name
                        .as_deref()
                        .and_then(|t| tool_detail(&ev.payload, t)),
                    tool_name,
                    requested_at: now_ms,
                });
                return RegistryEffect::PermissionRequested { request_id };
            }
            // A clean turn end returns the row to idle, clears in-flight
            // activity / parked permission, and clears any error. Background
            // subagents survive the turn; foreground ones can't.
            NormalizedEvent::Stop => {
                entry.status = FleetStatus::Idle;
                entry.activity = None;
                entry.pending_permission = None;
                entry.pending_plan = None;
                entry.clear_questions();
                entry.subagents.retain(|s| s.background);
                entry.last_error = None;
            }
            // Same idle transition as `Stop`, but the turn ended in an API
            // error — stamp a `Turn` error so the row can flag it (previously
            // this signal was collapsed into `Stop` and silently discarded).
            NormalizedEvent::StopFailure => {
                entry.status = FleetStatus::Idle;
                entry.activity = None;
                entry.pending_permission = None;
                entry.pending_plan = None;
                entry.clear_questions();
                entry.subagents.retain(|s| s.background);
                entry.last_error = Some(FleetError {
                    kind: FleetErrorKind::Turn,
                    detail: payload_str(&ev.payload, "reason")
                        .or_else(|| payload_str(&ev.payload, "error")),
                    at: now_ms,
                });
            }
            NormalizedEvent::SubagentStart => {
                push_native_subagent(entry, &ev.payload, now_ms);
            }
            // A subagent finished. The payload carries no correlation id, so
            // retire the oldest foreground entry (its PostToolUse follows and
            // no-ops); a background-only list retires FIFO.
            NormalizedEvent::SubagentStop => {
                if let Some(pos) = entry.subagents.iter().position(|s| !s.background) {
                    entry.subagents.remove(pos);
                } else if !entry.subagents.is_empty() {
                    entry.subagents.remove(0);
                }
            }
            // Context compaction: show a brief "compacting" beat (kept Working so
            // the row doesn't flash idle mid-turn). `trigger` is `manual`/`auto`.
            NormalizedEvent::PreCompact => {
                entry.status = FleetStatus::Working;
                entry.activity = Some(FleetActivity {
                    tool_name: "Compacting".to_string(),
                    detail: payload_str(&ev.payload, "trigger"),
                });
            }
            // Compaction done — drop the transient activity; the next tool call
            // or Stop drives the row from here.
            NormalizedEvent::PostCompact => {
                entry.status = FleetStatus::Working;
                entry.activity = None;
            }
            // A denied permission (auto-mode or an out-of-band "no") releases the
            // parked request so the row leaves the waiting state. A rejected plan
            // review parks its approval the same way (`PlanPending` +
            // `pending_permission`), so release it symmetrically — drop the stale
            // plan text and return to Working instead of leaving the row stuck on
            // a plan whose answer won't come back through Cognia.
            NormalizedEvent::PermissionDenied => {
                entry.pending_permission = None;
                if matches!(
                    entry.status,
                    FleetStatus::WaitingPermission | FleetStatus::PlanPending
                ) {
                    entry.status = FleetStatus::Working;
                    entry.pending_plan = None;
                }
            }
            NormalizedEvent::TurnComplete => {
                // Codex's `notify` program fires once per completed turn with
                // the turn's inputs + reply (kebab-case argv JSON). It is the
                // only lifecycle signal on the notify path, so lean on it to
                // populate the row: latest user input as the prompt, the
                // assistant reply as the trailing activity line.
                entry.status = FleetStatus::Idle;
                entry.pending_permission = None;
                // A completed turn supersedes anything still parked for it —
                // same contract as Claude's `Stop` (a stale plan/question must
                // not keep the row in a "needs you" pose after the turn ended).
                entry.pending_plan = None;
                entry.clear_questions();
                // The notify program's per-turn signal — the only turn marker
                // on the Codex path.
                entry.turn_count = entry.turn_count.saturating_add(1);
                if let Some(prompt) = ev
                    .payload
                    .get("input-messages")
                    .and_then(|v| v.as_array())
                    .and_then(|msgs| msgs.iter().rev().find_map(|m| m.as_str()))
                {
                    entry.last_prompt = Some(prompt.to_owned());
                }
                entry.activity =
                    payload_str(&ev.payload, "last-assistant-message").map(|reply| FleetActivity {
                        tool_name: "reply".to_string(),
                        detail: Some(reply),
                    });
            }
            NormalizedEvent::SessionEnd => {
                entry.status = FleetStatus::Ended;
                entry.ended_at = Some(now_ms);
                entry.activity = None;
                entry.pending_permission = None;
                entry.pending_plan = None;
                entry.clear_questions();
                entry.subagents.clear();
            }
            // OpenCode plugin events (normalized in `cognia-fleet.js` so we
            // never depend on OpenCode's internal bus schema).
            NormalizedEvent::SessionActive => {
                entry.status = FleetStatus::Working;
                // `send_message` is not set here: OpenCode's reverse command
                // channel (fleet/opencode.rs poll loop) is a property of the
                // integration, declared once in its manifest, not something a
                // `session-active` payload grants.
                entry.activity =
                    payload_str(&ev.payload, "tool_name").map(|tool_name| FleetActivity {
                        detail: tool_detail(&ev.payload, &tool_name),
                        tool_name,
                    });
                if let Some(prompt) = payload_str(&ev.payload, "prompt") {
                    entry.last_prompt = Some(prompt);
                }
            }
            NormalizedEvent::QuestionAsked => {
                let request_id = payload_str(&ev.payload, "request_id")
                    .or_else(|| payload_str(&ev.payload, "requestID"))
                    .unwrap_or_else(|| format!("question-{now_ms}"));
                entry.status = FleetStatus::WaitingInput;
                entry.activity = None;
                entry.pending_questions = extract_questions(&ev.payload);
                entry.pending_question_request = Some(PendingQuestionRequest {
                    request_id,
                    requested_at: now_ms,
                });
            }
            NormalizedEvent::SessionIdle => {
                entry.status = FleetStatus::Idle;
                entry.activity = None;
                // Idle means nothing is blocked on the user anymore — release
                // anything still parked (an ask answered in OpenCode's own TUI
                // never reports back through us; the long-poll responder times
                // out on its own).
                entry.pending_permission = None;
                entry.pending_plan = None;
                entry.clear_questions();
            }
        }

        entry.refresh_capabilities(self.runtime_capabilities.get(&ev.agent));
        RegistryEffect::Updated
    }

    /// Terminal info for one session (focus action lookup).
    pub fn session_terminal(&self, agent: FleetAgent, session_id: &str) -> Option<TerminalSource> {
        self.sessions
            .get(&(agent, session_id.to_string()))
            .and_then(|s| s.terminal.clone())
    }

    /// Agent process id for one session, for the interrupt action. Only
    /// returned while the session is live: an ended row's pid either belongs to
    /// nothing or, worse, to whatever the OS recycled it onto.
    pub fn session_agent_pid(&self, agent: FleetAgent, session_id: &str) -> Option<u32> {
        self.sessions
            .get(&(agent, session_id.to_string()))
            .filter(|s| !matches!(s.status, FleetStatus::Detached | FleetStatus::Ended))
            .and_then(|s| s.agent_pid)
    }

    pub fn session_capabilities(
        &self,
        agent: FleetAgent,
        session_id: &str,
    ) -> Option<FleetCapabilities> {
        self.sessions
            .get(&(agent, session_id.to_string()))
            .map(|session| session.capabilities)
    }

    /// Attach a terminal source resolved outside the event fold (the
    /// parent-chain fallback in `FleetRuntime::ingest`). Returns true when
    /// the snapshot changed.
    pub fn set_terminal(
        &mut self,
        agent: FleetAgent,
        session_id: &str,
        terminal: TerminalSource,
    ) -> bool {
        let Some(session) = self.sessions.get_mut(&(agent, session_id.to_string())) else {
            return false;
        };
        if session.terminal.is_some() {
            return false;
        }
        session.terminal = Some(terminal);
        // A newly classified terminal is a runtime fact that can only ever
        // narrow the manifest's `focus_terminal` ceiling (this OS may not know
        // how to raise that app).
        session.refresh_capabilities(self.runtime_capabilities.get(&agent));
        true
    }

    /// Whether a session currently lacks terminal info but has a live pid the
    /// parent-chain fallback could classify.
    pub fn needs_terminal_fallback(&self, agent: FleetAgent, session_id: &str) -> Option<u32> {
        let session = self.sessions.get(&(agent, session_id.to_string()))?;
        if session.terminal.is_some() {
            return None;
        }
        session.agent_pid
    }

    /// `Some(cwd)` when this session still needs its git branch captured for the
    /// current turn. The pure fold never shells out — the runtime calls this,
    /// runs `git`, then hands the result back via `set_git_branch`.
    pub fn needs_git_capture(&self, agent: FleetAgent, session_id: &str) -> Option<String> {
        let session = self.sessions.get(&(agent, session_id.to_string()))?;
        if session.git_checked {
            return None;
        }
        session.cwd.clone()
    }

    /// Record the captured branch (or its absence) and mark the turn checked.
    /// Returns true when the snapshot changed.
    pub fn set_git_branch(
        &mut self,
        agent: FleetAgent,
        session_id: &str,
        branch: Option<String>,
    ) -> bool {
        let Some(session) = self.sessions.get_mut(&(agent, session_id.to_string())) else {
            return false;
        };
        let changed = session.git_branch != branch || !session.git_checked;
        session.git_branch = branch;
        session.git_checked = true;
        changed
    }

    pub fn set_process_started_at(
        &mut self,
        agent: FleetAgent,
        session_id: &str,
        started_at: u64,
    ) -> bool {
        let Some(session) = self.sessions.get_mut(&(agent, session_id.to_string())) else {
            return false;
        };
        if session.process_started_at == Some(started_at) {
            return false;
        }
        session.process_started_at = Some(started_at);
        true
    }

    /// Detach every non-ended row when monitoring stops. Detached is an
    /// uncertainty state, not a synthetic completion: pending response
    /// channels are cleared, controls are disabled, and a future native event
    /// can make the row live again.
    pub fn mark_all_detached(&mut self) -> bool {
        let mut changed = false;
        for session in self.sessions.values_mut() {
            if matches!(session.status, FleetStatus::Ended | FleetStatus::Detached) {
                continue;
            }
            session.status_before_detach = Some(session.status);
            session.status = FleetStatus::Detached;
            session.activity = None;
            session.pending_permission = None;
            session.pending_plan = None;
            session.clear_questions();
            let runtime = self.runtime_capabilities.get(&session.agent);
            session.refresh_capabilities(runtime);
            changed = true;
        }
        changed
    }

    /// Reconcile detached rows against an OS process identity probe.
    /// `Some(true)` proves pid + start time still match; `Some(false)` proves
    /// the process ended or the pid was reused; `None` remains detached.
    pub fn reconcile_detached(
        &mut self,
        now_ms: u64,
        probe: impl Fn(u32, u64) -> Option<bool>,
    ) -> bool {
        let mut changed = false;
        for session in self
            .sessions
            .values_mut()
            .filter(|session| session.status == FleetStatus::Detached)
        {
            if super::integrations::manifest_for(session.agent).multi_session_host {
                continue;
            }
            let outcome = session
                .agent_pid
                .zip(session.process_started_at)
                .and_then(|(pid, started_at)| probe(pid, started_at));
            match outcome {
                Some(true) => {
                    session.status = match session.status_before_detach.take() {
                        Some(FleetStatus::Idle) => FleetStatus::Idle,
                        Some(FleetStatus::Ended) => FleetStatus::Ended,
                        _ => FleetStatus::Working,
                    };
                    session.ended_at = (session.status == FleetStatus::Ended).then_some(now_ms);
                    session.refresh_capabilities(self.runtime_capabilities.get(&session.agent));
                    changed = true;
                }
                Some(false) => {
                    session.status = FleetStatus::Ended;
                    session.status_before_detach = None;
                    session.ended_at = Some(now_ms);
                    session.refresh_capabilities(self.runtime_capabilities.get(&session.agent));
                    changed = true;
                }
                None => {}
            }
        }
        changed
    }

    pub fn recovery_sessions(&self) -> Vec<super::recovery::RecoverySession> {
        self.sessions
            .values()
            .filter(|session| session.status != FleetStatus::Ended)
            .map(|session| super::recovery::RecoverySession {
                agent: session.agent,
                session_id: session.session_id.clone(),
                status: session.status_before_detach.unwrap_or(session.status),
                cwd: session.cwd.clone(),
                project_name: session.project_name.clone(),
                model: session.model.clone(),
                transcript_path: session.transcript_path.clone(),
                agent_pid: session.agent_pid,
                process_started_at: session.process_started_at,
                started_at: session.started_at,
                last_event_at: session.last_event_at,
                tool_use_count: session.tool_use_count,
                turn_count: session.turn_count,
            })
            .collect()
    }

    pub fn restore_recovery(&mut self, rows: Vec<super::recovery::RecoverySession>) {
        for row in rows {
            if row.status == FleetStatus::Ended {
                continue;
            }
            let key = (row.agent, row.session_id.clone());
            let manifest = super::integrations::manifest_for(row.agent);
            let mut session = FleetSession {
                agent: row.agent,
                session_id: row.session_id,
                status: FleetStatus::Detached,
                lifecycle_confidence: LifecycleConfidence::Native,
                cwd: row.cwd,
                project_name: row.project_name,
                last_prompt: None,
                activity: None,
                permission_mode: None,
                model: row.model,
                terminal: None,
                transcript_path: row.transcript_path,
                agent_pid: row.agent_pid,
                pending_permission: None,
                pending_plan: None,
                pending_questions: Vec::new(),
                pending_question_request: None,
                subagents: Vec::new(),
                capabilities: manifest.capabilities,
                capability_descriptor_version: manifest.descriptor_version,
                capability_descriptor_source: manifest.descriptor_source.to_string(),
                started_at: row.started_at,
                last_event_at: row.last_event_at,
                ended_at: None,
                last_error: None,
                tool_use_count: row.tool_use_count,
                turn_count: row.turn_count,
                start_source: None,
                git_branch: None,
                host_ref: None,
                origin: None,
                agent_team_id: None,
                agent_team_run_id: None,
                agent_team_child_run_id: None,
                execution_run_id: None,
                review_evidence_ref: None,
                git_checked: false,
                process_started_at: row.process_started_at,
                status_before_detach: Some(row.status),
            };
            session.refresh_capabilities(self.runtime_capabilities.get(&row.agent));
            self.sessions.insert(key, session);
        }
    }

    /// Clear a parked permission (answered or timed out). Returns true when
    /// the snapshot changed.
    pub fn resolve_permission(&mut self, request_id: &str) -> bool {
        for session in self.sessions.values_mut() {
            if session
                .pending_permission
                .as_ref()
                .is_some_and(|p| p.request_id == request_id)
            {
                session.pending_permission = None;
                if session.status == FleetStatus::WaitingPermission {
                    session.status = FleetStatus::Working;
                }
                return true;
            }
        }
        false
    }

    /// Clear the answerable handle for a parked AskUserQuestion (answered or
    /// timed out). The display DTOs stay until `PostToolUse` so a fail-open
    /// (timed-out) question keeps showing until the terminal answer lands; a
    /// successful answer is superseded by the tool's own `PostToolUse`. Returns
    /// true when the snapshot changed.
    pub fn resolve_question(&mut self, request_id: &str) -> bool {
        for session in self.sessions.values_mut() {
            if session
                .pending_question_request
                .as_ref()
                .is_some_and(|q| q.request_id == request_id)
            {
                session.pending_question_request = None;
                return true;
            }
        }
        false
    }

    pub fn question_target(
        &self,
        request_id: &str,
    ) -> Option<(FleetAgent, String, Vec<PendingQuestion>)> {
        self.sessions
            .iter()
            .find_map(|((agent, session_id), session)| {
                session
                    .pending_question_request
                    .as_ref()
                    .filter(|request| request.request_id == request_id)
                    .map(|_| {
                        (
                            *agent,
                            session_id.clone(),
                            session.pending_questions.clone(),
                        )
                    })
            })
    }

    /// Drop ended rows past their linger window and stale rows whose agent
    /// process is gone. `pid_alive` is injected so tests don't need real pids.
    pub fn reap(&mut self, now_ms: u64, pid_alive: impl Fn(u32) -> bool) -> bool {
        let before = self.sessions.len();
        self.sessions.retain(|_, s| {
            if s.status == FleetStatus::Detached {
                return true;
            }
            if let Some(ended_at) = s.ended_at {
                return now_ms.saturating_sub(ended_at) < ENDED_LINGER_MS;
            }
            if now_ms.saturating_sub(s.last_event_at) >= STALE_AFTER_MS {
                if s.origin.as_deref() == Some("managed-team") {
                    return true;
                }
                return s.agent_pid.map(&pid_alive).unwrap_or(false);
            }
            true
        });
        self.sessions.len() != before
    }

    /// Full snapshot, most recently active first.
    pub fn snapshot(&self, now_ms: u64) -> FleetSnapshot {
        let mut sessions: Vec<FleetSession> = self.sessions.values().cloned().collect();
        sessions.sort_by(|a, b| b.last_event_at.cmp(&a.last_event_at));
        // Stable order (declaration order of the enum) so the settings card
        // doesn't reshuffle its rows between snapshots.
        let mut liveness: Vec<AgentLivenessRow> = self
            .liveness
            .iter()
            .map(|(agent, liveness)| AgentLivenessRow {
                agent: *agent,
                liveness: *liveness,
            })
            .collect();
        liveness.sort_by_key(|row| row.agent as u8);
        let mut runtime_capabilities: Vec<AgentRuntimeCapabilities> =
            self.runtime_capabilities.values().cloned().collect();
        runtime_capabilities.sort_by_key(|probe| probe.agent as u8);
        FleetSnapshot {
            sessions,
            hosts: Vec::new(),
            liveness,
            runtime_capabilities,
            generated_at: now_ms,
        }
    }
}

fn runtime_capability_probe(
    agent: FleetAgent,
    payload: &serde_json::Value,
    observed_at: u64,
) -> AgentRuntimeCapabilities {
    let declared = super::integrations::manifest_for(agent).capabilities;
    AgentRuntimeCapabilities {
        agent,
        send_message: declared.send_message
            && payload
                .get("send_message")
                .or_else(|| payload.get("sendMessage"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        interrupt: declared.interrupt
            && payload
                .get("interrupt")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        answers_questions: super::integrations::manifest_for(agent).answers_questions
            && payload
                .get("answers_questions")
                .or_else(|| payload.get("answersQuestions"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        interrupt_mode: payload
            .get("interrupt_mode")
            .or_else(|| payload.get("interruptMode"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        question_mode: payload
            .get("question_mode")
            .or_else(|| payload.get("questionMode"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        observed_at,
    }
}

fn new_session(
    agent: FleetAgent,
    session_id: String,
    ev: &FleetEvent,
    now_ms: u64,
) -> FleetSession {
    let manifest = super::integrations::manifest_for(agent);
    FleetSession {
        agent,
        session_id,
        status: FleetStatus::Idle,
        lifecycle_confidence: LifecycleConfidence::Native,
        cwd: None,
        project_name: None,
        last_prompt: None,
        activity: None,
        permission_mode: None,
        model: None,
        terminal: None,
        transcript_path: None,
        agent_pid: ev.ppid,
        pending_permission: None,
        pending_plan: None,
        pending_questions: Vec::new(),
        pending_question_request: None,
        subagents: Vec::new(),
        // The manifest's declared ceiling. `FleetRegistry::apply` narrows it
        // against this row's runtime facts immediately after inserting.
        capabilities: manifest.capabilities,
        capability_descriptor_version: manifest.descriptor_version,
        capability_descriptor_source: manifest.descriptor_source.to_string(),
        started_at: now_ms,
        last_event_at: now_ms,
        ended_at: None,
        last_error: None,
        tool_use_count: 0,
        turn_count: 0,
        start_source: None,
        git_branch: None,
        host_ref: None,
        origin: None,
        agent_team_id: None,
        agent_team_run_id: None,
        agent_team_child_run_id: None,
        execution_run_id: None,
        review_evidence_ref: None,
        git_checked: false,
        process_started_at: None,
        status_before_detach: None,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedFleetSession {
    pub session_id: String,
    pub host_ref: String,
    pub status: FleetStatus,
    pub agent_team_id: String,
    pub agent_team_run_id: String,
    pub agent_team_child_run_id: String,
    pub execution_run_id: String,
    pub review_evidence_ref: Option<String>,
    pub model: Option<String>,
    pub project_name: Option<String>,
    pub started_at: Option<u64>,
}

/// Session id extraction is per-agent: the key order lives in that agent's
/// [`AgentManifest`], not here. Codex is the cautionary tale — its `notify`
/// payload carries `thread-id`, never `session_id`, so a single hardcoded key
/// list silently dropped every Codex event ever sent.
fn extract_session_id(ev: &FleetEvent) -> Option<String> {
    super::integrations::manifest_for(ev.agent).session_id(&ev.payload)
}

fn payload_str(payload: &serde_json::Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Plan-mode detection mirrors `lib/agent/plan/exit-plan-capture.ts`, which
/// recognizes the SDK tool, the snake_case CLI variant, and the MCP-bridged id.
fn is_exit_plan_tool(tool_name: &str) -> bool {
    tool_name == "ExitPlanMode"
        || tool_name == "exit_plan_mode"
        || tool_name.ends_with("__exit_plan_mode")
}

/// AskUserQuestion — SDK name plus the MCP-bridged snake_case variant.
fn is_ask_user_question_tool(tool_name: &str) -> bool {
    tool_name == "AskUserQuestion"
        || tool_name == "ask_user_question"
        || tool_name.ends_with("__ask_user_question")
}

/// The subagent-spawning tool. "Task" is the SDK name; "Agent" is the
/// user-facing alias some builds report.
fn is_task_tool(tool_name: &str) -> bool {
    tool_name == "Task" || tool_name == "Agent"
}

/// Caps keeping a hostile/huge tool input from bloating every snapshot emit.
const MAX_PLAN_CHARS: usize = 4_000;
const MAX_QUESTION_CHARS: usize = 300;
const MAX_QUESTIONS: usize = 4;
const MAX_OPTIONS: usize = 6;
const MAX_SUBAGENT_DESC_CHARS: usize = 120;
const MAX_SUBAGENTS: usize = 12;

/// Char-safe truncation with an ellipsis marker.
fn truncate_chars(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if out.len() < text.len() {
        out.push('…');
    }
    out
}

/// The ExitPlanMode plan markdown, truncated for transport.
fn extract_plan(payload: &serde_json::Value) -> Option<String> {
    let plan = payload.get("tool_input")?.get("plan")?.as_str()?;
    let trimmed = plan.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate_chars(trimmed, MAX_PLAN_CHARS))
}

/// AskUserQuestion `tool_input.questions` → display DTOs (capped).
fn extract_questions(payload: &serde_json::Value) -> Vec<PendingQuestion> {
    let Some(questions) = payload
        .get("tool_input")
        .and_then(|i| i.get("questions"))
        .and_then(|q| q.as_array())
    else {
        return Vec::new();
    };
    questions
        .iter()
        .filter_map(|q| {
            let question = q.get("question")?.as_str()?.trim();
            if question.is_empty() {
                return None;
            }
            let options = q
                .get("options")
                .and_then(|o| o.as_array())
                .map(|opts| {
                    opts.iter()
                        .filter_map(|o| {
                            // Options are `{label, description}` objects; some
                            // bridged variants send plain strings.
                            o.get("label")
                                .and_then(|l| l.as_str())
                                .or_else(|| o.as_str())
                        })
                        .filter(|l| !l.trim().is_empty())
                        .take(MAX_OPTIONS)
                        .map(|l| truncate_chars(l.trim(), MAX_QUESTION_CHARS))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(PendingQuestion {
                question: truncate_chars(question, MAX_QUESTION_CHARS),
                header: q
                    .get("header")
                    .and_then(|h| h.as_str())
                    .map(|h| truncate_chars(h.trim(), 40)),
                options,
                multi_select: q
                    .get("multiSelect")
                    .or_else(|| q.get("multi_select"))
                    .and_then(|m| m.as_bool())
                    .unwrap_or(false),
            })
        })
        .take(MAX_QUESTIONS)
        .collect()
}

/// One option's display label — `{label}` objects, or a bare string for the
/// bridged variants (mirrors the fallback in [`extract_questions`]).
fn option_label(opt: &serde_json::Value) -> Option<String> {
    opt.get("label")
        .and_then(|l| l.as_str())
        .or_else(|| opt.as_str())
        .map(str::to_owned)
}

/// Build the AskUserQuestion answer decision's `updatedInput` from the raw
/// `tool_input.questions` and the island's per-question option selections
/// (indices into each question's `options`). Mirrors the Agent SDK user-input
/// contract: the original `questions` are passed through unchanged, and
/// `answers` maps each question's (untruncated) text to the selected option
/// label(s) — a single string for single-select, an array for multi-select.
/// Questions with no valid selection are omitted. `selections[i]` answers
/// `questions[i]`; extra/short selection rows are ignored.
pub fn build_ask_user_answer_input(
    raw_questions: &serde_json::Value,
    selections: &[Vec<u32>],
) -> serde_json::Value {
    let mut answers = serde_json::Map::new();
    if let Some(questions) = raw_questions.as_array() {
        for (i, selected) in selections.iter().enumerate() {
            let Some(q) = questions.get(i) else { continue };
            let Some(question_text) = q.get("question").and_then(|v| v.as_str()) else {
                continue;
            };
            let opts = q.get("options").and_then(|o| o.as_array());
            let multi = q
                .get("multiSelect")
                .or_else(|| q.get("multi_select"))
                .and_then(|m| m.as_bool())
                .unwrap_or(false);
            let labels: Vec<String> = selected
                .iter()
                .filter_map(|&idx| {
                    opts.and_then(|o| o.get(idx as usize))
                        .and_then(option_label)
                })
                .collect();
            if labels.is_empty() {
                continue;
            }
            let value = if multi {
                serde_json::Value::Array(
                    labels.into_iter().map(serde_json::Value::String).collect(),
                )
            } else {
                // Single-select: the first (and only expected) label.
                serde_json::Value::String(labels.into_iter().next().unwrap_or_default())
            };
            answers.insert(question_text.to_string(), value);
        }
    }
    serde_json::json!({
        "questions": raw_questions.clone(),
        "answers": serde_json::Value::Object(answers),
    })
}

fn subagent_description(payload: &serde_json::Value) -> Option<String> {
    let input = payload.get("tool_input")?;
    let text = input
        .get("description")
        .or_else(|| input.get("prompt"))
        .and_then(|v| v.as_str())?
        .trim();
    if text.is_empty() {
        return None;
    }
    Some(truncate_chars(text, MAX_SUBAGENT_DESC_CHARS))
}

fn subagent_is_background(payload: &serde_json::Value) -> bool {
    payload
        .get("tool_input")
        .and_then(|i| i.get("run_in_background"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false)
}

/// Track a Task tool spawn. FIFO-capped so a runaway loop can't grow the row.
fn push_subagent(entry: &mut FleetSession, payload: &serde_json::Value, now_ms: u64) {
    let Some(description) = subagent_description(payload) else {
        return;
    };
    if entry.subagents.len() >= MAX_SUBAGENTS {
        entry.subagents.remove(0);
    }
    entry.subagents.push(FleetSubagent {
        description,
        agent_type: payload
            .get("tool_input")
            .and_then(|i| i.get("subagent_type"))
            .and_then(|t| t.as_str())
            .filter(|t| !t.trim().is_empty())
            .map(|t| truncate_chars(t.trim(), 40)),
        background: subagent_is_background(payload),
        started_at: now_ms,
        lifecycle_confidence: LifecycleConfidence::Inferred,
    });
}

fn push_native_subagent(entry: &mut FleetSession, payload: &serde_json::Value, now_ms: u64) {
    let description = payload_str(payload, "description")
        .or_else(|| payload_str(payload, "agent_type"))
        .or_else(|| payload_str(payload, "subagent_type"))
        .unwrap_or_else(|| "Subagent".to_string());
    if entry.subagents.len() >= MAX_SUBAGENTS {
        entry.subagents.remove(0);
    }
    entry.subagents.push(FleetSubagent {
        description: truncate_chars(description.trim(), MAX_SUBAGENT_DESC_CHARS),
        agent_type: payload_str(payload, "agent_type")
            .or_else(|| payload_str(payload, "subagent_type"))
            .map(|value| truncate_chars(value.trim(), 40)),
        background: payload
            .get("background")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        started_at: now_ms,
        lifecycle_confidence: LifecycleConfidence::Native,
    });
}

/// A Task tool call returned. Foreground → the subagent is done, retire the
/// matching entry (exact description only — `SubagentStop` usually got there
/// first, and a blind fallback could retire a different parallel subagent).
/// Background → the call returning just means the task was accepted; keep it.
fn finish_task_subagent(entry: &mut FleetSession, payload: &serde_json::Value) {
    if subagent_is_background(payload) {
        return;
    }
    let Some(description) = subagent_description(payload) else {
        return;
    };
    if let Some(pos) = entry
        .subagents
        .iter()
        .position(|s| !s.background && s.description == description)
    {
        entry.subagents.remove(pos);
    }
}

/// Compact one-line detail for the island activity/permission rows. Pulls the
/// most informative field of the tool input without dumping the whole JSON.
fn tool_detail(payload: &serde_json::Value, tool_name: &str) -> Option<String> {
    let input = payload.get("tool_input")?;
    let text = match tool_name {
        "Bash" => input.get("command").and_then(|v| v.as_str()),
        "Read" | "Edit" | "Write" | "NotebookEdit" => {
            input.get("file_path").and_then(|v| v.as_str())
        }
        "Glob" | "Grep" => input.get("pattern").and_then(|v| v.as_str()),
        "WebFetch" | "WebSearch" => input
            .get("url")
            .or_else(|| input.get("query"))
            .and_then(|v| v.as_str()),
        "Agent" | "Task" => input
            .get("description")
            .or_else(|| input.get("prompt"))
            .and_then(|v| v.as_str()),
        _ => input
            .get("command")
            .or_else(|| input.get("file_path"))
            .or_else(|| input.get("description"))
            .and_then(|v| v.as_str()),
    }?;
    let mut detail: String = text.chars().take(160).collect();
    if detail.len() < text.len() {
        detail.push('…');
    }
    Some(detail)
}

/// Detect a failed `PostToolUse` result. Returns `None` when the tool
/// succeeded (or carried no result), and `Some(detail)` when it errored — the
/// inner `Option` is the best compact message available.
///
/// Claude's `tool_response` is normally an object (`{is_error, content}` or an
/// `error` field); some bridged variants send a bare string. A top-level
/// `is_error` flag is also honored. A plain string result without any error
/// flag is normal output, not an error.
fn extract_tool_error(payload: &serde_json::Value) -> Option<Option<String>> {
    let response = payload.get("tool_response");
    let flagged = response
        .and_then(|r| r.get("is_error"))
        .and_then(|v| v.as_bool())
        .or_else(|| payload.get("is_error").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    // An `error` field on the response is itself a failure signal.
    let error_msg = response
        .and_then(|r| r.get("error"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty());
    if !flagged && error_msg.is_none() {
        return None;
    }
    // Best available detail: explicit error, else stringified content, else a
    // bare-string response body.
    let detail = error_msg
        .or_else(|| {
            response
                .and_then(|r| r.get("content"))
                .and_then(|c| c.as_str())
        })
        .or_else(|| response.and_then(|r| r.as_str()))
        .filter(|s| !s.trim().is_empty())
        .map(|s| truncate_chars(s.trim(), 160));
    Some(detail)
}

fn project_name_of(cwd: &str) -> Option<String> {
    std::path::Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
}

/// Deterministic-enough correlation id: agent + session + arrival time. Only
/// one permission can be pending per session, so collisions are impossible in
/// practice; time keeps ids unique across sequential requests.
fn permission_request_id(agent: &FleetAgent, session_id: &str, now_ms: u64) -> String {
    format!("{agent:?}-{session_id}-{now_ms}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(agent: FleetAgent, event: &str, payload: serde_json::Value) -> FleetEvent {
        FleetEvent {
            agent,
            event: event.to_string(),
            pid: Some(999),
            ppid: Some(1234),
            env: HashMap::new(),
            payload,
        }
    }

    fn claude_ev(event: &str, payload: serde_json::Value) -> FleetEvent {
        ev(FleetAgent::ClaudeCode, event, payload)
    }

    const SID: &str = "abc-123";

    #[test]
    fn fleet_host_readiness_fields_are_additive_on_the_wire() {
        let legacy = FleetHost {
            host_ref: "device:legacy".into(),
            online: false,
            max_active_turns: 1,
            used_slots: None,
            placement_ready: None,
            placement_reason: None,
            runtime: "cognia-agent".into(),
            workspace_binding_ready: false,
            workspace_binding_refs: vec![],
            last_seen_at: 1,
        };
        let legacy_json = serde_json::to_value(&legacy).unwrap();
        assert!(legacy_json.get("placementReady").is_none());
        assert!(legacy_json.get("placementReason").is_none());

        let projected = FleetHost {
            placement_ready: Some(false),
            placement_reason: Some("execution_profile_missing".into()),
            ..legacy
        };
        let projected_json = serde_json::to_value(projected).unwrap();
        assert_eq!(projected_json["placementReady"], false);
        assert_eq!(
            projected_json["placementReason"],
            "execution_profile_missing"
        );
    }

    fn base_payload() -> serde_json::Value {
        serde_json::json!({
            "session_id": SID,
            "cwd": "/Users/x/proj/cognia-next",
            "transcript_path": "/Users/x/.claude/projects/-x/abc-123.jsonl",
            "permission_mode": "default"
        })
    }

    fn only_session(reg: &FleetRegistry) -> FleetSession {
        let snap = reg.snapshot(0);
        assert_eq!(snap.sessions.len(), 1);
        snap.sessions[0].clone()
    }

    #[test]
    fn managed_session_is_a_disposable_lineage_projection() {
        let mut reg = FleetRegistry::new();
        reg.upsert_managed_session(
            ManagedFleetSession {
                session_id: "remote-1".into(),
                host_ref: "device:worker-a".into(),
                status: FleetStatus::Working,
                agent_team_id: "team-1".into(),
                agent_team_run_id: "run-1".into(),
                agent_team_child_run_id: "child-1".into(),
                execution_run_id: "execution:team:run-1".into(),
                review_evidence_ref: None,
                model: Some("test-model".into()),
                project_name: Some("Project".into()),
                started_at: Some(10),
            },
            20,
        );
        let session = reg.snapshot(20).sessions.pop().unwrap();
        assert_eq!(session.agent, FleetAgent::Cognia);
        assert_eq!(session.origin.as_deref(), Some("managed-team"));
        assert_eq!(session.host_ref.as_deref(), Some("device:worker-a"));
        assert_eq!(session.agent_team_child_run_id.as_deref(), Some("child-1"));
        assert!(!reg.reap(STALE_AFTER_MS + 20, |_| false));
        assert!(reg.remove_managed_session("remote-1"));
        assert!(reg.snapshot(21).sessions.is_empty());
    }

    #[test]
    fn session_start_creates_idle_row_with_metadata() {
        let mut reg = FleetRegistry::new();
        let effect = reg.apply(&claude_ev("SessionStart", base_payload()), 1000);
        assert_eq!(effect, RegistryEffect::Updated);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Idle);
        assert_eq!(s.project_name.as_deref(), Some("cognia-next"));
        assert_eq!(s.agent_pid, Some(1234));
        assert!(s.capabilities.open_transcript);
        assert_eq!(s.started_at, 1000);
    }

    #[test]
    fn event_without_session_id_is_ignored() {
        let mut reg = FleetRegistry::new();
        let effect = reg.apply(&claude_ev("SessionStart", serde_json::json!({})), 0);
        assert_eq!(effect, RegistryEffect::Ignored);
        assert!(reg.is_empty());
    }

    #[test]
    fn prompt_submit_stores_prompt_and_goes_working() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["prompt"] = serde_json::json!("fix the login bug");
        reg.apply(&claude_ev("UserPromptSubmit", payload), 2000);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Working);
        assert_eq!(s.last_prompt.as_deref(), Some("fix the login bug"));
    }

    #[test]
    fn pre_tool_use_sets_activity_line() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("Bash");
        payload["tool_input"] = serde_json::json!({"command": "pnpm test"});
        reg.apply(&claude_ev("PreToolUse", payload), 0);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Working);
        let activity = s.activity.expect("activity");
        assert_eq!(activity.tool_name, "Bash");
        assert_eq!(activity.detail.as_deref(), Some("pnpm test"));
    }

    #[test]
    fn exit_plan_mode_tool_marks_plan_pending() {
        for tool in [
            "ExitPlanMode",
            "exit_plan_mode",
            "mcp__cognia-tools__exit_plan_mode",
        ] {
            let mut reg = FleetRegistry::new();
            let mut payload = base_payload();
            payload["tool_name"] = serde_json::json!(tool);
            reg.apply(&claude_ev("PreToolUse", payload), 0);
            assert_eq!(
                only_session(&reg).status,
                FleetStatus::PlanPending,
                "{tool}"
            );
        }
    }

    #[test]
    fn exit_plan_mode_captures_the_plan_and_clears_on_answer() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("ExitPlanMode");
        payload["tool_input"] = serde_json::json!({"plan": "## Steps\n1. Do X\n2. Do Y"});
        reg.apply(&claude_ev("PreToolUse", payload), 0);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::PlanPending);
        assert_eq!(
            s.pending_plan.as_deref(),
            Some("## Steps\n1. Do X\n2. Do Y")
        );

        // Approving the plan in the terminal → PostToolUse clears it.
        let mut post = base_payload();
        post["tool_name"] = serde_json::json!("ExitPlanMode");
        reg.apply(&claude_ev("PostToolUse", post), 1);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Working);
        assert!(s.pending_plan.is_none());
    }

    #[test]
    fn oversized_plan_is_truncated() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("ExitPlanMode");
        payload["tool_input"] = serde_json::json!({ "plan": "x".repeat(10_000) });
        reg.apply(&claude_ev("PreToolUse", payload), 0);
        let plan = only_session(&reg).pending_plan.expect("plan");
        assert!(plan.chars().count() <= MAX_PLAN_CHARS + 1);
        assert!(plan.ends_with('…'));
    }

    #[test]
    fn ask_user_question_parks_questions_and_waits_for_input() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("AskUserQuestion");
        payload["tool_input"] = serde_json::json!({
            "questions": [{
                "question": "Which auth method?",
                "header": "Auth",
                "multiSelect": false,
                "options": [
                    {"label": "OAuth", "description": "…"},
                    {"label": "API key", "description": "…"}
                ]
            }, {
                "question": "Enable telemetry?",
                "options": ["Yes", "No"],
                "multiSelect": true
            }]
        });
        reg.apply(&claude_ev("PreToolUse", payload), 0);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::WaitingInput);
        assert_eq!(s.pending_questions.len(), 2);
        assert_eq!(s.pending_questions[0].question, "Which auth method?");
        assert_eq!(s.pending_questions[0].header.as_deref(), Some("Auth"));
        assert_eq!(s.pending_questions[0].options, vec!["OAuth", "API key"]);
        assert!(!s.pending_questions[0].multi_select);
        // Plain-string options (bridged variants) also parse.
        assert_eq!(s.pending_questions[1].options, vec!["Yes", "No"]);
        assert!(s.pending_questions[1].multi_select);
        // PreToolUse alone is display-only — the answerable handle is unset
        // until the paired PermissionRequest arrives.
        assert!(s.pending_question_request.is_none());

        // Answering in the terminal → PostToolUse clears and resumes working.
        let mut post = base_payload();
        post["tool_name"] = serde_json::json!("AskUserQuestion");
        reg.apply(&claude_ev("PostToolUse", post), 1);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Working);
        assert!(s.pending_questions.is_empty());
    }

    #[test]
    fn permission_request_for_ask_user_question_parks_answerable_question() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("AskUserQuestion");
        payload["tool_input"] = serde_json::json!({
            "questions": [{
                "question": "Which auth method?",
                "header": "Auth",
                "multiSelect": false,
                "options": [
                    {"label": "OAuth", "description": "…"},
                    {"label": "API key", "description": "…"}
                ]
            }]
        });
        let effect = reg.apply(&claude_ev("PermissionRequest", payload), 7000);

        // It is a *question*, not a generic Approve/Deny: WaitingInput, the
        // answerable handle is set, and NO generic permission is parked.
        let RegistryEffect::QuestionRequested { request_id } = effect else {
            panic!("expected QuestionRequested, got {effect:?}");
        };
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::WaitingInput);
        assert!(s.pending_permission.is_none());
        assert_eq!(s.pending_questions.len(), 1);
        assert_eq!(s.pending_questions[0].options, vec!["OAuth", "API key"]);
        let req = s.pending_question_request.expect("answerable handle set");
        assert_eq!(req.request_id, request_id);
        assert_eq!(req.requested_at, 7000);

        // resolve_question clears the handle but leaves the display DTOs
        // (fail-open questions keep showing until PostToolUse).
        assert!(reg.resolve_question(&request_id));
        let s = only_session(&reg);
        assert!(s.pending_question_request.is_none());
        assert_eq!(s.pending_questions.len(), 1);
        assert!(!reg.resolve_question("nope"));
    }

    #[test]
    fn permission_request_for_exit_plan_keeps_plan_pose_and_stays_answerable() {
        for tool in [
            "ExitPlanMode",
            "exit_plan_mode",
            "mcp__cognia-tools__exit_plan_mode",
        ] {
            let mut reg = FleetRegistry::new();
            // PreToolUse parks the plan preview.
            let mut pre = base_payload();
            pre["tool_name"] = serde_json::json!(tool);
            pre["tool_input"] = serde_json::json!({"plan": "## Steps\n1. Do X"});
            reg.apply(&claude_ev("PreToolUse", pre), 0);

            // The paired PermissionRequest must NOT collapse the plan into a
            // generic tool approval: the row stays PlanPending, keeps the plan
            // text, and parks an answerable permission (Approve/Deny).
            let mut req = base_payload();
            req["tool_name"] = serde_json::json!(tool);
            req["tool_input"] = serde_json::json!({"plan": "## Steps\n1. Do X"});
            let effect = reg.apply(&claude_ev("PermissionRequest", req), 7000);
            let RegistryEffect::PermissionRequested { request_id } = effect else {
                panic!("expected PermissionRequested, got {effect:?} for {tool}");
            };
            let s = only_session(&reg);
            assert_eq!(s.status, FleetStatus::PlanPending, "{tool}");
            assert_eq!(
                s.pending_plan.as_deref(),
                Some("## Steps\n1. Do X"),
                "{tool}"
            );
            let pending = s
                .pending_permission
                .as_ref()
                .expect("answerable permission");
            assert_eq!(pending.request_id, request_id, "{tool}");
            assert_eq!(pending.tool_name.as_deref(), Some(tool), "{tool}");
            assert!(s.capabilities.approve_permission, "{tool}");
            // Answering releases the permission the standard way.
            assert!(reg.resolve_permission(&request_id));
            assert!(only_session(&reg).pending_permission.is_none(), "{tool}");
        }
    }

    #[test]
    fn opencode_question_is_answerable_only_after_runtime_probe() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["session_id"] = serde_json::json!("oc-auq");
        payload["tool_name"] = serde_json::json!("AskUserQuestion");
        payload["tool_input"] = serde_json::json!({ "questions": [{ "question": "Q?" }] });
        let effect = reg.apply(
            &ev(FleetAgent::Opencode, "PermissionRequest", payload.clone()),
            0,
        );
        assert!(matches!(effect, RegistryEffect::PermissionRequested { .. }));
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::WaitingPermission);
        assert!(s.pending_permission.is_some());
        assert!(s.pending_question_request.is_none());

        assert_eq!(
            reg.apply(
                &ev(
                    FleetAgent::Opencode,
                    "Capabilities",
                    serde_json::json!({
                        "sendMessage": true,
                        "interrupt": true,
                        "interruptMode": "v2",
                        "answersQuestions": true,
                        "questionMode": "v2"
                    }),
                ),
                1,
            ),
            RegistryEffect::Updated
        );
        let effect = reg.apply(&ev(FleetAgent::Opencode, "PermissionRequest", payload), 2);
        assert!(matches!(effect, RegistryEffect::QuestionRequested { .. }));
        assert!(only_session(&reg).pending_question_request.is_some());
    }

    #[test]
    fn opencode_controls_are_conservatively_intersected_with_runtime_probe() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["session_id"] = serde_json::json!("oc-controls");
        reg.apply(&ev(FleetAgent::Opencode, "session-active", payload), 1);
        let before = only_session(&reg);
        assert!(!before.capabilities.send_message);
        assert!(!before.capabilities.interrupt);

        reg.apply(
            &ev(
                FleetAgent::Opencode,
                "Capabilities",
                serde_json::json!({
                    "sendMessage": true,
                    "interrupt": true,
                    "interruptMode": "v1",
                    "answersQuestions": false
                }),
            ),
            2,
        );
        let after = only_session(&reg);
        assert!(after.capabilities.send_message);
        assert!(after.capabilities.interrupt);
        let snapshot = reg.snapshot(3);
        assert_eq!(snapshot.runtime_capabilities.len(), 1);
        assert_eq!(
            snapshot.runtime_capabilities[0].interrupt_mode.as_deref(),
            Some("v1")
        );
        assert!(!snapshot.runtime_capabilities[0].answers_questions);
    }

    #[test]
    fn detach_recovery_reconciles_only_matching_process_identity() {
        let mut reg = FleetRegistry::new();
        let mut event = claude_ev("UserPromptSubmit", base_payload());
        event.ppid = Some(4242);
        reg.apply(&event, 10);
        assert!(reg.set_process_started_at(FleetAgent::ClaudeCode, SID, 99));
        assert!(reg.mark_all_detached());
        let detached = only_session(&reg);
        assert_eq!(detached.status, FleetStatus::Detached);
        assert!(!detached.capabilities.approve_permission);
        assert!(!detached.capabilities.send_message);
        assert!(!detached.capabilities.focus_terminal);
        assert!(!detached.capabilities.interrupt);

        let rows = reg.recovery_sessions();
        assert_eq!(rows[0].status, FleetStatus::Working);
        let mut restored = FleetRegistry::new();
        restored.restore_recovery(rows.clone());
        assert_eq!(only_session(&restored).status, FleetStatus::Detached);
        assert!(
            restored.reconcile_detached(20, |pid, started| { Some(pid == 4242 && started == 99) })
        );
        assert_eq!(only_session(&restored).status, FleetStatus::Working);

        let mut ended = FleetRegistry::new();
        ended.restore_recovery(rows);
        assert!(ended.reconcile_detached(30, |_, _| Some(false)));
        let session = only_session(&ended);
        assert_eq!(session.status, FleetStatus::Ended);
        assert_eq!(session.ended_at, Some(30));
    }

    #[test]
    fn multi_session_provider_stays_detached_when_identity_is_unprovable() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["session_id"] = serde_json::json!("oc-detached");
        reg.apply(&ev(FleetAgent::Opencode, "session-active", payload), 1);
        reg.apply(
            &ev(
                FleetAgent::Opencode,
                "Capabilities",
                serde_json::json!({
                    "sendMessage": true,
                    "interrupt": true,
                    "answersQuestions": true
                }),
            ),
            2,
        );
        assert!(only_session(&reg).capabilities.send_message);
        reg.mark_all_detached();
        assert!(!reg.reconcile_detached(3, |_, _| Some(true)));
        let session = only_session(&reg);
        assert_eq!(session.status, FleetStatus::Detached);
        assert!(!session.capabilities.send_message);
        assert!(!session.capabilities.interrupt);
    }

    #[test]
    fn native_and_heuristic_subagents_record_lifecycle_confidence() {
        let mut reg = FleetRegistry::new();
        let mut native = base_payload();
        native["agent_type"] = serde_json::json!("Explore");
        reg.apply(&claude_ev("SubagentStart", native), 1);
        assert_eq!(
            only_session(&reg).subagents[0].lifecycle_confidence,
            LifecycleConfidence::Native
        );

        let mut inferred = base_payload();
        inferred["tool_name"] = serde_json::json!("Task");
        inferred["tool_input"] = serde_json::json!({"description": "Inspect hooks"});
        reg.apply(&claude_ev("PreToolUse", inferred), 2);
        assert_eq!(
            only_session(&reg).subagents[1].lifecycle_confidence,
            LifecycleConfidence::Inferred
        );
    }

    #[test]
    fn build_ask_user_answer_input_maps_selections_to_labels() {
        let raw = serde_json::json!({
            "questions": [
                {
                    "question": "Which auth method?",
                    "multiSelect": false,
                    "options": [{"label": "OAuth"}, {"label": "API key"}]
                },
                {
                    "question": "Which sections?",
                    "multiSelect": true,
                    "options": ["Intro", "Body", "Outro"]
                }
            ]
        });
        let questions = &raw["questions"];
        // Q0 single-select → index 1 ("API key"); Q1 multi-select → 0 and 2.
        let updated = build_ask_user_answer_input(questions, &[vec![1], vec![0, 2]]);
        // Original questions pass through unchanged.
        assert_eq!(updated["questions"], *questions);
        // Single-select answer is a string; multi-select is an array of labels.
        assert_eq!(updated["answers"]["Which auth method?"], "API key");
        assert_eq!(
            updated["answers"]["Which sections?"],
            serde_json::json!(["Intro", "Outro"])
        );
    }

    #[test]
    fn build_ask_user_answer_input_omits_empty_or_out_of_range() {
        let raw = serde_json::json!({
            "questions": [{ "question": "Pick?", "options": [{"label": "A"}] }]
        });
        // Out-of-range index → no label → question omitted from answers.
        let updated = build_ask_user_answer_input(&raw["questions"], &[vec![9]]);
        assert!(updated["answers"].as_object().unwrap().is_empty());
    }

    #[test]
    fn task_tool_tracks_foreground_and_background_subagents() {
        let mut reg = FleetRegistry::new();

        // Foreground subagent.
        let mut fg = base_payload();
        fg["tool_name"] = serde_json::json!("Task");
        fg["tool_input"] = serde_json::json!({
            "description": "Audit i18n keys",
            "subagent_type": "Explore"
        });
        reg.apply(&claude_ev("PreToolUse", fg), 10);

        // Background subagent.
        let mut bg = base_payload();
        bg["tool_name"] = serde_json::json!("Task");
        bg["tool_input"] = serde_json::json!({
            "description": "Run full test suite",
            "subagent_type": "general-purpose",
            "run_in_background": true
        });
        reg.apply(&claude_ev("PreToolUse", bg.clone()), 20);

        let s = only_session(&reg);
        assert_eq!(s.subagents.len(), 2);
        assert_eq!(s.subagents[0].description, "Audit i18n keys");
        assert_eq!(s.subagents[0].agent_type.as_deref(), Some("Explore"));
        assert!(!s.subagents[0].background);
        assert!(s.subagents[1].background);

        // The background Task call returns immediately — entry stays live.
        reg.apply(&claude_ev("PostToolUse", bg), 21);
        assert_eq!(only_session(&reg).subagents.len(), 2);

        // The foreground subagent finishes: SubagentStop retires it (oldest
        // foreground), its PostToolUse then finds nothing to remove.
        reg.apply(&claude_ev("SubagentStop", base_payload()), 30);
        let mut fg_post = base_payload();
        fg_post["tool_name"] = serde_json::json!("Task");
        fg_post["tool_input"] = serde_json::json!({"description": "Audit i18n keys"});
        reg.apply(&claude_ev("PostToolUse", fg_post), 31);
        let s = only_session(&reg);
        assert_eq!(s.subagents.len(), 1);
        assert!(s.subagents[0].background);

        // Turn end keeps the background entry; SubagentStop then retires it.
        reg.apply(&claude_ev("Stop", base_payload()), 40);
        assert_eq!(only_session(&reg).subagents.len(), 1);
        reg.apply(&claude_ev("SubagentStop", base_payload()), 50);
        assert!(only_session(&reg).subagents.is_empty());
    }

    #[test]
    fn subagent_list_is_fifo_capped() {
        let mut reg = FleetRegistry::new();
        for i in 0..(MAX_SUBAGENTS + 3) {
            let mut payload = base_payload();
            payload["tool_name"] = serde_json::json!("Task");
            payload["tool_input"] = serde_json::json!({ "description": format!("job {i}") });
            reg.apply(&claude_ev("PreToolUse", payload), i as u64);
        }
        let s = only_session(&reg);
        assert_eq!(s.subagents.len(), MAX_SUBAGENTS);
        assert_eq!(s.subagents[0].description, "job 3");
    }

    #[test]
    fn new_prompt_clears_parked_plan_question_and_foreground_subagents() {
        let mut reg = FleetRegistry::new();
        let mut plan = base_payload();
        plan["tool_name"] = serde_json::json!("ExitPlanMode");
        plan["tool_input"] = serde_json::json!({"plan": "plan text"});
        reg.apply(&claude_ev("PreToolUse", plan), 0);

        let mut bg = base_payload();
        bg["tool_name"] = serde_json::json!("Task");
        bg["tool_input"] = serde_json::json!({"description": "watcher", "run_in_background": true});
        reg.apply(&claude_ev("PreToolUse", bg), 1);

        let mut prompt = base_payload();
        prompt["prompt"] = serde_json::json!("next task");
        reg.apply(&claude_ev("UserPromptSubmit", prompt), 2);
        let s = only_session(&reg);
        assert!(s.pending_plan.is_none());
        assert!(s.pending_questions.is_empty());
        // Background subagents survive the new turn.
        assert_eq!(s.subagents.len(), 1);
        assert!(s.subagents[0].background);
    }

    #[test]
    fn new_dto_fields_serialize_camel_case() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("AskUserQuestion");
        payload["tool_input"] = serde_json::json!({
            "questions": [{"question": "Q?", "options": ["A"], "multiSelect": true}]
        });
        reg.apply(&claude_ev("PreToolUse", payload), 0);
        let json = serde_json::to_value(reg.snapshot(1)).unwrap();
        let s = &json["sessions"][0];
        assert!(s.get("pendingPlan").is_some());
        assert_eq!(s["pendingQuestions"][0]["question"], "Q?");
        assert_eq!(s["pendingQuestions"][0]["multiSelect"], true);

        // A Task spawn supersedes the parked question and lists the subagent.
        let mut task = base_payload();
        task["tool_name"] = serde_json::json!("Task");
        task["tool_input"] = serde_json::json!({"description": "d", "subagent_type": "Explore", "run_in_background": true});
        reg.apply(&claude_ev("PreToolUse", task), 2);
        let json = serde_json::to_value(reg.snapshot(3)).unwrap();
        let s = &json["sessions"][0];
        assert!(s["pendingQuestions"].as_array().unwrap().is_empty());
        assert_eq!(s["subagents"][0]["description"], "d");
        assert_eq!(s["subagents"][0]["agentType"], "Explore");
        assert_eq!(s["subagents"][0]["background"], true);
        assert!(s["subagents"][0].get("startedAt").is_some());
    }

    #[test]
    fn pending_question_request_serializes_camel_case() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("AskUserQuestion");
        payload["tool_input"] =
            serde_json::json!({ "questions": [{"question": "Q?", "options": ["A", "B"]}] });
        reg.apply(&claude_ev("PermissionRequest", payload), 42);
        let json = serde_json::to_value(reg.snapshot(43)).unwrap();
        let req = &json["sessions"][0]["pendingQuestionRequest"];
        assert!(req["requestId"].is_string());
        assert_eq!(req["requestedAt"], 42);
        // Absent (skipped) when no question is parked.
        let mut reg2 = FleetRegistry::new();
        reg2.apply(&claude_ev("SessionStart", base_payload()), 0);
        let json2 = serde_json::to_value(reg2.snapshot(1)).unwrap();
        assert!(json2["sessions"][0].get("pendingQuestionRequest").is_none());
    }

    #[test]
    fn idle_prompt_notification_marks_waiting_input_only_mid_turn() {
        let mut reg = FleetRegistry::new();
        // Mid-turn (Working): the notification is a real "blocked on you".
        reg.apply(&claude_ev("UserPromptSubmit", base_payload()), 0);
        let mut payload = base_payload();
        payload["notification_type"] = serde_json::json!("idle_prompt");
        reg.apply(&claude_ev("Notification", payload.clone()), 1);
        assert_eq!(only_session(&reg).status, FleetStatus::WaitingInput);

        // After a clean Stop the session is Idle; Claude Code still fires an
        // `idle_prompt` notification ~60 s later — it must NOT resurrect the
        // "needs input" pose (the reported stuck-attention bug).
        reg.apply(&claude_ev("Stop", base_payload()), 2);
        reg.apply(&claude_ev("Notification", payload.clone()), 3);
        assert_eq!(only_session(&reg).status, FleetStatus::Idle);

        // Same guard for the permission hint on an idle session.
        let mut perm = base_payload();
        perm["notification_type"] = serde_json::json!("permission_prompt");
        reg.apply(&claude_ev("Notification", perm), 4);
        assert_eq!(only_session(&reg).status, FleetStatus::Idle);

        // And an ended session stays ended.
        reg.apply(&claude_ev("SessionEnd", base_payload()), 5);
        reg.apply(&claude_ev("Notification", payload), 6);
        assert_eq!(only_session(&reg).status, FleetStatus::Ended);
    }

    #[test]
    fn notification_does_not_clobber_a_display_only_plan_pose() {
        // A bare PreToolUse parks the plan (display-only: no PermissionRequest
        // yet, so no pending_permission). A permission/idle notification hint
        // arriving in that window must NOT overwrite the plan pose — the plan
        // text and PlanPending status own the row until the real event lands.
        for notif in ["permission_prompt", "idle_prompt"] {
            let mut reg = FleetRegistry::new();
            let mut pre = base_payload();
            pre["tool_name"] = serde_json::json!("ExitPlanMode");
            pre["tool_input"] = serde_json::json!({"plan": "## Steps\n1. Do X"});
            reg.apply(&claude_ev("PreToolUse", pre), 0);
            assert_eq!(
                only_session(&reg).status,
                FleetStatus::PlanPending,
                "{notif}"
            );

            let mut hint = base_payload();
            hint["notification_type"] = serde_json::json!(notif);
            reg.apply(&claude_ev("Notification", hint), 1);
            let s = only_session(&reg);
            assert_eq!(s.status, FleetStatus::PlanPending, "{notif}");
            assert_eq!(
                s.pending_plan.as_deref(),
                Some("## Steps\n1. Do X"),
                "{notif}"
            );
            assert!(s.pending_permission.is_none(), "{notif}");
        }
    }

    #[test]
    fn notification_does_not_clobber_a_display_only_question_pose() {
        // Same guard for a bare AskUserQuestion PreToolUse (display-only
        // questions, no answerable handle yet).
        let mut reg = FleetRegistry::new();
        let mut pre = base_payload();
        pre["tool_name"] = serde_json::json!("AskUserQuestion");
        pre["tool_input"] = serde_json::json!({ "questions": [{ "question": "Q?" }] });
        reg.apply(&claude_ev("PreToolUse", pre), 0);
        assert_eq!(only_session(&reg).status, FleetStatus::WaitingInput);

        let mut hint = base_payload();
        hint["notification_type"] = serde_json::json!("permission_prompt");
        reg.apply(&claude_ev("Notification", hint), 1);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::WaitingInput);
        assert_eq!(s.pending_questions.len(), 1);
    }

    #[test]
    fn permission_denied_releases_a_parked_plan() {
        // A rejected plan review (auto-mode / out-of-band "no") must release the
        // plan pose the same way a denied generic permission does — drop the
        // plan text and return to Working, not leave the row stuck PlanPending.
        let mut reg = FleetRegistry::new();
        let mut pre = base_payload();
        pre["tool_name"] = serde_json::json!("ExitPlanMode");
        pre["tool_input"] = serde_json::json!({"plan": "## Steps\n1. Do X"});
        reg.apply(&claude_ev("PreToolUse", pre.clone()), 0);
        // The paired PermissionRequest parks the answerable permission.
        reg.apply(&claude_ev("PermissionRequest", pre), 1);
        assert_eq!(only_session(&reg).status, FleetStatus::PlanPending);

        reg.apply(&claude_ev("PermissionDenied", base_payload()), 2);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Working);
        assert!(s.pending_permission.is_none());
        assert!(s.pending_plan.is_none());
    }

    #[test]
    fn liveness_separates_never_arrived_from_arrived_but_dropped() {
        let mut reg = FleetRegistry::new();
        // Nothing sent yet: the agent has no liveness row at all, which is what
        // "never installed / never trusted" looks like.
        assert!(reg.snapshot(0).liveness.is_empty());

        // An event that reaches us but carries no usable session id is dropped
        // — and yet it PROVES the hooks fired. This is the shape the Codex
        // `notify` integration had for its entire life (its payload names the
        // session `thread-id`, which the manifest did not then accept), so it
        // must stay distinguishable from silence even now that the accepted key
        // list has grown to cover that case.
        let dropped = FleetEvent {
            agent: FleetAgent::Codex,
            event: "SessionStart".into(),
            payload: serde_json::json!({ "conversation": "t-1" }),
            pid: None,
            ppid: None,
            env: Default::default(),
        };
        assert_eq!(reg.apply(&dropped, 100), RegistryEffect::Ignored);
        let rows = reg.snapshot(100).liveness;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].agent, FleetAgent::Codex);
        assert_eq!(rows[0].liveness.last_seen_at, Some(100));
        assert_eq!(rows[0].liveness.seen_count, 1);
        // Seen but never accepted → integration installed, contract mismatched.
        assert_eq!(rows[0].liveness.last_accepted_at, None);
        assert_eq!(rows[0].liveness.accepted_count, 0);
    }

    #[test]
    fn liveness_records_an_accepted_event() {
        let mut reg = FleetRegistry::new();
        let good = FleetEvent {
            agent: FleetAgent::ClaudeCode,
            event: "SessionStart".into(),
            payload: serde_json::json!({ "session_id": "s-1" }),
            pid: None,
            ppid: Some(1234),
            env: Default::default(),
        };
        reg.apply(&good, 200);
        let rows = reg.snapshot(200).liveness;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].liveness.last_seen_at, Some(200));
        assert_eq!(rows[0].liveness.last_accepted_at, Some(200));
        assert_eq!(rows[0].liveness.seen_count, 1);
        assert_eq!(rows[0].liveness.accepted_count, 1);
    }

    #[test]
    fn liveness_rows_keep_a_stable_order() {
        let mut reg = FleetRegistry::new();
        for (agent, key) in [
            (FleetAgent::Opencode, "session_id"),
            (FleetAgent::ClaudeCode, "session_id"),
            (FleetAgent::Codex, "session_id"),
        ] {
            reg.apply(
                &FleetEvent {
                    agent,
                    event: "SessionStart".into(),
                    payload: serde_json::json!({ key: "s-1" }),
                    pid: None,
                    ppid: None,
                    env: Default::default(),
                },
                1,
            );
        }
        // HashMap iteration order is arbitrary; the snapshot must not be, or
        // the settings card reshuffles its rows on every update.
        let order: Vec<FleetAgent> = reg.snapshot(1).liveness.iter().map(|r| r.agent).collect();
        assert_eq!(
            order,
            vec![
                FleetAgent::ClaudeCode,
                FleetAgent::Codex,
                FleetAgent::Opencode
            ]
        );
    }

    #[test]
    fn liveness_row_serializes_flat_and_camel_case() {
        let json = serde_json::to_string(&AgentLivenessRow {
            agent: FleetAgent::ClaudeCode,
            liveness: AgentLiveness {
                last_seen_at: Some(5),
                last_accepted_at: None,
                seen_count: 3,
                accepted_count: 0,
            },
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"agent":"claude-code","lastSeenAt":5,"lastAcceptedAt":null,"seenCount":3,"acceptedCount":0}"#
        );
    }

    #[test]
    fn permission_request_parks_pending_and_signals_effect() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("Bash");
        payload["tool_input"] = serde_json::json!({"command": "rm -rf build"});
        let effect = reg.apply(&claude_ev("PermissionRequest", payload), 5000);
        let RegistryEffect::PermissionRequested { request_id } = effect else {
            panic!("expected PermissionRequested, got {effect:?}");
        };
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::WaitingPermission);
        assert!(s.capabilities.approve_permission);
        let pending = s.pending_permission.expect("pending");
        assert_eq!(pending.request_id, request_id);
        assert_eq!(pending.tool_name.as_deref(), Some("Bash"));
        assert_eq!(pending.detail.as_deref(), Some("rm -rf build"));
        assert_eq!(pending.requested_at, 5000);
    }

    #[test]
    fn resolve_permission_clears_pending_and_restores_working() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("Bash");
        let RegistryEffect::PermissionRequested { request_id } =
            reg.apply(&claude_ev("PermissionRequest", payload), 0)
        else {
            panic!("expected permission effect");
        };
        assert!(reg.resolve_permission(&request_id));
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Working);
        assert!(s.pending_permission.is_none());
        // Unknown id is a no-op.
        assert!(!reg.resolve_permission("nope"));
    }

    #[test]
    fn stop_returns_to_idle_and_clears_activity_and_error() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("Bash");
        payload["tool_input"] = serde_json::json!({"command": "ls"});
        reg.apply(&claude_ev("PreToolUse", payload), 0);
        // A failed tool parks an error; a clean Stop clears it.
        let mut post = base_payload();
        post["tool_name"] = serde_json::json!("Bash");
        post["tool_response"] = serde_json::json!({"is_error": true, "error": "boom"});
        reg.apply(&claude_ev("PostToolUse", post), 1);
        assert!(only_session(&reg).last_error.is_some());
        reg.apply(&claude_ev("Stop", base_payload()), 2);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Idle);
        assert!(s.activity.is_none());
        assert!(s.last_error.is_none());
    }

    #[test]
    fn stop_failure_returns_to_idle_and_stamps_turn_error() {
        // An API-error turn end must clear "working" like a clean Stop (else the
        // row is stranded working forever) BUT stamp a turn error so the island
        // can flag the failure — previously this signal was silently discarded.
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("Bash");
        payload["tool_input"] = serde_json::json!({"command": "ls"});
        reg.apply(&claude_ev("PreToolUse", payload), 0);
        let mut fail = base_payload();
        fail["reason"] = serde_json::json!("API overloaded");
        reg.apply(&claude_ev("StopFailure", fail), 1);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Idle);
        assert!(s.activity.is_none());
        let err = s.last_error.expect("turn error");
        assert_eq!(err.kind, FleetErrorKind::Turn);
        assert_eq!(err.detail.as_deref(), Some("API overloaded"));
        assert_eq!(err.at, 1);
    }

    #[test]
    fn post_tool_use_error_sets_then_success_clears_tool_error() {
        let mut reg = FleetRegistry::new();
        let mut fail = base_payload();
        fail["tool_name"] = serde_json::json!("Bash");
        fail["tool_response"] = serde_json::json!({"is_error": true, "content": "exit 1"});
        reg.apply(&claude_ev("PostToolUse", fail), 10);
        let err = only_session(&reg).last_error.expect("tool error");
        assert_eq!(err.kind, FleetErrorKind::Tool);
        assert_eq!(err.detail.as_deref(), Some("exit 1"));
        assert_eq!(err.at, 10);

        // A later clean tool clears the tool error.
        let mut ok = base_payload();
        ok["tool_name"] = serde_json::json!("Read");
        ok["tool_response"] = serde_json::json!({"content": "file body"});
        reg.apply(&claude_ev("PostToolUse", ok), 11);
        assert!(only_session(&reg).last_error.is_none());
    }

    #[test]
    fn post_tool_use_success_does_not_clear_a_turn_error() {
        let mut reg = FleetRegistry::new();
        reg.apply(&claude_ev("StopFailure", base_payload()), 0);
        assert_eq!(
            only_session(&reg).last_error.map(|e| e.kind),
            Some(FleetErrorKind::Turn)
        );
        // A clean tool result must NOT clear a turn-level error.
        let mut ok = base_payload();
        ok["tool_name"] = serde_json::json!("Read");
        reg.apply(&claude_ev("PostToolUse", ok), 1);
        assert_eq!(
            only_session(&reg).last_error.map(|e| e.kind),
            Some(FleetErrorKind::Turn)
        );
    }

    #[test]
    fn tool_and_turn_counts_increment() {
        let mut reg = FleetRegistry::new();
        reg.apply(&claude_ev("UserPromptSubmit", base_payload()), 0);
        reg.apply(&claude_ev("UserPromptSubmit", base_payload()), 1);
        let mut tool = base_payload();
        tool["tool_name"] = serde_json::json!("Bash");
        reg.apply(&claude_ev("PreToolUse", tool), 2);
        let s = only_session(&reg);
        assert_eq!(s.turn_count, 2);
        assert_eq!(s.tool_use_count, 1);
    }

    #[test]
    fn session_start_source_captured_and_new_turn_clears_error() {
        let mut reg = FleetRegistry::new();
        reg.apply(&claude_ev("StopFailure", base_payload()), 0);
        assert!(only_session(&reg).last_error.is_some());
        // A new turn clears the error and re-arms git capture.
        reg.apply(&claude_ev("UserPromptSubmit", base_payload()), 1);
        assert!(only_session(&reg).last_error.is_none());

        let mut start = base_payload();
        start["source"] = serde_json::json!("resume");
        reg.apply(&claude_ev("SessionStart", start), 2);
        assert_eq!(only_session(&reg).start_source.as_deref(), Some("resume"));
    }

    #[test]
    fn extract_tool_error_recognizes_each_shape() {
        // Object with is_error + explicit error message.
        assert_eq!(
            extract_tool_error(&serde_json::json!({
                "tool_response": {"is_error": true, "error": "boom"}
            })),
            Some(Some("boom".to_string()))
        );
        // Object with only an `error` field (no explicit flag).
        assert_eq!(
            extract_tool_error(&serde_json::json!({"tool_response": {"error": "nope"}})),
            Some(Some("nope".to_string()))
        );
        // Top-level is_error with a bare-string response body.
        assert_eq!(
            extract_tool_error(&serde_json::json!({
                "is_error": true, "tool_response": "raw failure"
            })),
            Some(Some("raw failure".to_string()))
        );
        // Flagged but no message → error with no detail.
        assert_eq!(
            extract_tool_error(&serde_json::json!({"is_error": true})),
            Some(None)
        );
        // Clean result (string body, no flag) → not an error.
        assert_eq!(
            extract_tool_error(&serde_json::json!({"tool_response": "all good"})),
            None
        );
        assert_eq!(extract_tool_error(&serde_json::json!({})), None);
    }

    #[test]
    fn git_seam_captures_branch_once_per_turn() {
        let mut reg = FleetRegistry::new();
        reg.apply(&claude_ev("SessionStart", base_payload()), 0);
        // needs_git_capture yields the cwd until a branch is recorded.
        assert_eq!(
            reg.needs_git_capture(FleetAgent::ClaudeCode, SID)
                .as_deref(),
            Some("/Users/x/proj/cognia-next")
        );
        assert!(reg.set_git_branch(FleetAgent::ClaudeCode, SID, Some("main".into())));
        assert_eq!(only_session(&reg).git_branch.as_deref(), Some("main"));
        // Once checked, no re-capture until a new turn re-arms it.
        assert!(reg.needs_git_capture(FleetAgent::ClaudeCode, SID).is_none());
        reg.apply(&claude_ev("UserPromptSubmit", base_payload()), 1);
        assert!(reg.needs_git_capture(FleetAgent::ClaudeCode, SID).is_some());
    }

    #[test]
    fn pre_compact_shows_compacting_activity_then_post_compact_clears_it() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["trigger"] = serde_json::json!("auto");
        reg.apply(&claude_ev("PreCompact", payload), 0);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Working);
        let activity = s.activity.expect("compacting activity");
        assert_eq!(activity.tool_name, "Compacting");
        assert_eq!(activity.detail.as_deref(), Some("auto"));

        reg.apply(&claude_ev("PostCompact", base_payload()), 1);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Working);
        assert!(s.activity.is_none());
    }

    #[test]
    fn permission_denied_releases_the_parked_request() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("Bash");
        reg.apply(&claude_ev("PermissionRequest", payload), 0);
        assert_eq!(only_session(&reg).status, FleetStatus::WaitingPermission);

        let effect = reg.apply(&claude_ev("PermissionDenied", base_payload()), 1);
        assert_eq!(effect, RegistryEffect::Updated);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Working);
        assert!(s.pending_permission.is_none());
    }

    #[test]
    fn session_end_lingers_then_reaps() {
        let mut reg = FleetRegistry::new();
        reg.apply(&claude_ev("SessionStart", base_payload()), 0);
        reg.apply(&claude_ev("SessionEnd", base_payload()), 1000);
        assert_eq!(only_session(&reg).status, FleetStatus::Ended);

        // Inside the linger window: kept.
        assert!(!reg.reap(1000 + ENDED_LINGER_MS - 1, |_| true));
        assert_eq!(reg.snapshot(0).sessions.len(), 1);
        // Past the linger window: dropped.
        assert!(reg.reap(1000 + ENDED_LINGER_MS, |_| true));
        assert!(reg.is_empty());
    }

    #[test]
    fn stale_session_with_dead_pid_is_reaped() {
        let mut reg = FleetRegistry::new();
        reg.apply(&claude_ev("SessionStart", base_payload()), 0);
        // Stale but pid alive → kept.
        assert!(!reg.reap(STALE_AFTER_MS, |_| true));
        assert_eq!(reg.snapshot(0).sessions.len(), 1);
        // Stale and pid dead → dropped.
        assert!(reg.reap(STALE_AFTER_MS, |_| false));
        assert!(reg.is_empty());
    }

    #[test]
    fn fresh_session_survives_reaper_even_with_dead_pid() {
        let mut reg = FleetRegistry::new();
        reg.apply(&claude_ev("SessionStart", base_payload()), 0);
        assert!(!reg.reap(1000, |_| false));
        assert_eq!(reg.snapshot(0).sessions.len(), 1);
    }

    #[test]
    fn new_session_from_same_pid_evicts_the_old_row() {
        // `/clear`: same claude process, new session id, SessionEnd lost.
        let mut reg = FleetRegistry::new();
        reg.apply(&claude_ev("SessionStart", base_payload()), 0);
        reg.apply(
            &claude_ev("UserPromptSubmit", {
                let mut p = base_payload();
                p["prompt"] = serde_json::json!("old work");
                p
            }),
            1,
        );

        let mut fresh = base_payload();
        fresh["session_id"] = serde_json::json!("def-456");
        reg.apply(&claude_ev("SessionStart", fresh), 2);

        let snap = reg.snapshot(3);
        assert_eq!(snap.sessions.len(), 1, "old same-pid row evicted");
        assert_eq!(snap.sessions[0].session_id, "def-456");
    }

    #[test]
    fn sessions_from_different_pids_coexist() {
        let mut reg = FleetRegistry::new();
        reg.apply(&claude_ev("SessionStart", base_payload()), 0);

        let mut other = claude_ev("SessionStart", {
            let mut p = base_payload();
            p["session_id"] = serde_json::json!("other-terminal");
            p
        });
        other.ppid = Some(9999);
        reg.apply(&other, 1);

        assert_eq!(reg.snapshot(2).sessions.len(), 2);
    }

    #[test]
    fn opencode_sessions_share_one_pid_without_eviction() {
        // One OpenCode server process can host several sessions.
        let mut reg = FleetRegistry::new();
        for sid in ["oc-a", "oc-b"] {
            let mut p = base_payload();
            p["session_id"] = serde_json::json!(sid);
            reg.apply(&ev(FleetAgent::Opencode, "session-active", p), 0);
        }
        assert_eq!(reg.snapshot(1).sessions.len(), 2);
    }

    #[test]
    fn eviction_ignores_rows_without_matching_pid() {
        let mut reg = FleetRegistry::new();
        let mut unknown_pid = claude_ev("SessionStart", base_payload());
        unknown_pid.ppid = None;
        reg.apply(&unknown_pid, 0);

        let mut fresh = base_payload();
        fresh["session_id"] = serde_json::json!("new-sid");
        reg.apply(&claude_ev("SessionStart", fresh), 1);

        // The pid-less row can't be attributed to this process → kept (the
        // stale reaper handles it later).
        assert_eq!(reg.snapshot(2).sessions.len(), 2);
    }

    /// The shipped `@openai/codex` `notify` payload identifies its session with
    /// **`thread-id`** — there is no `session_id` and no `session-id`. This
    /// test pins the real wire format; before the manifest layer the extractor
    /// only accepted `session_id`/`session-id`, so every Codex event ever sent
    /// was dropped before the fold and no Codex row ever reached the island —
    /// while the settings card kept reporting a healthy install.
    ///
    /// Verified 2026-07-21 against `@openai/codex 0.144.4`.
    #[test]
    fn codex_notify_payload_with_thread_id_produces_a_row() {
        let mut reg = FleetRegistry::new();
        let payload = serde_json::json!({
            "type": "agent-turn-complete",
            "thread-id": "019f65d9-4119-7cb3-a504-9f746f0b252a",
            "turn-id": "019f65d9-4029-71e2-a4ed-bb08a0be08f1",
            "client": "cli",
            "cwd": "/Users/x/proj/api",
            "input-messages": ["rename foo to bar"],
            "last-assistant-message": "Renamed and verified"
        });
        let effect = reg.apply(&ev(FleetAgent::Codex, "agent-turn-complete", payload), 0);
        assert_eq!(effect, RegistryEffect::Updated);
        let s = only_session(&reg);
        assert_eq!(s.agent, FleetAgent::Codex);
        assert_eq!(s.session_id, "019f65d9-4119-7cb3-a504-9f746f0b252a");
        assert_eq!(s.project_name.as_deref(), Some("api"));
    }

    /// Codex's hooks system (`~/.codex/hooks.json`) — the integration that
    /// replaces `notify` — speaks the Claude-congruent vocabulary with a real
    /// `session_id`. Verified 2026-07-21 against a live third-party
    /// `hooks.json` on `@openai/codex 0.144.4`.
    #[test]
    fn codex_hook_events_fold_like_claude() {
        let mut reg = FleetRegistry::new();
        let start = serde_json::json!({
            "hook_event_name": "SessionStart",
            "session_id": "codex-hooked",
            "cwd": "/Users/x/proj/web",
            "source": "startup"
        });
        reg.apply(&ev(FleetAgent::Codex, "SessionStart", start), 0);
        let pre = serde_json::json!({
            "hook_event_name": "PreToolUse",
            "session_id": "codex-hooked",
            "tool_name": "Bash",
            "tool_input": { "command": "pnpm test" }
        });
        reg.apply(&ev(FleetAgent::Codex, "PreToolUse", pre), 1);

        let s = only_session(&reg);
        assert_eq!(s.session_id, "codex-hooked");
        assert_eq!(s.status, FleetStatus::Working);
        assert_eq!(s.tool_use_count, 1);
        assert_eq!(s.activity.as_ref().unwrap().tool_name, "Bash");
    }

    /// An event outside the agent's declared vocabulary must not materialize a
    /// session. It previously fell through the fold's catch-all arm and still
    /// reported `Updated`, so a typo'd hook name or a foreign POST created a
    /// phantom agent row that only the reaper could clear.
    #[test]
    fn unknown_event_names_do_not_create_rows() {
        let mut reg = FleetRegistry::new();
        let payload = serde_json::json!({ "session_id": "ghost", "cwd": "/p" });
        let effect = reg.apply(&ev(FleetAgent::ClaudeCode, "TotallyMadeUp", payload), 0);
        assert_eq!(effect, RegistryEffect::Ignored);
        assert!(reg.is_empty());
    }

    /// Vocabularies do not leak across agents: OpenCode's `session-active` is
    /// meaningless to Claude Code and must be dropped rather than folded.
    #[test]
    fn foreign_vocabulary_is_rejected_per_agent() {
        let mut reg = FleetRegistry::new();
        let payload = serde_json::json!({ "session_id": "x", "cwd": "/p" });
        assert_eq!(
            reg.apply(&ev(FleetAgent::ClaudeCode, "session-active", payload), 0),
            RegistryEffect::Ignored
        );
        assert!(reg.is_empty());
    }

    /// Hypothetical `session-id` spelling, kept because the extractor still
    /// accepts it. NOT the shape Codex actually emits — see
    /// `codex_notify_payload_with_thread_id_produces_a_row` for that.
    #[test]
    fn codex_turn_complete_maps_kebab_session_id_and_surfaces_turn() {
        let mut reg = FleetRegistry::new();
        let payload = serde_json::json!({
            "type": "agent-turn-complete",
            "session-id": "5973b6c0",
            "cwd": "/Users/x/proj/api",
            "input-messages": ["first ask", "rename foo to bar"],
            "last-assistant-message": "Renamed and verified"
        });
        let effect = reg.apply(&ev(FleetAgent::Codex, "agent-turn-complete", payload), 0);
        assert_eq!(effect, RegistryEffect::Updated);
        let s = only_session(&reg);
        assert_eq!(s.agent, FleetAgent::Codex);
        assert_eq!(s.session_id, "5973b6c0");
        assert_eq!(s.status, FleetStatus::Idle);
        assert_eq!(s.project_name.as_deref(), Some("api"));
        // Latest user input becomes the prompt; the reply is the activity line.
        assert_eq!(s.last_prompt.as_deref(), Some("rename foo to bar"));
        assert_eq!(s.activity.as_ref().unwrap().tool_name, "reply");
        assert_eq!(
            s.activity.as_ref().unwrap().detail.as_deref(),
            Some("Renamed and verified")
        );
    }

    #[test]
    fn codex_turn_complete_tolerates_missing_turn_fields() {
        let mut reg = FleetRegistry::new();
        let payload = serde_json::json!({
            "type": "agent-turn-complete",
            "session-id": "bare",
            "cwd": "/p"
        });
        reg.apply(&ev(FleetAgent::Codex, "agent-turn-complete", payload), 0);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Idle);
        assert!(s.last_prompt.is_none());
        assert!(s.activity.is_none());
    }

    #[test]
    fn opencode_events_map_to_working_and_idle() {
        let mut reg = FleetRegistry::new();
        let mut active = base_payload();
        active["session_id"] = serde_json::json!("oc-1");
        active["tool_name"] = serde_json::json!("Bash");
        active["tool_input"] = serde_json::json!({"command": "npm run build"});
        active["prompt"] = serde_json::json!("build the project");
        reg.apply(&ev(FleetAgent::Opencode, "session-active", active), 0);
        let s = only_session(&reg);
        assert_eq!(s.agent, FleetAgent::Opencode);
        assert_eq!(s.status, FleetStatus::Working);
        assert_eq!(s.activity.as_ref().unwrap().tool_name, "Bash");
        assert_eq!(
            s.activity.as_ref().unwrap().detail.as_deref(),
            Some("npm run build")
        );
        assert_eq!(s.last_prompt.as_deref(), Some("build the project"));

        let mut idle = base_payload();
        idle["session_id"] = serde_json::json!("oc-1");
        reg.apply(&ev(FleetAgent::Opencode, "session-idle", idle), 1);
        assert_eq!(only_session(&reg).status, FleetStatus::Idle);
        assert!(only_session(&reg).activity.is_none());
    }

    #[test]
    fn opencode_session_idle_releases_parked_permission() {
        let mut reg = FleetRegistry::new();
        let mut ask = base_payload();
        ask["session_id"] = serde_json::json!("oc-perm");
        ask["tool_name"] = serde_json::json!("bash");
        reg.apply(&ev(FleetAgent::Opencode, "PermissionRequest", ask), 0);
        assert_eq!(only_session(&reg).status, FleetStatus::WaitingPermission);

        // Answered in OpenCode's own TUI → the session just goes idle; the
        // parked permission must not keep the row (and the island) waiting.
        let mut idle = base_payload();
        idle["session_id"] = serde_json::json!("oc-perm");
        reg.apply(&ev(FleetAgent::Opencode, "session-idle", idle), 1);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Idle);
        assert!(s.pending_permission.is_none());
    }

    #[test]
    fn codex_turn_complete_clears_parked_plan_and_questions() {
        let mut reg = FleetRegistry::new();
        let mut pre = base_payload();
        pre["session_id"] = serde_json::json!("cx-1");
        pre["tool_name"] = serde_json::json!("AskUserQuestion");
        pre["tool_input"] = serde_json::json!({"questions": [{"question": "Q?"}]});
        reg.apply(&ev(FleetAgent::Codex, "PreToolUse", pre), 0);
        assert_eq!(only_session(&reg).status, FleetStatus::WaitingInput);

        let mut done = base_payload();
        done["session_id"] = serde_json::json!("cx-1");
        reg.apply(&ev(FleetAgent::Codex, "agent-turn-complete", done), 1);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Idle);
        assert!(s.pending_questions.is_empty());
        assert!(s.pending_plan.is_none());
    }

    #[test]
    fn snapshot_sorts_most_recent_first() {
        let mut reg = FleetRegistry::new();
        // Distinct pids: two terminals (same-pid rows would evict each other).
        let mut p1 = base_payload();
        p1["session_id"] = serde_json::json!("s-old");
        let mut e1 = claude_ev("SessionStart", p1);
        e1.ppid = Some(1111);
        reg.apply(&e1, 100);
        let mut p2 = base_payload();
        p2["session_id"] = serde_json::json!("s-new");
        let mut e2 = claude_ev("SessionStart", p2);
        e2.ppid = Some(2222);
        reg.apply(&e2, 200);
        let snap = reg.snapshot(300);
        assert_eq!(snap.sessions[0].session_id, "s-new");
        assert_eq!(snap.sessions[1].session_id, "s-old");
        assert_eq!(snap.generated_at, 300);
    }

    #[test]
    fn session_serializes_camel_case_and_kebab_enums() {
        let mut reg = FleetRegistry::new();
        reg.apply(&claude_ev("SessionStart", base_payload()), 0);
        let json = serde_json::to_value(reg.snapshot(0)).unwrap();
        let s = &json["sessions"][0];
        assert_eq!(s["agent"], "claude-code");
        assert_eq!(s["status"], "idle");
        assert!(s.get("sessionId").is_some());
        assert!(s.get("lastEventAt").is_some());
        assert!(s.get("projectName").is_some());
        assert!(s["capabilities"].get("openTranscript").is_some());
        assert_eq!(s["capabilityDescriptorVersion"], 1);
        assert_eq!(s["capabilityDescriptorSource"], "builtin:claude-code");
    }

    /// The manifest is a ceiling, and a payload cannot raise it. OpenCode
    /// declares `open_transcript: false` / `focus_terminal: false`, yet its
    /// events routinely carry a `transcript_path` and a terminal env — which is
    /// exactly how the old "turn it on when the field shows up" code handed the
    /// island two buttons OpenCode cannot serve.
    #[test]
    fn manifest_false_capability_cannot_be_switched_on_by_a_payload() {
        use super::super::terminal::{TerminalApp, TerminalSource};

        let mut payload = base_payload();
        payload["session_id"] = serde_json::json!("oc-cap");
        let mut event = ev(FleetAgent::Opencode, "session-active", payload);
        event.env.insert("TERM_PROGRAM".into(), "iTerm.app".into());

        let mut reg = FleetRegistry::new();
        reg.apply(&event, 0);
        let s = only_session(&reg);
        // The payload carried a transcript path and the env classified a
        // terminal — both denied by the manifest.
        assert!(s.transcript_path.is_some(), "payload did carry the field");
        assert!(s.terminal.is_some(), "env did classify a terminal");
        assert!(!s.capabilities.open_transcript);
        assert!(!s.capabilities.focus_terminal);
        // Static provider identity is not runtime evidence for optional SDK
        // controls; OpenCode stays conservative until its plugin probes them.
        assert!(!s.capabilities.send_message);
        assert!(s.capabilities.approve_permission);

        reg.apply(
            &ev(
                FleetAgent::Opencode,
                "Capabilities",
                serde_json::json!({"sendMessage": true}),
            ),
            1,
        );
        assert!(only_session(&reg).capabilities.send_message);

        // The out-of-band terminal attach path (parent-chain fallback) narrows
        // the same way — a row that never saw a terminal env still must not
        // gain focus from a manifest that denies it.
        let mut bare = base_payload();
        bare["session_id"] = serde_json::json!("oc-bare");
        let mut reg = FleetRegistry::new();
        reg.apply(&ev(FleetAgent::Opencode, "session-active", bare), 0);
        assert!(reg.set_terminal(
            FleetAgent::Opencode,
            "oc-bare",
            TerminalSource {
                app: TerminalApp::Ghostty,
                label: "Ghostty".into(),
                session_ref: None,
            },
        ));
        let s = only_session(&reg);
        assert!(s.terminal.is_some());
        assert!(!s.capabilities.focus_terminal);
    }

    /// The other direction: a declared `true` still needs its runtime evidence,
    /// so the island never renders a transcript button before a transcript
    /// path exists.
    #[test]
    fn declared_capability_still_waits_for_its_runtime_evidence() {
        let mut reg = FleetRegistry::new();
        let payload = serde_json::json!({ "session_id": SID, "cwd": "/Users/x/proj" });
        reg.apply(&claude_ev("SessionStart", payload), 0);
        let s = only_session(&reg);
        assert!(!s.capabilities.open_transcript, "no transcript path yet");
        assert!(!s.capabilities.focus_terminal, "no terminal classified yet");
        // Not narrowed by anything → straight from the manifest.
        assert!(s.capabilities.approve_permission);
        assert!(!s.capabilities.send_message);

        // The transcript path arrives on a later event and the button appears.
        reg.apply(&claude_ev("UserPromptSubmit", base_payload()), 1);
        assert!(only_session(&reg).capabilities.open_transcript);
    }

    #[test]
    fn terminal_fallback_helpers() {
        use super::super::terminal::{TerminalApp, TerminalSource};
        let mut reg = FleetRegistry::new();
        reg.apply(&claude_ev("SessionStart", base_payload()), 0);

        // Env carried no terminal marker → fallback is needed, pid returned.
        assert_eq!(
            reg.needs_terminal_fallback(FleetAgent::ClaudeCode, SID),
            Some(1234)
        );
        assert!(reg.session_terminal(FleetAgent::ClaudeCode, SID).is_none());

        let terminal = TerminalSource {
            app: TerminalApp::Ghostty,
            label: "Ghostty".into(),
            session_ref: None,
        };
        assert!(reg.set_terminal(FleetAgent::ClaudeCode, SID, terminal.clone()));
        // Now present → no fallback, second set is a no-op.
        assert!(reg
            .needs_terminal_fallback(FleetAgent::ClaudeCode, SID)
            .is_none());
        assert!(!reg.set_terminal(FleetAgent::ClaudeCode, SID, terminal.clone()));
        assert_eq!(
            reg.session_terminal(FleetAgent::ClaudeCode, SID)
                .unwrap()
                .app,
            TerminalApp::Ghostty
        );
        let s = only_session(&reg);
        // Capability is platform-aware: advertised exactly when the current
        // OS can raise this terminal (Ghostty: macOS/Linux yes, Windows no).
        assert_eq!(
            s.capabilities.focus_terminal,
            super::super::control::can_focus(TerminalApp::Ghostty)
        );

        // Unknown session → None everywhere.
        assert!(reg
            .needs_terminal_fallback(FleetAgent::Codex, "nope")
            .is_none());
        assert!(reg.session_terminal(FleetAgent::Codex, "nope").is_none());
        assert!(!reg.set_terminal(FleetAgent::Codex, "nope", terminal));
    }

    #[test]
    fn env_classified_session_skips_fallback() {
        let mut ev = claude_ev("SessionStart", base_payload());
        ev.env.insert("TERM_PROGRAM".into(), "iTerm.app".into());
        let mut reg = FleetRegistry::new();
        reg.apply(&ev, 0);
        // Classified from env at apply time → no fallback pid.
        assert!(reg
            .needs_terminal_fallback(FleetAgent::ClaudeCode, SID)
            .is_none());
        assert!(reg.session_terminal(FleetAgent::ClaudeCode, SID).is_some());
    }

    #[test]
    fn tool_detail_truncates_long_commands() {
        let long = "x".repeat(400);
        let payload = serde_json::json!({"tool_input": {"command": long}});
        let detail = tool_detail(&payload, "Bash").unwrap();
        assert!(detail.chars().count() == 161 && detail.ends_with('…'));
    }
}
