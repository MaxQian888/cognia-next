// Shared CRUD + active-pointer + preset Tauri commands.
//
// Provider-agnostic surface — every command takes a `provider: String` and
// dispatches through `ProviderId::parse`. Per-provider commands
// (PKCE/device-code/discovery/paste-zen-key) live under the respective
// submodules (`anthropic::commands::*`, `codex::commands::*`,
// `opencode::commands::*`).

use tauri::{AppHandle, Manager, State};

use crate::api_key::ApiKeyState;
use crate::claude::sidecar::{kill_sidecar, SidecarState};
use crate::subscription::active::{self, ActiveAccountState, ActiveSnapshot};
use crate::subscription::anthropic::AnthropicProvider;
use crate::subscription::codex::CodexProvider;
use crate::subscription::migration::{self, MigrationOutcome};
use crate::subscription::opencode::OpencodeProvider;
use crate::subscription::preset::ProviderPreset;
use crate::subscription::provider::{ProviderId, SubscriptionProvider};
use crate::subscription::vault::{self, Account, AccountSummary, ProviderVault};

// ---------------------------------------------------------------------------
// Provider dispatch helper. Cheap function-call indirection — easier than a
// trait-object table because each provider impl is a unit struct.
// ---------------------------------------------------------------------------

fn for_provider<R>(
    id: ProviderId,
    f: impl FnOnce(&dyn SubscriptionProvider) -> R,
) -> R {
    match id {
        ProviderId::Anthropic => f(&AnthropicProvider),
        ProviderId::Codex => f(&CodexProvider),
        ProviderId::Opencode => f(&OpencodeProvider),
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/// Run v1 → v2 migration for every provider. Idempotent. Called once on app
/// boot from the renderer (`lib/subscription/core/migration.ts::subscriptionInit`).
#[tauri::command]
pub async fn subscription_init() -> Result<Vec<MigrationOutcome>, String> {
    Ok(migration::migrate_all())
}

// ---------------------------------------------------------------------------
// Account CRUD
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn subscription_list_accounts(provider: String) -> Result<Vec<AccountSummary>, String> {
    let id = ProviderId::parse(&provider)?;
    let vault = vault::load(id)?.unwrap_or_else(ProviderVault::empty);
    Ok(vault
        .accounts
        .iter()
        .map(AccountSummary::from_account)
        .collect())
}

#[tauri::command]
pub async fn subscription_get_account(
    provider: String,
    account_id: String,
) -> Result<Option<Account>, String> {
    let id = ProviderId::parse(&provider)?;
    let vault = match vault::load(id)? {
        Some(v) => v,
        None => return Ok(None),
    };
    Ok(vault.find_account(&account_id).cloned())
}

#[tauri::command]
pub async fn subscription_save_account(provider: String, account: Account) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    // Reject a credential whose discriminator doesn't match the provider —
    // saves the caller from a silent mismatch later.
    if account.credential.provider() != id {
        return Err(format!(
            "credential provider mismatch: account.credential is for {:?}, expected {:?}",
            account.credential.provider(),
            id
        ));
    }
    for_provider(id, |p| p.validate(&account.credential))?;

    let mut vault = vault::load(id)?.unwrap_or_else(ProviderVault::empty);
    vault.upsert_account(account);
    vault::save(id, &vault)
}

#[tauri::command]
pub async fn subscription_delete_account(
    provider: String,
    account_id: String,
    state: State<'_, ActiveAccountState>,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    let mut vault = match vault::load(id)? {
        Some(v) => v,
        None => return Ok(()),
    };
    let cleared_active = vault.active_account_id.as_deref() == Some(account_id.as_str());
    vault.remove_account(&account_id);
    vault::save(id, &vault)?;

    if cleared_active {
        // The active pointer is gone — drop the cache so the next sidecar
        // spawn doesn't reuse a credential that no longer exists.
        state.set(id, ActiveSnapshot::default()).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn subscription_rename_account(
    provider: String,
    account_id: String,
    label: Option<String>,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    let mut vault = vault::load(id)?
        .ok_or_else(|| format!("no vault exists for provider {provider:?}"))?;
    let account = vault
        .accounts
        .iter_mut()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("no account {account_id:?} in {provider} vault"))?;
    account.label = label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    vault::save(id, &vault)
}

// ---------------------------------------------------------------------------
// Active pointer
// ---------------------------------------------------------------------------

/// Set (or clear) the active account for a provider.
///
/// For Anthropic specifically: also pushes the resolved OAuth bearer into
/// `ApiKeyState` and kills the sidecar so the next spawn sees the new env.
/// For Codex / OpenCode: the env-builder reads `ActiveAccountState` directly
/// at the next external-agent spawn — no sidecar restart needed.
///
/// Passing `None` for `account_id` clears the active pointer.
#[tauri::command]
pub async fn subscription_set_active(
    provider: String,
    account_id: Option<String>,
    active_state: State<'_, ActiveAccountState>,
    api_key_state: State<'_, ApiKeyState>,
    sidecar_state: State<'_, SidecarState>,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    let mut vault = vault::load(id)?.unwrap_or_else(ProviderVault::empty);

    let (snapshot, must_restart_sidecar, anthropic_bearer) = match &account_id {
        Some(target_id) => {
            let account = vault
                .find_account(target_id)
                .ok_or_else(|| format!("no account {target_id:?} in {provider} vault"))?
                .clone();
            let env = for_provider(id, |p| {
                p.env_for_sidecar(&account, vault.preset.as_ref())
            });
            let restart = for_provider(id, |p| p.requires_sidecar_restart_on_active_switch());
            let bearer = if id == ProviderId::Anthropic {
                env.iter()
                    .find(|(k, _)| k == "CLAUDE_CODE_OAUTH_TOKEN")
                    .map(|(_, v)| v.clone())
            } else {
                None
            };
            (
                ActiveSnapshot {
                    active_account_id: Some(target_id.clone()),
                    env,
                },
                restart,
                bearer,
            )
        }
        None => (
            ActiveSnapshot::default(),
            for_provider(id, |p| p.requires_sidecar_restart_on_active_switch()),
            None,
        ),
    };

    vault.active_account_id = account_id.clone();
    vault::save(id, &vault)?;
    active_state.set(id, snapshot).await;

    // Anthropic-only side effects: push the bearer into the in-process
    // ApiKeyState (the contract sidecar.rs:143-155 reads at spawn time) and
    // kill the running sidecar so the next claude_send spawns a fresh one
    // with the new env.
    if id == ProviderId::Anthropic {
        api_key_state.set_oauth_bearer(anthropic_bearer).await;
        if must_restart_sidecar {
            kill_sidecar(sidecar_state.inner().clone()).await;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn subscription_get_active(
    provider: String,
    state: State<'_, ActiveAccountState>,
) -> Result<ActiveSnapshot, String> {
    let id = ProviderId::parse(&provider)?;
    Ok(state.get(id).await)
}

// ---------------------------------------------------------------------------
// Provider preset
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn subscription_get_preset(provider: String) -> Result<Option<ProviderPreset>, String> {
    let id = ProviderId::parse(&provider)?;
    let vault = vault::load(id)?.unwrap_or_else(ProviderVault::empty);
    Ok(vault.preset)
}

#[tauri::command]
pub async fn subscription_set_preset(
    provider: String,
    preset: Option<ProviderPreset>,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    let supports = for_provider(id, |p| p.supports_preset());
    if preset.is_some() && !supports {
        return Err(format!(
            "provider {provider:?} does not support presets"
        ));
    }
    if let Some(p) = preset.as_ref() {
        p.validate()?;
    }
    let mut vault = vault::load(id)?.unwrap_or_else(ProviderVault::empty);
    vault.preset = preset;
    vault::save(id, &vault)
}

// ---------------------------------------------------------------------------
// ADR-0028 — per-`query()` env injection. `claude_env_for_account` returns the
// env tuple for an arbitrary accountId WITHOUT touching `ActiveAccountState`,
// so the renderer can mix accounts per ChatSession without flipping the global
// active pointer. `claude_proxy_env_for_session` returns the current process
// proxy env tuple; the `session_id` parameter is forward-compat for per-session
// proxy overrides (deferred V2).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn claude_env_for_account(
    app: AppHandle,
    provider: String,
    account_id: String,
) -> Result<Option<Vec<(String, String)>>, String> {
    let id = ProviderId::parse(&provider)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app_data_dir: {e}"))?;
    active::env_for_account(&app_data_dir, id, &account_id)
}

#[tauri::command]
pub async fn claude_proxy_env_for_session(
    _session_id: String,
) -> Result<Vec<(String, String)>, String> {
    // _session_id is forward-compat for per-session proxy overrides (ADR-0028
    // open follow-up). V1 returns the process-level proxy as-is, identical to
    // what `src-tauri/src/claude/sidecar.rs:163` already injects at sidecar
    // spawn — but now also reachable per-`query()` from the renderer.
    Ok(crate::proxy_config::current().env_vars())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscription::vault::{AnthropicCredentialData, ProviderCredential};
    use std::collections::BTreeMap;

    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    fn sample_anthropic_account() -> Account {
        Account {
            id: uuid::Uuid::now_v7().to_string(),
            label: Some("Test".into()),
            credential: ProviderCredential::Anthropic(AnthropicCredentialData {
                access_token: "oat01-cmd".into(),
                refresh_token: "rt-cmd".into(),
                expires_at_ms: 1_800_000_000_000,
                mode: "subscription".into(),
                scope: None,
                email: None,
                plan: Some("pro".into()),
                stored_at_ms: 1_700_000_000_000,
            }),
            created_at_ms: 1_700_000_000_000,
            last_used_at_ms: 1_700_000_000_000,
        }
    }

    #[tokio::test]
    async fn save_rejects_credential_provider_mismatch() {
        use crate::subscription::vault::CodexCredentialData;
        let mut account = sample_anthropic_account();
        // Swap credential to a Codex one without changing the provider arg.
        account.credential = ProviderCredential::Codex(CodexCredentialData {
            access_token: "oat".into(),
            auth_mode: "chatgpt".into(),
            ..Default::default()
        });
        let err = subscription_save_account("anthropic".into(), account)
            .await
            .expect_err("should reject");
        assert!(err.contains("provider mismatch"));
    }

    #[tokio::test]
    async fn save_rejects_unknown_provider() {
        let err = subscription_save_account("bogus".into(), sample_anthropic_account())
            .await
            .expect_err("should reject");
        assert!(err.contains("bogus"));
    }

    #[tokio::test]
    async fn set_preset_rejects_for_opencode() {
        let mut headers = BTreeMap::new();
        headers.insert("X-Test".into(), "1".into());
        let preset = ProviderPreset {
            id: "p".into(),
            label: "test".into(),
            base_url: "https://example.com".into(),
            extra_headers: headers,
        };
        let err = subscription_set_preset("opencode".into(), Some(preset))
            .await
            .expect_err("opencode should not support presets");
        assert!(err.contains("preset"));
    }

    #[tokio::test]
    async fn list_accounts_returns_empty_when_no_vault() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Anthropic);
        let got = subscription_list_accounts("anthropic".into()).await.unwrap();
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn list_accounts_strips_secrets_from_summary() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Anthropic);
        let account = sample_anthropic_account();
        subscription_save_account("anthropic".into(), account.clone())
            .await
            .unwrap();
        let got = subscription_list_accounts("anthropic".into())
            .await
            .unwrap();
        assert_eq!(got.len(), 1);
        let blob = serde_json::to_string(&got[0]).unwrap();
        assert!(!blob.contains("oat01-cmd"));
        assert!(!blob.contains("rt-cmd"));

        vault::clear(ProviderId::Anthropic).unwrap();
    }

    #[tokio::test]
    async fn rename_updates_label() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Anthropic);
        let account = sample_anthropic_account();
        let aid = account.id.clone();
        subscription_save_account("anthropic".into(), account).await.unwrap();

        subscription_rename_account("anthropic".into(), aid.clone(), Some("New Label".into()))
            .await
            .unwrap();
        let got = subscription_get_account("anthropic".into(), aid.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got.label.as_deref(), Some("New Label"));

        // Empty/whitespace label clears it.
        subscription_rename_account("anthropic".into(), aid.clone(), Some("   ".into()))
            .await
            .unwrap();
        let got = subscription_get_account("anthropic".into(), aid)
            .await
            .unwrap()
            .unwrap();
        assert!(got.label.is_none());

        vault::clear(ProviderId::Anthropic).unwrap();
    }

    #[tokio::test]
    async fn rename_rejects_missing_account() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Anthropic);
        let err =
            subscription_rename_account("anthropic".into(), "nonexistent".into(), None)
                .await
                .expect_err("should fail");
        assert!(err.contains("no vault") || err.contains("no account"));
    }

    #[tokio::test]
    async fn get_and_set_preset_round_trip() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Anthropic);
        assert!(subscription_get_preset("anthropic".into()).await.unwrap().is_none());

        let mut headers = BTreeMap::new();
        headers.insert("X-Org".into(), "cognia".into());
        let preset = ProviderPreset {
            id: "p1".into(),
            label: "Bedrock".into(),
            base_url: "https://bedrock.example.com".into(),
            extra_headers: headers,
        };
        subscription_set_preset("anthropic".into(), Some(preset.clone()))
            .await
            .unwrap();
        let got = subscription_get_preset("anthropic".into()).await.unwrap();
        assert_eq!(got, Some(preset));

        // Clear it.
        subscription_set_preset("anthropic".into(), None).await.unwrap();
        assert!(subscription_get_preset("anthropic".into()).await.unwrap().is_none());

        vault::clear(ProviderId::Anthropic).unwrap();
    }
}
