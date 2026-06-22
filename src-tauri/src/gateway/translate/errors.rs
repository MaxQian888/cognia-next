//! Translation failures and inbound-format error rendering.
//!
//! When a request uses a feature the gateway can't carry across protocols
//! (image parts v1, `n > 1`, logprobs, …) it gets an explicit 400 in the
//! INBOUND format's own error shape — never a silent drop.

use serde_json::{json, Value};

/// One untranslatable feature, with a caller-readable reason.
#[derive(Debug, Clone, PartialEq)]
pub struct NotTranslatable {
    pub reason: String,
}

impl NotTranslatable {
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

impl std::fmt::Display for NotTranslatable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.reason)
    }
}

/// The wire format the CLIENT speaks (decided by the route).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InboundFormat {
    OpenAiChat,
    AnthropicMessages,
}

impl InboundFormat {
    /// Wire-protocol name as used by provider snapshots ("openai"/"anthropic").
    pub fn protocol_name(self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai",
            Self::AnthropicMessages => "anthropic",
        }
    }
}

/// Render an error body in the inbound format's native error shape.
pub fn error_body(format: InboundFormat, error_type: &str, message: &str) -> Value {
    match format {
        InboundFormat::OpenAiChat => json!({
            "error": { "message": message, "type": error_type, "param": null, "code": null }
        }),
        InboundFormat::AnthropicMessages => json!({
            "type": "error",
            "error": { "type": error_type, "message": message }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_bodies_match_native_shapes() {
        let oa = error_body(InboundFormat::OpenAiChat, "invalid_request_error", "nope");
        assert_eq!(oa["error"]["message"], "nope");
        assert_eq!(oa["error"]["type"], "invalid_request_error");

        let an = error_body(
            InboundFormat::AnthropicMessages,
            "invalid_request_error",
            "nope",
        );
        assert_eq!(an["type"], "error");
        assert_eq!(an["error"]["message"], "nope");
    }

    #[test]
    fn protocol_names_match_snapshot_vocabulary() {
        assert_eq!(InboundFormat::OpenAiChat.protocol_name(), "openai");
        assert_eq!(
            InboundFormat::AnthropicMessages.protocol_name(),
            "anthropic"
        );
    }
}
