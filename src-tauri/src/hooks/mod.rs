// Host-native compatibility hook dispatcher. The built-in Claude Agent SDK
// rail executes settings hooks inside the Node sidecar so every event has one
// owner and SDK input/output semantics are preserved. Rust remains the shared
// executor for external-agent adapters and direct compatibility commands.

pub mod builtin;
pub mod command;
pub mod commands;
pub mod trust;
pub mod types;
pub mod webhook;

use regex::Regex;
use serde_json::Value;

pub use types::{
    HookAgentIdentity, HookDecision, HookEvent, HookEventPayload, HookGroup, HookHandler,
    HookOutcome,
};

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

/// Test whether a hook group's matcher applies to the given target name.
///
/// The canonical rule lives in `sidecar/dispatch/agent-hooks.mjs` — that is the
/// rail the built-in agent runs on and the one users' existing Claude Code
/// settings were written against. This is a port of it, and the shared table in
/// `hooks/matcher-conformance.json` is asserted by all three runners' tests so
/// the ports cannot drift again.
///
///   - omitted / `""` / `"*"` → match everything
///   - `[A-Za-z0-9_-, |]` only → exact set, split on `[|,]`, alternatives trimmed
///   - anything else → unanchored regex; an invalid regex matches nothing
///
/// `narrow` tightens the exact-set alphabet to `[A-Za-z0-9_|]` (split on `|`
/// only). Used for `FileChanged` / `StopFailure`, whose targets are file paths
/// and error strings: their punctuation must stay regex-significant instead of
/// being read as list separators.
fn matcher_matches_with(matcher: Option<&str>, target: &str, narrow: bool) -> bool {
    let Some(m) = matcher else {
        return true;
    };
    let m = m.trim();
    if m.is_empty() || m == "*" {
        return true;
    }
    let in_exact_alphabet = m.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || c == '_'
            || c == '|'
            || (!narrow && (c == '-' || c == ',' || c == ' '))
    });
    if in_exact_alphabet {
        let alts: Vec<&str> = if narrow {
            m.split('|').collect()
        } else {
            m.split(['|', ',']).collect()
        };
        return alts.iter().any(|alt| alt.trim() == target);
    }
    // Treat as regex. Unanchored, matching the JS `RegExp.test` the other two
    // rails use — anchoring here would silently narrow existing configs.
    match Regex::new(m) {
        Ok(re) => re.is_match(target),
        Err(_) => false,
    }
}

/// The common case: {@link matcher_matches_with} with the wide exact-set alphabet.
fn matcher_matches(matcher: Option<&str>, target: &str) -> bool {
    matcher_matches_with(matcher, target, false)
}

/// True for the events whose matcher target is a path / free text rather than a
/// tool name, so the exact-set alphabet must be tightened.
fn uses_narrow_exact_set(event: HookEvent) -> bool {
    matches!(event, HookEvent::FileChanged | HookEvent::StopFailure)
}

/// Test a group's `agents` selector against the event's agent identity. An
/// absent selector matches everything, so every pre-existing config keeps its
/// behaviour. A present selector matches when it applies to EITHER the
/// `agent_kind` or the `agent_ref` — so `"teammate"` catches a whole class and
/// `"reviewer"` catches one named agent, without two separate fields.
///
/// An event with no identity at all never matches a present selector: a hook
/// that asked to be narrowed must not fire on an unidentified turn.
fn agents_match(selector: Option<&str>, identity: &HookAgentIdentity) -> bool {
    let Some(sel) = selector else {
        return true;
    };
    let sel = sel.trim();
    if sel.is_empty() || sel == "*" {
        return true;
    }
    identity
        .match_targets()
        .into_iter()
        .any(|t| matcher_matches(Some(sel), t))
}

/// Run all hooks for `event` whose matcher applies to `target_name`. `target_name`
/// is the tool name for tool-scoped events; for prompt-scoped events pass `""`
/// and configure matchers as `"*"`.
async fn run_event(
    settings: &ClaudeSettings,
    event: HookEvent,
    target_name: &str,
    identity: &HookAgentIdentity,
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
    let narrow = uses_narrow_exact_set(event);
    for group in groups {
        if !matcher_matches_with(group.matcher.as_deref(), target_name, narrow) {
            continue;
        }
        if !agents_match(group.agents.as_deref(), identity) {
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
        }
        | HookHandler::Http {
            url,
            headers,
            timeout,
        } => webhook::run_webhook_handler(&url, &headers, timeout, payload_json).await,
        // Needs the sidecar's renderer round-trip; this rail (external agents,
        // worktree lifecycle) has no renderer to reach. Soft-allow with a
        // warning naming the plugin, so the user can see WHY nothing ran
        // instead of watching a configured hook do nothing.
        HookHandler::Plugin { plugin_id, hook_id } => HookOutcome::InternalError {
            reason: format!(
                "plugin hook {plugin_id}:{hook_id} is not executable on this rail (sidecar only)"
            ),
        },
        HookHandler::Unsupported => HookOutcome::InternalError {
            reason: "unsupported handler type".to_string(),
        },
    }
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
    identity: HookAgentIdentity,
    fields: Value,
) -> HookDecision {
    let payload = HookEventPayload {
        hook_event_name: hook_event_name(event),
        session_id: session_id.to_string(),
        cwd: cwd.map(String::from),
        agent_kind: identity.kind.clone(),
        agent_ref: identity.agent_ref.clone(),
        fields,
    };
    run_event(&settings.merged, event, "", &identity, &payload).await
}

/// Run a tool-scoped hook whose matcher is tested against `tool_name`. Used for
/// `PostToolUse` / `PostToolUseFailure` / `PermissionRequest` / `PermissionDenied`.
pub async fn run_tool_scoped(
    settings: &EffectiveSettings,
    event: HookEvent,
    session_id: &str,
    cwd: Option<&str>,
    tool_name: &str,
    identity: HookAgentIdentity,
    fields: Value,
) -> HookDecision {
    let payload = HookEventPayload {
        hook_event_name: hook_event_name(event),
        session_id: session_id.to_string(),
        cwd: cwd.map(String::from),
        agent_kind: identity.kind.clone(),
        agent_ref: identity.agent_ref.clone(),
        fields,
    };
    run_event(&settings.merged, event, tool_name, &identity, &payload).await
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

    /// The cross-rail matcher table. Compiled in so the Rust suite fails when
    /// this rail drifts from the canonical sidecar rule — the exact defect this
    /// file was added for (three runners, three different semantics).
    const CONFORMANCE: &str = include_str!("../../../hooks/matcher-conformance.json");

    #[test]
    fn matcher_conformance_table_matches_the_canonical_rule() {
        let table: serde_json::Value = serde_json::from_str(CONFORMANCE).unwrap();
        for (key, narrow) in [("cases", false), ("narrowCases", true)] {
            let cases = table[key].as_array().unwrap_or_else(|| {
                panic!("conformance table is missing the `{key}` array");
            });
            assert!(!cases.is_empty(), "`{key}` must not be empty");
            for case in cases {
                let matcher = case["matcher"].as_str();
                let target = case["target"].as_str().expect("case.target");
                let expected = case["expected"].as_bool().expect("case.expected");
                let why = case["why"].as_str().unwrap_or("");
                assert_eq!(
                    matcher_matches_with(matcher, target, narrow),
                    expected,
                    "{key}: matcher={matcher:?} target={target:?} — {why}"
                );
            }
        }
    }

    fn identity(kind: Option<&str>, agent_ref: Option<&str>) -> HookAgentIdentity {
        HookAgentIdentity {
            kind: kind.map(String::from),
            agent_ref: agent_ref.map(String::from),
        }
    }

    #[test]
    fn agents_omitted_matches_every_agent() {
        let id = identity(Some("teammate"), Some("reviewer"));
        assert!(agents_match(None, &id));
        assert!(agents_match(Some(""), &id));
        assert!(agents_match(Some("*"), &id));
        // An absent selector still matches when there is no identity, so every
        // pre-existing config keeps its behaviour after this field was added.
        assert!(agents_match(None, &identity(None, None)));
    }

    #[test]
    fn agents_matches_either_kind_or_ref() {
        let id = identity(Some("teammate"), Some("reviewer"));
        assert!(agents_match(Some("teammate"), &id));
        assert!(agents_match(Some("reviewer"), &id));
        assert!(agents_match(Some("chat|teammate"), &id));
        assert!(agents_match(Some("^review"), &id));
        assert!(!agents_match(Some("chat"), &id));
        assert!(!agents_match(Some("planner"), &id));
    }

    #[test]
    fn agents_present_never_matches_an_unidentified_event() {
        // A hook that asked to be narrowed must not fire on a turn whose agent
        // we cannot name — the fail-safe direction for a guard.
        assert!(!agents_match(Some("teammate"), &identity(None, None)));
        assert!(!agents_match(Some("teammate"), &identity(Some(""), None)));
    }

    #[test]
    fn agent_identity_serializes_onto_the_payload() {
        let payload = HookEventPayload {
            hook_event_name: "PostToolUse".to_string(),
            session_id: "s1".to_string(),
            cwd: None,
            agent_kind: Some("teammate".to_string()),
            agent_ref: Some("reviewer".to_string()),
            fields: json!({ "tool_name": "Bash" }),
        };
        let v = serde_json::to_value(&payload).unwrap();
        assert_eq!(v["agent_kind"], "teammate");
        assert_eq!(v["agent_ref"], "reviewer");
        assert_eq!(v["tool_name"], "Bash");

        // Absent identity is omitted entirely so a hook script can tell
        // "no identity" apart from "identity is empty".
        let anon = HookEventPayload {
            hook_event_name: "PostToolUse".to_string(),
            session_id: "s1".to_string(),
            cwd: None,
            agent_kind: None,
            agent_ref: None,
            fields: json!({}),
        };
        let v = serde_json::to_value(&anon).unwrap();
        assert!(v.get("agent_kind").is_none());
        assert!(v.get("agent_ref").is_none());
    }

    #[test]
    fn hook_group_deserializes_the_agents_selector() {
        let g: HookGroup = serde_json::from_value(json!({
            "matcher": "Bash",
            "agents": "teammate",
            "hooks": [{ "type": "command", "command": "guard.mjs" }],
        }))
        .unwrap();
        assert_eq!(g.agents.as_deref(), Some("teammate"));
        // Omitted stays None — existing settings.json round-trips untouched.
        let legacy: HookGroup = serde_json::from_value(json!({
            "matcher": "Bash",
            "hooks": [{ "type": "command", "command": "guard.mjs" }],
        }))
        .unwrap();
        assert!(legacy.agents.is_none());
    }

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
