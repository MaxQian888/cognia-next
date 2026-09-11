//! Protocol translation between inbound wire formats (what the CLIENT
//! speaks) and upstream provider protocols.
//!
//! Architecture: one canonical IR ([`ir::ChatIR`] / [`ir::IrResponse`])
//! decouples N inbound formats from M upstream protocols (N+M translators,
//! not an N×M matrix — LiteLLM/one-api's converged design). Same-format
//! pairs bypass translation entirely (the executor's passthrough fast
//! path); mismatched pairs route through:
//!
//!   inbound body ── to_ir ──▶ ChatIR ── from_ir ──▶ upstream body
//!   upstream resp ─ response_to_ir ▶ IrResponse ─ response_from_ir ▶ client
//!
//! Streaming goes through [`stream::StreamTranscoder`] instead (chunk-level
//! state machine, no IR materialization).
//!
//! Untranslatable features return [`errors::NotTranslatable`], rendered as
//! an explicit 400 in the INBOUND format's native error shape.

pub mod anthropic;
pub mod errors;
pub mod ir;
pub mod openai;
pub mod responses;
pub mod stream;

use errors::{InboundFormat, NotTranslatable};
use ir::{ChatIR, IrResponse};
use serde_json::Value;

/// Parse an inbound request body into the IR.
pub fn request_to_ir(format: InboundFormat, body: &Value) -> Result<ChatIR, NotTranslatable> {
    match format {
        InboundFormat::OpenAiChat => openai::to_ir(body),
        InboundFormat::OpenAiResponses => responses::request_to_ir(body),
        InboundFormat::AnthropicMessages => anthropic::to_ir(body),
    }
}

/// Render an upstream request body from the IR for the given protocol.
/// Unknown protocols are not executable by the gateway.
pub fn request_from_ir(protocol: &str, ir: &ChatIR) -> Result<Value, NotTranslatable> {
    ir.validate_tool_choice()?;
    if protocol == "openai"
        && ir.messages.iter().any(|m| {
            m.content
                .iter()
                .any(|c| matches!(c, ir::IrContent::ToolResultMedia { .. }))
        })
    {
        return Err(NotTranslatable::new("image tool results require Responses or Anthropic; Chat Completions tool content is text-only"));
    }
    if protocol == "anthropic"
        && ir
            .response_format
            .as_ref()
            .is_some_and(|format| format["type"] != "json_schema")
    {
        return Err(NotTranslatable::new(
            "Anthropic structured output requires a JSON Schema; json_object has no equivalent",
        ));
    }
    if protocol != "anthropic" && ir.thinking.is_some() {
        return Err(NotTranslatable::new("explicit Anthropic thinking modes/token budgets have no equivalent on this upstream; use a supported reasoning effort instead"));
    }
    if let Some(effort) = ir.reasoning_effort.as_deref() {
        let accepted = if protocol == "anthropic" {
            matches!(effort, "low" | "medium" | "high" | "xhigh" | "max")
        } else {
            matches!(
                effort,
                "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
            )
        };
        if !accepted {
            return Err(NotTranslatable::new(format!(
                "reasoning effort '{effort}' has no equivalent on {protocol}"
            )));
        }
    }
    match protocol {
        "openai" => openai::from_ir(ir),
        "responses" => Ok(responses::request_from_ir(ir)),
        "anthropic" => Ok(anthropic::from_ir(ir)),
        other => Err(NotTranslatable::new(format!(
            "upstream protocol \"{other}\" is not executable by the gateway"
        ))),
    }
}

/// Parse an upstream NON-STREAMING response into the canonical response.
pub fn response_to_ir(protocol: &str, body: &Value) -> Result<IrResponse, NotTranslatable> {
    match protocol {
        "openai" => openai::response_to_ir(body),
        "responses" => responses::response_to_ir(body),
        "anthropic" => anthropic::response_to_ir(body),
        other => Err(NotTranslatable::new(format!(
            "upstream protocol \"{other}\" is not executable by the gateway"
        ))),
    }
}

/// Render the inbound NON-STREAMING response from the canonical response.
pub fn response_from_ir(format: InboundFormat, resp: &IrResponse, created: i64) -> Value {
    match format {
        InboundFormat::OpenAiChat => openai::response_from_ir(resp, created),
        InboundFormat::OpenAiResponses => responses::response_from_ir(resp, &resp.model, created),
        InboundFormat::AnthropicMessages => anthropic::response_from_ir(resp),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn structured_output_strict_tools_parallel_and_effort_survive_translation() {
        let schema = json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false});
        let source = json!({"model":"m","input":"answer","text":{"format":{"type":"json_schema","name":"Answer","strict":true,"schema":schema}},
            "tools":[{"type":"function","name":"check","parameters":schema,"strict":true}],"tool_choice":{"type":"function","name":"check"},"parallel_tool_calls":false,"reasoning":{"effort":"high"}});
        let ir = request_to_ir(InboundFormat::OpenAiResponses, &source).unwrap();
        let chat = request_from_ir("openai", &ir).unwrap();
        assert_eq!(chat["response_format"]["json_schema"]["schema"], schema);
        assert!(chat["response_format"]["json_schema"].get("type").is_none());
        assert_eq!(chat["response_format"]["json_schema"]["strict"], true);
        assert_eq!(chat["tools"][0]["function"]["strict"], true);
        assert_eq!(chat["parallel_tool_calls"], false);
        assert_eq!(chat["reasoning_effort"], "high");
        let anthropic = request_from_ir("anthropic", &ir).unwrap();
        assert_eq!(
            anthropic["output_config"]["format"],
            json!({"type":"json_schema","schema":schema})
        );
        assert_eq!(anthropic["output_config"]["effort"], "high");
        assert_eq!(anthropic["tools"][0]["strict"], true);
        assert_eq!(
            anthropic["tool_choice"],
            json!({"type":"tool","name":"check","disable_parallel_tool_use":true})
        );
        let back = request_from_ir(
            "responses",
            &request_to_ir(InboundFormat::AnthropicMessages, &anthropic).unwrap(),
        )
        .unwrap();
        assert_eq!(back["text"]["format"]["schema"], schema);
        assert_eq!(back["text"]["format"]["strict"], true);
        assert_eq!(back["parallel_tool_calls"], false);
        assert_eq!(back["tools"][0]["strict"], true);
    }

    #[test]
    fn controls_without_an_equivalent_fail_instead_of_becoming_auto() {
        for choice in [
            json!("typo"),
            json!({"type":"function","function":{"name":"missing"}}),
            json!("required"),
        ] {
            assert!(request_to_ir(
                InboundFormat::OpenAiChat,
                &json!({"model":"m","messages":[],"tool_choice":choice})
            )
            .is_err());
        }
        let mut ir = request_to_ir(
            InboundFormat::AnthropicMessages,
            &json!({"model":"m","messages":[],"thinking":{"type":"enabled","budget_tokens":2048}}),
        )
        .unwrap();
        assert!(request_from_ir("responses", &ir)
            .unwrap_err()
            .reason
            .contains("thinking"));
        ir.thinking = None;
        ir.reasoning_effort = Some("max".into());
        assert!(request_from_ir("openai", &ir)
            .unwrap_err()
            .reason
            .contains("no equivalent"));
        ir.reasoning_effort = None;
        ir.response_format = Some(json!({"type":"json_object"}));
        assert!(request_from_ir("anthropic", &ir)
            .unwrap_err()
            .reason
            .contains("JSON Schema"));
    }

    #[test]
    fn user_images_preserve_interleaved_captions_and_assistant_images_fail() {
        let mut body = json!({"model":"m","input":[{"role":"user","content":[{"type":"input_text","text":"first"},{"type":"input_image","image_url":"https://example.invalid/one.png"},{"type":"input_text","text":"second"}]}]});
        let ir = request_to_ir(InboundFormat::OpenAiResponses, &body).unwrap();
        let chat = request_from_ir("openai", &ir).unwrap();
        assert_eq!(chat["messages"][0]["content"][0]["text"], "first");
        assert_eq!(chat["messages"][0]["content"][1]["type"], "image_url");
        assert_eq!(chat["messages"][0]["content"][2]["text"], "second");
        body["input"][0]["role"] = json!("assistant");
        assert!(request_to_ir(InboundFormat::OpenAiResponses, &body).is_err());
    }

    #[test]
    fn multimodal_tool_results_preserve_order_and_image_bytes() {
        let body = json!({"model":"m","input":[{"type":"function_call_output","call_id":"call_1","output":[
            {"type":"input_text","text":"before"},{"type":"input_image","image_url":"data:image/png;base64,aGVsbG8="},{"type":"input_text","text":"after"}]}]});
        let ir = request_to_ir(InboundFormat::OpenAiResponses, &body).unwrap();
        assert!(request_from_ir("openai", &ir)
            .unwrap_err()
            .reason
            .contains("text-only"));
        let anthropic = request_from_ir("anthropic", &ir).unwrap();
        let content = &anthropic["messages"][0]["content"][0]["content"];
        assert_eq!(content[0]["text"], "before");
        assert_eq!(
            content[1],
            json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}})
        );
        assert_eq!(content[2]["text"], "after");
        let back = request_from_ir(
            "responses",
            &request_to_ir(InboundFormat::AnthropicMessages, &anthropic).unwrap(),
        )
        .unwrap();
        assert_eq!(back["input"][0], body["input"][0]);
        let invalid = json!({"model":"m","input":[{"type":"function_call_output","call_id":"call_1","output":[{"type":"input_file","file_id":"file_1"}]}]});
        assert!(request_to_ir(InboundFormat::OpenAiResponses, &invalid).is_err());
    }

    #[test]
    fn full_cross_format_request_pipeline() {
        // Anthropic inbound (Claude CLI) → openai upstream.
        let inbound = json!({
            "model": "fast",
            "max_tokens": 128,
            "system": "sys",
            "messages": [{ "role": "user", "content": "hi" }],
            "stream": false
        });
        let ir = request_to_ir(InboundFormat::AnthropicMessages, &inbound).unwrap();
        let upstream = request_from_ir("openai", &ir).unwrap();
        assert_eq!(upstream["messages"][0]["role"], "system");
        assert_eq!(upstream["messages"][1]["content"], "hi");
        assert_eq!(upstream["max_tokens"], 128);
    }

    #[test]
    fn full_cross_format_response_pipeline() {
        // openai upstream response → anthropic client shape.
        let upstream = json!({
            "id": "chatcmpl-9", "model": "gpt-4o-mini",
            "choices": [{ "index": 0, "finish_reason": "stop",
                "message": { "role": "assistant", "content": "hello" } }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 2 }
        });
        let ir = response_to_ir("openai", &upstream).unwrap();
        let out = response_from_ir(InboundFormat::AnthropicMessages, &ir, 0);
        assert_eq!(out["type"], "message");
        assert_eq!(out["content"][0]["text"], "hello");
        assert_eq!(out["stop_reason"], "end_turn");
        assert_eq!(out["usage"]["input_tokens"], 3);
    }

    #[test]
    fn unknown_upstream_protocol_is_not_executable() {
        let ir = request_to_ir(
            InboundFormat::OpenAiChat,
            &json!({ "model": "m", "messages": [] }),
        )
        .unwrap();
        assert!(request_from_ir("gemini", &ir).is_err());
        assert!(response_to_ir("cohere", &json!({})).is_err());
    }
}
