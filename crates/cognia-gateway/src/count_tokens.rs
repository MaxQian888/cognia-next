//! Local input-token estimation for `POST /v1/messages/count_tokens`.
//!
//! Claude Code calls this endpoint before every turn to size its context
//! window. Until now the gateway had no route for it, so every call was a
//! 404 and the CLI treated the base URL as broken. The handler in `server.rs`
//! forwards to the first Anthropic-protocol candidate. This module is the
//! **fallback** used only when no Anthropic candidate exists or the upstream
//! explicitly reports the endpoint as missing (404 / 405 / 501).
//!
//! Counting rule: the renderer's shared fallback (`lib/ai/tokens/
//! fallback-estimator.ts`) is a real `cl100k_base` tokenizer. The workspace
//! has no tiktoken crate and this is an *estimate* surface (the number only
//! feeds a context-window gauge, never billing), so the Rust twin is the
//! documented heuristic the renderer used before it adopted the tokenizer:
//! `ceil(latin_chars / 4) + cjk_chars`, where every CJK code point counts as
//! one token. It is deliberately a single rule applied to every text leaf so
//! there is exactly one place to change if a tokenizer crate is ever adopted.
//!
//! Non-text blocks (`image`, `document`) are charged a flat allowance because
//! the request body carries no dimensions.

use serde_json::Value;

/// Anthropic prices an image at roughly `(w × h) / 750` tokens. A typical
/// screenshot lands near this figure.
const NON_TEXT_BLOCK_TOKENS: u64 = 1_500;

/// Per-message framing (role + separators) the tokenizer would see.
const PER_MESSAGE_OVERHEAD: u64 = 4;

/// Whether a code point belongs to a CJK / Hangul / fullwidth range. These
/// scripts tokenize at roughly one token per character in `cl100k_base`.
fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x2E80..=0x9FFF      // CJK radicals, punctuation, kana, unified ideographs
        | 0xAC00..=0xD7AF    // Hangul syllables
        | 0xF900..=0xFAFF    // CJK compatibility ideographs
        | 0xFF00..=0xFFEF    // fullwidth forms
        | 0x20000..=0x2FA1F  // CJK extension B..F + compatibility supplement
    )
}

/// Estimate the tokens one text leaf contributes.
pub fn estimate_text_tokens(text: &str) -> u64 {
    let mut cjk = 0u64;
    let mut other = 0u64;
    for ch in text.chars() {
        if is_cjk(ch) {
            cjk += 1;
        } else if !ch.is_whitespace() || ch == ' ' {
            other += 1;
        }
    }
    cjk + other.div_ceil(4)
}

/// Walk a `content` value: a bare string or an array of content blocks.
fn content_tokens(content: &Value) -> u64 {
    match content {
        Value::String(text) => estimate_text_tokens(text),
        Value::Array(blocks) => blocks.iter().map(block_tokens).sum(),
        Value::Null => 0,
        other => estimate_text_tokens(&other.to_string()),
    }
}

fn block_tokens(block: &Value) -> u64 {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => block
            .get("text")
            .and_then(Value::as_str)
            .map(estimate_text_tokens)
            .unwrap_or(0),
        Some("tool_use") => {
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .map(estimate_text_tokens)
                .unwrap_or(0);
            let input = block
                .get("input")
                .map(|v| estimate_text_tokens(&v.to_string()))
                .unwrap_or(0);
            name + input
        }
        Some("tool_result") => block.get("content").map(content_tokens).unwrap_or(0),
        Some("image") | Some("document") => NON_TEXT_BLOCK_TOKENS,
        // Unknown block: charge its serialized shape so nothing is silently free.
        _ => estimate_text_tokens(&block.to_string()),
    }
}

/// Estimate the input tokens of an Anthropic `/v1/messages` or
/// `/v1/messages/count_tokens` body: `system` (string or block array),
/// every `messages[].content`, and every `tools[]` definition
/// (`name`, `description`, `input_schema`). An empty or non-object body is 0.
pub fn estimate_input_tokens(body: &Value) -> u64 {
    let Some(obj) = body.as_object() else {
        return 0;
    };
    let mut total = 0u64;

    if let Some(system) = obj.get("system") {
        total += content_tokens(system);
    }

    if let Some(messages) = obj.get("messages").and_then(Value::as_array) {
        for message in messages {
            total += PER_MESSAGE_OVERHEAD;
            if let Some(content) = message.get("content") {
                total += content_tokens(content);
            }
        }
    }

    if let Some(tools) = obj.get("tools").and_then(Value::as_array) {
        for tool in tools {
            for key in ["name", "description"] {
                if let Some(text) = tool.get(key).and_then(Value::as_str) {
                    total += estimate_text_tokens(text);
                }
            }
            if let Some(schema) = tool.get("input_schema") {
                total += estimate_text_tokens(&schema.to_string());
            }
        }
    }

    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_and_non_object_bodies_are_zero() {
        assert_eq!(estimate_input_tokens(&json!({})), 0);
        assert_eq!(estimate_input_tokens(&Value::Null), 0);
        assert_eq!(estimate_input_tokens(&json!("not a body")), 0);
        assert_eq!(estimate_input_tokens(&json!({ "messages": [] })), 0);
    }

    #[test]
    fn string_and_block_content_count_the_same() {
        let as_string = json!({
            "system": "You are terse.",
            "messages": [{ "role": "user", "content": "Summarize the attached report." }]
        });
        let as_blocks = json!({
            "system": [{ "type": "text", "text": "You are terse." }],
            "messages": [{
                "role": "user",
                "content": [{ "type": "text", "text": "Summarize the attached report." }]
            }]
        });
        assert_eq!(
            estimate_input_tokens(&as_string),
            estimate_input_tokens(&as_blocks)
        );
        assert!(estimate_input_tokens(&as_string) > PER_MESSAGE_OVERHEAD);
    }

    #[test]
    fn tool_definitions_and_tool_blocks_are_counted() {
        let without_tools = json!({
            "messages": [{ "role": "user", "content": "run it" }]
        });
        let with_tools = json!({
            "messages": [{ "role": "user", "content": "run it" }],
            "tools": [{
                "name": "read_file",
                "description": "Read a file from disk by absolute path.",
                "input_schema": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }]
        });
        let base = estimate_input_tokens(&without_tools);
        let tooled = estimate_input_tokens(&with_tools);
        assert!(tooled > base + 10, "tool schema must add tokens: {base} -> {tooled}");

        let with_tool_turn = json!({
            "messages": [
                { "role": "user", "content": "run it" },
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "t1", "name": "read_file",
                      "input": { "path": "/etc/hosts" } }
                ]},
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "t1",
                      "content": [{ "type": "text", "text": "127.0.0.1 localhost" }] }
                ]}
            ]
        });
        assert!(estimate_input_tokens(&with_tool_turn) > base + 2 * PER_MESSAGE_OVERHEAD);
    }

    #[test]
    fn non_text_blocks_get_a_flat_allowance() {
        let body = json!({
            "messages": [{ "role": "user", "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } }
            ]}]
        });
        assert_eq!(
            estimate_input_tokens(&body),
            NON_TEXT_BLOCK_TOKENS + PER_MESSAGE_OVERHEAD
        );
    }

    #[test]
    fn cjk_is_weighted_per_character() {
        // Same character count. CJK must cost roughly 4x the Latin estimate.
        let latin = estimate_text_tokens("abcdefgh");
        let cjk = estimate_text_tokens("你好世界再见朋友");
        assert_eq!(latin, 2);
        assert_eq!(cjk, 8);
        // Hangul and fullwidth punctuation are in the CJK set too.
        assert_eq!(estimate_text_tokens("안녕"), 2);
        assert_eq!(estimate_text_tokens("，"), 1);
    }

    /// The renderer's fallback estimator is a real `cl100k_base` tokenizer
    /// (`lib/ai/tokens/fallback-estimator.test.ts`). This heuristic must land
    /// in the same neighbourhood for the fixtures that test exercises. It is
    /// a context gauge, so a factor-of-two drift is the tolerated ceiling.
    #[test]
    fn heuristic_tracks_the_renderer_fixture_values() {
        // (text, cl100k_base token count)
        let fixtures: &[(&str, u64)] = &[
            ("Hello world", 2),
            ("你好，世界", 5),
            ("Cognia 支持 Bedrock", 8),
            ("The quick brown fox jumps over the lazy dog.", 10),
        ];
        for (text, expected) in fixtures {
            let got = estimate_text_tokens(text);
            let lo = expected / 2;
            let hi = expected * 2;
            assert!(
                (lo..=hi).contains(&got),
                "{text:?}: heuristic {got} outside [{lo}, {hi}] around cl100k {expected}"
            );
        }
    }
}
