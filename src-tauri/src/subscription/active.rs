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
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::subscription::provider::ProviderId;

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
            s.get(ProviderId::Anthropic).await.active_account_id.as_deref(),
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
        assert!(s.get(ProviderId::Anthropic).await.active_account_id.is_none());
    }
}
