// Anthropic provider impl — PKCE OAuth (flow runs in TS), keyring-backed
// credential persistence, sidecar-bound env vars.
//
// PKCE flow specifics (client_id, scopes, beta header set, refresh logic) live
// in `lib/subscription/anthropic/oauth.ts` on the renderer side because the
// flow itself is a sequence of browser interactions + form POSTs that's easier
// to drive from TS. The Rust side only persists the result and surfaces it
// for sidecar consumption.

pub mod commands;
pub mod credential;
pub mod discovery;

use crate::preset::ProviderPreset;
use crate::provider::{ProviderId, SubscriptionProvider};
use crate::vault::{Account, ProviderCredential};

pub struct AnthropicProvider;

impl SubscriptionProvider for AnthropicProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Anthropic
    }

    fn validate(&self, credential: &ProviderCredential) -> Result<(), String> {
        let c = match credential {
            ProviderCredential::Anthropic(c) => c,
            _ => return Err("anthropic provider rejects non-anthropic credentials".into()),
        };
        if c.access_token.trim().is_empty() {
            return Err("access_token must not be empty".into());
        }
        if c.refresh_token.trim().is_empty() {
            return Err("refresh_token must not be empty".into());
        }
        if c.mode != "subscription" && c.mode != "console" {
            return Err(format!(
                "mode must be 'subscription' or 'console', got {:?}",
                c.mode
            ));
        }
        if let Some(source) = c.original_source.as_deref() {
            if source != "file" && source != "keyring" {
                return Err(format!(
                    "originalSource must be 'file' or 'keyring', got {source:?}"
                ));
            }
        }
        Ok(())
    }

    fn default_label(&self, credential: &ProviderCredential) -> Option<String> {
        let c = match credential {
            ProviderCredential::Anthropic(c) => c,
            _ => return None,
        };
        match (c.plan.as_deref(), c.email.as_deref()) {
            (Some(plan), Some(email)) => Some(format!("{plan} · {email}")),
            (Some(plan), None) => Some(plan.to_string()),
            (None, Some(email)) => Some(email.to_string()),
            (None, None) => None,
        }
    }

    fn env_for_sidecar(
        &self,
        account: &Account,
        preset: Option<&ProviderPreset>,
    ) -> Vec<(String, String)> {
        let c = match &account.credential {
            ProviderCredential::Anthropic(c) => c,
            // Wrong variant — caller passed a foreign credential. Returning an
            // empty env is the safest fallback (sidecar will fail to spawn
            // rather than spawn with a Codex token in CLAUDE_CODE_OAUTH_TOKEN).
            _ => return Vec::new(),
        };
        let mut env = Vec::with_capacity(4);
        env.push((
            "CLAUDE_CODE_OAUTH_TOKEN".to_string(),
            c.access_token.clone(),
        ));
        if let Some(p) = preset {
            env.push(("ANTHROPIC_BASE_URL".to_string(), p.base_url.clone()));
            for (k, v) in &p.extra_headers {
                // `x-cognia-*` keys are INTERNAL preset config (e.g. the
                // Volcengine AccessKey ID / Secret used only for the SigV4 usage
                // query), NOT wire headers. Never forward them to the relay —
                // an account-wide credential must not ride on every chat request.
                if k.to_ascii_lowercase().starts_with("x-cognia-") {
                    continue;
                }
                // Sidecar reads custom headers from
                // `ANTHROPIC_CUSTOM_HEADERS_*` (one env var per header), the
                // same convention CCSwitch uses. Single-var-per-header keeps
                // the env shape predictable across platforms.
                env.push((format!("ANTHROPIC_CUSTOM_HEADER_{}", k), v.clone()));
            }
            // Emit model overrides from model_mapping when present and non-empty.
            if let Some(model) = p.model_mapping.get("default") {
                if !model.trim().is_empty() {
                    env.push(("ANTHROPIC_MODEL".to_string(), model.clone()));
                }
            }
            if let Some(model) = p.model_mapping.get("fast") {
                if !model.trim().is_empty() {
                    env.push(("ANTHROPIC_SMALL_FAST_MODEL".to_string(), model.clone()));
                }
            }
        }
        env
    }

    fn requires_sidecar_restart_on_active_switch(&self) -> bool {
        // The Claude SDK reads CLAUDE_CODE_OAUTH_TOKEN at init time only —
        // active-account switch MUST restart the sidecar for the new bearer
        // to take effect.
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::AnthropicCredentialData;
    use std::collections::BTreeMap;

    fn cred() -> AnthropicCredentialData {
        AnthropicCredentialData {
            access_token: "oat01-test".into(),
            refresh_token: "rt-test".into(),
            expires_at_ms: 1_800_000_000_000,
            mode: "subscription".into(),
            scope: Some("user:profile".into()),
            email: Some("user@example.com".into()),
            plan: Some("pro".into()),
            original_source: None,
            stored_at_ms: 1_700_000_000_000,
        }
    }

    fn account_from(c: AnthropicCredentialData) -> Account {
        Account {
            id: "test-id".into(),
            label: None,
            credential: ProviderCredential::Anthropic(c),
            created_at_ms: 0,
            last_used_at_ms: 0,
            preset_id: None,
        }
    }

    #[test]
    fn validate_accepts_well_formed() {
        assert!(AnthropicProvider
            .validate(&ProviderCredential::Anthropic(cred()))
            .is_ok());
    }

    #[test]
    fn validate_rejects_blank_access_token() {
        let mut c = cred();
        c.access_token = "".into();
        assert!(AnthropicProvider
            .validate(&ProviderCredential::Anthropic(c))
            .is_err());
    }

    #[test]
    fn validate_rejects_blank_refresh_token() {
        let mut c = cred();
        c.refresh_token = "".into();
        assert!(AnthropicProvider
            .validate(&ProviderCredential::Anthropic(c))
            .is_err());
    }

    #[test]
    fn validate_rejects_unknown_mode() {
        let mut c = cred();
        c.mode = "custom".into();
        assert!(AnthropicProvider
            .validate(&ProviderCredential::Anthropic(c))
            .is_err());
    }

    #[test]
    fn validate_rejects_unknown_original_source() {
        let mut c = cred();
        c.original_source = Some("copied".into());
        let error = AnthropicProvider
            .validate(&ProviderCredential::Anthropic(c))
            .unwrap_err();
        assert!(error.contains("originalSource"));
    }

    #[test]
    fn validate_rejects_non_anthropic_variant() {
        use crate::vault::CodexCredentialData;
        let codex = ProviderCredential::Codex(CodexCredentialData::default());
        assert!(AnthropicProvider.validate(&codex).is_err());
    }

    #[test]
    fn default_label_prefers_plan_plus_email() {
        let c = cred();
        assert_eq!(
            AnthropicProvider
                .default_label(&ProviderCredential::Anthropic(c))
                .as_deref(),
            Some("pro · user@example.com")
        );
    }

    #[test]
    fn default_label_falls_back_when_email_missing() {
        let mut c = cred();
        c.email = None;
        assert_eq!(
            AnthropicProvider
                .default_label(&ProviderCredential::Anthropic(c))
                .as_deref(),
            Some("pro")
        );
    }

    #[test]
    fn env_for_sidecar_emits_oauth_token() {
        let env = AnthropicProvider.env_for_sidecar(&account_from(cred()), None);
        assert!(env
            .iter()
            .any(|(k, v)| k == "CLAUDE_CODE_OAUTH_TOKEN" && v == "oat01-test"));
        // No preset → no base URL or header vars.
        assert!(!env.iter().any(|(k, _)| k == "ANTHROPIC_BASE_URL"));
    }

    #[test]
    fn env_for_sidecar_applies_preset() {
        let mut headers = BTreeMap::new();
        headers.insert("X-Org".into(), "cognia".into());
        let preset = ProviderPreset {
            id: "p1".into(),
            label: "Bedrock".into(),
            base_url: "https://example.com".into(),
            extra_headers: headers,
            template_id: None,
            model_mapping: BTreeMap::new(),
        };
        let env = AnthropicProvider.env_for_sidecar(&account_from(cred()), Some(&preset));
        assert!(env
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_BASE_URL" && v == "https://example.com"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_CUSTOM_HEADER_X-Org" && v == "cognia"));
    }

    #[test]
    fn env_for_sidecar_never_forwards_x_cognia_internal_config() {
        // `x-cognia-*` keys (e.g. Volcengine AK/SK for usage queries) are
        // internal config and must NOT become wire headers on chat requests.
        let mut headers = BTreeMap::new();
        headers.insert("X-Org".into(), "cognia".into());
        headers.insert("x-cognia-volc-access-key-id".into(), "AKID".into());
        headers.insert("X-Cognia-Volc-Secret-Access-Key".into(), "SECRET".into());
        let preset = ProviderPreset {
            id: "p1".into(),
            label: "Volcengine".into(),
            base_url: "https://ark.cn-beijing.volces.com/api/coding".into(),
            extra_headers: headers,
            template_id: Some("volcengine-agentplan".into()),
            model_mapping: BTreeMap::new(),
        };
        let env = AnthropicProvider.env_for_sidecar(&account_from(cred()), Some(&preset));
        // The real wire header is forwarded…
        assert!(env
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_CUSTOM_HEADER_X-Org" && v == "cognia"));
        // …but neither AK nor SK ever appears in the env (no leak to the relay).
        assert!(!env.iter().any(|(_, v)| v == "AKID" || v == "SECRET"));
        assert!(!env.iter().any(|(k, _)| k.to_lowercase().contains("cognia")));
    }

    #[test]
    fn env_for_sidecar_rejects_wrong_variant() {
        use crate::vault::CodexCredentialData;
        let wrong = Account {
            id: "x".into(),
            label: None,
            credential: ProviderCredential::Codex(CodexCredentialData::default()),
            created_at_ms: 0,
            last_used_at_ms: 0,
            preset_id: None,
        };
        assert!(AnthropicProvider.env_for_sidecar(&wrong, None).is_empty());
    }

    #[test]
    fn anthropic_requires_sidecar_restart() {
        assert!(AnthropicProvider.requires_sidecar_restart_on_active_switch());
        assert!(AnthropicProvider.supports_preset());
    }

    #[test]
    fn env_for_sidecar_emits_model_mapping_vars() {
        let mut mapping = BTreeMap::new();
        mapping.insert("default".into(), "claude-3-5-sonnet-20241022".into());
        mapping.insert("fast".into(), "claude-3-5-haiku-20241022".into());
        let preset = ProviderPreset {
            id: "p2".into(),
            label: "Bedrock with model map".into(),
            base_url: "https://bedrock.example.com".into(),
            extra_headers: BTreeMap::new(),
            template_id: None,
            model_mapping: mapping,
        };
        let env = AnthropicProvider.env_for_sidecar(&account_from(cred()), Some(&preset));
        assert!(env
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_MODEL" && v == "claude-3-5-sonnet-20241022"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_SMALL_FAST_MODEL" && v == "claude-3-5-haiku-20241022"));
    }

    #[test]
    fn env_for_sidecar_skips_absent_model_mapping() {
        let preset = ProviderPreset {
            id: "p3".into(),
            label: "No model map".into(),
            base_url: "https://bedrock.example.com".into(),
            extra_headers: BTreeMap::new(),
            template_id: None,
            model_mapping: BTreeMap::new(),
        };
        let env = AnthropicProvider.env_for_sidecar(&account_from(cred()), Some(&preset));
        assert!(!env.iter().any(|(k, _)| k == "ANTHROPIC_MODEL"));
        assert!(!env.iter().any(|(k, _)| k == "ANTHROPIC_SMALL_FAST_MODEL"));
    }
}
