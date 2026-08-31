//! Sidecar-event → ACP translation.
//!
//! The companion [`EventBus`](crate::companion_api::event_bus) republishes the
//! `claude://message` Tauri channel: each frame's payload is one `ClaudeEvent`
//! (see `lib/claude/types.ts`) — an SDK event envelope, a permission request,
//! a session-ended notice, etc. [`translate_frame`] reshapes one payload into
//! zero or more [`AcpOutbound`] actions the connection loop then executes
//! (send a `session/update`, resolve the pending `session/prompt`, fire a
//! `session/request_permission`, …).
//!
//! Translation is *almost* pure: a small per-turn [`TurnState`] deduplicates
//! tool calls (a `tool_use` block surfaces both in `content_block_start`
//! stream events and in the final `assistant` message) and suppresses the
//! duplicate full-text block when streaming deltas were already forwarded.

use serde_json::Value;
use std::collections::HashSet;

use super::types::{text_content, SessionUpdate, StopReason};

/// Per-turn translation state, reset when a new `session/prompt` starts.
#[derive(Debug, Default)]
pub struct TurnState {
    /// Tool-use ids already announced via a `tool_call` update.
    seen_tool_calls: HashSet<String>,
    /// Whether any `text_delta` stream events were forwarded this turn (the
    /// final `assistant` text block is then a duplicate and is skipped).
    saw_text_delta: bool,
    /// The most recent assistant `stop_reason` seen this turn. The `result`
    /// frame carries no stop reason of its own (only `subtype`/`is_error`), so
    /// we capture it here to distinguish `max_tokens` / `refusal` at turn end.
    last_stop_reason: Option<String>,
}

impl TurnState {
    pub fn reset(&mut self) {
        self.seen_tool_calls.clear();
        self.saw_text_delta = false;
        self.last_stop_reason = None;
    }
}

/// One translated action for the connection loop.
#[derive(Debug, PartialEq)]
pub enum AcpOutbound {
    /// Forward a `session/update` notification.
    Update(SessionUpdate),
    /// Fire a `session/request_permission` server→client request.
    PermissionRequest {
        request_id: String,
        tool_call_id: String,
        title: String,
        kind: String,
        raw_input: Value,
    },
    /// The turn ended — resolve the pending `session/prompt` with this reason.
    TurnEnded(StopReason),
    /// The turn failed — reject the pending `session/prompt` with this message.
    TurnFailed(String),
    /// The sidecar assigned its own session id (drives `session/load` resume).
    SdkSessionId(String),
}

/// Map a tool name onto an ACP tool-call `kind`.
pub fn tool_kind(tool_name: &str) -> &'static str {
    match tool_name {
        "Read" | "Glob" | "Grep" | "NotebookRead" => "read",
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "edit",
        "Bash" | "BashOutput" | "KillBash" => "execute",
        "WebFetch" | "WebSearch" => "fetch",
        "Task" => "think",
        _ => "other",
    }
}

/// Translate one `claude://message` payload for `session_id`.
///
/// Frames for other sessions (the bus is global) and event types with no ACP
/// projection (`log`, `ready`, `usage_headers`, `control_response`,
/// `plugin_tool_exec`, `system` frames, …) return an empty vec.
pub fn translate_frame(
    session_id: &str,
    payload: &Value,
    turn: &mut TurnState,
) -> Vec<AcpOutbound> {
    let frame_session = payload
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if frame_session != session_id {
        return Vec::new();
    }

    match payload.get("type").and_then(Value::as_str) {
        Some("event") => match payload.get("event") {
            Some(event) => translate_sdk_event(event, turn),
            None => Vec::new(),
        },
        Some("permission_request") => translate_permission_request(payload),
        Some("session_ended") => translate_session_ended(payload),
        Some("sdk_session_id") => payload
            .get("sdkSessionId")
            .and_then(Value::as_str)
            .map(|id| vec![AcpOutbound::SdkSessionId(id.to_string())])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// SDK event envelope (`{type:"event", sessionId, event: SDKMessage}`)
// ---------------------------------------------------------------------------

fn translate_sdk_event(event: &Value, turn: &mut TurnState) -> Vec<AcpOutbound> {
    match event.get("type").and_then(Value::as_str) {
        Some("stream_event") => translate_stream_event(event, turn),
        Some("assistant") => translate_assistant(event, turn),
        Some("user") => translate_user(event),
        Some("result") => translate_result(event, turn),
        Some("system") => translate_system(event),
        _ => Vec::new(),
    }
}

/// `SDKPartialAssistantMessage` — streaming deltas.
fn translate_stream_event(event: &Value, turn: &mut TurnState) -> Vec<AcpOutbound> {
    let Some(inner) = event.get("event") else {
        return Vec::new();
    };
    match inner.get("type").and_then(Value::as_str) {
        Some("content_block_delta") => {
            let Some(delta) = inner.get("delta") else {
                return Vec::new();
            };
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => {
                    let Some(text) = delta.get("text").and_then(Value::as_str) else {
                        return Vec::new();
                    };
                    turn.saw_text_delta = true;
                    vec![AcpOutbound::Update(SessionUpdate::AgentMessageChunk {
                        content: text_content(text),
                        message_id: event
                            .get("uuid")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })]
                }
                Some("thinking_delta") => {
                    let Some(thinking) = delta.get("thinking").and_then(Value::as_str) else {
                        return Vec::new();
                    };
                    vec![AcpOutbound::Update(SessionUpdate::AgentThoughtChunk {
                        content: text_content(thinking),
                        message_id: event
                            .get("uuid")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })]
                }
                _ => Vec::new(),
            }
        }
        Some("content_block_start") => {
            let Some(block) = inner.get("content_block") else {
                return Vec::new();
            };
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                return Vec::new();
            }
            tool_use_to_update(block, turn, "pending")
                .map(|u| vec![AcpOutbound::Update(u)])
                .unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

/// `SDKAssistantMessage` — the completed assistant message. Text blocks are
/// only forwarded when no streaming deltas were seen (non-streaming turns);
/// tool_use blocks upgrade already-announced calls to `in_progress`.
fn translate_assistant(event: &Value, turn: &mut TurnState) -> Vec<AcpOutbound> {
    let message = event.get("message");

    // Capture the assistant's stop reason for turn-end mapping. `tool_use` is
    // an intermediate stop (the turn continues), so ignore it — keep the last
    // *terminal* reason (`end_turn` / `max_tokens` / `refusal`).
    if let Some(stop_reason) = message
        .and_then(|m| m.get("stop_reason"))
        .and_then(Value::as_str)
    {
        if stop_reason != "tool_use" {
            turn.last_stop_reason = Some(stop_reason.to_string());
        }
    }

    let Some(blocks) = message
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if turn.saw_text_delta {
                    continue;
                }
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        out.push(AcpOutbound::Update(SessionUpdate::AgentMessageChunk {
                            content: text_content(text),
                            message_id: message
                                .and_then(|value| value.get("id"))
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        }));
                    }
                }
            }
            Some("tool_use") => {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                // TodoWrite is cognia's plan surface — project it as an ACP
                // `plan` update instead of a generic tool call.
                if name == "TodoWrite" {
                    if let Some(plan) = todo_write_to_plan(block) {
                        out.push(AcpOutbound::Update(plan));
                        continue;
                    }
                }
                if let Some(update) = tool_use_to_update(block, turn, "in_progress") {
                    out.push(AcpOutbound::Update(update));
                } else if let Some(id) = block.get("id").and_then(Value::as_str) {
                    // Already announced by content_block_start → status bump.
                    out.push(AcpOutbound::Update(SessionUpdate::ToolCallUpdate {
                        tool_call_id: id.to_string(),
                        status: "in_progress".to_string(),
                        content: None,
                        raw_output: None,
                    }));
                }
            }
            _ => {}
        }
    }
    if let Some(usage) = usage_to_update(message.and_then(|value| value.get("usage"))) {
        out.push(AcpOutbound::Update(usage));
    }
    out
}

fn usage_to_update(usage: Option<&Value>) -> Option<SessionUpdate> {
    let usage = usage?;
    let size = ["context_window", "contextWindow", "context_window_size"]
        .iter()
        .find_map(|key| usage.get(key).and_then(Value::as_u64))?;
    let used = [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .filter_map(|key| usage.get(key).and_then(Value::as_u64))
    .sum();
    Some(SessionUpdate::UsageUpdate {
        used,
        size,
        cost: None,
    })
}

/// Build a `tool_call` update from a `tool_use` block, deduplicating by id.
/// Returns `None` when this id was already announced.
fn tool_use_to_update(block: &Value, turn: &mut TurnState, status: &str) -> Option<SessionUpdate> {
    let id = block.get("id").and_then(Value::as_str)?;
    if !turn.seen_tool_calls.insert(id.to_string()) {
        return None;
    }
    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
    Some(SessionUpdate::ToolCall {
        tool_call_id: id.to_string(),
        title: name.to_string(),
        kind: tool_kind(name).to_string(),
        status: status.to_string(),
        raw_input: block.get("input").cloned(),
        locations: tool_locations(name, block.get("input")),
    })
}

fn tool_locations(tool_name: &str, input: Option<&Value>) -> Option<Value> {
    let input = input?;
    let path = ["file_path", "path", "notebook_path"]
        .iter()
        .find_map(|key| input.get(key).and_then(Value::as_str))?;
    if !matches!(
        tool_name,
        "Read" | "Edit" | "Write" | "MultiEdit" | "NotebookRead" | "NotebookEdit"
    ) {
        return None;
    }
    let mut location = serde_json::json!({ "path": path });
    if let Some(line) = input
        .get("line")
        .or_else(|| input.get("start_line"))
        .and_then(Value::as_u64)
    {
        location["line"] = serde_json::json!(line);
    }
    Some(serde_json::json!([location]))
}

/// Project a `TodoWrite` tool_use into an ACP `plan` update.
fn todo_write_to_plan(block: &Value) -> Option<SessionUpdate> {
    let todos = block
        .get("input")
        .and_then(|i| i.get("todos"))
        .and_then(Value::as_array)?;
    let entries = todos
        .iter()
        .map(|todo| {
            let content = todo
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let status = match todo.get("status").and_then(Value::as_str) {
                Some("in_progress") => "in_progress",
                Some("completed") => "completed",
                _ => "pending",
            };
            serde_json::json!({
                "content": content,
                "priority": "medium",
                "status": status,
            })
        })
        .collect();
    Some(SessionUpdate::Plan { entries })
}

/// `SDKUserMessage` — carries `tool_result` blocks closing tool calls.
fn translate_user(event: &Value) -> Vec<AcpOutbound> {
    let content = event.get("message").and_then(|m| m.get("content"));
    let message_id = event
        .get("uuid")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(text) = content.and_then(Value::as_str) {
        return vec![AcpOutbound::Update(SessionUpdate::UserMessageChunk {
            content: text_content(text),
            message_id,
        })];
    }
    let Some(blocks) = content.and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    out.push(AcpOutbound::Update(SessionUpdate::UserMessageChunk {
                        content: text_content(text),
                        message_id: message_id.clone(),
                    }));
                }
                continue;
            }
            Some("file") => {
                if let Some(source) = block.get("source") {
                    if source.get("type").and_then(Value::as_str) == Some("base64") {
                        if let (Some(blob), Some(mime_type)) = (
                            source.get("data").and_then(Value::as_str),
                            source.get("media_type").and_then(Value::as_str),
                        ) {
                            out.push(AcpOutbound::Update(SessionUpdate::UserMessageChunk {
                                content: serde_json::json!({
                                    "type": "resource",
                                    "resource": {
                                        "uri": format!("cognia://message/{}/file", message_id.as_deref().unwrap_or("unknown")),
                                        "mimeType": mime_type,
                                        "blob": blob,
                                    },
                                }),
                                message_id: message_id.clone(),
                            }));
                        }
                    }
                }
                continue;
            }
            Some("tool_result") => {}
            _ => continue,
        }
        let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) else {
            continue;
        };
        let is_error = block
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let content = block.get("content").map(|c| {
            serde_json::json!([{
                "type": "content",
                "content": { "type": "text", "text": tool_result_text(c) },
            }])
        });
        out.push(AcpOutbound::Update(SessionUpdate::ToolCallUpdate {
            tool_call_id: tool_use_id.to_string(),
            status: if is_error { "failed" } else { "completed" }.to_string(),
            content,
            raw_output: block.get("content").cloned(),
        }));
    }
    out
}

fn translate_system(event: &Value) -> Vec<AcpOutbound> {
    if event.get("subtype").and_then(Value::as_str) != Some("init") {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Some(commands) = event.get("slash_commands").and_then(Value::as_array) {
        let available_commands = commands
            .iter()
            .filter_map(|command| {
                if let Some(name) = command.as_str() {
                    return Some(serde_json::json!({
                        "name": name.trim_start_matches('/'),
                        "description": format!("Run /{}", name.trim_start_matches('/')),
                    }));
                }
                let name = command.get("name").and_then(Value::as_str)?;
                Some(serde_json::json!({
                    "name": name.trim_start_matches('/'),
                    "description": command
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("Run agent command"),
                }))
            })
            .collect();
        out.push(AcpOutbound::Update(
            SessionUpdate::AvailableCommandsUpdate { available_commands },
        ));
    }
    if let Some(mode) = event
        .get("permissionMode")
        .or_else(|| event.get("permission_mode"))
        .and_then(Value::as_str)
    {
        out.push(AcpOutbound::Update(SessionUpdate::CurrentModeUpdate {
            current_mode_id: mode.to_string(),
        }));
    }
    out
}

/// Flatten a tool_result `content` value (string or block array) to text.
fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

/// `SDKResultMessage` — the turn is over. The `result` frame carries no stop
/// reason itself, so the final assistant `stop_reason` (captured on `turn`)
/// distinguishes `max_tokens` / `refusal` from a plain `end_turn`.
fn translate_result(event: &Value, turn: &TurnState) -> Vec<AcpOutbound> {
    let subtype = event.get("subtype").and_then(Value::as_str).unwrap_or("");
    let is_error = event
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    match subtype {
        "error_max_turns" => vec![AcpOutbound::TurnEnded(StopReason::MaxTurnRequests)],
        _ if is_error => {
            let message = event
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("turn failed")
                .to_string();
            vec![AcpOutbound::TurnFailed(message)]
        }
        _ => {
            let reason = match turn.last_stop_reason.as_deref() {
                Some("max_tokens") => StopReason::MaxTokens,
                Some("refusal") => StopReason::Refusal,
                _ => StopReason::EndTurn,
            };
            vec![AcpOutbound::TurnEnded(reason)]
        }
    }
}

// ---------------------------------------------------------------------------
// Permission requests + session end
// ---------------------------------------------------------------------------

fn translate_permission_request(payload: &Value) -> Vec<AcpOutbound> {
    let Some(request_id) = payload.get("requestId").and_then(Value::as_str) else {
        return Vec::new();
    };
    let tool_name = payload
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let tool_call_id = payload
        .get("toolUseID")
        .and_then(Value::as_str)
        .unwrap_or(request_id);
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(tool_name);
    vec![AcpOutbound::PermissionRequest {
        request_id: request_id.to_string(),
        tool_call_id: tool_call_id.to_string(),
        title: title.to_string(),
        kind: tool_kind(tool_name).to_string(),
        raw_input: payload.get("input").cloned().unwrap_or(Value::Null),
    }]
}

fn translate_session_ended(payload: &Value) -> Vec<AcpOutbound> {
    match payload.get("error").and_then(Value::as_str) {
        Some(error) if !error.is_empty() => vec![AcpOutbound::TurnFailed(error.to_string())],
        _ => vec![AcpOutbound::TurnEnded(StopReason::EndTurn)],
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(session_id: &str, event: Value) -> Value {
        json!({ "type": "event", "sessionId": session_id, "event": event })
    }

    #[test]
    fn frames_for_other_sessions_are_dropped() {
        let mut turn = TurnState::default();
        let payload = envelope("other", json!({ "type": "result", "subtype": "success" }));
        assert!(translate_frame("mine", &payload, &mut turn).is_empty());
    }

    #[test]
    fn text_delta_becomes_message_chunk() {
        let mut turn = TurnState::default();
        let payload = envelope(
            "s1",
            json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "hel" },
                },
            }),
        );
        let out = translate_frame("s1", &payload, &mut turn);
        assert_eq!(
            out,
            vec![AcpOutbound::Update(SessionUpdate::AgentMessageChunk {
                content: text_content("hel"),
                message_id: None,
            })]
        );
        assert!(turn.saw_text_delta);
    }

    #[test]
    fn thinking_delta_becomes_thought_chunk() {
        let mut turn = TurnState::default();
        let payload = envelope(
            "s1",
            json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "thinking_delta", "thinking": "hmm" },
                },
            }),
        );
        let out = translate_frame("s1", &payload, &mut turn);
        assert_eq!(
            out,
            vec![AcpOutbound::Update(SessionUpdate::AgentThoughtChunk {
                content: text_content("hmm"),
                message_id: None,
            })]
        );
        assert!(!turn.saw_text_delta);
    }

    #[test]
    fn content_block_start_announces_pending_tool_call() {
        let mut turn = TurnState::default();
        let payload = envelope(
            "s1",
            json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "content_block": {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Bash",
                        "input": { "command": "ls" },
                    },
                },
            }),
        );
        let out = translate_frame("s1", &payload, &mut turn);
        assert_eq!(
            out,
            vec![AcpOutbound::Update(SessionUpdate::ToolCall {
                tool_call_id: "toolu_1".into(),
                title: "Bash".into(),
                kind: "execute".into(),
                status: "pending".into(),
                raw_input: Some(json!({ "command": "ls" })),
                locations: None,
            })]
        );
    }

    #[test]
    fn assistant_tool_use_after_stream_start_bumps_status() {
        let mut turn = TurnState::default();
        // First the stream announces it…
        let start = envelope(
            "s1",
            json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "content_block": { "type": "tool_use", "id": "toolu_1", "name": "Read", "input": {} },
                },
            }),
        );
        translate_frame("s1", &start, &mut turn);

        // …then the assistant message repeats the same block.
        let assistant = envelope(
            "s1",
            json!({
                "type": "assistant",
                "message": { "content": [
                    { "type": "tool_use", "id": "toolu_1", "name": "Read", "input": {} },
                ]},
            }),
        );
        let out = translate_frame("s1", &assistant, &mut turn);
        assert_eq!(
            out,
            vec![AcpOutbound::Update(SessionUpdate::ToolCallUpdate {
                tool_call_id: "toolu_1".into(),
                status: "in_progress".into(),
                content: None,
                raw_output: None,
            })]
        );
    }

    #[test]
    fn assistant_tool_use_without_stream_announces_in_progress() {
        let mut turn = TurnState::default();
        let assistant = envelope(
            "s1",
            json!({
                "type": "assistant",
                "message": { "content": [
                    { "type": "tool_use", "id": "toolu_9", "name": "WebSearch", "input": { "query": "x" } },
                ]},
            }),
        );
        let out = translate_frame("s1", &assistant, &mut turn);
        assert_eq!(
            out,
            vec![AcpOutbound::Update(SessionUpdate::ToolCall {
                tool_call_id: "toolu_9".into(),
                title: "WebSearch".into(),
                kind: "fetch".into(),
                status: "in_progress".into(),
                raw_input: Some(json!({ "query": "x" })),
                locations: None,
            })]
        );
    }

    #[test]
    fn assistant_text_skipped_after_deltas_forwarded_otherwise() {
        let assistant = envelope(
            "s1",
            json!({
                "type": "assistant",
                "message": { "content": [{ "type": "text", "text": "full answer" }] },
            }),
        );

        // Without deltas → forwarded once.
        let mut fresh = TurnState::default();
        let out = translate_frame("s1", &assistant, &mut fresh);
        assert_eq!(out.len(), 1);

        // With deltas already seen → suppressed.
        let mut streamed = TurnState {
            saw_text_delta: true,
            ..Default::default()
        };
        assert!(translate_frame("s1", &assistant, &mut streamed).is_empty());
    }

    #[test]
    fn todo_write_projects_to_plan() {
        let mut turn = TurnState::default();
        let assistant = envelope(
            "s1",
            json!({
                "type": "assistant",
                "message": { "content": [{
                    "type": "tool_use",
                    "id": "toolu_todo",
                    "name": "TodoWrite",
                    "input": { "todos": [
                        { "content": "step 1", "status": "completed" },
                        { "content": "step 2", "status": "in_progress" },
                        { "content": "step 3", "status": "pending" },
                    ]},
                }]},
            }),
        );
        let out = translate_frame("s1", &assistant, &mut turn);
        match &out[0] {
            AcpOutbound::Update(SessionUpdate::Plan { entries }) => {
                assert_eq!(entries.len(), 3);
                assert_eq!(entries[0]["status"], "completed");
                assert_eq!(entries[1]["status"], "in_progress");
                assert_eq!(entries[2]["content"], "step 3");
            }
            other => panic!("expected plan update, got {other:?}"),
        }
    }

    #[test]
    fn tool_result_closes_tool_call() {
        let mut turn = TurnState::default();
        let user = envelope(
            "s1",
            json!({
                "type": "user",
                "message": { "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": [{ "type": "text", "text": "ok" }],
                }]},
            }),
        );
        let out = translate_frame("s1", &user, &mut turn);
        match &out[0] {
            AcpOutbound::Update(SessionUpdate::ToolCallUpdate {
                tool_call_id,
                status,
                content,
                ..
            }) => {
                assert_eq!(tool_call_id, "toolu_1");
                assert_eq!(status, "completed");
                let content = content.as_ref().unwrap();
                assert_eq!(content[0]["content"]["text"], "ok");
            }
            other => panic!("expected tool_call_update, got {other:?}"),
        }
    }

    #[test]
    fn errored_tool_result_marks_failed() {
        let mut turn = TurnState::default();
        let user = envelope(
            "s1",
            json!({
                "type": "user",
                "message": { "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "is_error": true,
                    "content": "boom",
                }]},
            }),
        );
        let out = translate_frame("s1", &user, &mut turn);
        match &out[0] {
            AcpOutbound::Update(SessionUpdate::ToolCallUpdate { status, .. }) => {
                assert_eq!(status, "failed");
            }
            other => panic!("expected tool_call_update, got {other:?}"),
        }
    }

    #[test]
    fn result_stop_reason_matrix() {
        let mut turn = TurnState::default();

        let success = envelope("s1", json!({ "type": "result", "subtype": "success" }));
        assert_eq!(
            translate_frame("s1", &success, &mut turn),
            vec![AcpOutbound::TurnEnded(StopReason::EndTurn)]
        );

        let max_turns = envelope(
            "s1",
            json!({ "type": "result", "subtype": "error_max_turns", "is_error": true }),
        );
        assert_eq!(
            translate_frame("s1", &max_turns, &mut turn),
            vec![AcpOutbound::TurnEnded(StopReason::MaxTurnRequests)]
        );

        let errored = envelope(
            "s1",
            json!({ "type": "result", "subtype": "error", "is_error": true, "result": "bad" }),
        );
        assert_eq!(
            translate_frame("s1", &errored, &mut turn),
            vec![AcpOutbound::TurnFailed("bad".into())]
        );
    }

    #[test]
    fn result_maps_assistant_stop_reason() {
        // A `max_tokens` stop_reason on the assistant message carries through to
        // the turn-end stop reason (the result frame itself has none).
        let mut turn = TurnState::default();
        let assistant = envelope(
            "s1",
            json!({
                "type": "assistant",
                "message": { "stop_reason": "max_tokens", "content": [] },
            }),
        );
        translate_frame("s1", &assistant, &mut turn);
        let result = envelope("s1", json!({ "type": "result", "subtype": "success" }));
        assert_eq!(
            translate_frame("s1", &result, &mut turn),
            vec![AcpOutbound::TurnEnded(StopReason::MaxTokens)]
        );

        // `refusal` likewise.
        let mut turn = TurnState::default();
        let refused = envelope(
            "s1",
            json!({
                "type": "assistant",
                "message": { "stop_reason": "refusal", "content": [] },
            }),
        );
        translate_frame("s1", &refused, &mut turn);
        let result = envelope("s1", json!({ "type": "result", "subtype": "success" }));
        assert_eq!(
            translate_frame("s1", &result, &mut turn),
            vec![AcpOutbound::TurnEnded(StopReason::Refusal)]
        );

        // An intermediate `tool_use` stop must NOT override a later terminal
        // reason — and with no terminal reason we fall back to end_turn.
        let mut turn = TurnState::default();
        let tool_stop = envelope(
            "s1",
            json!({
                "type": "assistant",
                "message": {
                    "stop_reason": "tool_use",
                    "content": [{ "type": "tool_use", "id": "t1", "name": "Read", "input": {} }],
                },
            }),
        );
        translate_frame("s1", &tool_stop, &mut turn);
        let result = envelope("s1", json!({ "type": "result", "subtype": "success" }));
        assert_eq!(
            translate_frame("s1", &result, &mut turn),
            vec![AcpOutbound::TurnEnded(StopReason::EndTurn)]
        );
    }

    #[test]
    fn permission_request_translates() {
        let mut turn = TurnState::default();
        let payload = json!({
            "type": "permission_request",
            "sessionId": "s1",
            "requestId": "req-1",
            "toolUseID": "toolu_1",
            "toolName": "Bash",
            "input": { "command": "rm" },
        });
        let out = translate_frame("s1", &payload, &mut turn);
        assert_eq!(
            out,
            vec![AcpOutbound::PermissionRequest {
                request_id: "req-1".into(),
                tool_call_id: "toolu_1".into(),
                title: "Bash".into(),
                kind: "execute".into(),
                raw_input: json!({ "command": "rm" }),
            }]
        );
    }

    #[test]
    fn session_ended_resolves_or_fails() {
        let mut turn = TurnState::default();

        let clean = json!({ "type": "session_ended", "sessionId": "s1" });
        assert_eq!(
            translate_frame("s1", &clean, &mut turn),
            vec![AcpOutbound::TurnEnded(StopReason::EndTurn)]
        );

        let failed = json!({ "type": "session_ended", "sessionId": "s1", "error": "429" });
        assert_eq!(
            translate_frame("s1", &failed, &mut turn),
            vec![AcpOutbound::TurnFailed("429".into())]
        );
    }

    #[test]
    fn sdk_session_id_recorded() {
        let mut turn = TurnState::default();
        let payload = json!({
            "type": "sdk_session_id",
            "sessionId": "s1",
            "sdkSessionId": "sdk-abc",
        });
        assert_eq!(
            translate_frame("s1", &payload, &mut turn),
            vec![AcpOutbound::SdkSessionId("sdk-abc".into())]
        );
    }

    #[test]
    fn noise_event_types_are_dropped() {
        let mut turn = TurnState::default();
        for payload in [
            json!({ "type": "log", "sessionId": "s1", "level": "info", "message": "x" }),
            json!({ "type": "usage_headers", "sessionId": "s1", "headers": {} }),
            json!({ "type": "ready", "sessionId": "s1" }),
            envelope("s1", json!({ "type": "system", "subtype": "task_started" })),
        ] {
            assert!(
                translate_frame("s1", &payload, &mut turn).is_empty(),
                "expected {payload} to be dropped"
            );
        }
    }

    #[test]
    fn tool_kind_mapping() {
        assert_eq!(tool_kind("Read"), "read");
        assert_eq!(tool_kind("Grep"), "read");
        assert_eq!(tool_kind("Edit"), "edit");
        assert_eq!(tool_kind("Write"), "edit");
        assert_eq!(tool_kind("Bash"), "execute");
        assert_eq!(tool_kind("WebFetch"), "fetch");
        assert_eq!(tool_kind("Task"), "think");
        assert_eq!(tool_kind("SomethingElse"), "other");
    }

    #[test]
    fn turn_state_reset_clears_dedup() {
        let mut turn = TurnState {
            saw_text_delta: true,
            ..Default::default()
        };
        turn.seen_tool_calls.insert("toolu_1".into());
        turn.reset();
        assert!(!turn.saw_text_delta);
        assert!(turn.seen_tool_calls.is_empty());
    }
}
