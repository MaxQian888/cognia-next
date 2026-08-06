// Hook framework types. Mirrors the subset of the Claude Code hooks schema
// we currently support.
//
// Reference: https://code.claude.com/docs/en/hooks

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Claude Agent SDK 0.3.220 lifecycle events.
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
    /// Canonical Claude settings name. `webhook` remains a legacy alias.
    Http {
        url: String,
        #[serde(default)]
        headers: std::collections::HashMap<String, String>,
        #[serde(default)]
        timeout: Option<u64>,
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

/// Event payload pumped to a `command` handler on stdin. Mirrors the shape
/// Claude Code uses, minus session/transcript fields we don't have here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HookEventPayload {
    pub hook_event_name: String,
    pub session_id: String,
    pub cwd: Option<String>,
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
