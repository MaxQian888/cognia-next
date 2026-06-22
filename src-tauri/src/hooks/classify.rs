// Pure classification of sidecar/SDK messages into hook events.
//
// The built-in agent's sidecar forwards every SDK message verbatim as
// `{ type: "event", sessionId, event: <SDKMessage> }`, plus a terminal
// `{ type: "session_ended", sessionId, error? }`. This module maps those
// messages onto the `HookEvent` lifecycle so the stdout reader in
// `claude::sidecar` can fire the matching settings.json hooks.
//
// Everything here is a pure function of its input `Value` so it is exhaustively
// unit-testable without spawning a sidecar. Stateful correlation (matching a
// `tool_result` back to the `tool_use` that produced it, which needs a
// per-session map) lives in the reader; this module only extracts the raw
// tool_use / tool_result records via `extract_tool_uses` / `extract_tool_results`.
//
// Wire shapes are taken from `@anthropic-ai/claude-agent-sdk` `sdk.d.ts`:
//   - system/init            → SessionStart
//   - system/compact_boundary→ PostCompact
//   - system/notification    → Notification
//   - system/api_retry       → Notification (provider retry warning)
//   - system/elicitation_complete → ElicitationResult
//   - system/task_started    → TaskCreated
//   - system/task_notification → TaskCompleted + SubagentStop
//   - result/success         → Stop
//   - result/error_*         → StopFailure
//   - tool_use_summary       → PostToolBatch
//   - rate_limit_event       → Notification (subscription quota warning)
//   - session_ended          → SessionEnd (+ StopFailure when it carries an error)

use serde_json::{json, Value};

use super::types::HookEvent;

/// One lifecycle hook the reader should fire for an observed message. Every
/// classified hook is session-scoped (matcher target `""`); tool-scoped events
/// (PostToolUse) are handled separately via `extract_tool_results` so the tool
/// name can be recovered from the in-flight tool_use map.
#[derive(Debug, Clone, PartialEq)]
pub struct ClassifiedHook {
    pub event: HookEvent,
    pub fields: Value,
}

impl ClassifiedHook {
    fn session(event: HookEvent, fields: Value) -> Self {
        Self { event, fields }
    }
}

/// Cheap predicate the reader uses to decide whether to spawn an observer task
/// at all. The sidecar forwards a flood of `stream_event` partial-assistant
/// deltas during streaming; none of those can produce a hook, so we skip them
/// without allocating a task. Assistant/user events are relevant because they
/// carry tool_use / tool_result blocks even when they don't classify directly.
pub fn is_hook_relevant(msg: &Value) -> bool {
    match msg.get("type").and_then(|v| v.as_str()) {
        Some("session_ended") => true,
        Some("event") => matches!(
            msg.pointer("/event/type").and_then(|v| v.as_str()),
            Some("system")
                | Some("result")
                | Some("tool_use_summary")
                | Some("assistant")
                | Some("user")
                | Some("rate_limit_event")
        ),
        _ => false,
    }
}

/// Classify a full top-level sidecar message (`{ type, sessionId, ... }`).
/// Returns the stateless hooks it implies; tool-result correlation (PostToolUse)
/// is handled separately by the reader via `extract_tool_results`.
pub fn classify_sidecar_message(msg: &Value) -> Vec<ClassifiedHook> {
    match msg.get("type").and_then(|v| v.as_str()) {
        Some("session_ended") => {
            let err = msg.get("error").and_then(|v| v.as_str());
            let mut out = vec![ClassifiedHook::session(
                HookEvent::SessionEnd,
                json!({ "error": err }),
            )];
            // A session that ended carrying an error implies a failed stop. The
            // happy path fires StopFailure from the `result` message instead, so
            // this only adds coverage for hard crashes that never produced a
            // result. The rare double-fire is harmless (StopFailure is observational).
            if err.is_some() {
                out.push(ClassifiedHook::session(
                    HookEvent::StopFailure,
                    json!({ "error": err }),
                ));
            }
            out
        }
        Some("event") => classify_sdk_event(msg.get("event").unwrap_or(&Value::Null)),
        _ => Vec::new(),
    }
}

/// Classify a single SDK message (the `event` payload of a `type:"event"` line).
fn classify_sdk_event(evt: &Value) -> Vec<ClassifiedHook> {
    let Some(kind) = evt.get("type").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    match kind {
        "system" => classify_system(evt),
        "result" => {
            let subtype = evt.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
            let fields = json!({
                "subtype": subtype,
                "num_turns": evt.get("num_turns"),
                "duration_ms": evt.get("duration_ms"),
                "stop_reason": evt.get("stop_reason"),
            });
            let event = if subtype == "success" {
                HookEvent::Stop
            } else {
                HookEvent::StopFailure
            };
            vec![ClassifiedHook::session(event, fields)]
        }
        "tool_use_summary" => vec![ClassifiedHook::session(
            HookEvent::PostToolBatch,
            json!({
                "summary": evt.get("summary"),
                "preceding_tool_use_ids": evt.get("preceding_tool_use_ids"),
            }),
        )],
        // claude.ai subscription rate-limit warning — surfaced as a Notification
        // so a settings webhook/command hook can alert the user when their
        // quota is constrained.
        "rate_limit_event" => vec![ClassifiedHook::session(
            HookEvent::Notification,
            json!({
                "key": "rate_limit",
                "rate_limit_info": evt.get("rate_limit_info"),
            }),
        )],
        _ => Vec::new(),
    }
}

fn classify_system(evt: &Value) -> Vec<ClassifiedHook> {
    match evt.get("subtype").and_then(|v| v.as_str()) {
        Some("init") => vec![ClassifiedHook::session(
            HookEvent::SessionStart,
            json!({ "cwd": evt.get("cwd"), "model": evt.get("model") }),
        )],
        Some("compact_boundary") => {
            let meta = evt.get("compact_metadata");
            vec![ClassifiedHook::session(
                HookEvent::PostCompact,
                json!({
                    "trigger": meta.and_then(|m| m.get("trigger")),
                    "pre_tokens": meta.and_then(|m| m.get("pre_tokens")),
                    "post_tokens": meta.and_then(|m| m.get("post_tokens")),
                }),
            )]
        }
        Some("notification") => vec![ClassifiedHook::session(
            HookEvent::Notification,
            json!({
                "key": evt.get("key"),
                "text": evt.get("text"),
                "priority": evt.get("priority"),
            }),
        )],
        Some("task_started") => vec![ClassifiedHook::session(
            HookEvent::TaskCreated,
            json!({
                "task_id": evt.get("task_id"),
                "description": evt.get("description"),
                "task_type": evt.get("task_type"),
            }),
        )],
        Some("task_notification") => {
            let status = evt.get("status").and_then(|v| v.as_str());
            let fields = json!({
                "task_id": evt.get("task_id"),
                "status": status,
                "summary": evt.get("summary"),
            });
            // A finished subagent Task is both a completed task and a subagent stop.
            vec![
                ClassifiedHook::session(HookEvent::TaskCompleted, fields.clone()),
                ClassifiedHook::session(HookEvent::SubagentStop, fields),
            ]
        }
        // The SDK retries a failing API call — surface as a Notification so a
        // settings hook can warn the user their provider is struggling.
        Some("api_retry") => vec![ClassifiedHook::session(
            HookEvent::Notification,
            json!({
                "key": "api_retry",
                "attempt": evt.get("attempt"),
                "max_retries": evt.get("max_retries"),
                "retry_delay_ms": evt.get("retry_delay_ms"),
                "error_status": evt.get("error_status"),
            }),
        )],
        // An MCP server's elicitation request completed — fires ElicitationResult
        // so hooks can react to the resolved user input.
        Some("elicitation_complete") => vec![ClassifiedHook::session(
            HookEvent::ElicitationResult,
            json!({
                "mcp_server_name": evt.get("mcp_server_name"),
                "elicitation_id": evt.get("elicitation_id"),
            }),
        )],
        _ => Vec::new(),
    }
}

/// Extract `(tool_use_id, tool_name, input)` records from an assistant SDK
/// event so the reader can remember them until the matching `tool_result`
/// arrives (powering the PostToolUse payload's tool name + input).
pub fn extract_tool_uses(evt: &Value) -> Vec<(String, String, Value)> {
    if evt.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return Vec::new();
    }
    let Some(content) = evt.pointer("/message/content").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for block in content {
        if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
            let id = block.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let name = block
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            out.push((id.to_string(), name, input));
        }
    }
    out
}

/// Extract `(tool_use_id, is_error, content)` records from a user SDK event's
/// `tool_result` blocks.
pub fn extract_tool_results(evt: &Value) -> Vec<(String, bool, Value)> {
    if evt.get("type").and_then(|v| v.as_str()) != Some("user") {
        return Vec::new();
    }
    let Some(content) = evt.pointer("/message/content").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for block in content {
        if block.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
            let id = block
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let is_error = block
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let result = block.get("content").cloned().unwrap_or(Value::Null);
            out.push((id.to_string(), is_error, result));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(evt: Value) -> Value {
        json!({ "type": "event", "sessionId": "s1", "event": evt })
    }

    #[test]
    fn session_start_from_system_init() {
        let hooks = classify_sidecar_message(&event(json!({
            "type": "system", "subtype": "init", "cwd": "/repo", "model": "claude"
        })));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, HookEvent::SessionStart);
        assert_eq!(hooks[0].fields.get("cwd").unwrap(), "/repo");
    }

    #[test]
    fn post_compact_from_boundary() {
        let hooks = classify_sidecar_message(&event(json!({
            "type": "system",
            "subtype": "compact_boundary",
            "compact_metadata": { "trigger": "auto", "pre_tokens": 100, "post_tokens": 20 }
        })));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, HookEvent::PostCompact);
        assert_eq!(hooks[0].fields.get("trigger").unwrap(), "auto");
    }

    #[test]
    fn notification_event() {
        let hooks = classify_sidecar_message(&event(json!({
            "type": "system", "subtype": "notification", "key": "k", "text": "hi", "priority": "high"
        })));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, HookEvent::Notification);
    }

    #[test]
    fn task_started_is_task_created() {
        let hooks = classify_sidecar_message(&event(json!({
            "type": "system", "subtype": "task_started", "task_id": "t1", "description": "d"
        })));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, HookEvent::TaskCreated);
        assert_eq!(hooks[0].fields.get("task_id").unwrap(), "t1");
    }

    #[test]
    fn task_notification_fires_completed_and_subagent_stop() {
        let hooks = classify_sidecar_message(&event(json!({
            "type": "system", "subtype": "task_notification", "task_id": "t1", "status": "completed", "summary": "ok"
        })));
        let events: Vec<_> = hooks.iter().map(|h| h.event).collect();
        assert!(events.contains(&HookEvent::TaskCompleted));
        assert!(events.contains(&HookEvent::SubagentStop));
    }

    #[test]
    fn result_success_is_stop() {
        let hooks = classify_sidecar_message(&event(json!({
            "type": "result", "subtype": "success", "num_turns": 3
        })));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, HookEvent::Stop);
    }

    #[test]
    fn result_error_is_stop_failure() {
        let hooks = classify_sidecar_message(&event(json!({
            "type": "result", "subtype": "error_max_turns", "num_turns": 99
        })));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, HookEvent::StopFailure);
    }

    #[test]
    fn api_retry_is_notification() {
        let hooks = classify_sidecar_message(&event(json!({
            "type": "system", "subtype": "api_retry",
            "attempt": 2, "max_retries": 5, "retry_delay_ms": 1000, "error_status": 529
        })));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, HookEvent::Notification);
        assert_eq!(hooks[0].fields.get("key").unwrap(), "api_retry");
        assert_eq!(hooks[0].fields.get("attempt").unwrap(), 2);
    }

    #[test]
    fn elicitation_complete_is_elicitation_result() {
        let hooks = classify_sidecar_message(&event(json!({
            "type": "system", "subtype": "elicitation_complete",
            "mcp_server_name": "github", "elicitation_id": "e1"
        })));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, HookEvent::ElicitationResult);
        assert_eq!(hooks[0].fields.get("elicitation_id").unwrap(), "e1");
    }

    #[test]
    fn rate_limit_event_is_notification() {
        let hooks = classify_sidecar_message(&event(json!({
            "type": "rate_limit_event",
            "rate_limit_info": { "status": "allowed_warning" }
        })));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, HookEvent::Notification);
        assert_eq!(hooks[0].fields.get("key").unwrap(), "rate_limit");
    }

    #[test]
    fn rate_limit_event_is_hook_relevant() {
        assert!(is_hook_relevant(&event(
            json!({ "type": "rate_limit_event" })
        )));
    }

    #[test]
    fn tool_use_summary_is_post_tool_batch() {
        let hooks = classify_sidecar_message(&event(json!({
            "type": "tool_use_summary", "summary": "did 2 things", "preceding_tool_use_ids": ["a", "b"]
        })));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, HookEvent::PostToolBatch);
    }

    #[test]
    fn session_ended_clean_is_session_end_only() {
        let hooks =
            classify_sidecar_message(&json!({ "type": "session_ended", "sessionId": "s1" }));
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, HookEvent::SessionEnd);
    }

    #[test]
    fn session_ended_with_error_adds_stop_failure() {
        let hooks = classify_sidecar_message(&json!({
            "type": "session_ended", "sessionId": "s1", "error": "boom"
        }));
        let events: Vec<_> = hooks.iter().map(|h| h.event).collect();
        assert!(events.contains(&HookEvent::SessionEnd));
        assert!(events.contains(&HookEvent::StopFailure));
    }

    #[test]
    fn is_hook_relevant_filters_stream_flood() {
        assert!(is_hook_relevant(
            &json!({ "type": "session_ended", "sessionId": "s" })
        ));
        assert!(is_hook_relevant(&event(
            json!({ "type": "system", "subtype": "init" })
        )));
        assert!(is_hook_relevant(&event(json!({ "type": "assistant" }))));
        assert!(is_hook_relevant(&event(json!({ "type": "user" }))));
        assert!(is_hook_relevant(&event(
            json!({ "type": "result", "subtype": "success" })
        )));
        // Filtered out:
        assert!(!is_hook_relevant(&event(json!({ "type": "stream_event" }))));
        assert!(!is_hook_relevant(
            &json!({ "type": "sdk_session_id", "sessionId": "s" })
        ));
        assert!(!is_hook_relevant(&json!({ "type": "log", "message": "x" })));
    }

    #[test]
    fn unknown_messages_classify_to_nothing() {
        assert!(classify_sidecar_message(&json!({ "type": "log", "message": "x" })).is_empty());
        assert!(classify_sidecar_message(&event(json!({ "type": "stream_event" }))).is_empty());
        assert!(classify_sidecar_message(&event(json!({ "type": "assistant" }))).is_empty());
    }

    #[test]
    fn extract_tool_uses_reads_assistant_blocks() {
        let evt = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "text", "text": "hi" },
                { "type": "tool_use", "id": "tu1", "name": "Bash", "input": { "cmd": "ls" } }
            ]}
        });
        let uses = extract_tool_uses(&evt);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].0, "tu1");
        assert_eq!(uses[0].1, "Bash");
        assert_eq!(uses[0].2.get("cmd").unwrap(), "ls");
    }

    #[test]
    fn extract_tool_uses_ignores_non_assistant() {
        assert!(extract_tool_uses(&json!({ "type": "user" })).is_empty());
    }

    #[test]
    fn extract_tool_results_reads_user_blocks() {
        let evt = json!({
            "type": "user",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "tu1", "is_error": true, "content": "err" }
            ]}
        });
        let results = extract_tool_results(&evt);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "tu1");
        assert!(results[0].1);
    }

    #[test]
    fn extract_tool_results_defaults_is_error_false() {
        let evt = json!({
            "type": "user",
            "message": { "content": [ { "type": "tool_result", "tool_use_id": "tu2", "content": "ok" } ]}
        });
        let results = extract_tool_results(&evt);
        assert_eq!(results.len(), 1);
        assert!(!results[0].1);
    }
}
