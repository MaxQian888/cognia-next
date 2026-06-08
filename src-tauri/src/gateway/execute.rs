//! Candidate resolution + upstream request plumbing.
//!
//! The renderer's routing engine already ordered each alias's deployments;
//! the gateway's job is the simple part: map the requested model onto that
//! pre-ordered list (or a direct provider/model) and walk it, advancing on
//! transient failures. Strategy scoring stays renderer-side by design.

use serde_json::Value;

use super::snapshot::{ProviderSnapshot, RoutingSnapshot};

/// One executable route: a provider snapshot (credentials + protocol) and
/// the concrete upstream model id.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub provider: ProviderSnapshot,
    pub model_id: String,
}

/// Protocols the gateway can execute today.
pub fn is_executable_protocol(protocol: &str) -> bool {
    matches!(protocol, "openai" | "anthropic")
}

/// Resolve the inbound `model` field into an ordered candidate list:
///   1. an alias from the snapshot → its pre-ordered entries,
///   2. `provider:model` literal,
///   3. a model id owned by exactly one enabled provider.
/// Disabled providers and non-executable protocols are skipped.
pub fn resolve_candidates(snapshot: &RoutingSnapshot, model: &str) -> Vec<Candidate> {
    let mut out = Vec::new();

    if let Some(alias) = snapshot.find_alias(model) {
        for entry in &alias.entries {
            if let Some(provider) = snapshot.provider(&entry.provider_id) {
                if is_executable_protocol(&provider.protocol) {
                    out.push(Candidate {
                        provider: provider.clone(),
                        model_id: entry.model_id.clone(),
                    });
                }
            }
        }
        return out;
    }

    if let Some((provider_id, model_id)) = model.split_once(':') {
        if let Some(provider) = snapshot.provider(provider_id) {
            if is_executable_protocol(&provider.protocol) && !model_id.is_empty() {
                out.push(Candidate {
                    provider: provider.clone(),
                    model_id: model_id.to_string(),
                });
                return out;
            }
        }
    }

    for provider in &snapshot.providers {
        if provider.enabled
            && is_executable_protocol(&provider.protocol)
            && provider.models.iter().any(|m| m == model)
        {
            out.push(Candidate {
                provider: provider.clone(),
                model_id: model.to_string(),
            });
        }
    }
    out
}

/// Upstream endpoint for a protocol. Base URLs follow the catalog
/// convention of INCLUDING `/v1` (e.g. `https://api.openai.com/v1`,
/// `https://api.anthropic.com/v1`).
pub fn upstream_url(protocol: &str, base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    match protocol {
        "anthropic" => format!("{base}/messages"),
        _ => format!("{base}/chat/completions"),
    }
}

/// Auth + protocol headers for an upstream request. Never logged.
pub fn upstream_headers(protocol: &str, api_key: Option<&str>) -> Vec<(&'static str, String)> {
    let mut headers = vec![("content-type", "application/json".to_string())];
    match protocol {
        "anthropic" => {
            if let Some(key) = api_key {
                headers.push(("x-api-key", key.to_string()));
            }
            headers.push(("anthropic-version", "2023-06-01".to_string()));
        }
        _ => {
            if let Some(key) = api_key {
                headers.push(("authorization", format!("Bearer {key}")));
            }
        }
    }
    headers
}

/// Whether a failed attempt should advance the walk to the next candidate
/// (transient / upstream-side) instead of surfacing immediately (client
/// fault).
pub fn should_try_next(status: u16) -> bool {
    status == 429 || status == 408 || status >= 500
}

/// Incremental SSE de-framer: feed raw bytes, get back complete `data:`
/// payloads. `event:` lines are dropped — every payload the gateway cares
/// about carries a `type` discriminator in the JSON itself.
#[derive(Default)]
pub struct SseDeframer {
    buf: String,
}

impl SseDeframer {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.push_str(&String::from_utf8_lossy(bytes));
        let mut out = Vec::new();
        while let Some(idx) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=idx).collect();
            let line = line.trim_end_matches(['\n', '\r']);
            if let Some(data) = line.strip_prefix("data:") {
                out.push(data.trim().to_string());
            }
        }
        out
    }

    pub fn finish(&mut self) -> Option<String> {
        let tail = self.buf.trim();
        let data = tail.strip_prefix("data:").map(|d| d.trim().to_string());
        self.buf.clear();
        data
    }
}

/// Replace the model field on a passthrough body (alias → concrete model)
/// without touching anything else.
pub fn rewrite_model(body: &Value, model_id: &str) -> Value {
    let mut out = body.clone();
    out["model"] = Value::String(model_id.to_string());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> RoutingSnapshot {
        serde_json::from_value(serde_json::json!({
            "aliases": [{ "alias": "fast", "entries": [
                { "providerId": "groq", "modelId": "llama-3.3-70b" },
                { "providerId": "disabled-one", "modelId": "x" },
                { "providerId": "anthropic", "modelId": "claude-haiku" },
                { "providerId": "weird", "modelId": "y" }
            ]}],
            "providers": [
                { "id": "groq", "protocol": "openai", "baseUrl": "https://api.groq.com/openai/v1",
                  "apiKey": "sk-g", "enabled": true, "models": ["llama-3.3-70b"] },
                { "id": "anthropic", "protocol": "anthropic", "baseUrl": "https://api.anthropic.com/v1",
                  "apiKey": "sk-a", "enabled": true, "models": ["claude-haiku"] },
                { "id": "disabled-one", "protocol": "openai", "baseUrl": "https://x", "enabled": false },
                { "id": "weird", "protocol": "gemini", "baseUrl": "https://g", "enabled": true }
            ],
            "generatedAtMs": 1
        }))
        .unwrap()
    }

    #[test]
    fn alias_resolves_to_ordered_executable_candidates() {
        let candidates = resolve_candidates(&snapshot(), "fast");
        // disabled + non-executable protocols skipped, order preserved.
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].provider.id, "groq");
        assert_eq!(candidates[1].provider.id, "anthropic");
        assert_eq!(candidates[1].model_id, "claude-haiku");
    }

    #[test]
    fn provider_colon_model_literal_resolves() {
        let candidates = resolve_candidates(&snapshot(), "groq:whatever-model");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].model_id, "whatever-model");
        assert!(resolve_candidates(&snapshot(), "ghost:m").is_empty());
        assert!(resolve_candidates(&snapshot(), "groq:").is_empty());
    }

    #[test]
    fn bare_model_id_finds_its_owner() {
        let candidates = resolve_candidates(&snapshot(), "claude-haiku");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].provider.id, "anthropic");
        assert!(resolve_candidates(&snapshot(), "unknown-model").is_empty());
    }

    #[test]
    fn urls_and_headers_per_protocol() {
        assert_eq!(
            upstream_url("openai", "https://api.groq.com/openai/v1/"),
            "https://api.groq.com/openai/v1/chat/completions"
        );
        assert_eq!(
            upstream_url("anthropic", "https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
        let oa = upstream_headers("openai", Some("k"));
        assert!(oa.iter().any(|(n, v)| *n == "authorization" && v == "Bearer k"));
        let an = upstream_headers("anthropic", Some("k"));
        assert!(an.iter().any(|(n, v)| *n == "x-api-key" && v == "k"));
        assert!(an.iter().any(|(n, _)| *n == "anthropic-version"));
        // Keyless local providers get no auth header but keep content-type.
        assert_eq!(upstream_headers("openai", None).len(), 1);
    }

    #[test]
    fn transient_statuses_advance_the_walk() {
        assert!(should_try_next(429));
        assert!(should_try_next(500));
        assert!(should_try_next(503));
        assert!(!should_try_next(400));
        assert!(!should_try_next(401));
        assert!(!should_try_next(404));
    }

    #[test]
    fn sse_deframer_handles_split_chunks_and_crlf() {
        let mut d = SseDeframer::default();
        let mut out = d.push(b"data: {\"a\":");
        assert!(out.is_empty());
        out.extend(d.push(b"1}\r\nevent: ping\ndata: [DONE]\n"));
        assert_eq!(out, vec!["{\"a\":1}".to_string(), "[DONE]".to_string()]);
        assert_eq!(d.finish(), None);

        let mut d2 = SseDeframer::default();
        d2.push(b"data: tail-no-newline");
        assert_eq!(d2.finish(), Some("tail-no-newline".to_string()));
    }

    #[test]
    fn rewrite_model_only_touches_model() {
        let body = serde_json::json!({ "model": "fast", "messages": [1], "stream": true });
        let out = rewrite_model(&body, "concrete");
        assert_eq!(out["model"], "concrete");
        assert_eq!(out["stream"], true);
    }
}
