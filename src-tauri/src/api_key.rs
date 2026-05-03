// In-process Anthropic provider env store: API key + (optional) base URL.
//
// We deliberately do not persist either value in Rust — the frontend writes
// them to IndexedDB and pushes them down via the `claude_set_provider_env`
// command on startup and on every change. That keeps the persistence story
// on a single side of the IPC boundary and avoids two sources of truth.
//
// Both values are later injected into the sidecar's environment when we spawn
// it (see `claude::sidecar::spawn`):
//   - `ANTHROPIC_API_KEY` — always, when present
//   - `ANTHROPIC_BASE_URL` — only when set (CCSwitch-style proxy providers)
//
// Changing either triggers a sidecar restart because the SDK reads both env
// vars at init.

use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone, Default)]
struct Inner {
    api_key: Option<String>,
    base_url: Option<String>,
}

#[derive(Clone, Default)]
pub struct ApiKeyState {
    inner: Arc<RwLock<Inner>>,
}

impl ApiKeyState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the API key only; leave the base URL untouched. Existing
    /// callers (the legacy `claude_set_api_key` IPC) keep working.
    pub async fn set(&self, key: Option<String>) {
        let mut g = self.inner.write().await;
        g.api_key = key.filter(|k| !k.is_empty());
    }

    /// Replace both fields atomically. The frontend uses this whenever it
    /// switches CCSwitch providers so the sidecar restart sees a coherent
    /// (key, base-url) pair.
    pub async fn set_provider(&self, key: Option<String>, base_url: Option<String>) {
        let mut g = self.inner.write().await;
        g.api_key = key.filter(|k| !k.is_empty());
        g.base_url = base_url.filter(|u| !u.is_empty());
    }

    pub async fn get(&self) -> Option<String> {
        self.inner.read().await.api_key.clone()
    }

    pub async fn get_base_url(&self) -> Option<String> {
        self.inner.read().await.base_url.clone()
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
}
