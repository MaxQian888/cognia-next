//! Candidate resolution + upstream request plumbing.
//!
//! The renderer's routing engine already ordered each alias's deployments;
//! the gateway's job is the simple part: map the requested model onto that
//! pre-ordered list (or a direct provider/model) and walk it, advancing on
//! transient failures. Strategy scoring stays renderer-side by design.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::Value;

use super::snapshot::{ProviderSnapshot, RoutingSnapshot, SnapshotEntry};

/// One executable route: a provider snapshot (credentials + protocol) and
/// the concrete upstream model id.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub provider: ProviderSnapshot,
    pub model_id: String,
}

/// In-memory rotation state for one provider's upstream key pool. Process-local
/// and reset on restart — a fresh cursor after restart is harmless.
#[derive(Default)]
pub struct ProviderKeyRotation {
    /// Round-robin cursor: the pool index last handed out.
    last_index: usize,
    /// Per-key cumulative successful-use counts (drives `least-used` + the
    /// per-account usage surface).
    use_counts: HashMap<String, u64>,
}

/// Rotation cursors keyed by provider id. Lives on `GatewayState`, shared with
/// the running server so the same cursor advances across requests.
pub type KeyRotationMap = Mutex<HashMap<String, ProviderKeyRotation>>;

/// Pick the pool index the walk should START at, given the strategy. For
/// round-robin this advances (and persists) the per-provider cursor; random
/// picks a fresh start; least-used picks the account with the fewest recorded
/// successes.
fn rotation_start(strategy: &str, pool: &[String], st: &mut ProviderKeyRotation) -> usize {
    match strategy {
        "random" => {
            use rand::Rng;
            rand::thread_rng().gen_range(0..pool.len())
        }
        "least-used" => {
            let mut best = 0usize;
            let mut best_count = u64::MAX;
            for (i, key) in pool.iter().enumerate() {
                let count = st.use_counts.get(key).copied().unwrap_or(0);
                if count < best_count {
                    best_count = count;
                    best = i;
                }
            }
            best
        }
        // round-robin (default): hand out the next slot and remember it.
        _ => {
            st.last_index = (st.last_index + 1) % pool.len();
            st.last_index
        }
    }
}

/// Expand each candidate whose provider carries a rotation-enabled key pool
/// into one candidate per pooled key, ordered by the provider's rotation
/// strategy. The existing failover walk then tries each account in turn, so a
/// rate-limited / erroring key (any status in `retry_status_codes`, which
/// includes 429 + 5xx) rolls over to the next account of the SAME provider
/// before moving on. Candidates without a usable pool pass through unchanged
/// (single `api_key` — the app's single-key send path).
pub fn expand_key_pools(candidates: Vec<Candidate>, rotation: &KeyRotationMap) -> Vec<Candidate> {
    let mut out = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let pool: Vec<String> = if candidate.provider.rotation_enabled {
            candidate
                .provider
                .api_keys
                .iter()
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty())
                .collect()
        } else {
            Vec::new()
        };
        if pool.is_empty() {
            // No rotation pool — keep the provider's single `api_key`.
            out.push(candidate);
            continue;
        }
        let start = if pool.len() >= 2 {
            let strategy = candidate
                .provider
                .rotation_strategy
                .as_deref()
                .unwrap_or("round-robin");
            let mut guard = rotation.lock();
            let st = guard.entry(candidate.provider.id.clone()).or_default();
            rotation_start(strategy, &pool, st)
        } else {
            0
        };
        for offset in 0..pool.len() {
            let key = pool[(start + offset) % pool.len()].clone();
            let mut provider = candidate.provider.clone();
            provider.api_key = Some(key);
            out.push(Candidate {
                provider,
                model_id: candidate.model_id.clone(),
            });
        }
    }
    out
}

/// Record a successful upstream call against a pooled key so `least-used`
/// rotation and the per-account usage surface reflect real traffic. A no-op
/// for keyless providers.
pub fn record_key_success(rotation: &KeyRotationMap, provider_id: &str, api_key: Option<&str>) {
    let Some(key) = api_key else { return };
    let mut guard = rotation.lock();
    let st = guard.entry(provider_id.to_string()).or_default();
    *st.use_counts.entry(key.to_string()).or_insert(0) += 1;
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

/// Map an explicit, pre-ordered entry list (from the renderer's live routing
/// decision) onto executable candidates, resolving each against the
/// snapshot's providers. Disabled providers / non-executable protocols are
/// skipped, preserving order.
pub fn candidates_from_entries(
    snapshot: &RoutingSnapshot,
    entries: &[SnapshotEntry],
) -> Vec<Candidate> {
    let mut out = Vec::new();
    for entry in entries {
        if let Some(provider) = snapshot.provider(&entry.provider_id) {
            if is_executable_protocol(&provider.protocol) {
                out.push(Candidate {
                    provider: provider.clone(),
                    model_id: entry.model_id.clone(),
                });
            }
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

/// Upstream embeddings endpoint. OpenAI-compatible only (the catalog base URL
/// already includes `/v1`, matching [`upstream_url`]); Anthropic exposes no
/// embeddings endpoint in this protocol.
pub fn embeddings_url(base_url: &str) -> String {
    format!("{}/embeddings", base_url.trim_end_matches('/'))
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
    fn candidates_from_explicit_entries_resolve_and_skip() {
        let entries: Vec<SnapshotEntry> = serde_json::from_value(serde_json::json!([
            { "providerId": "anthropic", "modelId": "claude-haiku" },
            { "providerId": "disabled-one", "modelId": "x" },
            { "providerId": "weird", "modelId": "y" },
            { "providerId": "groq", "modelId": "llama-3.3-70b" }
        ]))
        .unwrap();
        let candidates = candidates_from_entries(&snapshot(), &entries);
        // disabled + gemini protocol skipped; order preserved.
        assert_eq!(
            candidates
                .iter()
                .map(|c| c.provider.id.as_str())
                .collect::<Vec<_>>(),
            vec!["anthropic", "groq"]
        );
        assert_eq!(candidates[0].model_id, "claude-haiku");
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
        assert!(oa
            .iter()
            .any(|(n, v)| *n == "authorization" && v == "Bearer k"));
        let an = upstream_headers("anthropic", Some("k"));
        assert!(an.iter().any(|(n, v)| *n == "x-api-key" && v == "k"));
        assert!(an.iter().any(|(n, _)| *n == "anthropic-version"));
        // Keyless local providers get no auth header but keep content-type.
        assert_eq!(upstream_headers("openai", None).len(), 1);
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
    fn embeddings_url_appends_path() {
        assert_eq!(
            embeddings_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/embeddings"
        );
        // Trailing slash trimmed.
        assert_eq!(
            embeddings_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/embeddings"
        );
    }

    #[test]
    fn rewrite_model_only_touches_model() {
        let body = serde_json::json!({ "model": "fast", "messages": [1], "stream": true });
        let out = rewrite_model(&body, "concrete");
        assert_eq!(out["model"], "concrete");
        assert_eq!(out["stream"], true);
    }

    fn pooled_candidate(keys: &[&str], enabled: bool, strategy: Option<&str>) -> Candidate {
        let provider: ProviderSnapshot = serde_json::from_value(serde_json::json!({
            "id": "groq", "protocol": "openai", "baseUrl": "u",
            "apiKey": "sk-single", "enabled": true, "models": ["m"],
            "apiKeys": keys, "rotationEnabled": enabled,
            "rotationStrategy": strategy,
        }))
        .unwrap();
        Candidate {
            provider,
            model_id: "m".into(),
        }
    }

    #[test]
    fn expand_passes_through_without_a_pool() {
        let rotation = KeyRotationMap::default();
        // rotation disabled → single key preserved, one candidate.
        let out = expand_key_pools(
            vec![pooled_candidate(&["sk-a", "sk-b"], false, None)],
            &rotation,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].provider.api_key.as_deref(), Some("sk-single"));
    }

    #[test]
    fn expand_produces_one_candidate_per_pooled_key() {
        let rotation = KeyRotationMap::default();
        let out = expand_key_pools(
            vec![pooled_candidate(
                &["sk-a", "sk-b", "sk-c"],
                true,
                Some("round-robin"),
            )],
            &rotation,
        );
        assert_eq!(out.len(), 3);
        let keys: Vec<&str> = out
            .iter()
            .filter_map(|c| c.provider.api_key.as_deref())
            .collect();
        // Every pool key appears exactly once (the failover fallback chain).
        assert!(keys.contains(&"sk-a") && keys.contains(&"sk-b") && keys.contains(&"sk-c"));
    }

    #[test]
    fn round_robin_advances_the_starting_key_each_call() {
        let rotation = KeyRotationMap::default();
        let first = expand_key_pools(
            vec![pooled_candidate(&["sk-a", "sk-b", "sk-c"], true, None)],
            &rotation,
        );
        let second = expand_key_pools(
            vec![pooled_candidate(&["sk-a", "sk-b", "sk-c"], true, None)],
            &rotation,
        );
        // Consecutive requests start at different pool slots.
        assert_ne!(
            first[0].provider.api_key.as_deref(),
            second[0].provider.api_key.as_deref()
        );
    }

    #[test]
    fn least_used_prefers_the_key_with_fewest_successes() {
        let rotation = KeyRotationMap::default();
        // sk-a used twice, sk-b once → least-used should start at sk-c (zero).
        record_key_success(&rotation, "groq", Some("sk-a"));
        record_key_success(&rotation, "groq", Some("sk-a"));
        record_key_success(&rotation, "groq", Some("sk-b"));
        let out = expand_key_pools(
            vec![pooled_candidate(
                &["sk-a", "sk-b", "sk-c"],
                true,
                Some("least-used"),
            )],
            &rotation,
        );
        assert_eq!(out[0].provider.api_key.as_deref(), Some("sk-c"));
    }

    #[test]
    fn expand_skips_blank_pool_keys() {
        let rotation = KeyRotationMap::default();
        let out = expand_key_pools(
            vec![pooled_candidate(&["sk-a", "  ", ""], true, None)],
            &rotation,
        );
        // Only the one non-blank key survives.
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].provider.api_key.as_deref(), Some("sk-a"));
    }
}
