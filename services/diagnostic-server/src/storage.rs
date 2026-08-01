use std::sync::Arc;

use anyhow::Context;
use bytes::Bytes;
use object_store::{
    aws::AmazonS3Builder, local::LocalFileSystem, path::Path, ObjectStore, PutPayload,
};

use crate::config::ServerConfig;

#[derive(Clone)]
pub struct ArtifactStore {
    inner: Arc<dyn ObjectStore>,
}

impl ArtifactStore {
    pub fn from_config(config: &ServerConfig) -> anyhow::Result<Self> {
        let inner: Arc<dyn ObjectStore> = if let Some(root) = &config.object_store_local_dir {
            std::fs::create_dir_all(root).context("create local artifact directory")?;
            Arc::new(LocalFileSystem::new_with_prefix(root)?)
        } else {
            let mut builder = AmazonS3Builder::new()
                .with_bucket_name(&config.object_store_bucket)
                .with_region(&config.object_store_region)
                .with_allow_http(
                    config
                        .object_store_endpoint
                        .as_deref()
                        .is_some_and(|endpoint| endpoint.starts_with("http://")),
                );
            if let Some(endpoint) = &config.object_store_endpoint {
                builder = builder
                    .with_endpoint(endpoint)
                    .with_virtual_hosted_style_request(false);
            }
            if let Some(access_key) = &config.object_store_access_key {
                builder = builder.with_access_key_id(access_key);
            }
            if let Some(secret_key) = &config.object_store_secret_key {
                builder = builder.with_secret_access_key(secret_key);
            }
            Arc::new(builder.build()?)
        };
        Ok(Self { inner })
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            inner: Arc::new(object_store::memory::InMemory::new()),
        }
    }

    pub async fn put_part(&self, key: &str, body: Vec<u8>) -> anyhow::Result<()> {
        self.inner
            .put(&Path::from(key), PutPayload::from(Bytes::from(body)))
            .await
            .context("write diagnostic artifact part")?;
        Ok(())
    }

    pub async fn get(&self, key: &str) -> anyhow::Result<Vec<u8>> {
        Ok(self
            .inner
            .get(&Path::from(key))
            .await
            .context("read diagnostic artifact")?
            .bytes()
            .await?
            .to_vec())
    }

    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.inner
            .delete(&Path::from(key))
            .await
            .context("delete diagnostic artifact")
    }

    pub async fn delete_many(&self, keys: &[String]) -> anyhow::Result<()> {
        for key in keys {
            self.delete(key).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stores_reads_and_deletes_parts() {
        let store = ArtifactStore::in_memory();
        store
            .put_part("tenant/incident/1", b"safe".to_vec())
            .await
            .unwrap();
        assert_eq!(store.get("tenant/incident/1").await.unwrap(), b"safe");
        store.delete("tenant/incident/1").await.unwrap();
        assert!(store.get("tenant/incident/1").await.is_err());
    }
}
