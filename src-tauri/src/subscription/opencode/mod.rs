// OpenCode provider impl — read-only discovery of the OpenCode CLI's
// auth.json + a paste-API-key flow for OpenCode-Zen subscription credentials.
//
// Two ingestion paths, both Phase 1:
//
//   1. Discovery — we parse ~/.local/share/opencode/auth.json (or the
//      Windows equivalent) and surface entries for the whitelisted set of
//      sub-providers: "anthropic", "openai", "opencode-zen". Other entries
//      are deliberately ignored — cognia today only knows how to consume
//      these three, and showing the user 70+ provider rows is noise.
//
//   2. Paste API key — for opencode-zen (their managed-subscription path),
//      the upstream OAuth endpoints aren't publicly documented. Until they
//      are, the user copies their key from opencode.ai/auth and pastes it
//      into cognia, where we persist it as an `OpencodeZen` credential.
//
// We never write back to ~/.local/share/opencode/auth.json — that file is
// owned by the OpenCode CLI and double-writing risks racing with their auth
// flow.

pub mod commands;
pub mod credential;
pub mod discovery;

use crate::subscription::preset::ProviderPreset;
use crate::subscription::provider::{ProviderId, SubscriptionProvider};
use crate::subscription::vault::{Account, ProviderCredential};

pub struct OpencodeProvider;

impl SubscriptionProvider for OpencodeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Opencode
    }

    fn validate(&self, credential: &ProviderCredential) -> Result<(), String> {
        match credential {
            ProviderCredential::OpencodeDiscovered(d) => {
                if !is_whitelisted_sub_provider(&d.sub_provider) {
                    return Err(format!(
                        "subProvider must be one of anthropic/openai/opencode-zen, got {:?}",
                        d.sub_provider
                    ));
                }
                if d.auth_json_path.trim().is_empty() {
                    return Err("authJsonPath must not be empty".into());
                }
                if d.original_payload_json.trim().is_empty() {
                    return Err("originalPayloadJson must not be empty".into());
                }
                Ok(())
            }
            ProviderCredential::OpencodeZen(z) => {
                if z.access_token.trim().is_empty() {
                    return Err("opencode-zen access_token must not be empty".into());
                }
                if let Some(base_url) = z.base_url.as_deref() {
                    let trimmed = base_url.trim();
                    if !trimmed.is_empty() {
                        url::Url::parse(trimmed)
                            .map_err(|e| format!("baseUrl must be a valid URL: {e}"))?;
                    }
                }
                Ok(())
            }
            _ => Err("opencode provider rejects non-opencode credentials".into()),
        }
    }

    fn default_label(&self, credential: &ProviderCredential) -> Option<String> {
        match credential {
            ProviderCredential::OpencodeDiscovered(d) => {
                // Label format: "Sub · file" so the UI can tell at a glance
                // which discovered row this account was adopted from.
                Some(format!("{} (discovered)", d.sub_provider))
            }
            ProviderCredential::OpencodeZen(_) => Some("OpenCode Zen".into()),
            _ => None,
        }
    }

    fn env_for_sidecar(
        &self,
        account: &Account,
        _preset: Option<&ProviderPreset>,
    ) -> Vec<(String, String)> {
        match &account.credential {
            ProviderCredential::OpencodeZen(z) => {
                let mut env = vec![("OPENCODE_API_KEY".to_string(), z.access_token.clone())];
                if let Some(base) = z.base_url.as_deref() {
                    let trimmed = base.trim();
                    if !trimmed.is_empty() {
                        env.push(("OPENCODE_BASE_URL".to_string(), trimmed.to_string()));
                    }
                }
                env
            }
            // Discovered entries are pointers, not adoptable secrets. Surface
            // no env until the user explicitly creates a Zen account from the
            // discovery row.
            ProviderCredential::OpencodeDiscovered(_) => Vec::new(),
            _ => Vec::new(),
        }
    }

    fn supports_preset(&self) -> bool {
        // OpenCode already manages its own multi-provider endpoints inside
        // auth.json — third-party relays belong in OpenCode's own config,
        // not in cognia's preset layer.
        false
    }
}

/// Whitelist of OpenCode sub-providers cognia currently knows how to consume.
/// Anything outside this set is dropped from discovery output.
pub fn is_whitelisted_sub_provider(name: &str) -> bool {
    matches!(name, "anthropic" | "openai" | "opencode-zen")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscription::vault::{OpencodeDiscoveredData, OpencodeZenData};

    fn discovered() -> OpencodeDiscoveredData {
        OpencodeDiscoveredData {
            sub_provider: "anthropic".into(),
            auth_json_path: "/home/u/.local/share/opencode/auth.json".into(),
            original_payload_json: r#"{"apiKey":"sk-test"}"#.into(),
            last_seen_at_ms: 1_700_000_000_000,
        }
    }

    fn zen() -> OpencodeZenData {
        OpencodeZenData {
            access_token: "ozk-1".into(),
            base_url: Some("https://zen.opencode.ai".into()),
            stored_at_ms: 1_700_000_000_000,
        }
    }

    fn account_from(c: ProviderCredential) -> Account {
        Account {
            id: "op-id".into(),
            label: None,
            credential: c,
            created_at_ms: 0,
            last_used_at_ms: 0,
            preset_id: None,
        }
    }

    #[test]
    fn whitelist_includes_three_known_providers() {
        assert!(is_whitelisted_sub_provider("anthropic"));
        assert!(is_whitelisted_sub_provider("openai"));
        assert!(is_whitelisted_sub_provider("opencode-zen"));
        assert!(!is_whitelisted_sub_provider("google"));
        assert!(!is_whitelisted_sub_provider("anthropic-claude")); // strict match
    }

    #[test]
    fn validate_accepts_discovered() {
        assert!(OpencodeProvider
            .validate(&ProviderCredential::OpencodeDiscovered(discovered()))
            .is_ok());
    }

    #[test]
    fn validate_rejects_non_whitelisted_subprovider() {
        let mut d = discovered();
        d.sub_provider = "groq".into();
        assert!(OpencodeProvider
            .validate(&ProviderCredential::OpencodeDiscovered(d))
            .is_err());
    }

    #[test]
    fn validate_rejects_empty_auth_json_path() {
        let mut d = discovered();
        d.auth_json_path = String::new();
        assert!(OpencodeProvider
            .validate(&ProviderCredential::OpencodeDiscovered(d))
            .is_err());
    }

    #[test]
    fn validate_accepts_zen_with_url() {
        assert!(OpencodeProvider
            .validate(&ProviderCredential::OpencodeZen(zen()))
            .is_ok());
    }

    #[test]
    fn validate_accepts_zen_without_url() {
        let mut z = zen();
        z.base_url = None;
        assert!(OpencodeProvider
            .validate(&ProviderCredential::OpencodeZen(z))
            .is_ok());
    }

    #[test]
    fn validate_rejects_zen_with_malformed_url() {
        let mut z = zen();
        z.base_url = Some("not a url".into());
        assert!(OpencodeProvider
            .validate(&ProviderCredential::OpencodeZen(z))
            .is_err());
    }

    #[test]
    fn validate_rejects_empty_zen_token() {
        let mut z = zen();
        z.access_token = String::new();
        assert!(OpencodeProvider
            .validate(&ProviderCredential::OpencodeZen(z))
            .is_err());
    }

    #[test]
    fn validate_rejects_wrong_variant() {
        use crate::subscription::vault::AnthropicCredentialData;
        let a = ProviderCredential::Anthropic(AnthropicCredentialData::default());
        assert!(OpencodeProvider.validate(&a).is_err());
    }

    #[test]
    fn default_label_for_discovered_includes_subprovider() {
        let label = OpencodeProvider.default_label(&ProviderCredential::OpencodeDiscovered(
            discovered(),
        ));
        assert_eq!(label.as_deref(), Some("anthropic (discovered)"));
    }

    #[test]
    fn default_label_for_zen() {
        let label = OpencodeProvider.default_label(&ProviderCredential::OpencodeZen(zen()));
        assert_eq!(label.as_deref(), Some("OpenCode Zen"));
    }

    #[test]
    fn env_for_zen_includes_api_key_and_optional_url() {
        let env = OpencodeProvider.env_for_sidecar(
            &account_from(ProviderCredential::OpencodeZen(zen())),
            None,
        );
        assert!(env
            .iter()
            .any(|(k, v)| k == "OPENCODE_API_KEY" && v == "ozk-1"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "OPENCODE_BASE_URL" && v == "https://zen.opencode.ai"));
    }

    #[test]
    fn env_for_zen_skips_blank_base_url() {
        let mut z = zen();
        z.base_url = Some("   ".into());
        let env = OpencodeProvider.env_for_sidecar(
            &account_from(ProviderCredential::OpencodeZen(z)),
            None,
        );
        assert!(!env.iter().any(|(k, _)| k == "OPENCODE_BASE_URL"));
    }

    #[test]
    fn env_for_discovered_is_empty() {
        let env = OpencodeProvider.env_for_sidecar(
            &account_from(ProviderCredential::OpencodeDiscovered(discovered())),
            None,
        );
        assert!(env.is_empty());
    }

    #[test]
    fn opencode_does_not_support_preset() {
        assert!(!OpencodeProvider.supports_preset());
        assert!(!OpencodeProvider.requires_sidecar_restart_on_active_switch());
    }
}
