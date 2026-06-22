//! Anthropic Messages API ⇄ ChatIR.
//!
//! Anthropic carries tool results as `tool_result` blocks inside user
//! messages (the IR's native shape) and tool inputs as JSON OBJECTS, so this
//! side is closer to 1:1 than the OpenAI one. `max_tokens` is REQUIRED by
//! the Anthropic API — `from_ir` defaults it when the IR has none.

use serde_json::{json, Map, Value};

use super::errors::NotTranslatable;
use super::ir::{
    ChatIR, IrContent, IrImage, IrMessage, IrResponse, IrRole, IrStopReason, IrToolChoice,
    IrToolDef, IrUsage,
};

/// Parse an Anthropic image `source` block into the IR image.
fn parse_anthropic_image(source: &Value) -> Result<IrImage, NotTranslatable> {
    match source["type"].as_str() {
        Some("base64") => Ok(IrImage::Base64 {
            media_type: source["media_type"]
                .as_str()
                .unwrap_or("image/png")
                .to_string(),
            data: source["data"].as_str().unwrap_or_default().to_string(),
        }),
        Some("url") => Ok(IrImage::Url(
            source["url"].as_str().unwrap_or_default().to_string(),
        )),
        other => Err(NotTranslatable::new(format!(
            "unsupported image source type: {}",
            other.unwrap_or("?")
        ))),
    }
}

/// Render an IR image as an Anthropic `image` content block.
fn anthropic_image_block(image: &IrImage) -> Value {
    let source = match image {
        IrImage::Url(url) => json!({ "type": "url", "url": url }),
        IrImage::Base64 { media_type, data } => {
            json!({ "type": "base64", "media_type": media_type, "data": data })
        }
    };
    json!({ "type": "image", "source": source })
}

/// Anthropic requires max_tokens; used when translating from a format that
/// left it unset.
pub const DEFAULT_MAX_TOKENS: u64 = 4096;

fn s(v: &Value) -> Option<String> {
    v.as_str().map(|x| x.to_string())
}

/// Parse an Anthropic Messages request body into the IR.
pub fn to_ir(body: &Value) -> Result<ChatIR, NotTranslatable> {
    let model = s(&body["model"]).ok_or_else(|| NotTranslatable::new("model is required"))?;

    let mut ir = ChatIR {
        model,
        stream: body.get("stream").and_then(Value::as_bool).unwrap_or(false),
        max_tokens: body.get("max_tokens").and_then(Value::as_u64),
        temperature: body.get("temperature").and_then(Value::as_f64),
        top_p: body.get("top_p").and_then(Value::as_f64),
        ..Default::default()
    };

    // `system` is a string or an array of text blocks.
    match body.get("system") {
        Some(Value::String(text)) => ir.system = Some(text.clone()),
        Some(Value::Array(blocks)) => {
            let joined = blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            if !joined.is_empty() {
                ir.system = Some(joined);
            }
        }
        _ => {}
    }

    if let Some(stops) = body.get("stop_sequences").and_then(Value::as_array) {
        for v in stops {
            if let Some(x) = v.as_str() {
                ir.stop.push(x.to_string());
            }
        }
    }

    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        for t in tools {
            let name =
                s(&t["name"]).ok_or_else(|| NotTranslatable::new("tools[].name is required"))?;
            ir.tools.push(IrToolDef {
                name,
                description: s(&t["description"]),
                input_schema: t.get("input_schema").cloned().unwrap_or_else(|| json!({})),
            });
        }
    }
    ir.tool_choice = match body.get("tool_choice") {
        Some(choice) => match s(&choice["type"]).as_deref() {
            Some("auto") => Some(IrToolChoice::Auto),
            Some("any") => Some(IrToolChoice::Any),
            Some("tool") => s(&choice["name"]).map(IrToolChoice::Tool),
            Some("none") => Some(IrToolChoice::None),
            _ => None,
        },
        None => None,
    };

    let messages = body["messages"]
        .as_array()
        .ok_or_else(|| NotTranslatable::new("messages array is required"))?;
    for msg in messages {
        let role = match s(&msg["role"]).as_deref() {
            Some("user") => IrRole::User,
            Some("assistant") => IrRole::Assistant,
            other => {
                return Err(NotTranslatable::new(format!(
                    "unsupported role: {}",
                    other.unwrap_or("?")
                )))
            }
        };
        let mut content = Vec::new();
        match &msg["content"] {
            Value::String(text) => content.push(IrContent::Text(text.clone())),
            Value::Array(blocks) => {
                for block in blocks {
                    match s(&block["type"]).as_deref() {
                        Some("text") => {
                            content.push(IrContent::Text(s(&block["text"]).unwrap_or_default()))
                        }
                        Some("tool_use") => content.push(IrContent::ToolUse {
                            id: s(&block["id"]).unwrap_or_default(),
                            name: s(&block["name"]).unwrap_or_default(),
                            input: block.get("input").cloned().unwrap_or_else(|| json!({})),
                        }),
                        Some("tool_result") => content.push(IrContent::ToolResult {
                            tool_use_id: s(&block["tool_use_id"]).unwrap_or_default(),
                            content: tool_result_text(&block["content"]),
                            is_error: block["is_error"].as_bool().unwrap_or(false),
                        }),
                        Some("image") => {
                            content.push(IrContent::Image(parse_anthropic_image(&block["source"])?))
                        }
                        // Thinking blocks are an Anthropic-internal detail —
                        // they don't survive a protocol hop; drop them.
                        Some("thinking") | Some("redacted_thinking") => {}
                        other => {
                            return Err(NotTranslatable::new(format!(
                                "unsupported content block type: {}",
                                other.unwrap_or("?")
                            )))
                        }
                    }
                }
            }
            _ => {}
        }
        ir.messages.push(IrMessage { role, content });
    }
    Ok(ir)
}

/// Anthropic `tool_result.content` is a string OR an array of text blocks.
fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Render an Anthropic Messages REQUEST from the IR (toward an
/// anthropic-protocol upstream).
pub fn from_ir(ir: &ChatIR) -> Value {
    let messages: Vec<Value> = ir
        .messages
        .iter()
        .map(|msg| {
            let blocks: Vec<Value> = msg
                .content
                .iter()
                .map(|c| match c {
                    IrContent::Text(text) => json!({ "type": "text", "text": text }),
                    IrContent::Image(img) => anthropic_image_block(img),
                    IrContent::ToolUse { id, name, input } => json!({
                        "type": "tool_use", "id": id, "name": name, "input": input
                    }),
                    IrContent::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } => json!({
                        "type": "tool_result", "tool_use_id": tool_use_id,
                        "content": content, "is_error": is_error
                    }),
                })
                .collect();
            json!({
                "role": match msg.role { IrRole::User => "user", IrRole::Assistant => "assistant" },
                "content": blocks,
            })
        })
        .collect();

    let mut out = Map::new();
    out.insert("model".into(), json!(ir.model));
    out.insert(
        "max_tokens".into(),
        json!(ir.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS)),
    );
    out.insert("messages".into(), json!(messages));
    out.insert("stream".into(), json!(ir.stream));
    if let Some(system) = &ir.system {
        out.insert("system".into(), json!(system));
    }
    if !ir.tools.is_empty() {
        out.insert(
            "tools".into(),
            Value::Array(
                ir.tools
                    .iter()
                    .map(|t| {
                        json!({
                            "name": t.name,
                            "description": t.description,
                            "input_schema": t.input_schema,
                        })
                    })
                    .collect(),
            ),
        );
    }
    match &ir.tool_choice {
        Some(IrToolChoice::Auto) => {
            out.insert("tool_choice".into(), json!({ "type": "auto" }));
        }
        Some(IrToolChoice::Any) => {
            out.insert("tool_choice".into(), json!({ "type": "any" }));
        }
        Some(IrToolChoice::Tool(name)) => {
            out.insert(
                "tool_choice".into(),
                json!({ "type": "tool", "name": name }),
            );
        }
        Some(IrToolChoice::None) => {
            out.insert("tool_choice".into(), json!({ "type": "none" }));
        }
        None => {}
    }
    if let Some(t) = ir.temperature {
        out.insert("temperature".into(), json!(t));
    }
    if let Some(p) = ir.top_p {
        out.insert("top_p".into(), json!(p));
    }
    if !ir.stop.is_empty() {
        out.insert("stop_sequences".into(), json!(ir.stop));
    }
    Value::Object(out)
}

/// Parse an Anthropic NON-STREAMING response into the canonical response.
pub fn response_to_ir(body: &Value) -> Result<IrResponse, NotTranslatable> {
    let blocks = body["content"]
        .as_array()
        .ok_or_else(|| NotTranslatable::new("upstream response has no content"))?;
    let mut content = Vec::new();
    for block in blocks {
        match s(&block["type"]).as_deref() {
            Some("text") => content.push(IrContent::Text(s(&block["text"]).unwrap_or_default())),
            Some("tool_use") => content.push(IrContent::ToolUse {
                id: s(&block["id"]).unwrap_or_default(),
                name: s(&block["name"]).unwrap_or_default(),
                input: block.get("input").cloned().unwrap_or_else(|| json!({})),
            }),
            // Thinking never crosses a protocol hop.
            Some("thinking") | Some("redacted_thinking") => {}
            _ => {}
        }
    }
    Ok(IrResponse {
        id: s(&body["id"]).unwrap_or_default(),
        model: s(&body["model"]).unwrap_or_default(),
        content,
        stop_reason: IrStopReason::from_anthropic(
            body["stop_reason"].as_str().unwrap_or("end_turn"),
        ),
        usage: IrUsage {
            input_tokens: body["usage"]["input_tokens"].as_u64().unwrap_or(0),
            output_tokens: body["usage"]["output_tokens"].as_u64().unwrap_or(0),
        },
    })
}

/// Render an Anthropic NON-STREAMING response from the canonical response.
pub fn response_from_ir(resp: &IrResponse) -> Value {
    let blocks: Vec<Value> = resp
        .content
        .iter()
        .filter_map(|c| match c {
            IrContent::Text(text) => Some(json!({ "type": "text", "text": text })),
            IrContent::ToolUse { id, name, input } => Some(json!({
                "type": "tool_use", "id": id, "name": name, "input": input
            })),
            // Tool results / images never appear in assistant output.
            IrContent::ToolResult { .. } | IrContent::Image(_) => None,
        })
        .collect();
    json!({
        "id": resp.id,
        "type": "message",
        "role": "assistant",
        "model": resp.model,
        "content": blocks,
        "stop_reason": resp.stop_reason.to_anthropic(),
        "stop_sequence": null,
        "usage": {
            "input_tokens": resp.usage.input_tokens,
            "output_tokens": resp.usage.output_tokens,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_ir_parses_system_tools_and_blocks() {
        let ir = to_ir(&json!({
            "model": "claude-x",
            "max_tokens": 1024,
            "system": [{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }],
            "stop_sequences": ["END"],
            "tools": [{ "name": "t", "description": "d", "input_schema": { "type": "object" } }],
            "tool_choice": { "type": "any" },
            "messages": [
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": [
                    { "type": "text", "text": "let me check" },
                    { "type": "tool_use", "id": "tu_1", "name": "t", "input": { "q": 1 } }
                ]},
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "tu_1", "content": "answer" }
                ]}
            ]
        }))
        .unwrap();
        assert_eq!(ir.system.as_deref(), Some("a\n\nb"));
        assert_eq!(ir.max_tokens, Some(1024));
        assert_eq!(ir.tool_choice, Some(IrToolChoice::Any));
        assert_eq!(ir.messages.len(), 3);
        match &ir.messages[1].content[1] {
            IrContent::ToolUse { input, .. } => assert_eq!(input["q"], 1),
            other => panic!("expected ToolUse, got {other:?}"),
        }
        match &ir.messages[2].content[0] {
            IrContent::ToolResult {
                tool_use_id,
                content,
                ..
            } => {
                assert_eq!(tool_use_id, "tu_1");
                assert_eq!(content, "answer");
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn to_ir_drops_thinking() {
        let ir = to_ir(&json!({
            "model": "m",
            "messages": [{ "role": "assistant", "content": [
                { "type": "thinking", "thinking": "..." },
                { "type": "text", "text": "answer" }
            ]}]
        }))
        .unwrap();
        assert_eq!(ir.messages[0].content.len(), 1);
    }

    #[test]
    fn parses_both_image_source_shapes() {
        let ir = to_ir(&json!({
            "model": "m",
            "messages": [{ "role": "user", "content": [
                { "type": "image", "source": {
                    "type": "base64", "media_type": "image/jpeg", "data": "QQ==" } },
                { "type": "image", "source": { "type": "url", "url": "https://x/i.png" } }
            ]}]
        }))
        .unwrap();
        assert_eq!(
            ir.messages[0].content[0],
            IrContent::Image(IrImage::Base64 {
                media_type: "image/jpeg".into(),
                data: "QQ==".into()
            })
        );
        assert_eq!(
            ir.messages[0].content[1],
            IrContent::Image(IrImage::Url("https://x/i.png".into()))
        );
    }

    #[test]
    fn rejects_unknown_image_source_type() {
        let err = to_ir(&json!({ "model": "m", "messages": [
            { "role": "user", "content": [{ "type": "image", "source": { "type": "blob" } }] }
        ]}))
        .unwrap_err();
        assert!(err.reason.contains("image source"));
    }

    #[test]
    fn cross_format_image_openai_data_url_to_anthropic_base64() {
        // OpenAI data: URL → IR → Anthropic base64 source.
        let ir = super::super::openai::to_ir(&json!({
            "model": "m",
            "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "what is this?" },
                { "type": "image_url", "image_url": {
                    "url": "data:image/png;base64,iVBORw0KGgo=" } }
            ]}]
        }))
        .unwrap();
        let out = from_ir(&ir);
        let blocks = out["messages"][0]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["source"]["type"], "base64");
        assert_eq!(blocks[1]["source"]["media_type"], "image/png");
        assert_eq!(blocks[1]["source"]["data"], "iVBORw0KGgo=");
    }

    #[test]
    fn from_ir_defaults_required_max_tokens() {
        // An OpenAI request with no max_tokens still renders a valid
        // Anthropic request.
        let ir = super::super::openai::to_ir(&json!({
            "model": "m", "messages": [{ "role": "user", "content": "hi" }]
        }))
        .unwrap();
        let out = from_ir(&ir);
        assert_eq!(out["max_tokens"], DEFAULT_MAX_TOKENS);
        assert_eq!(out["messages"][0]["content"][0]["text"], "hi");
    }

    #[test]
    fn cross_format_request_round_trip_openai_to_anthropic() {
        // OpenAI request (with tool history) → IR → Anthropic request.
        let ir = super::super::openai::to_ir(&json!({
            "model": "claude-via-alias",
            "messages": [
                { "role": "system", "content": "sys" },
                { "role": "user", "content": "q" },
                { "role": "assistant", "content": null, "tool_calls": [{
                    "id": "c1", "type": "function",
                    "function": { "name": "t", "arguments": "{\"a\":1}" }
                }]},
                { "role": "tool", "tool_call_id": "c1", "content": "r" }
            ],
            "tools": [{ "type": "function", "function": { "name": "t", "parameters": {} } }]
        }))
        .unwrap();
        let out = from_ir(&ir);
        assert_eq!(out["system"], "sys");
        // arguments string became an input OBJECT.
        assert_eq!(out["messages"][1]["content"][0]["input"]["a"], 1);
        // role:"tool" became a tool_result block in a user message.
        assert_eq!(out["messages"][2]["role"], "user");
        assert_eq!(out["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(out["tools"][0]["input_schema"], json!({}));
    }

    #[test]
    fn response_round_trip_and_cross_format() {
        let upstream = json!({
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-x",
            "content": [
                { "type": "text", "text": "ok" },
                { "type": "tool_use", "id": "tu_1", "name": "t", "input": { "x": 2 } }
            ],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 7, "output_tokens": 3 }
        });
        let ir = response_to_ir(&upstream).unwrap();
        assert_eq!(ir.stop_reason, IrStopReason::ToolUse);

        // Same IR renders both formats.
        let an = response_from_ir(&ir);
        assert_eq!(an["stop_reason"], "tool_use");
        assert_eq!(an["usage"]["input_tokens"], 7);

        let oa = super::super::openai::response_from_ir(&ir, 99);
        assert_eq!(oa["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(
            oa["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
            "{\"x\":2}"
        );
    }
}
