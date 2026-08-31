// Codex-specific Tauri commands.
//
// Three categories:
//
//   * Discovery: codex_oauth_discover — read-only probe of ~/.codex/auth.json
//     and codex-cli's keyring entry. Used by the "Reuse" mode of the login
//     dialog.
//
//   * OAuth: codex_oauth_request_device_code / codex_oauth_poll_device_code /
//     Refresh and targeted reauthentication stay inside the host lifecycle
//     commands so refresh credentials never cross into the renderer.
//
// Generic CRUD (save/load/clear/list/delete/rename) flows through the shared
// `subscription::commands::subscription_*` commands; only Codex-specific
// transport-layer wrappers live here.

use super::discovery::{self, DiscoveredCodexAuth};
use super::lifecycle::CodexLifecycleManager;
use super::oauth::{self, DeviceCodeResponse, PollOutcome};
use super::CodexProvider;
use crate::active::{ActiveAccountState, ActiveSnapshot};
use crate::provider::{ProviderId, SubscriptionProvider};
use crate::vault::{
    self, AccountAuthMetadata, AccountDetail, CodexCredentialData, ProviderCredential,
    ProviderVault,
};
use tauri::State;

#[tauri::command]
pub async fn codex_oauth_discover() -> Result<Option<DiscoveredCodexAuth>, String> {
    discovery::discover_codex_auth()
}

#[tauri::command]
pub async fn codex_oauth_request_device_code(
    local_account_id: String,
    lifecycle: State<'_, CodexLifecycleManager>,
) -> Result<DeviceCodeResponse, String> {
    vault::service_name_for_account(&local_account_id)?;
    let generation = lifecycle.begin_device_flow(&local_account_id).await;
    let mut response = oauth::request_device_code().await?;
    response.flow_generation = generation;
    Ok(response)
}

#[tauri::command]
pub async fn codex_oauth_poll_device_code(
    local_account_id: String,
    device_code: String,
    user_code: String,
    flow_generation: u64,
    lifecycle: State<'_, CodexLifecycleManager>,
) -> Result<PollOutcome, String> {
    vault::service_name_for_account(&local_account_id)?;
    if !lifecycle
        .is_current_device_flow(&local_account_id, flow_generation)
        .await
    {
        return Err("codex device flow was cancelled or superseded".into());
    }
    // codex's deviceauth/token poll keys on BOTH the opaque device_auth_id
    // (carried as `device_code`) and the displayed `user_code`.
    let outcome = oauth::poll_device_code(&device_code, &user_code).await?;
    if !lifecycle
        .is_current_device_flow(&local_account_id, flow_generation)
        .await
    {
        return Err("codex device flow was cancelled or superseded".into());
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn codex_oauth_cancel_device_code(
    local_account_id: String,
    flow_generation: u64,
    lifecycle: State<'_, CodexLifecycleManager>,
) -> Result<bool, String> {
    vault::service_name_for_account(&local_account_id)?;
    Ok(lifecycle
        .cancel_device_flow(&local_account_id, flow_generation)
        .await)
}

/// Refresh one Cognia-managed Codex account under its lifecycle lock. The
/// command re-loads and persists the vault itself, so a concurrent local
/// removal cannot be undone by a late refresh completion.
#[tauri::command]
pub async fn subscription_refresh_codex_account(
    local_account_id: String,
    account_id: String,
    lifecycle: State<'_, CodexLifecycleManager>,
    active_state: State<'_, ActiveAccountState>,
) -> Result<CodexCredentialData, String> {
    vault::service_name_for_account(&local_account_id)?;
    let _account_guard = lifecycle.lock_account(&local_account_id, &account_id).await;
    let current = {
        let _mutation_guard = vault::VAULT_MUTATION_LOCK.lock().await;
        let provider_vault = vault::load_for_account(&local_account_id, ProviderId::Codex)?
            .ok_or_else(|| "codex account no longer exists".to_string())?;
        let account = provider_vault
            .accounts
            .iter()
            .find(|account| account.id == account_id)
            .ok_or_else(|| "codex account no longer exists".to_string())?;
        let ProviderCredential::Codex(current) = &account.credential else {
            return Err("account is not a Codex credential".into());
        };
        if matches!(current.original_source.as_deref(), Some("file" | "keyring")) {
            return Err(
                "externally managed Codex credentials must be re-imported explicitly".into(),
            );
        }
        if current.auth_mode != "chatgpt" || current.refresh_token.trim().is_empty() {
            return Err("Codex account does not have a refreshable ChatGPT credential".into());
        }
        current.clone()
    };

    let response = match oauth::refresh_token(&current.refresh_token).await {
        Ok(response) => response,
        Err(error) => {
            if let Some(reason) = classify_reauth_reason(&error) {
                let _mutation_guard = vault::VAULT_MUTATION_LOCK.lock().await;
                let mut provider_vault =
                    vault::load_for_account(&local_account_id, ProviderId::Codex)?
                        .ok_or_else(|| "codex account no longer exists".to_string())?;
                let account = provider_vault
                    .accounts
                    .iter_mut()
                    .find(|account| account.id == account_id)
                    .ok_or_else(|| "codex account no longer exists".to_string())?;
                let now_ms = current_unix_ms();
                let metadata = account
                    .auth_metadata
                    .get_or_insert_with(AccountAuthMetadata::default);
                metadata.reauth_required_at_ms = Some(now_ms);
                metadata.reauth_reason = Some(reason.to_string());
                vault::save_for_account(&local_account_id, ProviderId::Codex, &provider_vault)?;
                return Err(format!("reauth_required:{reason}"));
            }
            return Err(error);
        }
    };

    let _mutation_guard = vault::VAULT_MUTATION_LOCK.lock().await;
    let mut provider_vault = vault::load_for_account(&local_account_id, ProviderId::Codex)?
        .ok_or_else(|| "codex account no longer exists".to_string())?;
    let account = provider_vault
        .accounts
        .iter_mut()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "codex account no longer exists".to_string())?;
    let now_ms = current_unix_ms();
    let mut fresh = current;
    fresh.access_token = response.access_token;
    if let Some(refresh_token) = response.refresh_token.filter(|value| !value.is_empty()) {
        fresh.refresh_token = refresh_token;
    }
    if let Some(id_token) = response.id_token.filter(|value| !value.is_empty()) {
        fresh.id_token_raw = id_token;
    }
    fresh.expires_at_ms = response
        .expires_in
        .filter(|seconds| *seconds > 0)
        .map(|seconds| now_ms.saturating_add(seconds.saturating_mul(1_000)))
        .unwrap_or(fresh.expires_at_ms);
    fresh.stored_at_ms = now_ms;
    account.credential = ProviderCredential::Codex(fresh.clone());
    let metadata = account
        .auth_metadata
        .get_or_insert_with(AccountAuthMetadata::default);
    metadata.reauth_required_at_ms = None;
    metadata.reauth_reason = None;
    metadata.last_credential_rotation_at_ms = Some(now_ms);
    if metadata.codex_identity.is_none() {
        metadata.codex_identity = vault::derive_codex_identity(&fresh.id_token_raw, &fresh);
    }
    vault::save_for_account(&local_account_id, ProviderId::Codex, &provider_vault)?;
    refresh_active_projection(&provider_vault, &account_id, &active_state).await;
    Ok(fresh)
}

/// Replace an existing managed OAuth credential only when the upstream
/// workspace and user identity match the stored account.
#[tauri::command]
pub async fn subscription_reauthenticate_codex_account(
    local_account_id: String,
    account_id: String,
    credential: CodexCredentialData,
    lifecycle: State<'_, CodexLifecycleManager>,
    active_state: State<'_, ActiveAccountState>,
) -> Result<AccountDetail, String> {
    vault::service_name_for_account(&local_account_id)?;
    let _account_guard = lifecycle.lock_account(&local_account_id, &account_id).await;
    if credential.auth_mode != "chatgpt" || credential.access_token.trim().is_empty() {
        return Err("targeted Codex reauthentication requires a ChatGPT credential".into());
    }
    let _mutation_guard = vault::VAULT_MUTATION_LOCK.lock().await;
    let mut provider_vault = vault::load_for_account(&local_account_id, ProviderId::Codex)?
        .ok_or_else(|| "codex account no longer exists".to_string())?;
    let account = provider_vault
        .accounts
        .iter_mut()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "codex account no longer exists".to_string())?;
    let ProviderCredential::Codex(current) = &account.credential else {
        return Err("account is not a Codex credential".into());
    };
    let current_identity = account
        .auth_metadata
        .as_ref()
        .and_then(|metadata| metadata.codex_identity.clone())
        .or_else(|| vault::derive_codex_identity(&current.id_token_raw, current))
        .filter(|identity| identity.is_verifiable())
        .ok_or_else(|| {
            "existing Codex identity cannot be verified; add the login as a new account".to_string()
        })?;
    let next_identity = vault::derive_codex_identity(&credential.id_token_raw, &credential)
        .filter(|identity| identity.is_verifiable())
        .ok_or_else(|| "new Codex identity cannot be verified".to_string())?;
    if !current_identity.matches(&next_identity) {
        return Err(
            "Codex reauthentication identity mismatch; original account was not changed".into(),
        );
    }

    let now_ms = current_unix_ms();
    account.credential = ProviderCredential::Codex(credential);
    account.last_used_at_ms = now_ms;
    let metadata = account
        .auth_metadata
        .get_or_insert_with(AccountAuthMetadata::default);
    metadata.codex_identity = Some(next_identity);
    metadata.reauth_required_at_ms = None;
    metadata.reauth_reason = None;
    metadata.last_credential_rotation_at_ms = Some(now_ms);
    let detail = AccountDetail::from_account(account);
    vault::save_for_account(&local_account_id, ProviderId::Codex, &provider_vault)?;
    refresh_active_projection(&provider_vault, &account_id, &active_state).await;
    Ok(detail)
}

fn active_projection_for(vault: &ProviderVault, account_id: &str) -> Option<ActiveSnapshot> {
    if vault.active_account_id.as_deref() != Some(account_id) {
        return None;
    }
    let account = vault.find_account(account_id)?;
    Some(ActiveSnapshot {
        active_account_id: Some(account_id.to_string()),
        env: CodexProvider.env_for_sidecar(account, vault.resolve_preset(account)),
    })
}

async fn refresh_active_projection(
    vault: &ProviderVault,
    account_id: &str,
    active_state: &ActiveAccountState,
) {
    if let Some(snapshot) = active_projection_for(vault, account_id) {
        active_state.set(ProviderId::Codex, snapshot).await;
    }
}

fn classify_reauth_reason(error: &str) -> Option<&'static str> {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("refresh token") && normalized.contains("reused") {
        Some("refresh_token_reused")
    } else if normalized.contains("refresh token") && normalized.contains("revoked") {
        Some("refresh_token_revoked")
    } else if normalized.contains("refresh token") && normalized.contains("expired") {
        Some("refresh_token_expired")
    } else if normalized.contains("invalid_grant") {
        Some("invalid_grant")
    } else {
        None
    }
}

fn current_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Account;

    #[tokio::test]
    async fn discover_returns_none_when_codex_home_empty() {
        // Use the shared hermetic seam: an isolated `CODEX_HOME` (held behind
        // the cross-test env lock) plus a forced-empty keyring, so this never
        // reads the developer's real keyring nor races the discovery tests
        // over the process-global `CODEX_HOME`.
        let _env = super::discovery::test_support::TestEnv::new();
        let got = codex_oauth_discover().await.unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn refresh_error_classification_is_stable_and_transient_errors_are_retryable() {
        assert_eq!(
            classify_reauth_reason("invalid_grant"),
            Some("invalid_grant")
        );
        assert_eq!(
            classify_reauth_reason("refresh token was reused"),
            Some("refresh_token_reused")
        );
        assert_eq!(classify_reauth_reason("network timeout"), None);
    }

    #[test]
    fn active_projection_uses_the_latest_codex_credential() {
        let account_id = "codex-active".to_string();
        let mut provider_vault = ProviderVault::empty();
        provider_vault.upsert_account(Account {
            id: account_id.clone(),
            label: None,
            credential: ProviderCredential::Codex(CodexCredentialData {
                access_token: "rotated-access-token".into(),
                refresh_token: "rotated-refresh-token".into(),
                auth_mode: "chatgpt".into(),
                ..CodexCredentialData::default()
            }),
            created_at_ms: 1,
            last_used_at_ms: 2,
            preset_id: None,
            auth_metadata: None,
        });
        provider_vault.active_account_id = Some(account_id.clone());

        let snapshot = active_projection_for(&provider_vault, &account_id)
            .expect("active Codex account should project");

        assert_eq!(
            snapshot.active_account_id.as_deref(),
            Some(account_id.as_str())
        );
        assert!(snapshot
            .env
            .iter()
            .any(|(key, value)| key == "CODEX_ACCESS_TOKEN" && value == "rotated-access-token"));
    }

    #[test]
    fn inactive_account_does_not_replace_the_active_projection() {
        let mut provider_vault = ProviderVault::empty();
        provider_vault.active_account_id = Some("other-account".into());

        assert!(active_projection_for(&provider_vault, "codex-inactive").is_none());
    }
}
