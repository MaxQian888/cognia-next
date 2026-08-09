// Anthropic-specific Tauri commands.
//
// PKCE flow runs entirely in TS (`lib/subscription/anthropic/oauth.ts`); the
// only Rust-side command we need here is the post-exchange persist hook, which
// validates the credential through `AnthropicProvider::validate` and inserts a
// new account into the v2 vault. Generic CRUD (list/get/delete/rename) flows
// through `subscription::commands::subscription_*` instead.

use super::discovery::{self, DiscoveredAnthropicAuth};
use super::AnthropicProvider;
use crate::provider::SubscriptionProvider;
use crate::vault::{Account, AnthropicCredentialData, ProviderCredential};

/// Read-only probe for an existing Claude Code CLI subscription login
/// (`~/.claude/.credentials.json` or the `"Claude Code-credentials"` keyring
/// entry). Used by the "Reuse" mode of the Anthropic login dialog and the
/// providers-tab one-click reuse card.
#[tauri::command]
pub async fn anthropic_oauth_discover() -> Result<Option<DiscoveredAnthropicAuth>, String> {
    tauri::async_runtime::spawn_blocking(discovery::discover_anthropic_auth)
        .await
        .map_err(|error| format!("Claude credential discovery task failed: {error}"))?
}

/// Validate and construct the result of a successful TS-side PKCE exchange.
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
    local_account_id: String,
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

    let _ = local_account_id;
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

    const LOCAL_ACCOUNT_ID: &str = "local-test";

    #[tokio::test]
    async fn discover_returns_none_when_config_dir_empty() {
        // Shared hermetic seam: isolated CLAUDE_CONFIG_DIR + forced-empty
        // keyring, so this never reads the developer's real login.
        let _env = super::discovery::test_support::TestEnv::new();
        let got = anthropic_oauth_discover().await.unwrap();
        assert!(got.is_none());
    }

    fn sample() -> AnthropicCredentialData {
        AnthropicCredentialData {
            access_token: "oat01-cmd-test".into(),
            refresh_token: "rt-cmd-test".into(),
            expires_at_ms: 1_800_000_000_000,
            mode: "subscription".into(),
            scope: Some("user:profile".into()),
            email: Some("user@example.com".into()),
            plan: Some("pro".into()),
            original_source: None,
            stored_at_ms: 1_700_000_000_000,
        }
    }

    #[tokio::test]
    async fn save_pkce_rejects_empty_access_token() {
        let mut c = sample();
        c.access_token = String::new();
        let result = anthropic_oauth_save_pkce_result(LOCAL_ACCOUNT_ID.into(), c, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn save_pkce_rejects_bad_mode() {
        let mut c = sample();
        c.mode = "weird".into();
        let result = anthropic_oauth_save_pkce_result(LOCAL_ACCOUNT_ID.into(), c, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn save_pkce_constructs_a_validated_account_without_persisting() {
        let account = anthropic_oauth_save_pkce_result(
            LOCAL_ACCOUNT_ID.into(),
            sample(),
            Some("Test Alias".into()),
        )
        .await
        .unwrap();
        assert_eq!(account.label.as_deref(), Some("Test Alias"));
        assert!(matches!(
            account.credential,
            ProviderCredential::Anthropic(_)
        ));
    }

    #[tokio::test]
    async fn save_pkce_derives_label_when_omitted() {
        let account = anthropic_oauth_save_pkce_result(LOCAL_ACCOUNT_ID.into(), sample(), None)
            .await
            .unwrap();
        assert_eq!(account.label.as_deref(), Some("pro · user@example.com"));
    }
}
