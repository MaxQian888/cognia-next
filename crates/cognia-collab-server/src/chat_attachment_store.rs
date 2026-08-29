use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;
use bytes::Bytes;
use object_store::{
    aws::AmazonS3Builder, local::LocalFileSystem, path::Path, ObjectStore, PutPayload,
};

#[async_trait]
pub trait ChatAttachmentObjectStore: Send + Sync {
    async fn put(&self, key: &str, body: Bytes) -> anyhow::Result<()>;
    async fn get(&self, key: &str) -> anyhow::Result<Bytes>;
    async fn delete(&self, key: &str) -> anyhow::Result<()>;
}

#[derive(Clone)]
pub struct ObjectStoreChatAttachments {
    inner: Arc<dyn ObjectStore>,
}

impl ObjectStoreChatAttachments {
    pub fn local(root: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&root).context("create shared-chat attachment directory")?;
        Ok(Self {
            inner: Arc::new(LocalFileSystem::new_with_prefix(root)?),
        })
    }

    pub fn s3(
        bucket: &str,
        region: &str,
        endpoint: Option<&str>,
        access_key: Option<&str>,
        secret_key: Option<&str>,
    ) -> anyhow::Result<Self> {
        let mut builder = AmazonS3Builder::new()
            .with_bucket_name(bucket)
            .with_region(region)
            .with_allow_http(endpoint.is_some_and(|value| value.starts_with("http://")));
        if let Some(endpoint) = endpoint {
            builder = builder
                .with_endpoint(endpoint)
                .with_virtual_hosted_style_request(false);
        }
        if let Some(access_key) = access_key {
            builder = builder.with_access_key_id(access_key);
        }
        if let Some(secret_key) = secret_key {
            builder = builder.with_secret_access_key(secret_key);
        }
        Ok(Self {
            inner: Arc::new(builder.build()?),
        })
    }

    pub fn in_memory() -> Self {
        Self {
            inner: Arc::new(object_store::memory::InMemory::new()),
        }
    }
}

#[async_trait]
impl ChatAttachmentObjectStore for ObjectStoreChatAttachments {
    async fn put(&self, key: &str, body: Bytes) -> anyhow::Result<()> {
        self.inner
            .put(&Path::from(key), PutPayload::from(body))
            .await
            .context("write shared-chat attachment")?;
        Ok(())
    }

    async fn get(&self, key: &str) -> anyhow::Result<Bytes> {
        self.inner
            .get(&Path::from(key))
            .await
            .context("read shared-chat attachment")?
            .bytes()
            .await
            .context("buffer shared-chat attachment")
    }

    async fn delete(&self, key: &str) -> anyhow::Result<()> {
        match self.inner.delete(&Path::from(key)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(error) => Err(error).context("delete shared-chat attachment"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn object_keys_round_trip_without_public_urls() {
        let store = ObjectStoreChatAttachments::in_memory();
        store
            .put(
                "org/workspace/session/attachment",
                Bytes::from_static(b"hello"),
            )
            .await
            .unwrap();
        assert_eq!(
            store.get("org/workspace/session/attachment").await.unwrap(),
            Bytes::from_static(b"hello")
        );
        store
            .delete("org/workspace/session/attachment")
            .await
            .unwrap();
        assert!(store.get("org/workspace/session/attachment").await.is_err());
    }
}
