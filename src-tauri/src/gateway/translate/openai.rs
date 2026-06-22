//! OpenAI chat-completions ⇄ ChatIR.
//!
//! Notable asymmetries handled here:
//!   - tool-call `arguments` is a JSON **string** on the wire (Anthropic's
//!     `input` is an object) — parsed/stringified at this boundary,
//!   - `role:"tool"` result messages normalize into user-role
//!     `IrContent::ToolResult` blocks (Anthropic's carrier shape),
//!   - leading/interleaved `system` messages concatenate into `ir.system`.

use serde_json::{json, Map, Value};

use super::errors::NotTranslatable;
use super::ir::{
    ChatIR, IrContent, IrImage, IrMessage, IrResponse, IrRole, IrStopReason, IrToolChoice,
    IrToolDef, IrUsage,
};

fn s(v: &Value) -> Option<String> {
    v.as_str().map(|x| x.to_string())
}

/// Parse an OpenAI `image_url.url` (a remote URL or a `data:` base64 URI).
fn parse_openai_image(url: &Value) -> Result<IrImage, NotTranslatable> {
    let url = url
        .as_str()
        .ok_or_else(|| NotTranslatable::new("image_url.url is required"))?;
    if let Some(rest) = url.strip_prefix("data:") {
        // data:<media_type>;base64,<data>
        let (meta, data) = rest
            .split_once(',')
            .ok_or_else(|| NotTranslatable::new("malformed data: image URL"))?;
        let media_type = meta.split(';').next().unwrap_or("image/png").to_string();
        return Ok(IrImage::Base64 {
            media_type,
            data: data.to_string(),
        });
    }
    Ok(IrImage::Url(url.to_string()))
}

/// Render an IR image as an OpenAI `image_url` part (base64 → `data:` URI).
fn openai_image_part(image: &IrImage) -> Value {
    let url = match image {
        IrImage::Url(url) => url.clone(),
        IrImage::Base64 { media_type, data } => format!("data:{media_type};base64,{data}"),
    };
    json!({ "type": "image_url", "image_url": { "url": url } })
}

/// Parse an OpenAI chat-completions request body into the IR.
pub fn to_ir(body: &Value) -> Result<ChatIR, NotTranslatable> {
    let model = s(&body["model"]).ok_or_else(|| NotTranslatable::new("model is required"))?;

    if body.get("n").and_then(Value::as_u64).unwrap_or(1) > 1 {
        return Err(NotTranslatable::new(
            "n > 1 is not supported by the gateway",
        ));
    }
    if body.get("logprobs").and_then(Value::as_bool) == Some(true) {
        return Err(NotTranslatable::new("logprobs is not translatable"));
    }

    let mut ir = ChatIR {
        model,
        stream: body.get("stream").and_then(Value::as_bool).unwrap_or(false),
        max_tokens: body
            .get("max_tokens")
            .or_else(|| body.get("max_completion_tokens"))
            .and_then(Value::as_u64),
        temperature: body.get("temperature").and_then(Value::as_f64),
        top_p: body.get("top_p").and_then(Value::as_f64),
        ..Default::default()
    };

    match body.get("stop") {
        Some(Value::String(one)) => ir.stop.push(one.clone()),
        Some(Value::Array(many)) => {
            for v in many {
                if let Some(x) = v.as_str() {
                    ir.stop.push(x.to_string());
                }
            }
        }
        _ => {}
    }

    // Tools.
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        for t in tools {
            let f = &t["function"];
            let name = s(&f["name"])
                .ok_or_else(|| NotTranslatable::new("tools[].function.name is required"))?;
            ir.tools.push(IrToolDef {
                name,
                description: s(&f["description"]),
                input_schema: f.get("parameters").cloned().unwrap_or_else(|| json!({})),
            });
        }
    }
    ir.tool_choice = match body.get("tool_choice") {
        Some(Value::String(mode)) => match mode.as_str() {
            "auto" => Some(IrToolChoice::Auto),
            "required" => Some(IrToolChoice::Any),
            "none" => Some(IrToolChoice::None),
            _ => None,
        },
        Some(Value::Object(o)) => s(&o["function"]["name"]).map(IrToolChoice::Tool),
        _ => None,
    };

    // Messages.
    let messages = body["messages"]
        .as_array()
        .ok_or_else(|| NotTranslatable::new("messages array is required"))?;
    let mut system_parts: Vec<String> = Vec::new();

    for msg in messages {
        let role = s(&msg["role"]).unwrap_or_default();
        match role.as_str() {
            "system" | "developer" => {
                if let Some(text) = content_to_text(&msg["content"])? {
                    system_parts.push(text);
                }
            }
            "user" => {
                let mut content = Vec::new();
                match &msg["content"] {
                    Value::String(text) => content.push(IrContent::Text(text.clone())),
                    Value::Array(parts) => {
                        for part in parts {
                            match s(&part["type"]).as_deref() {
                                Some("text") => {
                                    content.push(IrContent::Text(
                                        s(&part["text"]).unwrap_or_default(),
                                    ));
                                }
                                Some("image_url") => {
                                    content.push(IrContent::Image(parse_openai_image(
                                        &part["image_url"]["url"],
                                    )?));
                                }
                                other => {
                                    return Err(NotTranslatable::new(format!(
                                        "unsupported content part type: {}",
                                        other.unwrap_or("?")
                                    )));
                                }
                            }
                        }
                    }
                    _ => {}
                }
                ir.messages.push(IrMessage {
                    role: IrRole::User,
                    content,
                });
            }
            "assistant" => {
                let mut content = Vec::new();
                if let Some(text) = content_to_text(&msg["content"])? {
                    if !text.is_empty() {
                        content.push(IrContent::Text(text));
                    }
                }
                if let Some(calls) = msg.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        let id = s(&call["id"]).unwrap_or_default();
                        let name = s(&call["function"]["name"]).unwrap_or_default();
                        // Wire `arguments` is a JSON string — parse it here.
                        let raw_args = s(&call["function"]["arguments"]).unwrap_or_default();
                        let input: Value =
                            serde_json::from_str(&raw_args).unwrap_or_else(|_| json!({}));
                        content.push(IrContent::ToolUse { id, name, input });
                    }
                }
                ir.messages.push(IrMessage {
                    role: IrRole::Assistant,
                    content,
                });
            }
            "tool" => {
                // Normalize into a user-role ToolResult block; consecutive
                // tool messages merge into ONE user message (Anthropic
                // requires the results directly after the tool_use turn).
                let block = IrContent::ToolResult {
                    tool_use_id: s(&msg["tool_call_id"]).unwrap_or_default(),
                    content: content_to_text(&msg["content"])?.unwrap_or_default(),
                    is_error: false,
                };
                match ir.messages.last_mut() {
                    Some(last)
                        if last.role == IrRole::User
                            && last
                                .content
                                .iter()
                                .all(|c| matches!(c, IrContent::ToolResult { .. })) =>
                    {
                        last.content.push(block);
                    }
                    _ => ir.messages.push(IrMessage {
                        role: IrRole::User,
                        content: vec![block],
                    }),
                }
            }
            other => {
                return Err(NotTranslatable::new(format!("unsupported role: {other}")));
            }
        }
    }

    if !system_parts.is_empty() {
        ir.system = Some(system_parts.join("\n\n"));
    }
    Ok(ir)
}

fn content_to_text(content: &Value) -> Result<Option<String>, NotTranslatable> {
    match content {
        Value::String(text) => Ok(Some(text.clone())),
        Value::Array(parts) => {
            let mut out = String::new();
            for part in parts {
                match s(&part["type"]).as_deref() {
                    Some("text") => out.push_str(part["text"].as_str().unwrap_or_default()),
                    // Images on a system/assistant/tool message are unusual but
                    // not text — ignore here (user-message images are parsed in
                    // the dedicated branch above).
                    Some("image_url") => {}
                    _ => {}
                }
            }
            Ok(Some(out))
        }
        Value::Null => Ok(None),
        _ => Ok(None),
    }
}

/// Render an OpenAI chat-completions REQUEST from the IR (toward an
/// openai-protocol upstream).
pub fn from_ir(ir: &ChatIR) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = &ir.system {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for msg in &ir.messages {
        match msg.role {
            IrRole::User => {
                // Split text vs tool results: results become role:"tool" rows.
                let texts: Vec<&str> = msg
                    .content
                    .iter()
                    .filter_map(|c| match c {
                        IrContent::Text(t) => Some(t.as_str()),
                        _ => None,
                    })
                    .collect();
                for c in &msg.content {
                    if let IrContent::ToolResult {
                        tool_use_id,
                        content,
                        ..
                    } = c
                    {
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": tool_use_id,
                            "content": content,
                        }));
                    }
                }
                let images: Vec<&IrImage> = msg
                    .content
                    .iter()
                    .filter_map(|c| match c {
                        IrContent::Image(img) => Some(img),
                        _ => None,
                    })
                    .collect();
                if images.is_empty() {
                    if !texts.is_empty() {
                        messages.push(json!({ "role": "user", "content": texts.join("\n") }));
                    }
                } else {
                    // Mixed text+image → the multimodal content-array shape.
                    let mut parts: Vec<Value> = Vec::new();
                    if !texts.is_empty() {
                        parts.push(json!({ "type": "text", "text": texts.join("\n") }));
                    }
                    for img in images {
                        parts.push(openai_image_part(img));
                    }
                    messages.push(json!({ "role": "user", "content": parts }));
                }
            }
            IrRole::Assistant => {
                let mut obj = Map::new();
                obj.insert("role".into(), json!("assistant"));
                let text: String = msg
                    .content
                    .iter()
                    .filter_map(|c| match c {
                        IrContent::Text(t) => Some(t.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                let tool_calls: Vec<Value> = msg
                    .content
                    .iter()
                    .filter_map(|c| match c {
                        IrContent::ToolUse { id, name, input } => Some(json!({
                            "id": id,
                            "type": "function",
                            "function": {
                                "name": name,
                                // Wire `arguments` must be a STRING.
                                "arguments": serde_json::to_string(input)
                                    .unwrap_or_else(|_| "{}".into()),
                            }
                        })),
                        _ => None,
                    })
                    .collect();
                obj.insert(
                    "content".into(),
                    if text.is_empty() {
                        Value::Null
                    } else {
                        json!(text)
                    },
                );
                if !tool_calls.is_empty() {
                    obj.insert("tool_calls".into(), json!(tool_calls));
                }
                messages.push(Value::Object(obj));
            }
        }
    }

    let mut out = json!({ "model": ir.model, "messages": messages, "stream": ir.stream });
    if ir.stream {
        out["stream_options"] = json!({ "include_usage": true });
    }
    if !ir.tools.is_empty() {
        out["tools"] = Value::Array(
            ir.tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.input_schema,
                        }
                    })
                })
                .collect(),
        );
    }
    match &ir.tool_choice {
        Some(IrToolChoice::Auto) => out["tool_choice"] = json!("auto"),
        Some(IrToolChoice::Any) => out["tool_choice"] = json!("required"),
        Some(IrToolChoice::None) => out["tool_choice"] = json!("none"),
        Some(IrToolChoice::Tool(name)) => {
            out["tool_choice"] = json!({ "type": "function", "function": { "name": name } })
        }
        None => {}
    }
    if let Some(max) = ir.max_tokens {
        out["max_tokens"] = json!(max);
    }
    if let Some(t) = ir.temperature {
        out["temperature"] = json!(t);
    }
    if let Some(p) = ir.top_p {
        out["top_p"] = json!(p);
    }
    if !ir.stop.is_empty() {
        out["stop"] = json!(ir.stop);
    }
    out
}

/// Parse an OpenAI NON-STREAMING response into the canonical response.
pub fn response_to_ir(body: &Value) -> Result<IrResponse, NotTranslatable> {
    let choice = body["choices"]
        .as_array()
        .and_then(|c| c.first())
        .ok_or_else(|| NotTranslatable::new("upstream response has no choices"))?;
    let message = &choice["message"];
    let mut content = Vec::new();
    if let Some(text) = message["content"].as_str() {
        if !text.is_empty() {
            content.push(IrContent::Text(text.to_string()));
        }
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let raw_args = call["function"]["arguments"].as_str().unwrap_or("{}");
            content.push(IrContent::ToolUse {
                id: s(&call["id"]).unwrap_or_default(),
                name: s(&call["function"]["name"]).unwrap_or_default(),
                input: serde_json::from_str(raw_args).unwrap_or_else(|_| json!({})),
            });
        }
    }
    Ok(IrResponse {
        id: s(&body["id"]).unwrap_or_default(),
        model: s(&body["model"]).unwrap_or_default(),
        content,
        stop_reason: IrStopReason::from_openai(choice["finish_reason"].as_str().unwrap_or("stop")),
        usage: IrUsage {
            input_tokens: body["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
            output_tokens: body["usage"]["completion_tokens"].as_u64().unwrap_or(0),
        },
    })
}

/// Render an OpenAI NON-STREAMING response from the canonical response.
pub fn response_from_ir(resp: &IrResponse, created: i64) -> Value {
    let text: String = resp
        .content
        .iter()
        .filter_map(|c| match c {
            IrContent::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    let tool_calls: Vec<Value> = resp
        .content
        .iter()
        .filter_map(|c| match c {
            IrContent::ToolUse { id, name, input } => Some(json!({
                "id": id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": serde_json::to_string(input).unwrap_or_else(|_| "{}".into()),
                }
            })),
            _ => None,
        })
        .collect();
    let mut message = json!({
        "role": "assistant",
        "content": if text.is_empty() { Value::Null } else { json!(text) },
    });
    if !tool_calls.is_empty() {
        message["tool_calls"] = json!(tool_calls);
    }
    json!({
        "id": resp.id,
        "object": "chat.completion",
        "created": created,
        "model": resp.model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": resp.stop_reason.to_openai(),
        }],
        "usage": {
            "prompt_tokens": resp.usage.input_tokens,
            "completion_tokens": resp.usage.output_tokens,
            "total_tokens": resp.usage.input_tokens + resp.usage.output_tokens,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_ir_parses_text_system_and_params() {
        let ir = to_ir(&json!({
            "model": "gpt-4o",
            "max_tokens": 256,
            "temperature": 0.3,
            "stop": ["END"],
            "stream": true,
            "messages": [
                { "role": "system", "content": "be brief" },
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": "hello" },
                { "role": "user", "content": [{ "type": "text", "text": "multi" }] }
            ]
        }))
        .unwrap();
        assert_eq!(ir.model, "gpt-4o");
        assert_eq!(ir.system.as_deref(), Some("be brief"));
        assert_eq!(ir.messages.len(), 3);
        assert!(ir.stream);
        assert_eq!(ir.max_tokens, Some(256));
        assert_eq!(ir.stop, vec!["END".to_string()]);
    }

    #[test]
    fn to_ir_parses_tools_and_string_arguments() {
        let ir = to_ir(&json!({
            "model": "m",
            "tools": [{ "type": "function", "function": {
                "name": "get_weather", "description": "d",
                "parameters": { "type": "object", "properties": { "city": { "type": "string" } } }
            }}],
            "tool_choice": "required",
            "messages": [
                { "role": "user", "content": "weather?" },
                { "role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_1", "type": "function",
                    "function": { "name": "get_weather", "arguments": "{\"city\":\"SF\"}" }
                }]},
                { "role": "tool", "tool_call_id": "call_1", "content": "sunny" },
                { "role": "tool", "tool_call_id": "call_2", "content": "warm" }
            ]
        }))
        .unwrap();
        assert_eq!(ir.tools[0].name, "get_weather");
        assert_eq!(ir.tool_choice, Some(IrToolChoice::Any));
        // arguments STRING parsed into an object.
        match &ir.messages[1].content[0] {
            IrContent::ToolUse { id, name, input } => {
                assert_eq!(id, "call_1");
                assert_eq!(name, "get_weather");
                assert_eq!(input["city"], "SF");
            }
            other => panic!("expected ToolUse, got {other:?}"),
        }
        // Consecutive tool messages merged into ONE user message.
        assert_eq!(ir.messages.len(), 3);
        assert_eq!(ir.messages[2].content.len(), 2);
        assert!(matches!(
            ir.messages[2].content[0],
            IrContent::ToolResult { .. }
        ));
    }

    #[test]
    fn to_ir_rejects_untranslatable_features() {
        assert!(to_ir(&json!({ "model": "m", "n": 2, "messages": [] }))
            .unwrap_err()
            .reason
            .contains("n > 1"));
        assert!(to_ir(&json!({ "model": "m", "logprobs": true, "messages": [] })).is_err());
        assert!(to_ir(&json!({ "messages": [] })).is_err()); // no model
    }

    #[test]
    fn parses_remote_and_data_url_images() {
        let ir = to_ir(&json!({
            "model": "m",
            "messages": [{ "role": "user", "content": [
                { "type": "image_url", "image_url": { "url": "https://x/i.png" } },
                { "type": "image_url", "image_url": {
                    "url": "data:image/webp;base64,UklGRg==" } }
            ]}]
        }))
        .unwrap();
        assert_eq!(
            ir.messages[0].content[0],
            IrContent::Image(IrImage::Url("https://x/i.png".into()))
        );
        assert_eq!(
            ir.messages[0].content[1],
            IrContent::Image(IrImage::Base64 {
                media_type: "image/webp".into(),
                data: "UklGRg==".into()
            })
        );
    }

    #[test]
    fn cross_format_image_anthropic_base64_to_openai_data_url() {
        // Anthropic base64 source → IR → OpenAI multimodal content array.
        let ir = super::super::anthropic::to_ir(&json!({
            "model": "m",
            "max_tokens": 16,
            "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "describe" },
                { "type": "image", "source": {
                    "type": "base64", "media_type": "image/png", "data": "iVBOR" } }
            ]}]
        }))
        .unwrap();
        let out = from_ir(&ir);
        let parts = out["messages"][0]["content"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "image_url");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,iVBOR");
    }

    #[test]
    fn from_ir_renders_tool_round_trip_shapes() {
        let ir = to_ir(&json!({
            "model": "m",
            "messages": [
                { "role": "system", "content": "sys" },
                { "role": "user", "content": "q" },
                { "role": "assistant", "content": null, "tool_calls": [{
                    "id": "c1", "type": "function",
                    "function": { "name": "t", "arguments": "{\"a\":1}" }
                }]},
                { "role": "tool", "tool_call_id": "c1", "content": "r" }
            ]
        }))
        .unwrap();
        let out = from_ir(&ir);
        let msgs = out["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[2]["role"], "assistant");
        // Object input stringified back to wire arguments.
        assert_eq!(
            msgs[2]["tool_calls"][0]["function"]["arguments"],
            "{\"a\":1}"
        );
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[3]["tool_call_id"], "c1");
    }

    #[test]
    fn from_ir_adds_stream_options_when_streaming() {
        let mut ir = to_ir(&json!({ "model": "m", "messages": [], "stream": true })).unwrap();
        assert_eq!(from_ir(&ir)["stream_options"]["include_usage"], true);
        ir.stream = false;
        assert!(from_ir(&ir).get("stream_options").is_none());
    }

    #[test]
    fn response_round_trip() {
        let upstream = json!({
            "id": "chatcmpl-1", "model": "m",
            "choices": [{ "index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "ok",
                "tool_calls": [{ "id": "c1", "type": "function",
                    "function": { "name": "t", "arguments": "{\"x\":2}" } }]
            }}],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5 }
        });
        let ir = response_to_ir(&upstream).unwrap();
        assert_eq!(ir.usage.input_tokens, 10);
        assert_eq!(ir.stop_reason, IrStopReason::ToolUse);
        let back = response_from_ir(&ir, 1234);
        assert_eq!(back["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(back["usage"]["total_tokens"], 15);
        assert_eq!(
            back["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
            "{\"x\":2}"
        );
    }
}
