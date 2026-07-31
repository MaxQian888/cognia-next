//! OpenAI **Responses API** ⇄ canonical IR translation.
//!
//! The Responses API (`POST /v1/responses`) is a different request/response
//! shape from Chat Completions, but its core is the same single-turn chat the
//! gateway already routes. We parse a Responses request INTO [`ChatIR`] (so it
//! reuses `request_from_ir` for every upstream protocol — openai AND anthropic
//! providers work) and render the upstream [`IrResponse`] back OUT into a
//! Responses object.
//!
//! Scope (MVP): plain text/image message turns. Stateful responses
//! (`previous_response_id`), tools, and streaming are rejected upstream in the
//! handler with an explicit 400 — never silently dropped.

use serde_json::{json, Value};

use super::errors::NotTranslatable;
use super::ir::{ChatIR, IrContent, IrImage, IrMessage, IrResponse, IrRole, IrStopReason};

/// Reason string if the request uses a feature `/v1/responses` does not
/// support (`stream`, `tools`, `previous_response_id`); `None` when supported.
/// The handler renders the reason as an explicit 400 — never a silent drop.
pub fn unsupported_feature(body: &Value) -> Option<String> {
    if body["stream"].as_bool().unwrap_or(false) {
        return Some(
            "streaming responses are not supported on /v1/responses (capability: non-streaming)"
                .to_string(),
        );
    }
    if body.get("tools").map(|t| !t.is_null()).unwrap_or(false) {
        return Some("tools are not yet supported on /v1/responses".to_string());
    }
    if body
        .get("previous_response_id")
        .map(|v| !v.is_null())
        .unwrap_or(false)
    {
        return Some(
            "previous_response_id (stateful responses) is not supported; send the full input each call"
                .to_string(),
        );
    }
    None
}

/// Parse an OpenAI Responses request body into the canonical [`ChatIR`].
pub fn request_to_ir(body: &Value) -> Result<ChatIR, NotTranslatable> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .ok_or_else(|| NotTranslatable::new("model is required".to_string()))?
        .to_string();

    // `instructions` is the system prompt. System/developer input items append.
    let mut system_parts: Vec<String> = Vec::new();
    if let Some(instructions) = body.get("instructions").and_then(Value::as_str) {
        if !instructions.trim().is_empty() {
            system_parts.push(instructions.to_string());
        }
    }

    let mut messages: Vec<IrMessage> = Vec::new();
    match body.get("input") {
        Some(Value::String(text)) => {
            messages.push(IrMessage {
                role: IrRole::User,
                content: vec![IrContent::Text(text.clone())],
            });
        }
        Some(Value::Array(items)) => {
            for item in items {
                let item_type = item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("message");
                if item_type != "message" {
                    return Err(NotTranslatable::new(format!(
                        "input item type \"{item_type}\" is not supported on /v1/responses"
                    )));
                }
                let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                let content = parse_content(item.get("content"))?;
                match role {
                    "system" | "developer" => {
                        for part in &content {
                            if let IrContent::Text(text) = part {
                                system_parts.push(text.clone());
                            }
                        }
                    }
                    "assistant" => messages.push(IrMessage {
                        role: IrRole::Assistant,
                        content,
                    }),
                    _ => messages.push(IrMessage {
                        role: IrRole::User,
                        content,
                    }),
                }
            }
        }
        _ => {
            return Err(NotTranslatable::new(
                "input is required (a string or an array of message items)".to_string(),
            ))
        }
    }

    if messages.is_empty() {
        return Err(NotTranslatable::new(
            "input produced no user/assistant messages".to_string(),
        ));
    }

    Ok(ChatIR {
        losses: Vec::new(),
        model,
        system: if system_parts.is_empty() {
            None
        } else {
            Some(system_parts.join("\n\n"))
        },
        messages,
        tools: Vec::new(),
        tool_choice: None,
        max_tokens: body.get("max_output_tokens").and_then(Value::as_u64),
        temperature: body.get("temperature").and_then(Value::as_f64),
        top_p: body.get("top_p").and_then(Value::as_f64),
        stop: Vec::new(),
        stream: false,
    })
}

/// Parse a Responses content field (string or array of content parts).
fn parse_content(content: Option<&Value>) -> Result<Vec<IrContent>, NotTranslatable> {
    match content {
        Some(Value::String(text)) => Ok(vec![IrContent::Text(text.clone())]),
        Some(Value::Array(parts)) => {
            let mut out = Vec::new();
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("input_text") | Some("output_text") | Some("text") => {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            out.push(IrContent::Text(text.to_string()));
                        }
                    }
                    Some("input_image") => {
                        if let Some(url) = image_url(part) {
                            out.push(IrContent::Image(IrImage::Url(url)));
                        } else {
                            return Err(NotTranslatable::new(
                                "input_image without a resolvable image_url is not supported"
                                    .to_string(),
                            ));
                        }
                    }
                    Some(other) => {
                        return Err(NotTranslatable::new(format!(
                            "content part type \"{other}\" is not supported"
                        )))
                    }
                    None => {}
                }
            }
            Ok(out)
        }
        Some(Value::Null) | None => Ok(Vec::new()),
        Some(other) => Err(NotTranslatable::new(format!(
            "unsupported content shape: {other}"
        ))),
    }
}

/// Resolve an `input_image` part's URL — accepts `image_url` as a bare string
/// or as `{ url }`.
fn image_url(part: &Value) -> Option<String> {
    match part.get("image_url") {
        Some(Value::String(url)) => Some(url.clone()),
        Some(obj) => obj.get("url").and_then(Value::as_str).map(str::to_string),
        None => None,
    }
}

/// Render a Responses object from the upstream canonical [`IrResponse`].
pub fn response_from_ir(resp: &IrResponse, model: &str, created: i64) -> Value {
    let mut text = String::new();
    for part in &resp.content {
        if let IrContent::Text(chunk) = part {
            text.push_str(chunk);
        }
    }

    let status = match resp.stop_reason {
        IrStopReason::MaxTokens => "incomplete",
        _ => "completed",
    };
    let response_id = format!("resp_{}", uuid::Uuid::new_v4().simple());
    let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());

    let mut out = json!({
        "id": response_id,
        "object": "response",
        "created_at": created,
        "status": status,
        "model": model,
        "output": [{
            "type": "message",
            "id": message_id,
            "status": "completed",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text, "annotations": [] }],
        }],
        "usage": {
            "input_tokens": resp.usage.input_tokens,
            "output_tokens": resp.usage.output_tokens,
            "total_tokens": resp.usage.input_tokens + resp.usage.output_tokens,
        },
    });
    if status == "incomplete" {
        out["incomplete_details"] = json!({ "reason": "max_output_tokens" });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_features_are_flagged() {
        assert!(unsupported_feature(&json!({ "stream": true })).is_some());
        assert!(unsupported_feature(&json!({ "tools": [{ "type": "function" }] })).is_some());
        assert!(unsupported_feature(&json!({ "previous_response_id": "resp_1" })).is_some());
        // Supported request → None.
        assert!(unsupported_feature(&json!({ "model": "m", "input": "hi" })).is_none());
        // Null / absent unsupported fields are fine.
        assert!(
            unsupported_feature(&json!({ "tools": null, "previous_response_id": null })).is_none()
        );
    }

    #[test]
    fn string_input_becomes_single_user_message() {
        let ir = request_to_ir(&json!({ "model": "gpt", "input": "hello" })).unwrap();
        assert_eq!(ir.model, "gpt");
        assert_eq!(ir.messages.len(), 1);
        assert_eq!(ir.messages[0].role, IrRole::User);
        assert_eq!(
            ir.messages[0].content,
            vec![IrContent::Text("hello".into())]
        );
        assert!(ir.system.is_none());
        assert!(!ir.stream);
    }

    #[test]
    fn instructions_and_options_map_across() {
        let ir = request_to_ir(&json!({
            "model": "m",
            "instructions": "be terse",
            "input": "hi",
            "max_output_tokens": 64,
            "temperature": 0.3,
            "top_p": 0.9,
        }))
        .unwrap();
        assert_eq!(ir.system.as_deref(), Some("be terse"));
        assert_eq!(ir.max_tokens, Some(64));
        assert_eq!(ir.temperature, Some(0.3));
        assert_eq!(ir.top_p, Some(0.9));
    }

    #[test]
    fn array_input_with_roles_and_parts() {
        let ir = request_to_ir(&json!({
            "model": "m",
            "input": [
                { "role": "system", "content": "sys rule" },
                { "role": "user", "content": [
                    { "type": "input_text", "text": "look at this" },
                    { "type": "input_image", "image_url": "https://x/y.png" },
                ]},
                { "role": "assistant", "content": [{ "type": "output_text", "text": "ok" }] },
            ],
        }))
        .unwrap();
        assert_eq!(ir.system.as_deref(), Some("sys rule"));
        assert_eq!(ir.messages.len(), 2);
        assert_eq!(ir.messages[0].role, IrRole::User);
        assert_eq!(
            ir.messages[0].content[0],
            IrContent::Text("look at this".into())
        );
        assert_eq!(
            ir.messages[0].content[1],
            IrContent::Image(IrImage::Url("https://x/y.png".into()))
        );
        assert_eq!(ir.messages[1].role, IrRole::Assistant);
    }

    #[test]
    fn image_url_object_form() {
        let ir = request_to_ir(&json!({
            "model": "m",
            "input": [{ "role": "user", "content": [
                { "type": "input_image", "image_url": { "url": "https://a/b.jpg" } },
            ]}],
        }))
        .unwrap();
        assert_eq!(
            ir.messages[0].content[0],
            IrContent::Image(IrImage::Url("https://a/b.jpg".into()))
        );
    }

    #[test]
    fn rejects_missing_model_and_input() {
        assert!(request_to_ir(&json!({ "input": "x" })).is_err());
        assert!(request_to_ir(&json!({ "model": "m" })).is_err());
        assert!(request_to_ir(&json!({ "model": "", "input": "x" })).is_err());
    }

    #[test]
    fn rejects_non_message_items_and_unknown_parts() {
        assert!(request_to_ir(&json!({
            "model": "m",
            "input": [{ "type": "function_call", "name": "f" }],
        }))
        .is_err());
        assert!(request_to_ir(&json!({
            "model": "m",
            "input": [{ "role": "user", "content": [{ "type": "input_audio" }] }],
        }))
        .is_err());
    }

    #[test]
    fn response_from_ir_completed_shape() {
        let resp = IrResponse {
            id: "up-1".into(),
            model: "gpt".into(),
            content: vec![IrContent::Text("the answer".into())],
            stop_reason: IrStopReason::Stop,
            usage: super::super::ir::IrUsage {
                input_tokens: 5,
                output_tokens: 3,
            },
        };
        let out = response_from_ir(&resp, "my-alias", 1234);
        assert_eq!(out["object"], "response");
        assert_eq!(out["status"], "completed");
        assert_eq!(out["model"], "my-alias");
        assert_eq!(out["created_at"], 1234);
        assert!(out["id"].as_str().unwrap().starts_with("resp_"));
        assert_eq!(out["output"][0]["type"], "message");
        assert_eq!(out["output"][0]["role"], "assistant");
        assert_eq!(out["output"][0]["content"][0]["type"], "output_text");
        assert_eq!(out["output"][0]["content"][0]["text"], "the answer");
        assert_eq!(out["usage"]["input_tokens"], 5);
        assert_eq!(out["usage"]["output_tokens"], 3);
        assert_eq!(out["usage"]["total_tokens"], 8);
        assert!(out.get("incomplete_details").is_none());
    }

    #[test]
    fn response_from_ir_incomplete_on_max_tokens() {
        let resp = IrResponse {
            id: "up-2".into(),
            model: "gpt".into(),
            content: vec![IrContent::Text("truncat".into())],
            stop_reason: IrStopReason::MaxTokens,
            usage: super::super::ir::IrUsage::default(),
        };
        let out = response_from_ir(&resp, "m", 0);
        assert_eq!(out["status"], "incomplete");
        assert_eq!(out["incomplete_details"]["reason"], "max_output_tokens");
    }
}
