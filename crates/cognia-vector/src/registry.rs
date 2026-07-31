//! Per-`configId` cache of cloud `VectorBackend` implementations.
//!
//! Native is intentionally NOT supported here — it stays behind the
//! legacy `VectorState` (in `mod.rs`) and its sync command surface in
//! `commands.rs`. Cross-provider commands (`vector_cloud_*`) talk to
//! cloud backends through this registry; if a caller passes
//! `provider="native"` they get `NotAvailable` and should route to the
//! legacy commands instead.

use std::collections::HashMap;
use std::sync::Arc;

use log::debug;
use parking_lot::RwLock;

use super::backends::chroma::ChromaBackend;
use super::backends::milvus::MilvusBackend;
use super::backends::pinecone::PineconeBackend;
use super::backends::qdrant::QdrantBackend;
use super::backends::weaviate::WeaviateBackend;
use super::credentials::{self, VectorCredentials};
use super::error::{Result, VectorError};
use super::types::VectorProvider;
use super::VectorBackend;

pub struct VectorRegistry {
    backends: RwLock<HashMap<String, Arc<dyn VectorBackend>>>,
}

impl VectorRegistry {
    pub fn new() -> Self {
        Self {
            backends: RwLock::new(HashMap::new()),
        }
    }

    /// Look up or lazily build a cloud backend. Reads credentials from
    /// the OS keyring on first access; subsequent calls hit the in-memory
    /// `HashMap` cache.
    pub async fn resolve(
        &self,
        provider: VectorProvider,
        config_id: &str,
    ) -> Result<Arc<dyn VectorBackend>> {
        if provider == VectorProvider::Native {
            return Err(VectorError::NotAvailable(
                "native provider is served by legacy commands, not the cloud registry".into(),
            ));
        }
        if let Some(existing) = self.backends.read().get(config_id).cloned() {
            return Ok(existing);
        }

        let creds = credentials::load(provider, config_id)?.ok_or_else(|| {
            VectorError::Configuration(format!(
                "no credentials stored for {provider:?}/{config_id}"
            ))
        })?;
        let backend = build_cloud_backend(creds).await?;
        // The credential blob is provider-tagged, but the keyring lookup is
        // keyed by `(provider, config_id)`. A mismatched pair would silently
        // resolve to the wrong backend on subsequent calls, since the cache
        // key is just `config_id`. Catch the divergence at first build time.
        let constructed = backend.provider();
        if constructed != provider {
            return Err(VectorError::Configuration(format!(
                "credential blob for {config_id} declares {constructed:?} but caller requested {provider:?}"
            )));
        }
        debug!("vector: instantiated {provider:?} backend for config_id={config_id}");
        self.backends
            .write()
            .insert(config_id.to_string(), backend.clone());
        Ok(backend)
    }

    /// Drop a cached backend. Called after the JS layer updates or removes
    /// credentials so the next `resolve` rebuilds with fresh state.
    pub fn evict(&self, config_id: &str) {
        self.backends.write().remove(config_id);
    }

    pub fn known_config_ids(&self) -> Vec<String> {
        self.backends.read().keys().cloned().collect()
    }
}

impl Default for VectorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

async fn build_cloud_backend(creds: VectorCredentials) -> Result<Arc<dyn VectorBackend>> {
    let backend: Arc<dyn VectorBackend> = match creds {
        VectorCredentials::Pinecone {
            api_key,
            index_name,
            namespace,
        } => Arc::new(PineconeBackend::new(api_key, index_name, namespace).await?),
        VectorCredentials::Qdrant {
            url,
            api_key,
            collection_name: _,
        } => Arc::new(QdrantBackend::new(url, api_key)?),
        VectorCredentials::Chroma { url, auth_token } => {
            Arc::new(ChromaBackend::new(url, auth_token)?)
        }
        VectorCredentials::Milvus {
            address,
            token,
            username,
            password,
            ssl,
            collection_name: _,
        } => Arc::new(MilvusBackend::new(address, token, username, password, ssl).await?),
        VectorCredentials::Weaviate { url, api_key } => {
            Arc::new(WeaviateBackend::new(url, api_key)?)
        }
    };
    Ok(backend)
}

#[cfg(test)]
mod tests {
    use super::*;

    // `unwrap_err()` would require `Debug` on `Arc<dyn VectorBackend>`, and we
    // deliberately do NOT bound the trait on `Debug` — backend structs hold
    // raw API keys / tokens and a default derived `Debug` would leak them.
    // Helper assertions below match on the `Result` directly instead.

    #[test]
    fn new_starts_empty() {
        let r = VectorRegistry::new();
        assert!(r.known_config_ids().is_empty());
    }

    #[tokio::test]
    async fn resolve_native_rejected() {
        let r = VectorRegistry::new();
        match r.resolve(VectorProvider::Native, "native").await {
            Err(VectorError::NotAvailable(_)) => {}
            Err(e) => panic!("expected NotAvailable, got: {e}"),
            Ok(_) => panic!("expected NotAvailable, got Ok"),
        }
    }

    #[tokio::test]
    async fn resolve_cloud_without_credentials_errors() {
        let r = VectorRegistry::new();
        // Use an id deliberately unlikely to exist in any test machine's keyring.
        match r
            .resolve(
                VectorProvider::Pinecone,
                "this-config-should-never-exist-xyz-12345",
            )
            .await
        {
            Err(VectorError::Configuration(_)) | Err(VectorError::Auth(_)) => {}
            Err(e) => panic!("expected Configuration|Auth, got: {e}"),
            Ok(_) => panic!("expected error, got Ok"),
        }
    }

    #[test]
    fn evict_is_idempotent_on_missing_id() {
        let r = VectorRegistry::new();
        r.evict("nonexistent"); // must not panic
        assert!(r.known_config_ids().is_empty());
    }
}
