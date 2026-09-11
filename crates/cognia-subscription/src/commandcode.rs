//! CommandCode subscription keys use the documented provider gateway.
//! This provider deliberately has no undocumented OAuth or CLI-store discovery.

use crate::preset::ProviderPreset;
use crate::provider::{ProviderId, SubscriptionProvider};
use crate::vault::{Account, ProviderCredential};

pub const COMMANDCODE_DEFAULT_BASE_URL: &str = "https://api.commandcode.ai/provider/v1";
pub struct CommandCodeProvider;

impl SubscriptionProvider for CommandCodeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Commandcode
    }

    fn validate(&self, credential: &ProviderCredential) -> Result<(), String> {
        if let ProviderCredential::ApiKey(value) = credential {
            if value.provider_id != ProviderId::Commandcode {
                return Err("commandcode credential provider mismatch".into());
            }
            return crate::api_key::validate(value);
        }
        let ProviderCredential::Commandcode(value) = credential else {
            return Err("commandcode provider rejects non-commandcode credentials".into());
        };
        if value.access_token.trim().is_empty() {
            return Err("commandcode accessToken must not be empty".into());
        }
        if value.access_token.chars().any(char::is_control) {
            return Err("commandcode accessToken must not contain control characters".into());
        }
        if let Some(base) = value
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let url = url::Url::parse(base)
                .map_err(|_| "commandcode baseUrl must be a valid HTTP(S) URL")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("commandcode baseUrl must be an HTTP(S) URL without credentials, query, or fragment".into());
            }
        }
        Ok(())
    }

    fn default_label(&self, credential: &ProviderCredential) -> Option<String> {
        matches!(credential, ProviderCredential::Commandcode(_)).then(|| "CommandCode".into())
    }

    fn env_for_sidecar(
        &self,
        account: &Account,
        preset: Option<&ProviderPreset>,
    ) -> Vec<(String, String)> {
        let ProviderCredential::Commandcode(value) = &account.credential else {
            return Vec::new();
        };
        let base = preset
            .map(|p| p.base_url.trim())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                value
                    .base_url
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or(COMMANDCODE_DEFAULT_BASE_URL);
        let mut env = vec![
            ("COMMAND_CODE_API_KEY".into(), value.access_token.clone()),
            ("COMMAND_CODE_BASE_URL".into(), base.into()),
        ];
        if let Some(preset) = preset {
            for (name, value) in &preset.extra_headers {
                if !name.to_ascii_lowercase().starts_with("x-cognia-") {
                    env.push((format!("COMMAND_CODE_CUSTOM_HEADER_{name}"), value.clone()));
                }
            }
            if let Some(model) = preset
                .model_mapping
                .get("default")
                .filter(|s| !s.trim().is_empty())
            {
                env.push(("COMMAND_CODE_MODEL".into(), model.clone()));
            }
        }
        env
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{
        self, AccountDetail, AccountSummary, CommandCodeCredentialData, ProviderVault,
    };

    fn account() -> Account {
        Account {
            id: "commandcode-test".into(),
            label: None,
            credential: ProviderCredential::Commandcode(CommandCodeCredentialData {
                access_token: "test-commandcode-key".into(),
                stored_at_ms: 123,
                base_url: None,
            }),
            created_at_ms: 123,
            last_used_at_ms: 0,
            preset_id: None,
            auth_metadata: None,
        }
    }

    #[test]
    fn credential_roundtrip_and_safe_detail() {
        let account = account();
        let json = serde_json::to_value(&account.credential).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"provider":"commandcode","accessToken":"test-commandcode-key","storedAtMs":123})
        );
        assert_eq!(
            serde_json::from_value::<ProviderCredential>(json).unwrap(),
            account.credential
        );
        let summary = AccountSummary::from_account_at(&account, i64::MAX / 2);
        assert_eq!(summary.provider, "commandcode");
        assert_eq!(summary.variant, "commandcode");
        assert_eq!(summary.health, "ready");
        assert_eq!(summary.expires_at_ms, 0);
        assert_eq!(summary.auth_mode, "api_key");
        assert!(!summary.is_external);
        let detail = AccountDetail::from_account(&account);
        assert!(!serde_json::to_string(&detail)
            .unwrap()
            .contains("test-commandcode-key"));
    }

    #[test]
    fn validates_key_and_optional_gateway_without_echoing_secrets() {
        assert!(CommandCodeProvider.validate(&account().credential).is_ok());
        for key in ["", "  ", "secret\ninjected"] {
            let credential = ProviderCredential::Commandcode(CommandCodeCredentialData {
                access_token: key.into(),
                ..Default::default()
            });
            let error = CommandCodeProvider.validate(&credential).unwrap_err();
            assert!(!error.contains("secret"));
        }
        for base in [
            "not a url",
            "file:///tmp/key",
            "https://user:secret@example.com",
            "https://example.com?key=secret",
            "https://example.com/#secret",
        ] {
            let credential = ProviderCredential::Commandcode(CommandCodeCredentialData {
                access_token: "test".into(),
                base_url: Some(base.into()),
                ..Default::default()
            });
            assert!(CommandCodeProvider.validate(&credential).is_err());
        }
        assert!(CommandCodeProvider
            .validate(&ProviderCredential::OpencodeZen(Default::default()))
            .is_err());
    }

    #[test]
    fn relay_env_takes_precedence_and_filters_internal_headers() {
        let mut account = account();
        let ProviderCredential::Commandcode(value) = &mut account.credential else {
            unreachable!()
        };
        value.base_url = Some("https://account.example/v1".into());
        let mut preset = ProviderPreset {
            id: "relay".into(),
            label: "Relay".into(),
            base_url: "https://relay.example/v1".into(),
            extra_headers: Default::default(),
            template_id: None,
            model_mapping: Default::default(),
        };
        preset
            .extra_headers
            .insert("X-Tenant".into(), "team".into());
        preset
            .extra_headers
            .insert("X-Cognia-Quota".into(), "private".into());
        preset
            .model_mapping
            .insert("default".into(), "model-id".into());
        let env = CommandCodeProvider.env_for_sidecar(&account, Some(&preset));
        assert!(env.contains(&("COMMAND_CODE_API_KEY".into(), "test-commandcode-key".into())));
        assert!(env.contains(&(
            "COMMAND_CODE_BASE_URL".into(),
            "https://relay.example/v1".into()
        )));
        assert!(env.contains(&("COMMAND_CODE_CUSTOM_HEADER_X-Tenant".into(), "team".into())));
        assert!(env.contains(&("COMMAND_CODE_MODEL".into(), "model-id".into())));
        assert!(!env.iter().any(|(key, _)| key.contains("Cognia")));
        let env = CommandCodeProvider.env_for_sidecar(&account, None);
        assert!(env.contains(&(
            "COMMAND_CODE_BASE_URL".into(),
            "https://account.example/v1".into()
        )));
    }

    #[test]
    fn default_gateway_and_no_legacy_oauth() {
        let env = CommandCodeProvider.env_for_sidecar(&account(), None);
        assert!(env.contains(&(
            "COMMAND_CODE_BASE_URL".into(),
            COMMANDCODE_DEFAULT_BASE_URL.into()
        )));
        assert!(CommandCodeProvider.supports_preset());
        assert!(!CommandCodeProvider.requires_sidecar_restart_on_active_switch());
        assert!(
            matches!(crate::migration::migrate_v1_to_v2(ProviderId::Commandcode).unwrap(), crate::migration::MigrationOutcome::NoLegacyData { provider } if provider == "commandcode")
        );
    }

    #[test]
    fn vault_roundtrip_is_provider_and_local_account_scoped() {
        let local = "commandcode-roundtrip-test";
        let mut source = ProviderVault::empty();
        source.accounts.push(account());
        source.active_account_id = Some("commandcode-test".into());
        vault::save_for_account(local, ProviderId::Commandcode, &source).unwrap();
        let loaded = vault::load_for_account(local, ProviderId::Commandcode)
            .unwrap()
            .unwrap();
        let exported = serde_json::to_string(&loaded).unwrap();
        let imported: ProviderVault = serde_json::from_str(&exported).unwrap();
        assert_eq!(imported, source);
        assert!(vault::load_for_account(local, ProviderId::Opencode)
            .unwrap()
            .is_none());
        assert!(
            vault::load_for_account("other-commandcode-local", ProviderId::Commandcode)
                .unwrap()
                .is_none()
        );
        vault::clear_for_account(local, ProviderId::Commandcode).unwrap();
    }
}
