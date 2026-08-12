//! Per-agent integration manifests — the declarative seam that replaces the
//! `match`/`if` chains previously scattered across the fleet module.
//!
//! Every supported coding agent reports lifecycle events in its own dialect:
//! Claude Code says `PreToolUse`, Gemini CLI says `BeforeTool`, the retired
//! Codex `notify` program said `agent-turn-complete`, OpenCode says
//! `session-active`. They also disagree on where the session id lives, on the
//! shape of a blocking decision reply, and on whether one process may host
//! several concurrent sessions.
//!
//! Previously each of those differences was a separate hardcoded branch, so
//! adding an agent meant ~20 edits spread across the crate — and a wrong guess
//! failed *silently*: the Codex `notify` payload never carried `session_id`
//! (its field is `thread-id`), so every Codex event was dropped at the door
//! while the settings UI kept reporting a healthy install.
//!
//! A manifest states those differences as data:
//!
//! - [`AgentManifest::session_id_keys`] — payload keys to try, in order.
//! - [`AgentManifest::event_map`] — the agent's event names, normalized.
//! - [`AgentManifest::capabilities`] — the *ceiling* of what the island may do
//!   with this agent's sessions, declared up front and never inferred from
//!   "this payload happened to carry a field". Runtime probes may narrow it
//!   (see `FleetSession::refresh_capabilities`), never widen it.
//! - [`AgentManifest::decision_shape`] — how a blocking reply is encoded, via
//!   [`AgentManifest::permission_decision`] / [`AgentManifest::question_decision`].
//! - [`AgentManifest::multi_session_host`] / [`AgentManifest::answers_questions`]
//!   — the two behaviors that used to be `agent != FleetAgent::Opencode` tests.
//!
//! The registry fold then only ever matches on [`NormalizedEvent`], so a new
//! agent is a manifest plus an installer — not a fold rewrite.

use super::registry::{FleetAgent, FleetCapabilities};

/// The single event vocabulary the registry folds over. Each agent's raw event
/// names are mapped onto this by its manifest, so the fold never sees a
/// vendor-specific string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NormalizedEvent {
    /// Runtime SDK feature probe. Unlike lifecycle events this is agent-wide
    /// and carries no session id; the registry intersects it with the static
    /// manifest ceiling before enabling native controls.
    Capabilities,
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    Notification,
    PermissionRequest,
    PermissionDenied,
    Stop,
    StopFailure,
    SubagentStart,
    SubagentStop,
    PreCompact,
    PostCompact,
    SessionEnd,
    /// A turn finished and the event carries the turn's payload (the retired
    /// Codex `notify` `agent-turn-complete`: latest user input + assistant
    /// reply). Distinct from [`Self::SessionIdle`] because it is a per-turn
    /// marker the fold counts; a bare idle signal is not.
    TurnComplete,
    /// The agent went idle with no turn payload (OpenCode `session-idle`).
    /// Releases anything parked but does not count a turn — OpenCode gives no
    /// guarantee this fires exactly once per turn.
    SessionIdle,
    /// The agent reports it is actively working (OpenCode `session-active`).
    SessionActive,
    QuestionAsked,
}

/// How an agent expects a blocking hook's decision to be encoded on stdout.
/// Claude Code, Codex hooks and Factory Droid share the `hookSpecificOutput`
/// envelope; OpenCode wants a bare `{status}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionShape {
    /// `{"hookSpecificOutput":{"hookEventName":…,"permissionDecision":…}}`
    HookSpecificOutput,
    /// `{"status":"allow"|"deny"}`
    OpencodeStatus,
}

/// One agent's contract with the fleet ingress.
#[derive(Debug, Clone, Copy)]
pub struct AgentManifest {
    pub agent: FleetAgent,
    /// Version of this built-in capability descriptor. Increment whenever the
    /// declared control contract changes so consumers can detect drift.
    pub descriptor_version: u32,
    /// Stable lineage identifier for diagnostics and persisted projections.
    pub descriptor_source: &'static str,
    /// Payload keys to try, in order, when extracting the session id. Ordered
    /// most-specific first so a payload carrying both keys resolves stably.
    pub session_id_keys: &'static [&'static str],
    /// Raw event name → normalized. Unlisted names are ignored outright
    /// (they must never create a session row).
    pub event_map: &'static [(&'static str, NormalizedEvent)],
    /// What the island may do with this agent's sessions. Declared, not
    /// inferred — a capability that isn't wired end-to-end must be `false`
    /// here rather than flickering on when some payload happens to carry a
    /// field.
    pub capabilities: FleetCapabilities,
    pub decision_shape: DecisionShape,
    /// True when one OS process legitimately hosts several concurrent
    /// sessions, which exempts it from same-pid row eviction. (`/clear` mints
    /// a new session id inside the same pid for single-session agents, so
    /// their stale rows must be evicted; an OpenCode server's rows must not.)
    pub multi_session_host: bool,
    /// True when the integration has an answer channel for AskUserQuestion.
    /// Hook-based agents park a wait-mode `PermissionRequest`; OpenCode bridges
    /// its native Question API through the same normalized event contract.
    pub answers_questions: bool,
}

impl AgentManifest {
    /// Normalize a raw event name. `None` means "not part of this agent's
    /// vocabulary" — the caller must drop the event rather than fold it.
    pub fn normalize(&self, raw: &str) -> Option<NormalizedEvent> {
        self.event_map
            .iter()
            .find(|(name, _)| *name == raw)
            .map(|(_, ev)| *ev)
    }

    /// Pull the session id out of a raw hook payload using this agent's key
    /// order. Empty strings are treated as absent.
    pub fn session_id(&self, payload: &serde_json::Value) -> Option<String> {
        self.session_id_keys.iter().find_map(|key| {
            payload
                .get(*key)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
    }

    /// Encode a blocking permission answer in this agent's reply format.
    /// `behavior` is the already-stringified `allow` / `deny`. The routes layer
    /// calls this instead of branching on [`FleetAgent`] — the shape is
    /// declared by [`Self::decision_shape`], so adding an agent never touches
    /// the ingress.
    pub fn permission_decision(&self, behavior: &str) -> serde_json::Value {
        match self.decision_shape {
            DecisionShape::HookSpecificOutput => serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": { "behavior": behavior }
                }
            }),
            DecisionShape::OpencodeStatus => serde_json::json!({ "status": behavior }),
        }
    }

    /// Encode an AskUserQuestion answer — the same blocking reply as an `allow`
    /// permission, carrying the built `updatedInput` (`{questions, answers}`)
    /// so the tool resolves with the island's selection instead of prompting in
    /// the terminal.
    ///
    /// `None` means "this agent has no answer channel", which is a guard rather
    /// than a comment: the registry only emits `QuestionRequested` for a
    /// manifest with [`Self::answers_questions`]. A `None` at the ingress
    /// therefore fails open (empty `204`) instead of shipping an envelope the
    /// agent cannot parse.
    pub fn question_decision(&self, updated_input: serde_json::Value) -> Option<serde_json::Value> {
        if !self.answers_questions {
            return None;
        }
        match self.decision_shape {
            DecisionShape::HookSpecificOutput => Some(serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "allow",
                        "updatedInput": updated_input
                    }
                }
            })),
            DecisionShape::OpencodeStatus => Some(serde_json::json!({
                "status": "allow",
                "updatedInput": updated_input
            })),
        }
    }
}

/// Claude Code — `~/.claude/settings.json` hooks. The reference integration:
/// every event, a wait-mode `PermissionRequest`, and full plan/question answering.
const CLAUDE_CODE: AgentManifest = AgentManifest {
    agent: FleetAgent::ClaudeCode,
    descriptor_version: 1,
    descriptor_source: "builtin:claude-code",
    session_id_keys: &["session_id"],
    event_map: &[
        ("SessionStart", NormalizedEvent::SessionStart),
        ("UserPromptSubmit", NormalizedEvent::UserPromptSubmit),
        ("PreToolUse", NormalizedEvent::PreToolUse),
        ("PostToolUse", NormalizedEvent::PostToolUse),
        ("Notification", NormalizedEvent::Notification),
        ("PermissionRequest", NormalizedEvent::PermissionRequest),
        ("PermissionDenied", NormalizedEvent::PermissionDenied),
        ("Stop", NormalizedEvent::Stop),
        ("StopFailure", NormalizedEvent::StopFailure),
        ("SubagentStart", NormalizedEvent::SubagentStart),
        ("SubagentStop", NormalizedEvent::SubagentStop),
        ("PreCompact", NormalizedEvent::PreCompact),
        ("PostCompact", NormalizedEvent::PostCompact),
        ("SessionEnd", NormalizedEvent::SessionEnd),
    ],
    capabilities: FleetCapabilities {
        approve_permission: true,
        send_message: false,
        focus_terminal: true,
        open_transcript: true,
        interrupt: true,
    },
    decision_shape: DecisionShape::HookSpecificOutput,
    multi_session_host: false,
    answers_questions: true,
};

/// Codex CLI — `~/.codex/hooks.json`.
///
/// **This replaces the `notify` integration, which never worked.** The shipped
/// `notify` payload carries `thread-id` / `turn-id` / `cwd` / `client` /
/// `input-messages` / `last-assistant-message` and *no* `session_id`, so every
/// event was dropped before it reached the fold. Codex's hooks system is
/// event-for-event congruent with Claude Code's, including a genuine blocking
/// `PermissionRequest`.
///
/// `thread-id` is kept as a session-id fallback so a machine still running the
/// old `notify` program degrades to observable rather than invisible.
///
/// Install caveat (handled by the installer, not here): Codex gates hooks
/// behind a persisted `trusted_hash` that the user grants in the TUI, so a
/// freshly written `hooks.json` does not fire until trusted.
const CODEX: AgentManifest = AgentManifest {
    agent: FleetAgent::Codex,
    descriptor_version: 1,
    descriptor_source: "builtin:codex",
    session_id_keys: &["session_id", "session-id", "thread-id", "thread_id"],
    event_map: &[
        ("SessionStart", NormalizedEvent::SessionStart),
        ("UserPromptSubmit", NormalizedEvent::UserPromptSubmit),
        ("PreToolUse", NormalizedEvent::PreToolUse),
        ("PostToolUse", NormalizedEvent::PostToolUse),
        ("PermissionRequest", NormalizedEvent::PermissionRequest),
        ("Stop", NormalizedEvent::Stop),
        ("SessionEnd", NormalizedEvent::SessionEnd),
        ("SubagentStart", NormalizedEvent::SubagentStart),
        ("SubagentStop", NormalizedEvent::SubagentStop),
        ("PreCompact", NormalizedEvent::PreCompact),
        ("PostCompact", NormalizedEvent::PostCompact),
        // Retired `notify` program — kept so an un-migrated machine still
        // reports turn completions instead of going dark.
        ("agent-turn-complete", NormalizedEvent::TurnComplete),
    ],
    capabilities: FleetCapabilities {
        approve_permission: true,
        send_message: false,
        focus_terminal: true,
        open_transcript: true,
        interrupt: true,
    },
    decision_shape: DecisionShape::HookSpecificOutput,
    multi_session_host: false,
    answers_questions: true,
};

/// OpenCode — a JS plugin in `~/.config/opencode/plugin/`. One server process
/// hosts many sessions, and it is the only agent with a reverse command
/// channel (injected prompts), but it has no transcript path and no
/// AskUserQuestion gate.
const OPENCODE: AgentManifest = AgentManifest {
    agent: FleetAgent::Opencode,
    descriptor_version: 1,
    descriptor_source: "builtin:opencode",
    session_id_keys: &["session_id", "session-id"],
    event_map: &[
        ("Capabilities", NormalizedEvent::Capabilities),
        ("session-active", NormalizedEvent::SessionActive),
        ("session-idle", NormalizedEvent::SessionIdle),
        ("PermissionRequest", NormalizedEvent::PermissionRequest),
        ("question.asked", NormalizedEvent::QuestionAsked),
    ],
    capabilities: FleetCapabilities {
        approve_permission: true,
        send_message: true,
        focus_terminal: false,
        open_transcript: false,
        // Delivered through the bound OpenCode client, never an OS signal to
        // the shared multi-session server process.
        interrupt: true,
    },
    decision_shape: DecisionShape::OpencodeStatus,
    multi_session_host: true,
    answers_questions: true,
};

/// Cognia-managed AgentTeam sessions are inserted directly as a Fleet read
/// model, not through hook ingress. Their controls remain on AgentTeam.
const COGNIA: AgentManifest = AgentManifest {
    agent: FleetAgent::Cognia,
    descriptor_version: 1,
    descriptor_source: "builtin:cognia",
    session_id_keys: &[],
    event_map: &[],
    capabilities: FleetCapabilities {
        approve_permission: false,
        send_message: false,
        focus_terminal: false,
        open_transcript: false,
        interrupt: false,
    },
    decision_shape: DecisionShape::HookSpecificOutput,
    multi_session_host: true,
    answers_questions: false,
};

/// Every manifest, in display order.
pub const MANIFESTS: &[AgentManifest] = &[CLAUDE_CODE, CODEX, OPENCODE, COGNIA];

/// The manifest for an agent. Total — every [`FleetAgent`] variant has one,
/// which the `every_agent_has_a_manifest` test pins.
pub fn manifest_for(agent: FleetAgent) -> &'static AgentManifest {
    MANIFESTS
        .iter()
        .find(|m| m.agent == agent)
        .expect("every FleetAgent variant must have a manifest")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `manifest_for` panics on a missing entry, so this pins the totality of
    /// the lookup for every variant a hook envelope can deserialize into.
    #[test]
    fn every_agent_has_a_manifest() {
        for agent in [
            FleetAgent::ClaudeCode,
            FleetAgent::Codex,
            FleetAgent::Opencode,
            FleetAgent::Cognia,
        ] {
            assert_eq!(manifest_for(agent).agent, agent);
            assert!(manifest_for(agent).descriptor_version > 0);
            assert!(manifest_for(agent)
                .descriptor_source
                .starts_with("builtin:"));
        }
    }

    #[test]
    fn manifests_are_unique_per_agent() {
        let mut seen = Vec::new();
        for m in MANIFESTS {
            assert!(
                !seen.contains(&m.agent),
                "duplicate manifest for {:?}",
                m.agent
            );
            seen.push(m.agent);
        }
    }

    /// The regression that matters most: the shipped Codex `notify` payload has
    /// no `session_id`, only `thread-id`. Before the manifest layer this
    /// returned `None` and the event was dropped at the door — silently, for
    /// every Codex session that ever ran.
    #[test]
    fn codex_session_id_falls_back_to_thread_id() {
        let payload = json!({
            "thread-id": "019f65d9-4119-7cb3-a504-9f746f0b252a",
            "turn-id": "turn-1",
            "cwd": "/tmp/project",
            "last-assistant-message": "done",
        });
        assert_eq!(
            manifest_for(FleetAgent::Codex).session_id(&payload),
            Some("019f65d9-4119-7cb3-a504-9f746f0b252a".to_string())
        );
    }

    /// Codex hooks carry a real `session_id`, which must win over the
    /// `notify`-era fallback when both are present.
    #[test]
    fn codex_prefers_session_id_over_thread_id() {
        let payload = json!({ "session_id": "canonical", "thread-id": "legacy" });
        assert_eq!(
            manifest_for(FleetAgent::Codex).session_id(&payload),
            Some("canonical".to_string())
        );
    }

    #[test]
    fn empty_session_id_is_treated_as_absent() {
        let payload = json!({ "session_id": "", "thread-id": "fallback" });
        assert_eq!(
            manifest_for(FleetAgent::Codex).session_id(&payload),
            Some("fallback".to_string())
        );
        assert_eq!(
            manifest_for(FleetAgent::ClaudeCode).session_id(&json!({ "session_id": "" })),
            None
        );
    }

    #[test]
    fn unknown_events_do_not_normalize() {
        // An unlisted name must be dropped, not folded — folding one used to
        // create a phantom session row.
        assert_eq!(
            manifest_for(FleetAgent::ClaudeCode).normalize("NotAnEvent"),
            None
        );
        // Claude's vocabulary is not OpenCode's.
        assert_eq!(
            manifest_for(FleetAgent::ClaudeCode).normalize("session-active"),
            None
        );
        assert_eq!(
            manifest_for(FleetAgent::Opencode).normalize("PreToolUse"),
            None
        );
    }

    #[test]
    fn codex_normalizes_both_hook_and_legacy_notify_events() {
        let codex = manifest_for(FleetAgent::Codex);
        assert_eq!(
            codex.normalize("PreToolUse"),
            Some(NormalizedEvent::PreToolUse)
        );
        assert_eq!(
            codex.normalize("agent-turn-complete"),
            Some(NormalizedEvent::TurnComplete)
        );
    }

    /// The two flags that used to be `agent != FleetAgent::Opencode` tests.
    #[test]
    fn opencode_is_the_only_multi_session_host_and_all_agents_answer_questions() {
        for m in MANIFESTS {
            let is_opencode = m.agent == FleetAgent::Opencode;
            assert_eq!(m.multi_session_host, is_opencode, "{:?}", m.agent);
            assert!(m.answers_questions, "{:?}", m.agent);
        }
    }

    /// `send_message` is the reverse command channel; only OpenCode has one.
    /// Declaring it elsewhere would route a reply into OpenCode's handler.
    #[test]
    fn only_opencode_declares_send_message() {
        for m in MANIFESTS {
            assert_eq!(
                m.capabilities.send_message,
                m.agent == FleetAgent::Opencode,
                "{:?}",
                m.agent
            );
        }
    }

    #[test]
    fn opencode_uses_its_own_decision_shape() {
        assert_eq!(
            manifest_for(FleetAgent::Opencode).decision_shape,
            DecisionShape::OpencodeStatus
        );
        for agent in [FleetAgent::ClaudeCode, FleetAgent::Codex] {
            assert_eq!(
                manifest_for(agent).decision_shape,
                DecisionShape::HookSpecificOutput
            );
        }
    }

    /// The encoder, not just the declaration: each shape produces the envelope
    /// its forwarder can actually parse. Pins the branch that used to live as a
    /// `match agent { … }` in `routes::permission_decision`.
    #[test]
    fn permission_decision_is_encoded_per_declared_shape() {
        let claude = manifest_for(FleetAgent::ClaudeCode).permission_decision("deny");
        assert_eq!(
            claude["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(claude["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert!(claude.get("status").is_none());

        let codex = manifest_for(FleetAgent::Codex).permission_decision("allow");
        assert_eq!(codex["hookSpecificOutput"]["decision"]["behavior"], "allow");

        let opencode = manifest_for(FleetAgent::Opencode).permission_decision("allow");
        assert_eq!(opencode["status"], "allow");
        assert!(opencode.get("hookSpecificOutput").is_none());
    }

    /// OpenCode "never routes here" is now enforced, not documented: it neither
    /// answers questions nor has a reply slot for `updatedInput`, so the
    /// encoder refuses rather than emitting an envelope its plugin would ignore.
    #[test]
    fn only_question_answering_agents_encode_an_answer() {
        let updated = json!({ "questions": [], "answers": { "q": "a" } });
        for agent in [FleetAgent::ClaudeCode, FleetAgent::Codex] {
            let decision = manifest_for(agent)
                .question_decision(updated.clone())
                .unwrap_or_else(|| panic!("{agent:?} must encode an answer"));
            assert_eq!(
                decision["hookSpecificOutput"]["decision"]["behavior"],
                "allow"
            );
            assert_eq!(
                decision["hookSpecificOutput"]["decision"]["updatedInput"]["answers"]["q"],
                "a"
            );
        }
        let opencode = manifest_for(FleetAgent::Opencode)
            .question_decision(updated)
            .expect("OpenCode native Question API is answerable");
        assert_eq!(opencode["status"], "allow");
        assert_eq!(opencode["updatedInput"]["answers"]["q"], "a");
    }

    /// Capabilities the fold can never satisfy must not be declared: an agent
    /// with no transcript path must not advertise `open_transcript`, or the
    /// island renders a button that does nothing.
    #[test]
    fn opencode_declares_no_transcript_or_focus() {
        let m = manifest_for(FleetAgent::Opencode);
        assert!(!m.capabilities.open_transcript);
        assert!(!m.capabilities.focus_terminal);
    }
}
