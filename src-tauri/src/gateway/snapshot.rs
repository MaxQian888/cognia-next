//! Routing + credential snapshot pushed by the renderer.
//!
//! The routing ENGINE (alias mappings, strategy scoring, health/circuit
//! telemetry) lives renderer-side; the gateway consumes its OUTPUT: per-alias
//! pre-ordered deployment lists plus the provider credentials needed to
//! execute upstream calls in Rust. Pushed on boot + on settings changes +
//! periodically (`gateway_push_snapshot`), so the gateway keeps serving with
//! the last-known snapshot when the window is closed.
//!
//! API keys live in this struct in memory only — never logged, never
//! persisted, never echoed back to the renderer.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasSnapshot {
    pub alias: String,
    /// Pre-ordered by the renderer's routing engine: primary first, then the
    /// fallback chain. The gateway walks it in order.
    pub entries: Vec<SnapshotEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub id: String,
    /// Wire protocol: "openai" | "anthropic" (others are not yet executable
    /// by the gateway and are skipped by the fallback walk).
    pub protocol: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingSnapshot {
    #[serde(default)]
    pub aliases: Vec<AliasSnapshot>,
    #[serde(default)]
    pub providers: Vec<ProviderSnapshot>,
    pub generated_at_ms: i64,
}

impl RoutingSnapshot {
    pub fn find_alias(&self, alias: &str) -> Option<&AliasSnapshot> {
        let needle = alias.to_lowercase();
        self.aliases
            .iter()
            .find(|a| a.alias.to_lowercase() == needle)
    }

    pub fn provider(&self, id: &str) -> Option<&ProviderSnapshot> {
        self.providers.iter().find(|p| p.id == id && p.enabled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> RoutingSnapshot {
        serde_json::from_value(serde_json::json!({
            "aliases": [
                { "alias": "Fast", "entries": [
                    { "providerId": "groq", "modelId": "llama-3.3-70b" },
                    { "providerId": "openai", "modelId": "gpt-4o-mini" }
                ]}
            ],
            "providers": [
                { "id": "groq", "protocol": "openai", "baseUrl": "https://api.groq.com/openai/v1",
                  "apiKey": "sk-g", "enabled": true, "models": ["llama-3.3-70b"] },
                { "id": "openai", "protocol": "openai", "baseUrl": "https://api.openai.com/v1",
                  "apiKey": "sk-o", "enabled": false }
            ],
            "generatedAtMs": 1750000000000i64
        }))
        .unwrap()
    }

    #[test]
    fn deserializes_camel_case_and_defaults() {
        let s = snapshot();
        assert_eq!(s.aliases[0].entries[0].provider_id, "groq");
        assert_eq!(s.providers[0].base_url, "https://api.groq.com/openai/v1");
        assert_eq!(s.providers[1].models.len(), 0); // defaulted
    }

    #[test]
    fn alias_lookup_is_case_insensitive() {
        let s = snapshot();
        assert!(s.find_alias("fast").is_some());
        assert!(s.find_alias("FAST").is_some());
        assert!(s.find_alias("ghost").is_none());
    }

    #[test]
    fn provider_lookup_skips_disabled() {
        let s = snapshot();
        assert!(s.provider("groq").is_some());
        assert!(s.provider("openai").is_none()); // disabled
        assert!(s.provider("ghost").is_none());
    }
}
