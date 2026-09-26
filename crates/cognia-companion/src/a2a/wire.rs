//! A2A wire types — the subset of the Agent2Agent protocol (a2a-protocol.org,
//! v0.3 JSON-RPC transport) the cognia A2A *server* produces and consumes.
//!
//! Field names are camelCase on the wire. The JSON-RPC envelope helpers are
//! reused from the sibling ACP module (`super::super::acp::types`) so both
//! agent-facing surfaces agree on one JSON-RPC dialect.

use serde_json::{json, Value};

/// The A2A protocol version this server negotiates (JSON-RPC transport).
pub const A2A_PROTOCOL_VERSION: &str = "0.3.0";

/// A2A error codes (spec section 8.2), in addition to the standard JSON-RPC
/// ones reused from `acp::types::rpc_error_code`.
pub mod a2a_error_code {
    pub const TASK_NOT_FOUND: i64 = -32001;
    pub const TASK_NOT_CANCELABLE: i64 = -32002;
    pub const UNSUPPORTED_OPERATION: i64 = -32004;
}

/// A2A task lifecycle states (spec section 6.3, `TaskState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Submitted,
    Working,
    InputRequired,
    Completed,
    Failed,
    Canceled,
}

impl TaskState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskState::Submitted => "submitted",
            TaskState::Working => "working",
            TaskState::InputRequired => "input-required",
            TaskState::Completed => "completed",
            TaskState::Failed => "failed",
            TaskState::Canceled => "canceled",
        }
    }
}

/// Build a `TextPart` (`{kind:"text", text}`).
pub fn text_part(text: &str) -> Value {
    json!({ "kind": "text", "text": text })
}

/// Build an agent-role `Message` carrying a single text part.
pub fn agent_message(context_id: &str, task_id: &str, text: &str) -> Value {
    json!({
        "kind": "message",
        "role": "agent",
        "messageId": uuid::Uuid::new_v4().to_string(),
        "contextId": context_id,
        "taskId": task_id,
        "parts": [text_part(text)],
    })
}

/// Build a `TaskStatus` object (`{state, message?}`).
pub fn task_status(state: TaskState, message: Option<Value>) -> Value {
    let mut status = json!({ "state": state.as_str() });
    if let Some(message) = message {
        status["message"] = message;
    }
    status
}

/// Build an `Artifact` carrying a single text part.
pub fn text_artifact(artifact_id: &str, name: &str, text: &str) -> Value {
    json!({
        "artifactId": artifact_id,
        "name": name,
        "parts": [text_part(text)],
    })
}

/// Build a full `Task` object.
pub fn build_task(
    task_id: &str,
    context_id: &str,
    state: TaskState,
    artifacts: Vec<Value>,
    status_message: Option<Value>,
) -> Value {
    json!({
        "kind": "task",
        "id": task_id,
        "contextId": context_id,
        "status": task_status(state, status_message),
        "artifacts": artifacts,
    })
}

/// Convert an A2A `Message`'s `parts` into the cognia sidecar `SendContent`
/// shape (`lib/claude/types.ts`): text parts stay text; base64 image file
/// parts become `{type:"image", source:{type:"base64", …}}`; data parts and
/// non-image / URI file parts degrade to text so nothing is silently dropped.
///
/// Returns an error string when the message has no parts or a part is malformed.
pub fn message_parts_to_send_content(message: &Value) -> Result<Value, String> {
    let parts = message
        .get("parts")
        .and_then(Value::as_array)
        .ok_or_else(|| "message.parts must be an array".to_string())?;
    if parts.is_empty() {
        return Err("message.parts must not be empty".to_string());
    }

    let mut out: Vec<Value> = Vec::with_capacity(parts.len());
    for part in parts {
        match part.get("kind").and_then(Value::as_str) {
            Some("text") => {
                let text = part
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "text part missing `text`".to_string())?;
                out.push(json!({ "type": "text", "text": text }));
            }
            Some("data") => {
                let data = part.get("data").cloned().unwrap_or(Value::Null);
                out.push(json!({ "type": "text", "text": format!("[data]\n{data}") }));
            }
            Some("file") => {
                let file = part
                    .get("file")
                    .ok_or_else(|| "file part missing `file`".to_string())?;
                let name = file.get("name").and_then(Value::as_str).unwrap_or("file");
                let mime = file.get("mimeType").and_then(Value::as_str).unwrap_or("");
                if let Some(bytes) = file.get("bytes").and_then(Value::as_str) {
                    if mime.starts_with("image/") {
                        out.push(json!({
                            "type": "image",
                            "source": { "type": "base64", "media_type": mime, "data": bytes },
                        }));
                    } else {
                        out.push(json!({ "type": "text", "text": format!("[file {name}] (base64, {} chars)", bytes.len()) }));
                    }
                } else if let Some(uri) = file.get("uri").and_then(Value::as_str) {
                    out.push(json!({ "type": "text", "text": format!("[file {name}] {uri}") }));
                } else {
                    return Err("file part missing both `bytes` and `uri`".to_string());
                }
            }
            Some(other) => return Err(format!("unsupported part kind \"{other}\"")),
            None => return Err("part missing `kind`".to_string()),
        }
    }
    Ok(Value::Array(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_state_wire_values() {
        assert_eq!(TaskState::Submitted.as_str(), "submitted");
        assert_eq!(TaskState::Working.as_str(), "working");
        assert_eq!(TaskState::InputRequired.as_str(), "input-required");
        assert_eq!(TaskState::Completed.as_str(), "completed");
        assert_eq!(TaskState::Failed.as_str(), "failed");
        assert_eq!(TaskState::Canceled.as_str(), "canceled");
    }

    #[test]
    fn text_part_shape() {
        assert_eq!(text_part("hi"), json!({ "kind": "text", "text": "hi" }));
    }

    #[test]
    fn agent_message_shape() {
        let msg = agent_message("ctx-1", "task-1", "hello");
        assert_eq!(msg["kind"], "message");
        assert_eq!(msg["role"], "agent");
        assert_eq!(msg["contextId"], "ctx-1");
        assert_eq!(msg["taskId"], "task-1");
        assert_eq!(msg["parts"][0]["text"], "hello");
        assert!(msg["messageId"].as_str().is_some());
    }

    #[test]
    fn task_status_with_and_without_message() {
        let bare = task_status(TaskState::Working, None);
        assert_eq!(bare["state"], "working");
        assert!(bare.get("message").is_none());

        let with_msg = task_status(TaskState::Completed, Some(json!({ "kind": "message" })));
        assert_eq!(with_msg["state"], "completed");
        assert_eq!(with_msg["message"]["kind"], "message");
    }

    #[test]
    fn build_task_shape() {
        let artifact = text_artifact("response", "response", "answer");
        let task = build_task("t1", "c1", TaskState::Completed, vec![artifact], None);
        assert_eq!(task["kind"], "task");
        assert_eq!(task["id"], "t1");
        assert_eq!(task["contextId"], "c1");
        assert_eq!(task["status"]["state"], "completed");
        assert_eq!(task["artifacts"][0]["artifactId"], "response");
        assert_eq!(task["artifacts"][0]["parts"][0]["text"], "answer");
    }

    #[test]
    fn parts_text_and_data() {
        let message = json!({ "parts": [
            { "kind": "text", "text": "do the thing" },
            { "kind": "data", "data": { "k": "v" } },
        ]});
        let out = message_parts_to_send_content(&message).unwrap();
        let arr = out.as_array().unwrap();
        assert_eq!(arr[0], json!({ "type": "text", "text": "do the thing" }));
        assert_eq!(arr[1]["type"], "text");
        assert!(arr[1]["text"].as_str().unwrap().contains("\"k\":\"v\""));
    }

    #[test]
    fn parts_image_file_and_uri_file() {
        let message = json!({ "parts": [
            { "kind": "file", "file": { "name": "a.png", "mimeType": "image/png", "bytes": "aGk=" } },
            { "kind": "file", "file": { "name": "b.pdf", "uri": "https://x/b.pdf" } },
            { "kind": "file", "file": { "name": "c.bin", "mimeType": "application/octet-stream", "bytes": "AAAA" } },
        ]});
        let out = message_parts_to_send_content(&message).unwrap();
        let arr = out.as_array().unwrap();
        assert_eq!(arr[0]["type"], "image");
        assert_eq!(arr[0]["source"]["media_type"], "image/png");
        assert_eq!(arr[0]["source"]["data"], "aGk=");
        assert_eq!(arr[1]["type"], "text");
        assert_eq!(arr[1]["text"], "[file b.pdf] https://x/b.pdf");
        assert_eq!(arr[2]["type"], "text");
        assert!(arr[2]["text"].as_str().unwrap().contains("[file c.bin]"));
    }

    #[test]
    fn parts_rejects_bad_input() {
        assert!(message_parts_to_send_content(&json!({})).is_err());
        assert!(message_parts_to_send_content(&json!({ "parts": [] })).is_err());
        assert!(message_parts_to_send_content(&json!({ "parts": [{ "kind": "text" }] })).is_err());
        assert!(message_parts_to_send_content(&json!({ "parts": [{ "kind": "audio" }] })).is_err());
        assert!(message_parts_to_send_content(&json!({ "parts": [{ "kind": "file" }] })).is_err());
        assert!(message_parts_to_send_content(
            &json!({ "parts": [{ "kind": "file", "file": {} }] })
        )
        .is_err());
        assert!(message_parts_to_send_content(&json!({ "parts": [{ "text": "x" }] })).is_err());
    }
}
