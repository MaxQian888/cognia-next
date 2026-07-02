//! ACP wire types — JSON-RPC 2.0 envelope plus the subset of the Agent
//! Client Protocol (agentclientprotocol.com) the cognia ACP *server* speaks.
//!
//! The shapes deliberately mirror what cognia's own ACP *client*
//! (`lib/ai/agent/external/acp-client.ts`) sends and consumes, so both sides
//! of the codebase agree on one dialect of the spec (protocol version 1).
//! Field names are camelCase on the wire.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The single protocol version this server negotiates.
pub const ACP_PROTOCOL_VERSION: u64 = 1;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

/// One inbound JSON-RPC message (request, notification, or response).
///
/// A permissive shape: `method + id` → request, `method` only → notification,
/// `result`/`error` with `id` → response to a server-initiated request
/// (e.g. `session/request_permission`).
#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcIncoming {
    #[serde(default)]
    pub jsonrpc: Option<String>,
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<Value>,
}

impl JsonRpcIncoming {
    pub fn is_request(&self) -> bool {
        self.method.is_some() && self.id.is_some()
    }

    pub fn is_notification(&self) -> bool {
        self.method.is_some() && self.id.is_none()
    }

    pub fn is_response(&self) -> bool {
        self.method.is_none() && self.id.is_some()
    }
}

/// JSON-RPC error codes used by this server.
pub mod rpc_error_code {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// ACP auth-required error (spec-defined).
    pub const AUTH_REQUIRED: i64 = -32000;
}

/// Serialize a JSON-RPC success response.
pub fn rpc_response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Serialize a JSON-RPC error response.
pub fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

/// Serialize a JSON-RPC notification.
pub fn rpc_notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

/// Serialize a server→client JSON-RPC request.
pub fn rpc_request(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

// ---------------------------------------------------------------------------
// ACP: initialize
// ---------------------------------------------------------------------------

/// Build the `initialize` result advertising this server's capabilities.
///
/// Mirrors what `acp-client.ts` negotiates: `protocolVersion`, an
/// `agentCapabilities` object, and `agentInfo`. `loadSession: true` because
/// the global resume index supports `session/load` across reconnects.
pub fn initialize_result() -> Value {
    json!({
        "protocolVersion": ACP_PROTOCOL_VERSION,
        "agentCapabilities": {
            "loadSession": true,
            "promptCapabilities": {
                "image": true,
                "audio": false,
                "embeddedContext": true,
            },
        },
        "agentInfo": {
            "name": "cognia",
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

// ---------------------------------------------------------------------------
// ACP: session/prompt content blocks → cognia SendContent blocks
// ---------------------------------------------------------------------------

/// Convert ACP prompt content blocks into the sidecar `SendContent` shape
/// (`lib/claude/types.ts`): text blocks stay text; base64 images become
/// `{type:"image", source:{type:"base64", media_type, data}}`; resources and
/// resource links degrade to text so no content is silently dropped.
///
/// Returns an error string when the prompt is empty or malformed.
pub fn prompt_blocks_to_send_content(prompt: &Value) -> Result<Value, String> {
    let blocks = prompt
        .as_array()
        .ok_or_else(|| "prompt must be an array of content blocks".to_string())?;
    if blocks.is_empty() {
        return Err("prompt must not be empty".to_string());
    }

    let mut out: Vec<Value> = Vec::with_capacity(blocks.len());
    for block in blocks {
        let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
        match block_type {
            "text" => {
                let text = block
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "text block missing `text`".to_string())?;
                out.push(json!({ "type": "text", "text": text }));
            }
            "image" => {
                let mime = block
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png");
                if let Some(data) = block.get("data").and_then(Value::as_str) {
                    out.push(json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": mime, "data": data },
                    }));
                } else if let Some(uri) = block.get("uri").and_then(Value::as_str) {
                    out.push(json!({ "type": "text", "text": format!("[image] {uri}") }));
                } else {
                    return Err("image block missing both `data` and `uri`".to_string());
                }
            }
            "resource_link" => {
                let uri = block
                    .get("uri")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "resource_link block missing `uri`".to_string())?;
                out.push(json!({ "type": "text", "text": format!("[resource] {uri}") }));
            }
            "resource" => {
                let resource = block
                    .get("resource")
                    .ok_or_else(|| "resource block missing `resource`".to_string())?;
                let uri = resource.get("uri").and_then(Value::as_str).unwrap_or("");
                match resource.get("text").and_then(Value::as_str) {
                    Some(text) => out.push(json!({
                        "type": "text",
                        "text": format!("[resource {uri}]\n{text}"),
                    })),
                    None => out.push(json!({ "type": "text", "text": format!("[resource] {uri}") })),
                }
            }
            other => {
                return Err(format!("unsupported prompt block type \"{other}\""));
            }
        }
    }
    Ok(Value::Array(out))
}

// ---------------------------------------------------------------------------
// ACP: session/update variants (server → client notifications)
// ---------------------------------------------------------------------------

/// One `session/update` payload — the `update` object inside the
/// notification params. Serialized with the `sessionUpdate` discriminator
/// exactly as `acp-client.ts` consumes it (`handleSessionUpdate`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
pub enum SessionUpdate {
    AgentMessageChunk {
        content: Value,
    },
    AgentThoughtChunk {
        content: Value,
    },
    ToolCall {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        title: String,
        kind: String,
        status: String,
        #[serde(rename = "rawInput", skip_serializing_if = "Option::is_none")]
        raw_input: Option<Value>,
    },
    ToolCallUpdate {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Value>,
        #[serde(rename = "rawOutput", skip_serializing_if = "Option::is_none")]
        raw_output: Option<Value>,
    },
    Plan {
        entries: Vec<Value>,
    },
}

/// Wrap a [`SessionUpdate`] into the full `session/update` notification.
pub fn session_update_notification(session_id: &str, update: &SessionUpdate) -> Value {
    rpc_notification(
        "session/update",
        json!({
            "sessionId": session_id,
            "update": serde_json::to_value(update).unwrap_or(Value::Null),
        }),
    )
}

/// Build a text content object (`{type:"text", text}`) used inside chunks.
pub fn text_content(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

// ---------------------------------------------------------------------------
// ACP: permission request (server → client request)
// ---------------------------------------------------------------------------

/// The three options cognia offers on every permission prompt. Option ids
/// double as the `claude_approve` decision they map back to.
pub fn permission_options() -> Value {
    json!([
        { "optionId": "allow", "name": "Allow once", "kind": "allow_once" },
        { "optionId": "allow_always", "name": "Always allow", "kind": "allow_always" },
        { "optionId": "deny", "name": "Reject", "kind": "reject_once" },
    ])
}

/// Build the params for a `session/request_permission` server→client request.
/// The tool-call fields are nested under `toolCall` per the ACP spec
/// (`RequestPermissionRequest = { sessionId, toolCall, options }`).
pub fn permission_request_params(
    session_id: &str,
    tool_call_id: &str,
    title: &str,
    kind: &str,
    raw_input: &Value,
) -> Value {
    json!({
        "sessionId": session_id,
        "toolCall": {
            "toolCallId": tool_call_id,
            "title": title,
            "kind": kind,
            "rawInput": raw_input,
        },
        "options": permission_options(),
    })
}

/// Map a permission-response outcome back onto a `claude_approve` decision.
/// `selected` with a known option id maps directly; anything else (cancelled,
/// unknown option) denies — fail closed.
pub fn outcome_to_decision(outcome: &Value) -> String {
    let outcome_obj = outcome.get("outcome").unwrap_or(outcome);
    let kind = outcome_obj
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or("cancelled");
    if kind != "selected" {
        return "deny".to_string();
    }
    match outcome_obj.get("optionId").and_then(Value::as_str) {
        Some("allow") => "allow".to_string(),
        Some("allow_always") => "allow_always".to_string(),
        _ => "deny".to_string(),
    }
}

// ---------------------------------------------------------------------------
// ACP: stop reasons
// ---------------------------------------------------------------------------

/// ACP `stopReason` values for the `session/prompt` result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
}

impl StopReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            StopReason::EndTurn => "end_turn",
            StopReason::MaxTokens => "max_tokens",
            StopReason::MaxTurnRequests => "max_turn_requests",
            StopReason::Refusal => "refusal",
            StopReason::Cancelled => "cancelled",
        }
    }
}

/// Build the `session/prompt` result payload.
pub fn prompt_result(stop_reason: StopReason) -> Value {
    json!({ "stopReason": stop_reason.as_str() })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incoming_classification() {
        let req: JsonRpcIncoming =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)
                .unwrap();
        assert!(req.is_request());
        assert!(!req.is_notification());
        assert!(!req.is_response());

        let notif: JsonRpcIncoming = serde_json::from_str(
            r#"{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}"#,
        )
        .unwrap();
        assert!(notif.is_notification());
        assert!(!notif.is_request());

        let resp: JsonRpcIncoming = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":7,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}}"#,
        )
        .unwrap();
        assert!(resp.is_response());
        assert!(!resp.is_request());
    }

    #[test]
    fn response_and_error_shapes() {
        let resp = rpc_response(&serde_json::json!(3), serde_json::json!({"ok": true}));
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 3);
        assert_eq!(resp["result"]["ok"], true);

        let err = rpc_error(
            &serde_json::json!("abc"),
            rpc_error_code::METHOD_NOT_FOUND,
            "nope",
        );
        assert_eq!(err["error"]["code"], -32601);
        assert_eq!(err["error"]["message"], "nope");
        assert_eq!(err["id"], "abc");
    }

    #[test]
    fn initialize_result_shape() {
        let v = initialize_result();
        assert_eq!(v["protocolVersion"], 1);
        assert_eq!(v["agentCapabilities"]["loadSession"], true);
        assert_eq!(v["agentInfo"]["name"], "cognia");
        assert!(v["agentInfo"]["version"].as_str().is_some());
    }

    #[test]
    fn prompt_blocks_text_and_image() {
        let blocks = json!([
            { "type": "text", "text": "hello" },
            { "type": "image", "data": "aGk=", "mimeType": "image/jpeg" },
        ]);
        let out = prompt_blocks_to_send_content(&blocks).unwrap();
        let arr = out.as_array().unwrap();
        assert_eq!(arr[0], json!({ "type": "text", "text": "hello" }));
        assert_eq!(arr[1]["type"], "image");
        assert_eq!(arr[1]["source"]["media_type"], "image/jpeg");
        assert_eq!(arr[1]["source"]["data"], "aGk=");
    }

    #[test]
    fn prompt_blocks_resources_degrade_to_text() {
        let blocks = json!([
            { "type": "resource_link", "uri": "file:///a.rs" },
            { "type": "resource", "resource": { "uri": "file:///b.rs", "text": "fn main() {}" } },
            { "type": "image", "uri": "https://x/y.png", "mimeType": "image/png" },
        ]);
        let out = prompt_blocks_to_send_content(&blocks).unwrap();
        let arr = out.as_array().unwrap();
        assert_eq!(arr[0]["text"], "[resource] file:///a.rs");
        assert!(arr[1]["text"]
            .as_str()
            .unwrap()
            .contains("fn main() {}"));
        assert_eq!(arr[2]["text"], "[image] https://x/y.png");
    }

    #[test]
    fn prompt_blocks_rejects_bad_input() {
        assert!(prompt_blocks_to_send_content(&json!("not an array")).is_err());
        assert!(prompt_blocks_to_send_content(&json!([])).is_err());
        assert!(prompt_blocks_to_send_content(&json!([{ "type": "audio" }])).is_err());
        assert!(prompt_blocks_to_send_content(&json!([{ "type": "text" }])).is_err());
        assert!(prompt_blocks_to_send_content(&json!([{ "type": "image" }])).is_err());
        assert!(prompt_blocks_to_send_content(&json!([{ "type": "resource_link" }])).is_err());
        assert!(prompt_blocks_to_send_content(&json!([{ "type": "resource" }])).is_err());
    }

    #[test]
    fn session_update_serializes_with_discriminator() {
        let update = SessionUpdate::AgentMessageChunk {
            content: text_content("hi"),
        };
        let v = serde_json::to_value(&update).unwrap();
        assert_eq!(v["sessionUpdate"], "agent_message_chunk");
        assert_eq!(v["content"]["text"], "hi");

        let tool = SessionUpdate::ToolCall {
            tool_call_id: "t1".into(),
            title: "Bash".into(),
            kind: "execute".into(),
            status: "pending".into(),
            raw_input: Some(json!({"command": "ls"})),
        };
        let v = serde_json::to_value(&tool).unwrap();
        assert_eq!(v["sessionUpdate"], "tool_call");
        assert_eq!(v["toolCallId"], "t1");
        assert_eq!(v["rawInput"]["command"], "ls");

        let upd = SessionUpdate::ToolCallUpdate {
            tool_call_id: "t1".into(),
            status: "completed".into(),
            content: None,
            raw_output: None,
        };
        let v = serde_json::to_value(&upd).unwrap();
        assert_eq!(v["sessionUpdate"], "tool_call_update");
        assert!(v.get("content").is_none());
        assert!(v.get("rawOutput").is_none());
    }

    #[test]
    fn session_update_notification_envelope() {
        let update = SessionUpdate::Plan {
            entries: vec![json!({"content": "step 1", "priority": "medium", "status": "pending"})],
        };
        let v = session_update_notification("sess-1", &update);
        assert_eq!(v["method"], "session/update");
        assert_eq!(v["params"]["sessionId"], "sess-1");
        assert_eq!(v["params"]["update"]["sessionUpdate"], "plan");
        assert!(v.get("id").is_none());
    }

    #[test]
    fn permission_request_shape() {
        let params = permission_request_params(
            "sess-1",
            "toolu_1",
            "Bash",
            "execute",
            &json!({"command": "rm -rf"}),
        );
        assert_eq!(params["sessionId"], "sess-1");
        assert_eq!(params["toolCall"]["toolCallId"], "toolu_1");
        assert_eq!(params["toolCall"]["kind"], "execute");
        let options = params["options"].as_array().unwrap();
        assert_eq!(options.len(), 3);
        assert_eq!(options[0]["optionId"], "allow");
        assert_eq!(options[1]["kind"], "allow_always");
        assert_eq!(options[2]["kind"], "reject_once");
    }

    #[test]
    fn outcome_decision_mapping() {
        let selected = json!({ "outcome": { "outcome": "selected", "optionId": "allow" } });
        assert_eq!(outcome_to_decision(&selected), "allow");

        let always = json!({ "outcome": { "outcome": "selected", "optionId": "allow_always" } });
        assert_eq!(outcome_to_decision(&always), "allow_always");

        let deny = json!({ "outcome": { "outcome": "selected", "optionId": "deny" } });
        assert_eq!(outcome_to_decision(&deny), "deny");

        let cancelled = json!({ "outcome": { "outcome": "cancelled" } });
        assert_eq!(outcome_to_decision(&cancelled), "deny");

        // Flat shape (no nested outcome object) also fails closed.
        assert_eq!(outcome_to_decision(&json!({})), "deny");
        let unknown = json!({ "outcome": { "outcome": "selected", "optionId": "wat" } });
        assert_eq!(outcome_to_decision(&unknown), "deny");
    }

    #[test]
    fn stop_reason_wire_values() {
        assert_eq!(prompt_result(StopReason::EndTurn)["stopReason"], "end_turn");
        assert_eq!(
            prompt_result(StopReason::MaxTurnRequests)["stopReason"],
            "max_turn_requests"
        );
        assert_eq!(
            prompt_result(StopReason::Cancelled)["stopReason"],
            "cancelled"
        );
        assert_eq!(prompt_result(StopReason::Refusal)["stopReason"], "refusal");
        assert_eq!(
            prompt_result(StopReason::MaxTokens)["stopReason"],
            "max_tokens"
        );
    }
}
