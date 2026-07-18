// In-process active-account resolver.
//
// One `ActiveAccountState` per app instance. Holds, for each provider, the
// resolved environment variables the sidecar / external-agent process should
// see when THIS provider's active account is selected. Lookups are
// synchronous and cheap — the renderer cannot pay an OS-keyring round-trip on
// every sidecar spawn.
//
// `subscription_set_active` writes into this cache (and, for Anthropic, into
// `ApiKeyState` so the existing sidecar.rs:143-155 contract keeps working).
// `subscription_get_active` reads from it.
//
// **Important**: this cache is a *projection* of the persisted vault. The
// vault is the source of truth; the cache is rebuilt on app boot by reading
// each provider's vault and applying its current `active_account_id`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::anthropic::AnthropicProvider;
use crate::codex::CodexProvider;
use crate::opencode::OpencodeProvider;
use crate::preset::ProviderPreset;
use crate::provider::{ProviderId, SubscriptionProvider};
use crate::vault::{self, Account, ProviderVault};

/// Snapshot of the in-process active state for one provider.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveSnapshot {
    /// UUIDv7 of the active account, or `None` when the user explicitly
    /// cleared the active selection (or when no accounts exist yet).
    #[serde(rename = "activeAccountId")]
    pub active_account_id: Option<String>,
    /// Env vars the sidecar / external-agent process should inherit when
    /// spawning under this provider's active account. Empty when there's no
    /// active account.
    pub env: Vec<(String, String)>,
}

#[derive(Default)]
struct Inner {
    /// Keyed by `ProviderId::as_str()`. Using a string key keeps the type
    /// `Send + 'static` without juggling `Copy` on `ProviderId`.
    by_provider: HashMap<&'static str, ActiveSnapshot>,
}

#[derive(Clone, Default)]
pub struct ActiveAccountState {
    inner: Arc<RwLock<Inner>>,
}

impl ActiveAccountState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the snapshot for one provider. Pass `ActiveSnapshot::default()`
    /// to clear (active becomes `None`, env becomes empty).
    pub async fn set(&self, provider: ProviderId, snapshot: ActiveSnapshot) {
        let mut g = self.inner.write().await;
        g.by_provider.insert(provider.as_str(), snapshot);
    }

    /// Read the snapshot for one provider. Returns the default snapshot when
    /// nothing has been recorded yet (active = None, env = []).
    pub async fn get(&self, provider: ProviderId) -> ActiveSnapshot {
        self.inner
            .read()
            .await
            .by_provider
            .get(provider.as_str())
            .cloned()
            .unwrap_or_default()
    }

    /// Convenience accessor used by external-agent env-builder + sidecar
    /// spawn paths. The Tauri command surface returns the full
    /// `ActiveSnapshot`, but Rust-side callers usually only want the env vec.
    #[allow(dead_code)]
    pub async fn env_for(&self, provider: ProviderId) -> Vec<(String, String)> {
        self.get(provider).await.env
    }

    /// Drop every cached snapshot. Today only the test suite exercises this
    /// path; the future "sign out from every provider" admin flow will hook
    /// here too.
    #[allow(dead_code)]
    pub async fn clear_all(&self) {
        let mut g = self.inner.write().await;
        g.by_provider.clear();
    }
}

// ---------------------------------------------------------------------------
// ADR-0028 — per-account env lookup, read-only sibling of `set` / `get`.
//
// `env_for_account` resolves the env tuple for a specific accountId WITHOUT
// touching `ActiveAccountState`. Used by `claude_env_for_account` so the
// renderer can build per-`query()` env per ChatSession (ADR-0028 §"Per-query
// env injection") without flipping the global active pointer.
//
// Beyond what `SubscriptionProvider::env_for_sidecar` already emits, this also
// appends a per-account `CLAUDE_CONFIG_DIR` pointing at
// `<app_data>/cognia/accounts/<local_account_id>/claude-configs/<account_id>/`.
// Per-account credentials directories are the cure for the OAuth refresh race
// (Anthropic issues #43392 / #24317): two concurrent CLI subprocesses sharing
// one `.credentials.json` will race on refresh; per-account dirs give each
// account its own file. Scoping by `local_account_id` also keeps two local
// accounts that happen to hold the same provider `account_id` mutually
// invisible (ADR-0054).
// ---------------------------------------------------------------------------

/// Per-account `CLAUDE_CONFIG_DIR` path. Pure: caller decides whether to
/// ensure-create. Scoped by `local_account_id` so the OAuth-refresh watcher
/// (`subscription/commands.rs`) and this env builder resolve to the SAME
/// directory and two local accounts never collide on one config dir.
pub fn per_account_config_dir(
    app_data_dir: &Path,
    local_account_id: &str,
    account_id: &str,
) -> PathBuf {
    app_data_dir
        .join("cognia")
        .join("accounts")
        .join(local_account_id)
        .join("claude-configs")
        .join(account_id)
}

/// Legacy (pre-ADR-0054) per-account config dir that omitted the
/// `local_account_id` segment. Used only by [`migrate_legacy_config_dir`].
fn legacy_per_account_config_dir(app_data_dir: &Path, account_id: &str) -> PathBuf {
    app_data_dir
        .join("cognia")
        .join("claude-configs")
        .join(account_id)
}

/// Best-effort one-time migration of a pre-ADR-0054 config dir into its new
/// `local_account_id`-scoped location. No-op when the new dir already exists or
/// the legacy dir is absent. Failures are non-fatal — the CLI can re-OAuth into
/// a fresh dir — so the caller only logs a warning.
fn migrate_legacy_config_dir(app_data_dir: &Path, account_id: &str, new_dir: &Path) {
    if new_dir.exists() {
        return;
    }
    let legacy = legacy_per_account_config_dir(app_data_dir, account_id);
    if legacy == new_dir || !legacy.exists() {
        return;
    }
    if let Some(parent) = new_dir.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!(
                "failed to create parent for legacy config-dir migration ({}): {e}",
                parent.display()
            );
            return;
        }
    }
    if let Err(e) = std::fs::rename(&legacy, new_dir) {
        log::warn!(
            "failed to migrate legacy CLAUDE_CONFIG_DIR {} -> {}: {e}",
            legacy.display(),
            new_dir.display()
        );
    }
}

/// Inline dispatch to the provider impl's `env_for_sidecar`. The same shape
/// lives in `subscription/commands.rs::for_provider` but kept local here to
/// avoid widening that helper's visibility.
fn dispatch_env_for_sidecar(
    provider: ProviderId,
    account: &Account,
    preset: Option<&ProviderPreset>,
) -> Vec<(String, String)> {
    match provider {
        ProviderId::Anthropic => AnthropicProvider.env_for_sidecar(account, preset),
        ProviderId::Codex => CodexProvider.env_for_sidecar(account, preset),
        ProviderId::Opencode => OpencodeProvider.env_for_sidecar(account, preset),
    }
}

/// Read-only env builder used by `claude_env_for_account`. Returns `None`
/// when the account-scoped vault does not exist for the provider or the
/// account_id is not in that local account's vault — callers fall through to
/// the next precedence rung (`character.accountIdOverride` →
/// `settings.defaultAccountId` → `ActiveAccountState.get(provider)`).
///
/// Ensure-creates the per-account config directory so the spawned CLI
/// subprocess can write its `.credentials.json` there immediately.
pub fn env_for_local_account(
    app_data_dir: &Path,
    local_account_id: &str,
    provider: ProviderId,
    account_id: &str,
) -> Result<Option<Vec<(String, String)>>, String> {
    let Some(vault) = vault::load_for_account(local_account_id, provider)? else {
        return Ok(None);
    };
    let Some(account) = vault.find_account(account_id) else {
        return Ok(None);
    };
    let env =
        env_for_account_with_vault(app_data_dir, local_account_id, provider, &vault, account)?;
    Ok(Some(env))
}

/// Pure variant of `env_for_account` that takes the loaded vault by reference
/// — exercised by unit tests without the keyring.
pub fn env_for_account_with_vault(
    app_data_dir: &Path,
    local_account_id: &str,
    provider: ProviderId,
    vault: &ProviderVault,
    account: &Account,
) -> Result<Vec<(String, String)>, String> {
    let mut env = dispatch_env_for_sidecar(provider, account, vault.resolve_preset(account));
    let config_dir = per_account_config_dir(app_data_dir, local_account_id, &account.id);
    migrate_legacy_config_dir(app_data_dir, &account.id, &config_dir);
    std::fs::create_dir_all(&config_dir).map_err(|e| {
        format!(
            "failed to create per-account CLAUDE_CONFIG_DIR at {}: {e}",
            config_dir.display()
        )
    })?;
    env.push((
        "CLAUDE_CONFIG_DIR".to_string(),
        config_dir.to_string_lossy().into_owned(),
    ));
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn get_returns_default_when_unset() {
        let s = ActiveAccountState::new();
        let got = s.get(ProviderId::Anthropic).await;
        assert!(got.active_account_id.is_none());
        assert!(got.env.is_empty());
    }

    #[tokio::test]
    async fn set_then_get_round_trips() {
        let s = ActiveAccountState::new();
        let snap = ActiveSnapshot {
            active_account_id: Some("0193c2b0-0000-7000-8000-000000000001".into()),
            env: vec![("CLAUDE_CODE_OAUTH_TOKEN".into(), "oat".into())],
        };
        s.set(ProviderId::Anthropic, snap.clone()).await;
        assert_eq!(s.get(ProviderId::Anthropic).await, snap);
    }

    #[tokio::test]
    async fn providers_isolated_from_each_other() {
        let s = ActiveAccountState::new();
        s.set(
            ProviderId::Anthropic,
            ActiveSnapshot {
                active_account_id: Some("a".into()),
                env: vec![("CLAUDE_CODE_OAUTH_TOKEN".into(), "oat".into())],
            },
        )
        .await;
        s.set(
            ProviderId::Codex,
            ActiveSnapshot {
                active_account_id: Some("c".into()),
                env: vec![("CODEX_ACCESS_TOKEN".into(), "ct".into())],
            },
        )
        .await;
        assert_eq!(
            s.get(ProviderId::Anthropic)
                .await
                .active_account_id
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            s.get(ProviderId::Codex).await.active_account_id.as_deref(),
            Some("c")
        );
        assert_eq!(s.env_for(ProviderId::Opencode).await, vec![]);
    }

    #[tokio::test]
    async fn clear_all_resets_state() {
        let s = ActiveAccountState::new();
        s.set(
            ProviderId::Anthropic,
            ActiveSnapshot {
                active_account_id: Some("a".into()),
                env: vec![],
            },
        )
        .await;
        s.clear_all().await;
        assert!(s
            .get(ProviderId::Anthropic)
            .await
            .active_account_id
            .is_none());
    }

    // -----------------------------------------------------------------------
    // ADR-0028 — per-account env builder tests.
    // -----------------------------------------------------------------------

    use crate::vault::{AnthropicCredentialData, ProviderCredential};

    fn sample_anthropic_account(id: &str) -> Account {
        Account {
            id: id.to_string(),
            label: Some("Test".into()),
            credential: ProviderCredential::Anthropic(AnthropicCredentialData {
                access_token: "oat01-env-for-account".into(),
                refresh_token: "rt-env-for-account".into(),
                expires_at_ms: 1_800_000_000_000,
                mode: "subscription".into(),
                scope: None,
                email: Some("user@example.com".into()),
                plan: Some("pro".into()),
                original_source: None,
                stored_at_ms: 1_700_000_000_000,
            }),
            created_at_ms: 1_700_000_000_000,
            last_used_at_ms: 1_700_000_000_000,
            preset_id: None,
        }
    }

    fn vault_with(accounts: Vec<Account>) -> ProviderVault {
        let mut v = ProviderVault::empty();
        for a in accounts {
            v.upsert_account(a);
        }
        v
    }

    #[test]
    fn per_account_config_dir_builds_expected_path() {
        let app_data = Path::new("/tmp/app-data");
        let got = per_account_config_dir(app_data, "local-1", "01abc-account");
        let expected =
            Path::new("/tmp/app-data/cognia/accounts/local-1/claude-configs/01abc-account");
        assert_eq!(got, expected);
    }

    #[test]
    fn per_account_config_dir_scopes_by_local_account() {
        // Same provider account_id under two different local accounts must
        // resolve to two distinct directories (ADR-0054 isolation).
        let app_data = Path::new("/tmp/app-data");
        let a = per_account_config_dir(app_data, "local-A", "shared-acct");
        let b = per_account_config_dir(app_data, "local-B", "shared-acct");
        assert_ne!(a, b);
    }

    #[test]
    fn env_for_account_with_vault_emits_oauth_token_and_config_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let account = sample_anthropic_account("01abc");
        let vault = vault_with(vec![account.clone()]);
        let env = env_for_account_with_vault(
            tmp.path(),
            "local-1",
            ProviderId::Anthropic,
            &vault,
            &account,
        )
        .unwrap();

        // OAuth bearer surfaces verbatim.
        assert!(env
            .iter()
            .any(|(k, v)| k == "CLAUDE_CODE_OAUTH_TOKEN" && v == "oat01-env-for-account"));

        // CLAUDE_CONFIG_DIR points at the local-account-scoped path and is the
        // SAME path the watcher resolves through `per_account_config_dir`.
        let config_dir_entry = env
            .iter()
            .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
            .expect("CLAUDE_CONFIG_DIR must be present");
        let expected = per_account_config_dir(tmp.path(), "local-1", "01abc");
        assert_eq!(config_dir_entry.1, expected.to_string_lossy());

        // Directory is ensure-created.
        assert!(expected.is_dir(), "per-account config dir must be created");
    }

    #[test]
    fn env_for_account_with_vault_migrates_legacy_config_dir() {
        // A pre-ADR-0054 config dir (no local_account_id segment) holding a
        // .credentials.json should be moved into the new scoped location on
        // first resolve, preserving the existing OAuth credentials.
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp
            .path()
            .join("cognia")
            .join("claude-configs")
            .join("01abc");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join(".credentials.json"), b"{\"oauth\":1}").unwrap();

        let account = sample_anthropic_account("01abc");
        let vault = vault_with(vec![account.clone()]);
        env_for_account_with_vault(
            tmp.path(),
            "local-1",
            ProviderId::Anthropic,
            &vault,
            &account,
        )
        .unwrap();

        let new_dir = per_account_config_dir(tmp.path(), "local-1", "01abc");
        assert!(
            new_dir.join(".credentials.json").is_file(),
            "legacy credentials must be migrated into the scoped dir"
        );
        assert!(!legacy.exists(), "legacy dir must be moved, not copied");
    }

    #[test]
    fn env_for_account_with_vault_does_not_emit_api_key() {
        // OAuth-mode anthropic credentials must not co-emit ANTHROPIC_API_KEY —
        // the SDK warns if both are set. We rely on AnthropicProvider::env_for_sidecar
        // already enforcing this; verify the contract from this layer too.
        let tmp = tempfile::tempdir().unwrap();
        let account = sample_anthropic_account("01abc");
        let vault = vault_with(vec![account.clone()]);
        let env = env_for_account_with_vault(
            tmp.path(),
            "local-1",
            ProviderId::Anthropic,
            &vault,
            &account,
        )
        .unwrap();
        assert!(
            !env.iter().any(|(k, _)| k == "ANTHROPIC_API_KEY"),
            "OAuth-mode account must not emit ANTHROPIC_API_KEY"
        );
    }

    #[test]
    fn env_for_account_with_vault_applies_preset_base_url() {
        use crate::preset::ProviderPreset;
        use std::collections::BTreeMap;

        let tmp = tempfile::tempdir().unwrap();
        let mut headers = BTreeMap::new();
        headers.insert("X-Org".into(), "cognia".into());
        let preset = ProviderPreset {
            id: "p1".into(),
            label: "Bedrock".into(),
            base_url: "https://bedrock.example.com".into(),
            extra_headers: headers,
            template_id: None,
            model_mapping: BTreeMap::new(),
        };
        let account = sample_anthropic_account("01abc");
        let mut vault = vault_with(vec![account.clone()]);
        // Use v3 preset mechanism: add preset to library and set as default.
        vault.upsert_preset(preset);
        vault.default_preset_id = Some("p1".into());

        let env = env_for_account_with_vault(
            tmp.path(),
            "local-1",
            ProviderId::Anthropic,
            &vault,
            &account,
        )
        .unwrap();
        assert!(env
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_BASE_URL" && v == "https://bedrock.example.com"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_CUSTOM_HEADER_X-Org" && v == "cognia"));
    }

    #[test]
    fn env_for_account_with_vault_isolates_config_dir_per_account() {
        // Two accounts in the same vault must produce two distinct
        // CLAUDE_CONFIG_DIR paths — this is the OAuth refresh race mitigation
        // (each account gets its own .credentials.json).
        let tmp = tempfile::tempdir().unwrap();
        let a = sample_anthropic_account("acct-A");
        let b = sample_anthropic_account("acct-B");
        let vault = vault_with(vec![a.clone(), b.clone()]);

        let env_a =
            env_for_account_with_vault(tmp.path(), "local-1", ProviderId::Anthropic, &vault, &a)
                .unwrap();
        let env_b =
            env_for_account_with_vault(tmp.path(), "local-1", ProviderId::Anthropic, &vault, &b)
                .unwrap();

        let dir_a = env_a
            .iter()
            .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
            .unwrap()
            .1
            .clone();
        let dir_b = env_b
            .iter()
            .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
            .unwrap()
            .1
            .clone();
        assert_ne!(
            dir_a, dir_b,
            "different accounts must get different config dirs"
        );
    }
}
