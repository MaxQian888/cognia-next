//! Gateway session-id derivation (W1.3).
//!
//! Session affinity (already live on the chat plane via `provider-telemetry`)
//! keeps a multi-turn conversation pinned to the deployment that served it, so
//! Anthropic/OpenAI prompt-cache reads keep hitting. The gateway never had a
//! session id to feed that machinery, so its traffic re-scattered across
//! accounts. This derives one, borrowing sub2api's `GenerateSessionHash`
//! priority — most importantly keying on the FIRST `cache_control: ephemeral`
//! block so the affinity key lines up with Anthropic's own prompt-cache key,
//! turning stickiness directly into cache-read discounts.
//!
//! Priority:
//!   (a) Anthropic `metadata.user_id` — Claude Code's native per-conversation
//!       signal.
//!   (b) hash of the first `cache_control:{type:"ephemeral"}` content block.
//!   (c) fallback: `client_ip + user_agent + api_key_id + system digest`.
//!
//! Output is an opaque, stable, fixed-length tag — never a raw identifier — so
//! nothing sensitive lands in the in-memory affinity store. `DefaultHasher`
//! (SipHash with fixed keys) is deterministic within and across process runs,
//! which is all affinity needs (pins are in-memory and reset on restart).

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde_json::Value;

/// Derive a stable affinity key for a chat request body.
pub fn derive_session_id(
    body: &Value,
    client_ip: &str,
    user_agent: &str,
    api_key_id: &str,
) -> String {
    // (a) Anthropic metadata.user_id.
    if let Some(uid) = body
        .get("metadata")
        .and_then(|m| m.get("user_id"))
        .and_then(Value::as_str)
    {
        if !uid.trim().is_empty() {
            return hash_tag("uid", uid);
        }
    }
    // (b) First cache_control:ephemeral content block.
    if let Some(anchor) = first_cache_anchor(body) {
        return hash_tag("cc", &anchor);
    }
    // (c) Connection identity + system-prompt digest.
    let composite = format!(
        "{client_ip}\u{1f}{user_agent}\u{1f}{api_key_id}\u{1f}{}",
        system_digest(body)
    );
    hash_tag("fb", &composite)
}

/// Whether a content block carries `cache_control:{type:"ephemeral"}`.
fn is_ephemeral(block: &Value) -> bool {
    block
        .get("cache_control")
        .and_then(|c| c.get("type"))
        .and_then(Value::as_str)
        == Some("ephemeral")
}

/// A stable string for one content block: its `text` when present, else the
/// whole block serialized canonically.
fn block_anchor(block: &Value) -> String {
    if let Some(text) = block.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    block.to_string()
}

/// Find the first `cache_control:ephemeral` block across `system` + `messages`.
fn first_cache_anchor(body: &Value) -> Option<String> {
    if let Some(blocks) = body.get("system").and_then(Value::as_array) {
        for b in blocks {
            if is_ephemeral(b) {
                return Some(block_anchor(b));
            }
        }
    }
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for msg in messages {
            if let Some(blocks) = msg.get("content").and_then(Value::as_array) {
                for b in blocks {
                    if is_ephemeral(b) {
                        return Some(block_anchor(b));
                    }
                }
            }
        }
    }
    None
}

/// A short, stable digest of the system prompt (string or block-array form),
/// or of the first system message, capped to keep the composite bounded.
fn system_digest(body: &Value) -> String {
    let raw = match body.get("system") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => body
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|msgs| {
                msgs.iter()
                    .find(|m| m.get("role").and_then(Value::as_str) == Some("system"))
            })
            .map(|m| match m.get("content") {
                Some(Value::String(s)) => s.clone(),
                other => other.map(|v| v.to_string()).unwrap_or_default(),
            })
            .unwrap_or_default(),
    };
    raw.chars().take(256).collect()
}

fn hash_tag(prefix: &str, s: &str) -> String {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("gw-{prefix}-{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn metadata_user_id_wins_and_is_stable() {
        let a = json!({ "metadata": { "user_id": "user_abc" }, "messages": [] });
        let id1 = derive_session_id(&a, "1.1.1.1", "ua", "k1");
        // Same user_id → same id even from a different connection.
        let id2 = derive_session_id(&a, "9.9.9.9", "other", "k2");
        assert_eq!(id1, id2);
        assert!(id1.starts_with("gw-uid-"));
        // A different user_id → different id.
        let b = json!({ "metadata": { "user_id": "user_zzz" } });
        assert_ne!(id1, derive_session_id(&b, "1.1.1.1", "ua", "k1"));
    }

    #[test]
    fn cache_control_anchor_keys_on_content() {
        let body = json!({
            "system": [
                { "type": "text", "text": "no cache here" },
                { "type": "text", "text": "BIG SHARED PREFIX", "cache_control": { "type": "ephemeral" } }
            ],
            "messages": []
        });
        let id = derive_session_id(&body, "1.1.1.1", "ua", "k1");
        assert!(id.starts_with("gw-cc-"));
        // Same cached prefix but different connection / trailing message → same
        // key (aligned with Anthropic's own cache key).
        let body2 = json!({
            "system": [
                { "type": "text", "text": "BIG SHARED PREFIX", "cache_control": { "type": "ephemeral" } }
            ],
            "messages": [ { "role": "user", "content": "later turn" } ]
        });
        assert_eq!(id, derive_session_id(&body2, "2.2.2.2", "diff", "k9"));
        // Different cached content → different key.
        let body3 = json!({
            "system": [
                { "type": "text", "text": "DIFFERENT PREFIX", "cache_control": { "type": "ephemeral" } }
            ]
        });
        assert_ne!(id, derive_session_id(&body3, "1.1.1.1", "ua", "k1"));
    }

    #[test]
    fn cache_control_in_messages_is_found() {
        let body = json!({
            "messages": [
                { "role": "user", "content": [
                    { "type": "text", "text": "prefix", "cache_control": { "type": "ephemeral" } }
                ]}
            ]
        });
        assert!(derive_session_id(&body, "1.1.1.1", "ua", "k1").starts_with("gw-cc-"));
    }

    #[test]
    fn fallback_uses_connection_and_system_digest() {
        // No metadata, no cache_control → fallback.
        let body = json!({
            "system": "You are helpful.",
            "messages": [ { "role": "user", "content": "hi" } ]
        });
        let id = derive_session_id(&body, "1.1.1.1", "curl/8", "keyA");
        assert!(id.starts_with("gw-fb-"));
        // Same connection identity + same system → stable across turns.
        let body2 = json!({
            "system": "You are helpful.",
            "messages": [ { "role": "user", "content": "second turn" } ]
        });
        assert_eq!(id, derive_session_id(&body2, "1.1.1.1", "curl/8", "keyA"));
        // A different calling key → different fallback bucket.
        assert_ne!(id, derive_session_id(&body, "1.1.1.1", "curl/8", "keyB"));
    }
}
