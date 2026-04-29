// In-process Anthropic API key store.
//
// We deliberately do not persist the key in Rust — the frontend writes it to
// IndexedDB and pushes it down to us via the `claude_set_api_key` command on
// startup and on every change. That keeps the persistence story on a single
// side of the IPC boundary and avoids two sources of truth.
//
// The key is later injected into the sidecar's environment when we spawn it
// (see `claude::sidecar::spawn`). Changing the key triggers a sidecar restart
// because the SDK reads the env var on init.

use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone, Default)]
pub struct ApiKeyState {
    inner: Arc<RwLock<Option<String>>>,
}

impl ApiKeyState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn set(&self, key: Option<String>) {
        let mut g = self.inner.write().await;
        *g = key.filter(|k| !k.is_empty());
    }

    pub async fn get(&self) -> Option<String> {
        self.inner.read().await.clone()
    }
}
