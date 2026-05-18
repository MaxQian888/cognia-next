// Codex provider impl — OpenAI device-code OAuth + read-only discovery of
// codex-cli's `~/.codex/auth.json` (or its `"Codex Auth"` keyring entry).
//
// Unlike Anthropic, the Codex provider isn't wired into the cognia sidecar
// (which only speaks to Claude). It's consumed by the external-agent runner
// (`lib/ai/agent/external/env-builder.ts`) when spawning the codex CLI as an
// external agent. Active-account switches therefore don't need a sidecar
// restart — they take effect on the next external-agent spawn.

pub mod commands;
pub mod credential;
pub mod discovery;
pub mod oauth;

use crate::subscription::preset::ProviderPreset;
use crate::subscription::provider::{ProviderId, SubscriptionProvider};
use crate::subscription::vault::{Account, ProviderCredential};

pub struct CodexProvider;

impl SubscriptionProvider for CodexProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Codex
    }

    fn validate(&self, credential: &ProviderCredential) -> Result<(), String> {
        let c = match credential {
            ProviderCredential::Codex(c) => c,
            _ => return Err("codex provider rejects non-codex credentials".into()),
        };
        if c.access_token.trim().is_empty() && c.refresh_token.trim().is_empty() {
            return Err("at least one of access_token / refresh_token must be set".into());
        }
        if c.auth_mode != "chatgpt" && c.auth_mode != "api_key" {
            return Err(format!(
                "auth_mode must be 'chatgpt' or 'api_key', got {:?}",
                c.auth_mode
            ));
        }
        // api_key mode MUST have access_token (the raw key); refresh_token is
        // optional/never used.
        if c.auth_mode == "api_key" && c.access_token.trim().is_empty() {
            return Err("api_key mode requires access_token to be set".into());
        }
        Ok(())
    }

    fn default_label(&self, credential: &ProviderCredential) -> Option<String> {
        let c = match credential {
            ProviderCredential::Codex(c) => c,
            _ => return None,
        };
        match (c.chatgpt_plan_type.as_deref(), c.email.as_deref()) {
            (Some(plan), Some(email)) => Some(format!("{plan} · {email}")),
            (Some(plan), None) => Some(plan.to_string()),
            (None, Some(email)) => Some(email.to_string()),
            (None, None) => match c.auth_mode.as_str() {
                "api_key" => Some("API key".into()),
                _ => None,
            },
        }
    }

    fn env_for_sidecar(
        &self,
        account: &Account,
        preset: Option<&ProviderPreset>,
    ) -> Vec<(String, String)> {
        let c = match &account.credential {
            ProviderCredential::Codex(c) => c,
            _ => return Vec::new(),
        };
        let mut env: Vec<(String, String)> = Vec::with_capacity(4);
        match c.auth_mode.as_str() {
            "chatgpt" => {
                // The Codex CLI reads CODEX_ACCESS_TOKEN as its primary
                // ChatGPT-mode bearer; mirroring the codex-cli env contract.
                env.push(("CODEX_ACCESS_TOKEN".into(), c.access_token.clone()));
            }
            "api_key" => {
                // External codex agent reads OPENAI_API_KEY first, then
                // CODEX_API_KEY as a back-compat alias. Set both for safety.
                env.push(("OPENAI_API_KEY".into(), c.access_token.clone()));
                env.push(("CODEX_API_KEY".into(), c.access_token.clone()));
            }
            _ => return Vec::new(),
        }
        if let Some(p) = preset {
            env.push(("OPENAI_BASE_URL".into(), p.base_url.clone()));
            for (k, v) in &p.extra_headers {
                env.push((format!("OPENAI_CUSTOM_HEADER_{}", k), v.clone()));
            }
        }
        env
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscription::vault::CodexCredentialData;
    use std::collections::BTreeMap;

    fn chatgpt_cred() -> CodexCredentialData {
        CodexCredentialData {
            access_token: "oat-codex".into(),
            refresh_token: "rt-codex".into(),
            id_token_raw: "eyJ.fake.jwt".into(),
            expires_at_ms: 1_800_000_000_000,
            auth_mode: "chatgpt".into(),
            email: Some("user@example.com".into()),
            chatgpt_plan_type: Some("plus".into()),
            chatgpt_user_id: Some("u1".into()),
            account_id: Some("acct_1".into()),
            original_source: Some("oauth".into()),
            stored_at_ms: 1_700_000_000_000,
        }
    }

    fn api_key_cred() -> CodexCredentialData {
        CodexCredentialData {
            access_token: "sk-test-key".into(),
            refresh_token: String::new(),
            id_token_raw: String::new(),
            expires_at_ms: 0,
            auth_mode: "api_key".into(),
            email: None,
            chatgpt_plan_type: None,
            chatgpt_user_id: None,
            account_id: None,
            original_source: Some("oauth".into()),
            stored_at_ms: 1_700_000_000_000,
        }
    }

    fn account_from(c: CodexCredentialData) -> Account {
        Account {
            id: "codex-id".into(),
            label: None,
            credential: ProviderCredential::Codex(c),
            created_at_ms: 0,
            last_used_at_ms: 0,
        }
    }

    #[test]
    fn validate_accepts_chatgpt_credential() {
        assert!(CodexProvider
            .validate(&ProviderCredential::Codex(chatgpt_cred()))
            .is_ok());
    }

    #[test]
    fn validate_accepts_api_key_credential() {
        assert!(CodexProvider
            .validate(&ProviderCredential::Codex(api_key_cred()))
            .is_ok());
    }

    #[test]
    fn validate_rejects_both_tokens_empty() {
        let mut c = chatgpt_cred();
        c.access_token = String::new();
        c.refresh_token = String::new();
        assert!(CodexProvider
            .validate(&ProviderCredential::Codex(c))
            .is_err());
    }

    #[test]
    fn validate_rejects_unknown_auth_mode() {
        let mut c = chatgpt_cred();
        c.auth_mode = "bearer".into();
        assert!(CodexProvider
            .validate(&ProviderCredential::Codex(c))
            .is_err());
    }

    #[test]
    fn validate_rejects_api_key_without_access_token() {
        let mut c = api_key_cred();
        c.access_token = String::new();
        // Even with refresh_token present, api_key mode demands access_token.
        c.refresh_token = "should not save".into();
        assert!(CodexProvider
            .validate(&ProviderCredential::Codex(c))
            .is_err());
    }

    #[test]
    fn validate_rejects_wrong_variant() {
        use crate::subscription::vault::AnthropicCredentialData;
        let a = ProviderCredential::Anthropic(AnthropicCredentialData::default());
        assert!(CodexProvider.validate(&a).is_err());
    }

    #[test]
    fn default_label_prefers_plan_plus_email() {
        let label = CodexProvider.default_label(&ProviderCredential::Codex(chatgpt_cred()));
        assert_eq!(label.as_deref(), Some("plus · user@example.com"));
    }

    #[test]
    fn default_label_for_api_key_without_email() {
        let label = CodexProvider.default_label(&ProviderCredential::Codex(api_key_cred()));
        assert_eq!(label.as_deref(), Some("API key"));
    }

    #[test]
    fn env_chatgpt_mode_emits_codex_access_token() {
        let env = CodexProvider.env_for_sidecar(&account_from(chatgpt_cred()), None);
        assert!(env
            .iter()
            .any(|(k, v)| k == "CODEX_ACCESS_TOKEN" && v == "oat-codex"));
        assert!(!env.iter().any(|(k, _)| k == "OPENAI_API_KEY"));
    }

    #[test]
    fn env_api_key_mode_emits_both_openai_and_codex_keys() {
        let env = CodexProvider.env_for_sidecar(&account_from(api_key_cred()), None);
        assert!(env
            .iter()
            .any(|(k, v)| k == "OPENAI_API_KEY" && v == "sk-test-key"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "CODEX_API_KEY" && v == "sk-test-key"));
        assert!(!env.iter().any(|(k, _)| k == "CODEX_ACCESS_TOKEN"));
    }

    #[test]
    fn env_applies_preset_base_url() {
        let mut headers = BTreeMap::new();
        headers.insert("X-Beta".into(), "1".into());
        let preset = ProviderPreset {
            id: "p".into(),
            label: "Azure".into(),
            base_url: "https://my-azure.openai.com/v1".into(),
            extra_headers: headers,
        };
        let env = CodexProvider.env_for_sidecar(&account_from(api_key_cred()), Some(&preset));
        assert!(env
            .iter()
            .any(|(k, v)| k == "OPENAI_BASE_URL" && v == "https://my-azure.openai.com/v1"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "OPENAI_CUSTOM_HEADER_X-Beta" && v == "1"));
    }

    #[test]
    fn codex_does_not_require_sidecar_restart() {
        assert!(!CodexProvider.requires_sidecar_restart_on_active_switch());
        assert!(CodexProvider.supports_preset());
    }
}
