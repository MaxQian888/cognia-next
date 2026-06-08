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
pub mod stream;

use errors::{InboundFormat, NotTranslatable};
use ir::{ChatIR, IrResponse};
use serde_json::Value;

/// Parse an inbound request body into the IR.
pub fn request_to_ir(format: InboundFormat, body: &Value) -> Result<ChatIR, NotTranslatable> {
    match format {
        InboundFormat::OpenAiChat => openai::to_ir(body),
        InboundFormat::AnthropicMessages => anthropic::to_ir(body),
    }
}

/// Render an upstream request body from the IR for the given protocol.
/// Unknown protocols are not executable by the gateway.
pub fn request_from_ir(protocol: &str, ir: &ChatIR) -> Result<Value, NotTranslatable> {
    match protocol {
        "openai" => Ok(openai::from_ir(ir)),
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
        InboundFormat::AnthropicMessages => anthropic::response_from_ir(resp),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
