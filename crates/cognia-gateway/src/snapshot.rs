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

/// Wire/auth behavior for a provider entry (ADR-0090 Phase 2). Projected from
/// the Provider Profile Store's TransportProfile; validated at snapshot ingest
/// by the shared header policy. Absent ⇒ the legacy protocol defaults
/// (anthropic → x-api-key + pinned version header, else Bearer).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransportSnapshot {
    /// "x-api-key" | "bearer" | "custom-header".
    pub auth_scheme: String,
    /// Custom auth header name (only for `auth_scheme == "custom-header"`).
    #[serde(default)]
    pub auth_header_name: Option<String>,
    /// Extra static headers, policy-validated at ingest AND at send time.
    #[serde(default)]
    pub static_headers: Vec<(String, String)>,
    /// Additional inbound semantic headers forwarded on same-protocol routes.
    #[serde(default)]
    pub forwarded_semantic_headers: Vec<String>,
}

/// Who produced a snapshot — the CAS authority axis (R3). Same-version pushes
/// from DIFFERENT authorities are rejected; last-writer-wins is forbidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapshotAuthority {
    Renderer,
    ProfileStore,
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
    /// The primary / single credential. Always the fallback when no rotation
    /// pool is configured (or rotation is disabled).
    #[serde(default)]
    pub api_key: Option<String>,
    /// Upstream multi-account pool. Mirrors the app's per-provider
    /// `UserProviderSettings.apiKeys[]` so the gateway rotates / fails over
    /// across the same accounts the chat pipeline does. Empty = single-key.
    #[serde(default)]
    pub api_keys: Vec<String>,
    /// Rotation strategy for the pool: "round-robin" | "random" | "least-used".
    /// `None` defaults to round-robin. Only consulted when `rotation_enabled`
    /// and `api_keys` is non-empty.
    #[serde(default)]
    pub rotation_strategy: Option<String>,
    /// Whether the pool actually rotates. Mirrors
    /// `UserProviderSettings.apiKeyRotationEnabled`; when false the gateway
    /// uses `api_key` alone (matching the app's single-key send path).
    #[serde(default)]
    pub rotation_enabled: bool,
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<String>,
    /// The Provider Profile Store deployment this entry projects (Phase 2).
    #[serde(default)]
    pub deployment_id: Option<String>,
    /// Transport behavior override; absent ⇒ legacy protocol defaults.
    #[serde(default)]
    pub transport: Option<TransportSnapshot>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingSnapshot {
    #[serde(default)]
    pub aliases: Vec<AliasSnapshot>,
    #[serde(default)]
    pub providers: Vec<ProviderSnapshot>,
    pub generated_at_ms: i64,
    /// Provider Profile Store CAS version this snapshot projects. Legacy
    /// (pre-Phase-2) publishers omit it.
    #[serde(default)]
    pub profile_version: Option<u64>,
    /// Which publisher produced it. Required alongside `profile_version`.
    #[serde(default)]
    pub authority: Option<SnapshotAuthority>,
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

    /// Provider entry projecting a given Profile Store deployment (ticket
    /// candidates address deployments, not live provider ids).
    pub fn provider_by_deployment(&self, deployment_id: &str) -> Option<&ProviderSnapshot> {
        self.providers
            .iter()
            .find(|p| p.enabled && p.deployment_id.as_deref() == Some(deployment_id))
    }

    /// Fail-closed ingest validation: every transport's static headers and
    /// custom auth-header name must pass the shared header policy, and a
    /// versioned snapshot must name its authority. An invalid snapshot is
    /// rejected WHOLE — the gateway keeps serving the previous one.
    pub fn validate(&self) -> Result<(), String> {
        if self.profile_version.is_some() && self.authority.is_none() {
            return Err("versioned snapshot must declare its authority".into());
        }
        for provider in &self.providers {
            let Some(transport) = &provider.transport else {
                continue;
            };
            match transport.auth_scheme.as_str() {
                "x-api-key" | "bearer" => {}
                "custom-header" => {
                    let name = transport.auth_header_name.as_deref().unwrap_or("");
                    // The auth header itself may be a normally-blocked name
                    // ONLY if it is a well-formed token that is not hop-by-hop
                    // or internal; re-use the policy but allow the dedicated
                    // auth classification (a custom auth header IS an auth
                    // header by design — e.g. `x-goog-api-key`).
                    let verdict = crate::header_policy::check_header(
                        name,
                        Some("x"),
                        crate::header_policy::HeaderContext::Static,
                    );
                    let acceptable = verdict.allowed
                        || verdict.reason == crate::header_policy::HeaderPolicyReason::AuthHeader;
                    if !acceptable {
                        return Err(format!(
                            "provider {}: invalid custom auth header name '{name}' ({})",
                            provider.id,
                            verdict.reason.code()
                        ));
                    }
                }
                other => {
                    return Err(format!(
                        "provider {}: unknown auth scheme '{other}'",
                        provider.id
                    ));
                }
            }
            let violations = crate::header_policy::validate_static_headers(
                transport
                    .static_headers
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.as_str())),
            );
            if let Some((name, reason)) = violations.first() {
                return Err(format!(
                    "provider {}: blocked static header '{name}' ({reason})",
                    provider.id
                ));
            }
            for name in &transport.forwarded_semantic_headers {
                let verdict = crate::header_policy::check_header(
                    name,
                    None,
                    crate::header_policy::HeaderContext::Forward,
                );
                if !verdict.allowed {
                    return Err(format!(
                        "provider {}: blocked forwarded header '{name}' ({})",
                        provider.id,
                        verdict.reason.code()
                    ));
                }
            }
        }
        Ok(())
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

    #[test]
    fn provider_pool_fields_deserialize_with_defaults() {
        // Pool fields absent → single-key defaults.
        let single: ProviderSnapshot = serde_json::from_value(serde_json::json!({
            "id": "p", "protocol": "openai", "baseUrl": "u", "apiKey": "sk-1", "enabled": true
        }))
        .unwrap();
        assert!(single.api_keys.is_empty());
        assert!(!single.rotation_enabled);
        assert!(single.rotation_strategy.is_none());

        // Pool fields present → carried through.
        let pooled: ProviderSnapshot = serde_json::from_value(serde_json::json!({
            "id": "p", "protocol": "openai", "baseUrl": "u", "enabled": true,
            "apiKeys": ["sk-a", "sk-b"], "rotationEnabled": true,
            "rotationStrategy": "least-used"
        }))
        .unwrap();
        assert_eq!(
            pooled.api_keys,
            vec!["sk-a".to_string(), "sk-b".to_string()]
        );
        assert!(pooled.rotation_enabled);
        assert_eq!(pooled.rotation_strategy.as_deref(), Some("least-used"));
    }
}
