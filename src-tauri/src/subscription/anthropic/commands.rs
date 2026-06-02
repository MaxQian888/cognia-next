// Anthropic-specific Tauri commands.
//
// PKCE flow runs entirely in TS (`lib/subscription/anthropic/oauth.ts`); the
// only Rust-side command we need here is the post-exchange persist hook, which
// validates the credential through `AnthropicProvider::validate` and inserts a
// new account into the v2 vault. Generic CRUD (list/get/delete/rename) flows
// through `subscription::commands::subscription_*` instead.

use super::AnthropicProvider;
use crate::subscription::provider::{ProviderId, SubscriptionProvider};
use crate::subscription::vault::{
    self, Account, AnthropicCredentialData, ProviderCredential, ProviderVault,
};

/// Persist the result of a successful TS-side PKCE exchange.
///
/// The renderer holds the access/refresh token pair after the PKCE round-trip
/// and posts them down here. We validate the credential, generate a new
/// account id, and append it to the Anthropic vault. The renderer follows up
/// with `subscription_set_active` to make it active and trigger a sidecar
/// restart.
///
/// `label` is the optional user-provided alias (the new-account dialog can
/// prompt for one). When `None`, the provider's `default_label` derives one
/// from the credential claims.
#[tauri::command]
pub async fn anthropic_oauth_save_pkce_result(
    payload: AnthropicCredentialData,
    label: Option<String>,
) -> Result<Account, String> {
    let provider = AnthropicProvider;
    let credential = ProviderCredential::Anthropic(payload);
    provider.validate(&credential)?;

    let now_ms = current_unix_ms();
    let resolved_label = label
        .filter(|s| !s.trim().is_empty())
        .or_else(|| provider.default_label(&credential));

    let account = Account {
        id: uuid::Uuid::now_v7().to_string(),
        label: resolved_label,
        credential,
        created_at_ms: now_ms,
        last_used_at_ms: now_ms,
        preset_id: None,
    };

    let mut vault = vault::load(ProviderId::Anthropic)?.unwrap_or_else(ProviderVault::empty);
    vault.upsert_account(account.clone());
    vault::save(ProviderId::Anthropic, &vault)?;
    Ok(account)
}

fn current_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> AnthropicCredentialData {
        AnthropicCredentialData {
            access_token: "oat01-cmd-test".into(),
            refresh_token: "rt-cmd-test".into(),
            expires_at_ms: 1_800_000_000_000,
            mode: "subscription".into(),
            scope: Some("user:profile".into()),
            email: Some("user@example.com".into()),
            plan: Some("pro".into()),
            stored_at_ms: 1_700_000_000_000,
        }
    }

    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    #[tokio::test]
    async fn save_pkce_rejects_empty_access_token() {
        let mut c = sample();
        c.access_token = String::new();
        let result = anthropic_oauth_save_pkce_result(c, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn save_pkce_rejects_bad_mode() {
        let mut c = sample();
        c.mode = "weird".into();
        let result = anthropic_oauth_save_pkce_result(c, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn save_pkce_persists_into_vault() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Anthropic);

        let account = anthropic_oauth_save_pkce_result(sample(), Some("Test Alias".into()))
            .await
            .unwrap();
        assert_eq!(account.label.as_deref(), Some("Test Alias"));

        let vault = vault::load(ProviderId::Anthropic).unwrap().unwrap();
        assert_eq!(vault.accounts.len(), 1);
        assert_eq!(vault.accounts[0].id, account.id);

        vault::clear(ProviderId::Anthropic).unwrap();
    }

    #[tokio::test]
    async fn save_pkce_derives_label_when_omitted() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Anthropic);

        let account = anthropic_oauth_save_pkce_result(sample(), None)
            .await
            .unwrap();
        assert_eq!(account.label.as_deref(), Some("pro · user@example.com"));

        vault::clear(ProviderId::Anthropic).unwrap();
    }
}
