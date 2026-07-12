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
}

impl FleetAgent {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "claude-code" => Some(Self::ClaudeCode),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::Opencode),
            _ => None,
        }
    }
}

/// Lifecycle state of one monitored session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FleetStatus {
    Idle,
    Working,
    WaitingInput,
    WaitingPermission,
    PlanPending,
    Ended,
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

/// A parked AskUserQuestion the user must answer in the agent's own terminal.
/// Display-only: the hook path cannot answer it, so the island renders the
/// question and its options while the session sits in `WaitingInput`.
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
}

/// One monitored external session — the island row DTO.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSession {
    pub agent: FleetAgent,
    pub session_id: String,
    pub status: FleetStatus,
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
    /// Live subagents (Task tool), foreground and background.
    pub subagents: Vec<FleetSubagent>,
    pub capabilities: FleetCapabilities,
    /// Epoch ms of the first event seen for this session.
    pub started_at: u64,
    /// Epoch ms of the most recent event.
    pub last_event_at: u64,
    /// Set when the session transitions to `Ended`; used for linger cleanup.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
}

/// Full snapshot emitted to the frontend on every change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSnapshot {
    pub sessions: Vec<FleetSession>,
    pub generated_at: u64,
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
    /// Event was unusable (no session id, unknown shape) — nothing to emit.
    Ignored,
}

/// The registry proper. Owned by `FleetRuntime` behind a mutex.
#[derive(Debug, Default)]
pub struct FleetRegistry {
    sessions: HashMap<(FleetAgent, String), FleetSession>,
}

impl FleetRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// Fold one hook event into the registry.
    pub fn apply(&mut self, ev: &FleetEvent, now_ms: u64) -> RegistryEffect {
        let Some(session_id) = extract_session_id(ev) else {
            return RegistryEffect::Ignored;
        };

        let key = (ev.agent, session_id.clone());

        // One Claude Code / Codex process runs one interactive session at a
        // time, but `/clear` (and `--resume`) mint a NEW session id inside the
        // same pid — and the old session's `SessionEnd` hook is fail-open
        // (0.4 s curl), so it can simply be lost. Without eviction the stale
        // row survives forever: the reaper keeps any row whose agent pid is
        // alive, and the pid IS alive — it's now running the new session. So
        // when a new session id shows up for a pid we already track, drop that
        // pid's other rows. OpenCode is exempt: one server process can
        // legitimately host several concurrent sessions.
        if !self.sessions.contains_key(&key) && ev.agent != FleetAgent::Opencode {
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
            entry.capabilities.open_transcript = true;
        }
        if let Some(mode) = payload_str(&ev.payload, "permission_mode") {
            entry.permission_mode = Some(mode);
        }
        if let Some(model) = payload_str(&ev.payload, "model") {
            entry.model = Some(model);
        }
        if entry.terminal.is_none() && !ev.env.is_empty() {
            entry.terminal = super::terminal::classify_terminal(&ev.env);
            // Platform-aware: only advertise focus when the current OS knows
            // how to raise this terminal (no silently-dead row buttons).
            entry.capabilities.focus_terminal = entry
                .terminal
                .as_ref()
                .is_some_and(|t| super::control::can_focus(t.app));
        }

        match ev.event.as_str() {
            "SessionStart" => {
                entry.status = FleetStatus::Idle;
                entry.ended_at = None;
            }
            "UserPromptSubmit" => {
                entry.status = FleetStatus::Working;
                if let Some(prompt) = payload_str(&ev.payload, "prompt") {
                    entry.last_prompt = Some(prompt);
                }
                entry.activity = None;
                // A new turn supersedes anything parked for the previous one;
                // background subagents keep running across turns.
                entry.pending_plan = None;
                entry.pending_questions.clear();
                entry.subagents.retain(|s| s.background);
            }
            "PreToolUse" => {
                let tool = payload_str(&ev.payload, "tool_name");
                if tool.as_deref().is_some_and(is_exit_plan_tool) {
                    entry.status = FleetStatus::PlanPending;
                    entry.activity = None;
                    entry.pending_plan = extract_plan(&ev.payload);
                } else if tool.as_deref().is_some_and(is_ask_user_question_tool) {
                    // The agent is blocked on a terminal answer — surface the
                    // question(s) instead of a generic "working" line.
                    entry.status = FleetStatus::WaitingInput;
                    entry.activity = None;
                    entry.pending_questions = extract_questions(&ev.payload);
                } else {
                    entry.status = FleetStatus::Working;
                    // Another tool running means the plan/question moment passed.
                    entry.pending_plan = None;
                    entry.pending_questions.clear();
                    if tool.as_deref().is_some_and(is_task_tool) {
                        push_subagent(entry, &ev.payload, now_ms);
                    }
                    entry.activity = tool.map(|tool_name| FleetActivity {
                        detail: tool_detail(&ev.payload, &tool_name),
                        tool_name,
                    });
                }
            }
            "PostToolUse" => {
                // Keep Working; the activity line stays until the next tool
                // or Stop so slow model turns still show the last action.
                entry.status = FleetStatus::Working;
                // The tool returned — a parked plan approval / question was
                // answered in the terminal.
                entry.pending_plan = None;
                entry.pending_questions.clear();
                if payload_str(&ev.payload, "tool_name")
                    .as_deref()
                    .is_some_and(is_task_tool)
                {
                    finish_task_subagent(entry, &ev.payload);
                }
            }
            "Notification" => {
                match payload_str(&ev.payload, "notification_type").as_deref() {
                    Some("idle_prompt") => entry.status = FleetStatus::WaitingInput,
                    Some("permission_prompt") => {
                        // Only a display hint — the real approval flow arrives
                        // via the PermissionRequest long-poll (P3).
                        if entry.pending_permission.is_none() {
                            entry.status = FleetStatus::WaitingPermission;
                        }
                    }
                    _ => {}
                }
            }
            "PermissionRequest" => {
                let request_id = permission_request_id(&ev.agent, &session_id, now_ms);
                let tool_name = payload_str(&ev.payload, "tool_name");
                entry.status = FleetStatus::WaitingPermission;
                entry.pending_permission = Some(PendingPermission {
                    request_id: request_id.clone(),
                    detail: tool_name
                        .as_deref()
                        .and_then(|t| tool_detail(&ev.payload, t)),
                    tool_name,
                    requested_at: now_ms,
                });
                entry.capabilities.approve_permission = true;
                return RegistryEffect::PermissionRequested { request_id };
            }
            // A clean turn end and an API-error turn end both return the row to
            // idle and clear any in-flight activity / parked permission.
            // Background subagents survive the turn; foreground ones can't.
            "Stop" | "StopFailure" => {
                entry.status = FleetStatus::Idle;
                entry.activity = None;
                entry.pending_permission = None;
                entry.pending_plan = None;
                entry.pending_questions.clear();
                entry.subagents.retain(|s| s.background);
            }
            // A subagent finished. The payload carries no correlation id, so
            // retire the oldest foreground entry (its PostToolUse follows and
            // no-ops); a background-only list retires FIFO.
            "SubagentStop" => {
                if let Some(pos) = entry.subagents.iter().position(|s| !s.background) {
                    entry.subagents.remove(pos);
                } else if !entry.subagents.is_empty() {
                    entry.subagents.remove(0);
                }
            }
            // Context compaction: show a brief "compacting" beat (kept Working so
            // the row doesn't flash idle mid-turn). `trigger` is `manual`/`auto`.
            "PreCompact" => {
                entry.status = FleetStatus::Working;
                entry.activity = Some(FleetActivity {
                    tool_name: "Compacting".to_string(),
                    detail: payload_str(&ev.payload, "trigger"),
                });
            }
            // Compaction done — drop the transient activity; the next tool call
            // or Stop drives the row from here.
            "PostCompact" => {
                entry.status = FleetStatus::Working;
                entry.activity = None;
            }
            // A denied permission (auto-mode or an out-of-band "no") releases the
            // parked request so the row leaves the waiting state.
            "PermissionDenied" => {
                entry.pending_permission = None;
                if entry.status == FleetStatus::WaitingPermission {
                    entry.status = FleetStatus::Working;
                }
            }
            "agent-turn-complete" => {
                // Codex's `notify` program fires once per completed turn with
                // the turn's inputs + reply (kebab-case argv JSON). It is the
                // only lifecycle signal on the notify path, so lean on it to
                // populate the row: latest user input as the prompt, the
                // assistant reply as the trailing activity line.
                entry.status = FleetStatus::Idle;
                entry.pending_permission = None;
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
            "SessionEnd" => {
                entry.status = FleetStatus::Ended;
                entry.ended_at = Some(now_ms);
                entry.activity = None;
                entry.pending_permission = None;
                entry.pending_plan = None;
                entry.pending_questions.clear();
                entry.subagents.clear();
            }
            // OpenCode plugin events (normalized in `cognia-fleet.js` so we
            // never depend on OpenCode's internal bus schema).
            "session-active" => {
                entry.status = FleetStatus::Working;
                // OpenCode sessions are controllable: the plugin can inject a
                // prompt via its bound client (see fleet/opencode.rs poll loop).
                entry.capabilities.send_message = true;
                entry.activity =
                    payload_str(&ev.payload, "tool_name").map(|tool_name| FleetActivity {
                        detail: tool_detail(&ev.payload, &tool_name),
                        tool_name,
                    });
                if let Some(prompt) = payload_str(&ev.payload, "prompt") {
                    entry.last_prompt = Some(prompt);
                }
            }
            "session-idle" => {
                entry.status = FleetStatus::Idle;
                entry.activity = None;
            }
            // Subagent events only bump last_event_at (already done above).
            _ => {}
        }

        RegistryEffect::Updated
    }

    /// Terminal info for one session (focus action lookup).
    pub fn session_terminal(&self, agent: FleetAgent, session_id: &str) -> Option<TerminalSource> {
        self.sessions
            .get(&(agent, session_id.to_string()))
            .and_then(|s| s.terminal.clone())
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
        session.capabilities.focus_terminal = super::control::can_focus(terminal.app);
        session.terminal = Some(terminal);
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

    /// Drop ended rows past their linger window and stale rows whose agent
    /// process is gone. `pid_alive` is injected so tests don't need real pids.
    pub fn reap(&mut self, now_ms: u64, pid_alive: impl Fn(u32) -> bool) -> bool {
        let before = self.sessions.len();
        self.sessions.retain(|_, s| {
            if let Some(ended_at) = s.ended_at {
                return now_ms.saturating_sub(ended_at) < ENDED_LINGER_MS;
            }
            if now_ms.saturating_sub(s.last_event_at) >= STALE_AFTER_MS {
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
        FleetSnapshot {
            sessions,
            generated_at: now_ms,
        }
    }
}

fn new_session(
    agent: FleetAgent,
    session_id: String,
    ev: &FleetEvent,
    now_ms: u64,
) -> FleetSession {
    FleetSession {
        agent,
        session_id,
        status: FleetStatus::Idle,
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
        subagents: Vec::new(),
        capabilities: FleetCapabilities::default(),
        started_at: now_ms,
        last_event_at: now_ms,
        ended_at: None,
    }
}

/// Session id lives at `payload.session_id` for Claude/Codex hooks and
/// `payload["session-id"]` for the Codex notify program.
fn extract_session_id(ev: &FleetEvent) -> Option<String> {
    payload_str(&ev.payload, "session_id").or_else(|| payload_str(&ev.payload, "session-id"))
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

        // Answering in the terminal → PostToolUse clears and resumes working.
        let mut post = base_payload();
        post["tool_name"] = serde_json::json!("AskUserQuestion");
        reg.apply(&claude_ev("PostToolUse", post), 1);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Working);
        assert!(s.pending_questions.is_empty());
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
        bg["tool_input"] =
            serde_json::json!({"description": "watcher", "run_in_background": true});
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
        task["tool_input"] =
            serde_json::json!({"description": "d", "subagent_type": "Explore", "run_in_background": true});
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
    fn idle_prompt_notification_marks_waiting_input() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["notification_type"] = serde_json::json!("idle_prompt");
        reg.apply(&claude_ev("Notification", payload), 0);
        assert_eq!(only_session(&reg).status, FleetStatus::WaitingInput);
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
    fn stop_returns_to_idle_and_clears_activity() {
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("Bash");
        payload["tool_input"] = serde_json::json!({"command": "ls"});
        reg.apply(&claude_ev("PreToolUse", payload), 0);
        reg.apply(&claude_ev("Stop", base_payload()), 1);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Idle);
        assert!(s.activity.is_none());
    }

    #[test]
    fn stop_failure_also_returns_to_idle() {
        // An API-error turn end must clear "working" like a clean Stop, else the
        // row is stranded working forever.
        let mut reg = FleetRegistry::new();
        let mut payload = base_payload();
        payload["tool_name"] = serde_json::json!("Bash");
        payload["tool_input"] = serde_json::json!({"command": "ls"});
        reg.apply(&claude_ev("PreToolUse", payload), 0);
        reg.apply(&claude_ev("StopFailure", base_payload()), 1);
        let s = only_session(&reg);
        assert_eq!(s.status, FleetStatus::Idle);
        assert!(s.activity.is_none());
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
