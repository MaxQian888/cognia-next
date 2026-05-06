// In-process Anthropic provider env store: API key + (optional) base URL +
// (optional) OAuth bearer.
//
// We deliberately do not persist any of these in Rust — the frontend writes
// them (api key/base URL → IndexedDB; OAuth bearer → keyring) and pushes them
// down via the `claude_set_provider_env` / `claude_set_oauth_bearer` IPCs on
// startup and on every change. Single source of truth on the JS side.
//
// Values are later injected into the sidecar's environment when we spawn it
// (see `claude::sidecar::spawn`):
//   - `CLAUDE_CODE_OAUTH_TOKEN` — when an OAuth bearer is registered. This
//     is the same env var the official `claude login` CLI sets, so the
//     `@anthropic-ai/claude-agent-sdk` picks it up natively (sends Bearer
//     auth + the `oauth-2025-04-20` beta header automatically).
//   - `ANTHROPIC_API_KEY` — when no OAuth bearer is set and the user has
//     configured an API key (legacy + CCSwitch flows).
//   - `ANTHROPIC_BASE_URL` — only when set (CCSwitch-style proxy providers);
//     orthogonal to the auth mode above.
//
// OAuth takes precedence over API key. We never set both — the SDK's
// behavior with both is unspecified and we want a deterministic path.
//
// Changing any field triggers a sidecar restart because the SDK reads env at
// init time only.

use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone, Default)]
struct Inner {
    api_key: Option<String>,
    base_url: Option<String>,
    oauth_bearer: Option<String>,
}

#[derive(Clone, Default)]
pub struct ApiKeyState {
    inner: Arc<RwLock<Inner>>,
}

impl ApiKeyState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the API key only; leave the base URL and OAuth bearer
    /// untouched. Existing callers (the legacy `claude_set_api_key` IPC)
    /// keep working.
    pub async fn set(&self, key: Option<String>) {
        let mut g = self.inner.write().await;
        g.api_key = key.filter(|k| !k.is_empty());
    }

    /// Replace api key + base URL atomically; leave the OAuth bearer alone.
    /// The frontend uses this whenever it switches CCSwitch providers so
    /// the sidecar restart sees a coherent (key, base-url) pair.
    pub async fn set_provider(&self, key: Option<String>, base_url: Option<String>) {
        let mut g = self.inner.write().await;
        g.api_key = key.filter(|k| !k.is_empty());
        g.base_url = base_url.filter(|u| !u.is_empty());
    }

    /// Replace the OAuth bearer. `None` clears it (sidecar will fall back to
    /// the API-key path on next spawn).
    pub async fn set_oauth_bearer(&self, token: Option<String>) {
        let mut g = self.inner.write().await;
        g.oauth_bearer = token.filter(|t| !t.is_empty());
    }

    pub async fn get(&self) -> Option<String> {
        self.inner.read().await.api_key.clone()
    }

    pub async fn get_base_url(&self) -> Option<String> {
        self.inner.read().await.base_url.clone()
    }

    pub async fn get_oauth_bearer(&self) -> Option<String> {
        self.inner.read().await.oauth_bearer.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_strings_are_normalized_to_none() {
        let s = ApiKeyState::new();
        s.set_provider(Some(String::new()), Some(String::new())).await;
        assert!(s.get().await.is_none());
        assert!(s.get_base_url().await.is_none());
    }

    #[tokio::test]
    async fn set_provider_replaces_both_fields() {
        let s = ApiKeyState::new();
        s.set_provider(Some("k1".into()), Some("https://a".into()))
            .await;
        assert_eq!(s.get().await.as_deref(), Some("k1"));
        assert_eq!(s.get_base_url().await.as_deref(), Some("https://a"));

        s.set_provider(Some("k2".into()), None).await;
        assert_eq!(s.get().await.as_deref(), Some("k2"));
        assert!(s.get_base_url().await.is_none());
    }

    #[tokio::test]
    async fn legacy_set_only_touches_api_key() {
        let s = ApiKeyState::new();
        s.set_provider(Some("k".into()), Some("https://b".into()))
            .await;
        s.set(Some("k2".into())).await;
        assert_eq!(s.get().await.as_deref(), Some("k2"));
        // Base URL preserved across the legacy setter.
        assert_eq!(s.get_base_url().await.as_deref(), Some("https://b"));
    }

    #[tokio::test]
    async fn oauth_bearer_is_orthogonal_to_api_key() {
        let s = ApiKeyState::new();
        s.set(Some("ak".into())).await;
        s.set_oauth_bearer(Some("oat-1".into())).await;
        assert_eq!(s.get().await.as_deref(), Some("ak"));
        assert_eq!(s.get_oauth_bearer().await.as_deref(), Some("oat-1"));

        // Clearing the bearer leaves the api key alone — the spawn path
        // decides which one wins, not this struct.
        s.set_oauth_bearer(None).await;
        assert_eq!(s.get().await.as_deref(), Some("ak"));
        assert!(s.get_oauth_bearer().await.is_none());
    }

    #[tokio::test]
    async fn oauth_bearer_normalizes_empty_to_none() {
        let s = ApiKeyState::new();
        s.set_oauth_bearer(Some(String::new())).await;
        assert!(s.get_oauth_bearer().await.is_none());
    }
}
