use std::sync::Arc;

use anyhow::Context;
use bytes::Bytes;
use object_store::{
    aws::AmazonS3Builder, local::LocalFileSystem, path::Path, ObjectStore, PutPayload,
};

use crate::config::ServerConfig;
use crate::{crypto::TenantKeyManager, db::DiagnosticRepository, kms::AwsKmsClient};
use uuid::Uuid;

#[derive(Clone)]
pub struct ArtifactStore {
    inner: Arc<dyn ObjectStore>,
    keys: TenantKeyManager,
}

impl ArtifactStore {
    pub fn from_config(
        config: &ServerConfig,
        repository: DiagnosticRepository,
    ) -> anyhow::Result<Self> {
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
        let kms = AwsKmsClient::new(
            config.kms_endpoint.clone(),
            config.kms_region.clone(),
            config.kms_key_id.clone(),
            config.kms_access_key_id.clone(),
            config.kms_secret_access_key.clone(),
            config.kms_session_token.clone(),
            config.kms_timeout,
        )?;
        Ok(Self {
            inner,
            keys: TenantKeyManager::new(
                Arc::new(repository),
                Arc::new(kms),
                config.kms_key_id.clone(),
            ),
        })
    }

    #[cfg(test)]
    pub fn in_memory(keys: TenantKeyManager) -> Self {
        Self {
            inner: Arc::new(object_store::memory::InMemory::new()),
            keys,
        }
    }

    pub async fn put_part(&self, tenant_id: Uuid, key: &str, body: Vec<u8>) -> anyhow::Result<()> {
        let encrypted = self
            .keys
            .encrypt(tenant_id, &body)
            .await
            .context("encrypt diagnostic artifact")?;
        self.inner
            .put(&Path::from(key), PutPayload::from(Bytes::from(encrypted)))
            .await
            .context("write diagnostic artifact part")?;
        Ok(())
    }

    pub async fn get(&self, tenant_id: Uuid, key: &str) -> anyhow::Result<Vec<u8>> {
        let encrypted = self
            .inner
            .get(&Path::from(key))
            .await
            .context("read diagnostic artifact")?
            .bytes()
            .await?
            .to_vec();
        self.keys
            .decrypt(tenant_id, &encrypted)
            .await
            .context("decrypt diagnostic artifact")
    }

    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        match self.inner.delete(&Path::from(key)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(error) => Err(error).context("delete diagnostic artifact"),
        }
    }

    pub async fn delete_many(&self, keys: &[String]) -> anyhow::Result<()> {
        for key in keys {
            self.delete(key).await?;
        }
        Ok(())
    }

    pub async fn rotate_tenant_key(&self, tenant_id: Uuid) -> anyhow::Result<i32> {
        self.keys.rotate(tenant_id).await
    }

    pub async fn crypto_shred_tenant(&self, tenant_id: Uuid) -> anyhow::Result<u64> {
        self.keys.shred(tenant_id).await
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::{
        crypto::TenantKeyStore,
        db::TenantKeyRecord,
        kms::{GeneratedDataKey, KeyWrappingService},
    };

    struct TestKeyStore;

    #[async_trait]
    impl TenantKeyStore for TestKeyStore {
        async fn active(&self, tenant_id: Uuid) -> anyhow::Result<Option<TenantKeyRecord>> {
            Ok(Some(TenantKeyRecord {
                tenant_id,
                key_version: 1,
                wrapped_dek: vec![1],
                kms_key_id: "test".to_owned(),
                state: "active".to_owned(),
            }))
        }

        async fn version(
            &self,
            tenant_id: Uuid,
            _key_version: i32,
        ) -> anyhow::Result<Option<TenantKeyRecord>> {
            self.active(tenant_id).await
        }

        async fn insert(
            &self,
            tenant_id: Uuid,
            _wrapped_dek: &[u8],
            _kms_key_id: &str,
        ) -> anyhow::Result<TenantKeyRecord> {
            Ok(self.active(tenant_id).await?.unwrap())
        }

        async fn rotate(
            &self,
            tenant_id: Uuid,
            _wrapped_dek: &[u8],
            _kms_key_id: &str,
        ) -> anyhow::Result<TenantKeyRecord> {
            Ok(self.active(tenant_id).await?.unwrap())
        }

        async fn shred(&self, _tenant_id: Uuid) -> anyhow::Result<u64> {
            Ok(1)
        }
    }

    struct TestKms;

    #[async_trait]
    impl KeyWrappingService for TestKms {
        async fn generate_data_key(&self, _tenant_id: Uuid) -> anyhow::Result<GeneratedDataKey> {
            unreachable!("test store always has an active key")
        }

        async fn decrypt_data_key(
            &self,
            _tenant_id: Uuid,
            _wrapped: &[u8],
        ) -> anyhow::Result<[u8; 32]> {
            Ok([4_u8; 32])
        }
    }

    #[tokio::test]
    async fn stores_reads_and_deletes_parts() {
        let tenant_id = Uuid::new_v4();
        let keys =
            TenantKeyManager::new(Arc::new(TestKeyStore), Arc::new(TestKms), "test".to_owned());
        let store = ArtifactStore::in_memory(keys);
        store
            .put_part(tenant_id, "tenant/incident/1", b"safe".to_vec())
            .await
            .unwrap();
        assert_eq!(
            store.get(tenant_id, "tenant/incident/1").await.unwrap(),
            b"safe"
        );
        store.delete("tenant/incident/1").await.unwrap();
        store.delete("tenant/incident/1").await.unwrap();
        assert!(store.get(tenant_id, "tenant/incident/1").await.is_err());
    }
}
