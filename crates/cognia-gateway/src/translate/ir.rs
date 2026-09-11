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
    /// Multimodal tool results supported by Responses and Anthropic. Chat
    /// Completions rejects these at the translation boundary, never drops images.
    ToolResultMedia {
        tool_use_id: String,
        content: Vec<IrContent>,
        is_error: bool,
    },
}

pub fn tool_result(tool_use_id: String, parts: Vec<IrContent>, is_error: bool) -> IrContent {
    if parts.iter().any(|part| matches!(part, IrContent::Image(_))) {
        IrContent::ToolResultMedia {
            tool_use_id,
            content: parts,
            is_error,
        }
    } else {
        IrContent::ToolResult {
            tool_use_id,
            content: parts
                .into_iter()
                .filter_map(|part| {
                    if let IrContent::Text(text) = part {
                        Some(text)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
            is_error,
        }
    }
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
    pub strict: Option<bool>,
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
    pub parallel_tool_calls: Option<bool>,
    /// Canonical Chat response_format shape, with source schema unchanged.
    pub response_format: Option<Value>,
    pub reasoning_effort: Option<String>,
    /// Explicit Anthropic thinking controls cannot silently become a different
    /// provider's effort setting.
    pub thinking: Option<Value>,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub stop: Vec<String>,
    pub stream: bool,
    /// Structured record of every field the translation dropped, merged, or
    /// approximated (ADR-0090 Phase 2). Attached to the request log — never
    /// injected into response bodies. Silent drops are forbidden: a
    /// translator that cannot represent a field MUST push a loss.
    pub losses: Vec<TranslationLoss>,
}

/// Validate optional flags at the wire boundary instead of silently ignoring
/// malformed controls and changing the caller's requested behavior.
pub fn optional_bool(
    value: Option<&Value>,
    field: &str,
) -> Result<Option<bool>, super::errors::NotTranslatable> {
    match value.filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(super::errors::NotTranslatable::new(format!(
            "{field} must be boolean"
        ))),
    }
}

pub fn output_format(
    value: Option<&Value>,
    flavor: &str,
) -> Result<Option<Value>, super::errors::NotTranslatable> {
    use super::errors::NotTranslatable;
    use serde_json::json;
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    match value["type"].as_str() {
        Some("text") => Ok(None),
        Some("json_object") if flavor != "anthropic" => Ok(Some(json!({"type":"json_object"}))),
        Some("json_schema") => {
            let mut schema = if flavor == "openai" {
                value["json_schema"].clone()
            } else {
                value.clone()
            };
            if !schema["schema"].is_object() {
                return Err(NotTranslatable::new(
                    "JSON Schema output requires an object schema",
                ));
            }
            let strict = optional_bool(schema.get("strict"), "output strict")?;
            let name = schema
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("response")
                .to_owned();
            if name.is_empty()
                || name.len() > 64
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err(NotTranslatable::new("JSON Schema output name must contain 1-64 letters, digits, underscores or hyphens"));
            }
            schema.as_object_mut().unwrap().remove("type");
            schema["name"] = json!(name);
            if let Some(strict) = strict {
                schema["strict"] = json!(strict);
            }
            if flavor == "anthropic" {
                schema["strict"] = json!(true);
            }
            Ok(Some(json!({"type":"json_schema","json_schema":schema})))
        }
        _ => Err(NotTranslatable::new("unsupported structured output format")),
    }
}

impl ChatIR {
    pub fn validate_tool_choice(&self) -> Result<(), super::errors::NotTranslatable> {
        use super::errors::NotTranslatable;
        if self.messages.iter().any(|message| {
            message.role == IrRole::Assistant
                && message
                    .content
                    .iter()
                    .any(|part| matches!(part, IrContent::Image(_)))
        }) {
            return Err(NotTranslatable::new(
                "assistant image content has no supported cross-protocol representation",
            ));
        }
        if let Some(IrToolChoice::Tool(name)) = &self.tool_choice {
            if !self.tools.iter().any(|tool| tool.name == *name) {
                return Err(NotTranslatable::new("tool_choice names an undeclared tool"));
            }
        }
        if self.tool_choice == Some(IrToolChoice::Any) && self.tools.is_empty() {
            return Err(NotTranslatable::new(
                "required tool_choice needs at least one tool",
            ));
        }
        let mut names = std::collections::HashSet::new();
        if self.tools.iter().any(|tool| !names.insert(&tool.name)) {
            return Err(NotTranslatable::new("tool names must be unique"));
        }
        Ok(())
    }
}

/// One recorded semantic loss during cross-protocol translation.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationLoss {
    /// JSON-ish path of the inbound field (e.g. "system", "messages[2].content[0]").
    pub path: String,
    /// "dropped" | "merged" | "approximated".
    pub kind: &'static str,
    pub detail: String,
}

impl TranslationLoss {
    pub fn dropped(path: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            kind: "dropped",
            detail: detail.into(),
        }
    }
    pub fn merged(path: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            kind: "merged",
            detail: detail.into(),
        }
    }
    pub fn approximated(path: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            kind: "approximated",
            detail: detail.into(),
        }
    }
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
        assert_eq!(
            IrStopReason::from_openai("length").to_anthropic(),
            "max_tokens"
        );
        assert_eq!(
            IrStopReason::from_openai("tool_calls").to_anthropic(),
            "tool_use"
        );
        assert_eq!(IrStopReason::from_anthropic("end_turn").to_openai(), "stop");
        assert_eq!(
            IrStopReason::from_anthropic("max_tokens").to_openai(),
            "length"
        );
        assert_eq!(
            IrStopReason::from_anthropic("tool_use").to_openai(),
            "tool_calls"
        );
        assert_eq!(
            IrStopReason::from_anthropic("stop_sequence").to_openai(),
            "stop"
        );
        // Unknowns degrade to a safe terminal reason, never panic.
        assert_eq!(IrStopReason::from_openai("weird").to_openai(), "stop");
    }
}
