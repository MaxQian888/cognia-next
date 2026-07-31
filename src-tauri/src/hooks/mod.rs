// Hook dispatcher — loads hook config from the merged Claude Code settings
// and runs handlers that match an event + tool. Phase 1 wires:
//   - `UserPromptSubmit`: invoked by `claude::commands::claude_send` BEFORE
//     forwarding the prompt to the sidecar. A blocking hook causes the
//     command to return Err with the hook's reason; non-blocking hooks may
//     contribute additional context that the caller prepends to the prompt.
//   - `PreToolUse`: invoked from inside `claude::sidecar`'s stdout reader
//     when a `permission_request` event arrives. A blocking hook short-
//     circuits the user-approval round-trip with an automatic deny.
//
// Project- and local-scope hooks are loaded only when the workspace has been
// trusted (Phase 2 ships the trust UI); for now we read the user-scope file
// only, which lives at `~/.claude/settings.json`.

pub mod builtin;
pub mod classify;
pub mod command;
pub mod commands;
pub mod trust;
pub mod types;
pub mod webhook;

use regex::Regex;
use serde_json::{json, Value};

pub use classify::{classify_sidecar_message, extract_tool_results, extract_tool_uses};
pub use types::{HookDecision, HookEvent, HookEventPayload, HookGroup, HookHandler, HookOutcome};

use crate::settings::{ClaudeSettings, EffectiveSettings};

/// Pull the array of `HookGroup`s for `event` out of a `ClaudeSettings`.
/// Returns an empty vec when the event has no configured hooks.
fn groups_for_event(settings: &ClaudeSettings, event: HookEvent) -> Vec<HookGroup> {
    let Some(hooks) = settings.hooks.as_ref() else {
        return Vec::new();
    };
    let event_name = match serde_json::to_value(event) {
        Ok(Value::String(s)) => s,
        _ => return Vec::new(),
    };
    let Some(arr) = hooks.get(&event_name).and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|v| serde_json::from_value::<HookGroup>(v.clone()).ok())
        .collect()
}

/// Test whether a hook group's matcher applies to the given target name. The
/// matcher follows Claude Code's rules:
///   - omitted / `"*"` → match everything
///   - alphanumeric + `_` + `|` → exact-string-or-pipe-set match
///   - anything else → JS-style regex
fn matcher_matches(matcher: Option<&str>, target: &str) -> bool {
    let Some(m) = matcher else {
        return true;
    };
    let m = m.trim();
    if m.is_empty() || m == "*" {
        return true;
    }
    // Pipe-separated alternatives where each alternative is alphanumeric/_:
    if m.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '|')
    {
        for alt in m.split('|') {
            if alt == target {
                return true;
            }
        }
        return false;
    }
    // Treat as regex.
    match Regex::new(m) {
        Ok(re) => re.is_match(target),
        Err(_) => false,
    }
}

/// Run all hooks for `event` whose matcher applies to `target_name`. `target_name`
/// is the tool name for tool-scoped events; for prompt-scoped events pass `""`
/// and configure matchers as `"*"`.
async fn run_event(
    settings: &ClaudeSettings,
    event: HookEvent,
    target_name: &str,
    payload: &HookEventPayload,
) -> HookDecision {
    let groups = groups_for_event(settings, event);
    let mut decision = HookDecision::default();
    if groups.is_empty() {
        return decision;
    }
    let payload_json = match serde_json::to_string(payload) {
        Ok(s) => s,
        Err(e) => {
            decision.merge(HookOutcome::InternalError {
                reason: format!("payload serialize: {e}"),
            });
            return decision;
        }
    };
    for group in groups {
        if !matcher_matches(group.matcher.as_deref(), target_name) {
            continue;
        }
        for handler in group.hooks {
            let outcome = run_handler(handler, &payload_json).await;
            decision.merge(outcome);
            if decision.is_blocked() {
                // First block wins; no point running the rest of this group / event.
                return decision;
            }
        }
    }
    decision
}

async fn run_handler(handler: HookHandler, payload_json: &str) -> HookOutcome {
    match handler {
        HookHandler::Command { command, timeout } => {
            command::run_command_handler(&command, timeout, payload_json).await
        }
        HookHandler::Webhook {
            url,
            headers,
            timeout,
        } => webhook::run_webhook_handler(&url, &headers, timeout, payload_json).await,
        HookHandler::Unsupported => HookOutcome::InternalError {
            reason: "unsupported handler type".to_string(),
        },
    }
}

/// Convenience wrapper for the prompt-scoped event. Returns the merged decision
/// so the caller can treat `block` as a hard error and `additional_context`
/// as a prompt prefix.
pub async fn run_user_prompt_submit(
    settings: &EffectiveSettings,
    session_id: &str,
    cwd: Option<&str>,
    prompt_text: &str,
) -> HookDecision {
    let payload = HookEventPayload {
        hook_event_name: "UserPromptSubmit".to_string(),
        session_id: session_id.to_string(),
        cwd: cwd.map(String::from),
        fields: json!({ "prompt": prompt_text }),
    };
    run_event(&settings.merged, HookEvent::UserPromptSubmit, "", &payload).await
}

// PreToolUse execution moved into the sidecar (`dispatch/agent-hooks.mjs`) as an
// SDK-native hook, so it can block BEFORE `canUseTool` and rewrite `updatedInput`
// in-process. The former `run_pre_tool_use` HOST-side runner was retired with
// that cutover (ADR-0040 convergence follow-up); `run_event` + the tool-scoped
// wrapper below still serve the observational tool events (PermissionRequest /
// PermissionDenied).

/// The PascalCase wire name of a `HookEvent` (the key used in settings.json
/// and the `hook_event_name` payload field). Derived from the serde rename so
/// it can never drift from the enum.
pub fn hook_event_name(event: HookEvent) -> String {
    match serde_json::to_value(event) {
        Ok(Value::String(s)) => s,
        _ => String::new(),
    }
}

/// Run a session-scoped lifecycle hook (matcher target `""`). Used for
/// observational events such as `SessionStart`, `SessionEnd`, `Stop`,
/// `SubagentStop`, `Notification`, `PostCompact`, `TaskCreated`/`TaskCompleted`.
/// The returned `HookDecision` carries any `additionalContext` + warnings; for
/// observational events the caller ignores `block`.
pub async fn run_session_scoped(
    settings: &EffectiveSettings,
    event: HookEvent,
    session_id: &str,
    cwd: Option<&str>,
    fields: Value,
) -> HookDecision {
    let payload = HookEventPayload {
        hook_event_name: hook_event_name(event),
        session_id: session_id.to_string(),
        cwd: cwd.map(String::from),
        fields,
    };
    run_event(&settings.merged, event, "", &payload).await
}

/// Run a tool-scoped hook whose matcher is tested against `tool_name`. Used for
/// `PostToolUse` / `PostToolUseFailure` / `PermissionRequest` / `PermissionDenied`.
pub async fn run_tool_scoped(
    settings: &EffectiveSettings,
    event: HookEvent,
    session_id: &str,
    cwd: Option<&str>,
    tool_name: &str,
    fields: Value,
) -> HookDecision {
    let payload = HookEventPayload {
        hook_event_name: hook_event_name(event),
        session_id: session_id.to_string(),
        cwd: cwd.map(String::from),
        fields,
    };
    run_event(&settings.merged, event, tool_name, &payload).await
}

/// Load merged settings for the given cwd. Returns an empty `EffectiveSettings`
/// when reading fails so a missing/broken config never blocks the user.
pub fn load_effective_settings(cwd: Option<&str>) -> EffectiveSettings {
    match crate::settings::read_claude_effective_settings(cwd.map(String::from)) {
        Ok(mut eff) => {
            // Merge the product-bundled built-in hooks UNDER the user's own
            // hooks (user groups run first). Honors `builtinHookOverrides`.
            builtin::apply_builtin_hooks(&mut eff.merged);
            eff
        }
        Err(err) => {
            log::warn!("hooks: settings load failed ({err}); proceeding without hooks");
            EffectiveSettings::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matcher_omitted_matches_all() {
        assert!(matcher_matches(None, "Bash"));
        assert!(matcher_matches(Some(""), "Bash"));
        assert!(matcher_matches(Some("*"), "Bash"));
    }

    #[test]
    fn matcher_pipe_set_exact_match() {
        assert!(matcher_matches(Some("Bash|Edit"), "Bash"));
        assert!(matcher_matches(Some("Bash|Edit"), "Edit"));
        assert!(!matcher_matches(Some("Bash|Edit"), "Read"));
    }

    #[test]
    fn matcher_regex_fallback() {
        assert!(matcher_matches(Some("^Notebook"), "NotebookEdit"));
        assert!(!matcher_matches(Some("^Notebook"), "Read"));
    }

    #[test]
    fn groups_for_event_extracts_array() {
        let s = ClaudeSettings {
            hooks: Some(json!({
              "UserPromptSubmit": [
                { "matcher": "*", "hooks": [{ "type": "command", "command": "echo hi" }] }
              ]
            })),
            ..Default::default()
        };
        let groups = groups_for_event(&s, HookEvent::UserPromptSubmit);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].hooks.len(), 1);
    }
}
