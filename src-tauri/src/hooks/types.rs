// Hook framework types. Mirrors the subset of the Claude Code hooks schema
// we currently support.
//
// Reference: https://code.claude.com/docs/en/hooks

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Hook lifecycle events exposed by the pinned Claude Agent SDK. Execution
/// ownership is SDK-native for the built-in rail and host-native for external
/// adapters; the shared identity keeps settings round-trippable across both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    UserPromptSubmit,
    Stop,
    Setup,
    SubagentStart,
    SubagentStop,
    SessionStart,
    SessionEnd,
    Notification,
    PreCompact,
    PostCompact,
    TaskCreated,
    TaskCompleted,
    PermissionRequest,
    PermissionDenied,
    WorktreeCreate,
    WorktreeRemove,
    FileChanged,
    DirectoryAdded,
    CwdChanged,
    InstructionsLoaded,
    ConfigChange,
    Elicitation,
    ElicitationResult,
    PostToolBatch,
    PostToolUseFailure,
    StopFailure,
    TeammateIdle,
    UserPromptExpansion,
    MessageDisplay,
}

/// One hook block in `settings.json`'s `hooks.{Event}` array.
#[derive(Debug, Clone, Deserialize)]
pub struct HookGroup {
    /// Tool-name regex (or comma-separated literal) to match. None = match all.
    #[serde(default)]
    pub matcher: Option<String>,
    /// Agent selector, orthogonal to `matcher`: same syntax, tested against the
    /// event's `agent_kind` and `agent_ref`. None = match every agent.
    ///
    /// A cognia extension. Real Claude Code ignores the unknown key and will run
    /// the group unconditionally — the settings UI says so explicitly.
    #[serde(default)]
    pub agents: Option<String>,
    /// Handlers run sequentially; first blocking handler wins.
    pub hooks: Vec<HookHandler>,
}

/// A single handler entry inside a `HookGroup`. Webhook fields are unused
/// in Phase 1 but we deserialize them so settings.json still round-trips.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)]
pub enum HookHandler {
    /// Spawn a shell command with the JSON event payload on stdin.
    Command {
        command: String,
        #[serde(default)]
        timeout: Option<u64>, // seconds
    },
    /// HTTP POST with the event payload as JSON body. Phase 2.
    Webhook {
        url: String,
        #[serde(default)]
        headers: std::collections::HashMap<String, String>,
        #[serde(default)]
        timeout: Option<u64>,
    },
    /// Claude Code's current settings name for an HTTP POST handler. The
    /// legacy Cognia `webhook` spelling remains accepted for compatibility.
    Http {
        url: String,
        #[serde(default)]
        headers: std::collections::HashMap<String, String>,
        #[serde(default)]
        timeout: Option<u64>,
    },
    /// Plugin handler (`{ type: "plugin", pluginId, hookId }`). Recognised so
    /// settings.json round-trips, but NOT executable on this rail: it needs the
    /// renderer round-trip only the sidecar can perform
    /// (`sidecar/dispatch/plugin-hook-exec.mjs`). Treated as unsupported here,
    /// which soft-allows with a warning.
    Plugin {
        #[serde(default)]
        plugin_id: String,
        #[serde(default)]
        hook_id: String,
    },
    /// MCP-tool / prompt / agent handlers — recognised so settings.json
    /// round-trips, but execution is unimplemented in Phase 1.
    #[serde(other)]
    Unsupported,
}

/// Result of running a single handler.
#[derive(Debug, Clone)]
pub enum HookOutcome {
    /// Handler exited 0 with no JSON output (or plain stdout). Allow.
    Allow,
    /// Handler exited 0 with JSON output containing extra context.
    AllowWithContext { additional_context: String },
    /// Handler exited 2 (or returned `permissionDecision: "deny"`). Block.
    Block { reason: String },
    /// Handler timed out. Soft-allow with a warning surfaced upward.
    TimedOut { duration_ms: u64 },
    /// Handler crashed for an internal reason (couldn't spawn, JSON parse, etc.).
    /// Soft-allow on the principle that a broken hook should not lock the user
    /// out of the tool entirely.
    InternalError { reason: String },
}

/// Aggregate decision from running all handlers in a group / for an event.
#[derive(Debug, Clone, Default)]
pub struct HookDecision {
    /// Set when any handler blocked. The string is the user-facing reason.
    pub block: Option<String>,
    /// Concatenated `additionalContext` strings, in handler order, separated by
    /// `\n\n`.
    pub additional_context: Option<String>,
    /// Diagnostic warnings (timeouts, crashes) — surfaced via the UI but not
    /// treated as blocking.
    pub warnings: Vec<String>,
}

impl HookDecision {
    pub fn merge(&mut self, outcome: HookOutcome) {
        match outcome {
            HookOutcome::Allow => {}
            HookOutcome::AllowWithContext { additional_context } => {
                match self.additional_context.as_mut() {
                    Some(existing) => {
                        existing.push_str("\n\n");
                        existing.push_str(&additional_context);
                    }
                    None => self.additional_context = Some(additional_context),
                }
            }
            HookOutcome::Block { reason } => {
                // First block wins — keep the earliest reason.
                if self.block.is_none() {
                    self.block = Some(reason);
                }
            }
            HookOutcome::TimedOut { duration_ms } => {
                self.warnings
                    .push(format!("hook timed out after {duration_ms}ms (soft-allow)"));
            }
            HookOutcome::InternalError { reason } => {
                self.warnings.push(format!("hook crashed: {reason}"));
            }
        }
    }

    pub fn is_blocked(&self) -> bool {
        self.block.is_some()
    }
}

/// Which agent a lifecycle event came from. Mirrors the TS `HookAgentKind`
/// union plus its free-form companion; both reach a hook script as top-level
/// payload fields (`agent_kind` / `agent_ref`) and are what the `agents`
/// selector on a `HookGroup` is tested against.
///
/// Kept as `Option<String>` rather than an enum: an unknown kind from a future
/// TS release must round-trip and simply fail to match, never abort the event.
#[derive(Debug, Clone, Default)]
pub struct HookAgentIdentity {
    pub kind: Option<String>,
    pub agent_ref: Option<String>,
}

impl HookAgentIdentity {
    /// The strings an `agents` selector may match: the kind and the ref.
    pub fn match_targets(&self) -> Vec<&str> {
        [self.kind.as_deref(), self.agent_ref.as_deref()]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect()
    }
}

/// Event payload pumped to a `command` handler on stdin. Mirrors the shape
/// Claude Code uses, minus session/transcript fields we don't have here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HookEventPayload {
    pub hook_event_name: String,
    pub session_id: String,
    pub cwd: Option<String>,
    /// Which agent produced the event. Omitted from the JSON when unknown so a
    /// hook script can distinguish "no identity" from "identity is empty".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<String>,
    /// Free-form identity within `agent_kind` (teammate id, subagent def id...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_ref: Option<String>,
    /// Free-form bag of event-specific fields (prompt text, tool name + input, etc.).
    #[serde(flatten)]
    pub fields: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_new_sdk_events() {
        for (name, expected) in [
            ("Setup", HookEvent::Setup),
            ("SubagentStart", HookEvent::SubagentStart),
            ("DirectoryAdded", HookEvent::DirectoryAdded),
            ("MessageDisplay", HookEvent::MessageDisplay),
        ] {
            let event: HookEvent = serde_json::from_value(Value::String(name.into())).unwrap();
            assert_eq!(event, expected);
        }
    }

    #[test]
    fn deserializes_canonical_http_and_legacy_webhook_handlers() {
        let http: HookHandler = serde_json::from_value(serde_json::json!({
            "type": "http",
            "url": "https://example.test/hook"
        }))
        .unwrap();
        let webhook: HookHandler = serde_json::from_value(serde_json::json!({
            "type": "webhook",
            "url": "https://example.test/hook"
        }))
        .unwrap();

        assert!(matches!(http, HookHandler::Http { .. }));
        assert!(matches!(webhook, HookHandler::Webhook { .. }));
    }
}
