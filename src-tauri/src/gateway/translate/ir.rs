//! Canonical intermediate representation (IR) for chat requests/responses.
//!
//! N inbound formats × M upstream protocols collapse to N+M translators:
//! every inbound body parses INTO `ChatIR`, every upstream request renders
//! FROM it (and responses go the other way through `IrResponse`). Adding a
//! new format means one `to_ir`/`from_ir` pair, not a translation matrix.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum IrRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq)]
pub enum IrContent {
    Text(String),
    /// An image part in a user message. Carried as either a remote URL or a
    /// base64 data payload — the two wire formats disagree on which they
    /// accept, so `from_ir` adapts to the target (OpenAI takes a `data:` URL
    /// for base64; Anthropic takes a `{type:"base64"}` source, or a `url`
    /// source on recent API versions).
    Image(IrImage),
    /// Assistant-initiated tool invocation. `input` is the parsed JSON object
    /// (OpenAI's `arguments` STRING is parsed at the boundary).
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// Tool execution result, carried in a user-role message (Anthropic
    /// shape; OpenAI's `role:"tool"` messages normalize into this).
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
}

/// Image source — exactly one of `url` / base64(`media_type`,`data`).
#[derive(Debug, Clone, PartialEq)]
pub enum IrImage {
    Url(String),
    Base64 { media_type: String, data: String },
}

#[derive(Debug, Clone)]
pub struct IrMessage {
    pub role: IrRole,
    pub content: Vec<IrContent>,
}

#[derive(Debug, Clone)]
pub struct IrToolDef {
    pub name: String,
    pub description: Option<String>,
    /// JSON Schema for the tool input (OpenAI `parameters` ≡ Anthropic
    /// `input_schema`).
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum IrToolChoice {
    Auto,
    /// Model MUST call some tool (OpenAI `required` ≡ Anthropic `any`).
    Any,
    /// Model MUST call this specific tool.
    Tool(String),
    /// Tool calling disabled for this turn.
    None,
}

/// Canonical request. Built by `openai::to_ir` / `anthropic::to_ir`.
#[derive(Debug, Clone, Default)]
pub struct ChatIR {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<IrMessage>,
    pub tools: Vec<IrToolDef>,
    pub tool_choice: Option<IrToolChoice>,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub stop: Vec<String>,
    pub stream: bool,
}

impl Default for IrMessage {
    fn default() -> Self {
        Self {
            role: IrRole::User,
            content: Vec::new(),
        }
    }
}

/// Canonical stop reason (OpenAI `finish_reason` ≡ Anthropic `stop_reason`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IrStopReason {
    Stop,
    MaxTokens,
    ToolUse,
    Other,
}

impl IrStopReason {
    pub fn from_openai(reason: &str) -> Self {
        match reason {
            "stop" => Self::Stop,
            "length" => Self::MaxTokens,
            "tool_calls" | "function_call" => Self::ToolUse,
            _ => Self::Other,
        }
    }

    pub fn from_anthropic(reason: &str) -> Self {
        match reason {
            "end_turn" | "stop_sequence" => Self::Stop,
            "max_tokens" => Self::MaxTokens,
            "tool_use" => Self::ToolUse,
            _ => Self::Other,
        }
    }

    pub fn to_openai(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::MaxTokens => "length",
            Self::ToolUse => "tool_calls",
            Self::Other => "stop",
        }
    }

    pub fn to_anthropic(self) -> &'static str {
        match self {
            Self::Stop => "end_turn",
            Self::MaxTokens => "max_tokens",
            Self::ToolUse => "tool_use",
            Self::Other => "end_turn",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct IrUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Canonical NON-STREAMING response: assistant content + stop reason + usage.
#[derive(Debug, Clone)]
pub struct IrResponse {
    pub id: String,
    pub model: String,
    pub content: Vec<IrContent>,
    pub stop_reason: IrStopReason,
    pub usage: IrUsage,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_reason_maps_round_trip() {
        assert_eq!(IrStopReason::from_openai("stop").to_anthropic(), "end_turn");
        assert_eq!(IrStopReason::from_openai("length").to_anthropic(), "max_tokens");
        assert_eq!(IrStopReason::from_openai("tool_calls").to_anthropic(), "tool_use");
        assert_eq!(IrStopReason::from_anthropic("end_turn").to_openai(), "stop");
        assert_eq!(IrStopReason::from_anthropic("max_tokens").to_openai(), "length");
        assert_eq!(IrStopReason::from_anthropic("tool_use").to_openai(), "tool_calls");
        assert_eq!(IrStopReason::from_anthropic("stop_sequence").to_openai(), "stop");
        // Unknowns degrade to a safe terminal reason, never panic.
        assert_eq!(IrStopReason::from_openai("weird").to_openai(), "stop");
    }
}
