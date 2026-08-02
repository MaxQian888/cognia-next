use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use async_trait::async_trait;
use rand::{rngs::OsRng, RngCore};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::{
    db::{DiagnosticRepository, TenantKeyRecord},
    kms::KeyWrappingService,
};

const ENVELOPE_MAGIC: &[u8; 8] = b"COGDIAG1";
const NONCE_BYTES: usize = 12;
const HEADER_BYTES: usize = ENVELOPE_MAGIC.len() + 4 + NONCE_BYTES;
type DataEncryptionKey = [u8; 32];
type TenantKeyCache = HashMap<(Uuid, i32), DataEncryptionKey>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvelopeMetadata {
    pub key_version: i32,
}

#[async_trait]
pub trait TenantKeyStore: Send + Sync {
    async fn active(&self, tenant_id: Uuid) -> anyhow::Result<Option<TenantKeyRecord>>;
    async fn version(
        &self,
        tenant_id: Uuid,
        key_version: i32,
    ) -> anyhow::Result<Option<TenantKeyRecord>>;
    async fn insert(
        &self,
        tenant_id: Uuid,
        wrapped_dek: &[u8],
        kms_key_id: &str,
    ) -> anyhow::Result<TenantKeyRecord>;
    async fn rotate(
        &self,
        tenant_id: Uuid,
        wrapped_dek: &[u8],
        kms_key_id: &str,
    ) -> anyhow::Result<TenantKeyRecord>;
    async fn shred(&self, tenant_id: Uuid) -> anyhow::Result<u64>;
}

#[async_trait]
impl TenantKeyStore for DiagnosticRepository {
    async fn active(&self, tenant_id: Uuid) -> anyhow::Result<Option<TenantKeyRecord>> {
        self.active_tenant_key(tenant_id).await
    }

    async fn version(
        &self,
        tenant_id: Uuid,
        key_version: i32,
    ) -> anyhow::Result<Option<TenantKeyRecord>> {
        self.tenant_key(tenant_id, key_version).await
    }

    async fn insert(
        &self,
        tenant_id: Uuid,
        wrapped_dek: &[u8],
        kms_key_id: &str,
    ) -> anyhow::Result<TenantKeyRecord> {
        self.insert_tenant_key(tenant_id, wrapped_dek, kms_key_id)
            .await
    }

    async fn rotate(
        &self,
        tenant_id: Uuid,
        wrapped_dek: &[u8],
        kms_key_id: &str,
    ) -> anyhow::Result<TenantKeyRecord> {
        self.rotate_tenant_key(tenant_id, wrapped_dek, kms_key_id)
            .await
    }

    async fn shred(&self, tenant_id: Uuid) -> anyhow::Result<u64> {
        self.shred_tenant_keys(tenant_id).await
    }
}

#[derive(Clone)]
pub struct TenantKeyManager {
    store: Arc<dyn TenantKeyStore>,
    kms: Arc<dyn KeyWrappingService>,
    kms_key_id: String,
    cache: Arc<RwLock<TenantKeyCache>>,
}

impl TenantKeyManager {
    pub fn new(
        store: Arc<dyn TenantKeyStore>,
        kms: Arc<dyn KeyWrappingService>,
        kms_key_id: String,
    ) -> Self {
        Self {
            store,
            kms,
            kms_key_id,
            cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn encrypt(&self, tenant_id: Uuid, plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
        let (version, dek) = self.active_dek(tenant_id).await?;
        encrypt_artifact(tenant_id, version, &dek, plaintext)
    }

    pub async fn decrypt(&self, tenant_id: Uuid, envelope: &[u8]) -> anyhow::Result<Vec<u8>> {
        let metadata = envelope_metadata(envelope)?;
        let dek = self
            .dek_for_version(tenant_id, metadata.key_version)
            .await?;
        Ok(decrypt_artifact(tenant_id, &dek, envelope)?.1)
    }

    pub async fn rotate(&self, tenant_id: Uuid) -> anyhow::Result<i32> {
        let generated = self.kms.generate_data_key(tenant_id).await?;
        let record = self
            .store
            .rotate(tenant_id, &generated.wrapped, &self.kms_key_id)
            .await?;
        self.cache
            .write()
            .await
            .insert((tenant_id, record.key_version), generated.plaintext);
        Ok(record.key_version)
    }

    pub async fn shred(&self, tenant_id: Uuid) -> anyhow::Result<u64> {
        let shredded = self.store.shred(tenant_id).await?;
        self.cache
            .write()
            .await
            .retain(|(cached_tenant, _), _| *cached_tenant != tenant_id);
        Ok(shredded)
    }

    async fn active_dek(&self, tenant_id: Uuid) -> anyhow::Result<(i32, [u8; 32])> {
        if let Some(record) = self.store.active(tenant_id).await? {
            let dek = self.decrypt_record(tenant_id, &record).await?;
            return Ok((record.key_version, dek));
        }
        let generated = self.kms.generate_data_key(tenant_id).await?;
        let record = self
            .store
            .insert(tenant_id, &generated.wrapped, &self.kms_key_id)
            .await?;
        let dek = if record.wrapped_dek == generated.wrapped {
            generated.plaintext
        } else {
            self.decrypt_record(tenant_id, &record).await?
        };
        self.cache
            .write()
            .await
            .insert((tenant_id, record.key_version), dek);
        Ok((record.key_version, dek))
    }

    async fn dek_for_version(&self, tenant_id: Uuid, key_version: i32) -> anyhow::Result<[u8; 32]> {
        if let Some(dek) = self.cache.read().await.get(&(tenant_id, key_version)) {
            return Ok(*dek);
        }
        let record = self
            .store
            .version(tenant_id, key_version)
            .await?
            .ok_or_else(|| anyhow::anyhow!("tenant data key does not exist"))?;
        let dek = self.decrypt_record(tenant_id, &record).await?;
        self.cache
            .write()
            .await
            .insert((tenant_id, key_version), dek);
        Ok(dek)
    }

    async fn decrypt_record(
        &self,
        tenant_id: Uuid,
        record: &TenantKeyRecord,
    ) -> anyhow::Result<[u8; 32]> {
        if record.state == "destroyed" || record.wrapped_dek.is_empty() {
            anyhow::bail!("tenant data key has been destroyed");
        }
        if let Some(dek) = self
            .cache
            .read()
            .await
            .get(&(tenant_id, record.key_version))
        {
            return Ok(*dek);
        }
        let dek = self
            .kms
            .decrypt_data_key(tenant_id, &record.wrapped_dek)
            .await?;
        self.cache
            .write()
            .await
            .insert((tenant_id, record.key_version), dek);
        Ok(dek)
    }
}

pub fn encrypt_artifact(
    tenant_id: Uuid,
    key_version: i32,
    dek: &[u8; 32],
    plaintext: &[u8],
) -> anyhow::Result<Vec<u8>> {
    if key_version <= 0 {
        anyhow::bail!("tenant key version must be positive");
    }
    let mut nonce_bytes = [0_u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut nonce_bytes);
    let aad = artifact_aad(tenant_id, key_version);
    let ciphertext = Aes256Gcm::new_from_slice(dek)
        .expect("AES-256 key has fixed length")
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| anyhow::anyhow!("encrypt diagnostic artifact"))?;
    let mut envelope = Vec::with_capacity(HEADER_BYTES + ciphertext.len());
    envelope.extend_from_slice(ENVELOPE_MAGIC);
    envelope.extend_from_slice(&key_version.to_be_bytes());
    envelope.extend_from_slice(&nonce_bytes);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

pub fn decrypt_artifact(
    tenant_id: Uuid,
    dek: &[u8; 32],
    envelope: &[u8],
) -> anyhow::Result<(EnvelopeMetadata, Vec<u8>)> {
    let metadata = envelope_metadata(envelope)?;
    let nonce = envelope
        .get(12..HEADER_BYTES)
        .ok_or_else(|| anyhow::anyhow!("truncated diagnostic artifact envelope"))?;
    let ciphertext = envelope
        .get(HEADER_BYTES..)
        .ok_or_else(|| anyhow::anyhow!("truncated diagnostic artifact envelope"))?;
    let aad = artifact_aad(tenant_id, metadata.key_version);
    let plaintext = Aes256Gcm::new_from_slice(dek)
        .expect("AES-256 key has fixed length")
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| anyhow::anyhow!("diagnostic artifact authentication failed"))?;
    Ok((metadata, plaintext))
}

pub fn envelope_metadata(envelope: &[u8]) -> anyhow::Result<EnvelopeMetadata> {
    if envelope.len() < HEADER_BYTES || envelope.get(..8) != Some(ENVELOPE_MAGIC) {
        anyhow::bail!("invalid diagnostic artifact envelope");
    }
    let version_bytes: [u8; 4] = envelope[8..12]
        .try_into()
        .expect("checked envelope header length");
    let key_version = i32::from_be_bytes(version_bytes);
    if key_version <= 0 {
        anyhow::bail!("invalid diagnostic artifact key version");
    }
    Ok(EnvelopeMetadata { key_version })
}

fn artifact_aad(tenant_id: Uuid, key_version: i32) -> Vec<u8> {
    format!("cognia-diagnostic:v1:{tenant_id}:{key_version}").into_bytes()
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };

    use super::*;
    use crate::kms::GeneratedDataKey;

    #[derive(Default)]
    struct MemoryKeyStore {
        records: Mutex<Vec<TenantKeyRecord>>,
    }

    #[async_trait]
    impl TenantKeyStore for MemoryKeyStore {
        async fn active(&self, tenant_id: Uuid) -> anyhow::Result<Option<TenantKeyRecord>> {
            Ok(self
                .records
                .lock()
                .unwrap()
                .iter()
                .find(|record| record.tenant_id == tenant_id && record.state == "active")
                .cloned())
        }

        async fn version(
            &self,
            tenant_id: Uuid,
            key_version: i32,
        ) -> anyhow::Result<Option<TenantKeyRecord>> {
            Ok(self
                .records
                .lock()
                .unwrap()
                .iter()
                .find(|record| record.tenant_id == tenant_id && record.key_version == key_version)
                .cloned())
        }

        async fn insert(
            &self,
            tenant_id: Uuid,
            wrapped_dek: &[u8],
            kms_key_id: &str,
        ) -> anyhow::Result<TenantKeyRecord> {
            let record = TenantKeyRecord {
                tenant_id,
                key_version: 1,
                wrapped_dek: wrapped_dek.to_vec(),
                kms_key_id: kms_key_id.to_owned(),
                state: "active".to_owned(),
            };
            self.records.lock().unwrap().push(record.clone());
            Ok(record)
        }

        async fn rotate(
            &self,
            tenant_id: Uuid,
            wrapped_dek: &[u8],
            kms_key_id: &str,
        ) -> anyhow::Result<TenantKeyRecord> {
            let mut records = self.records.lock().unwrap();
            for record in records
                .iter_mut()
                .filter(|record| record.tenant_id == tenant_id)
            {
                if record.state == "active" {
                    record.state = "retired".to_owned();
                }
            }
            let version = records
                .iter()
                .filter(|record| record.tenant_id == tenant_id)
                .map(|record| record.key_version)
                .max()
                .unwrap_or(0)
                + 1;
            let record = TenantKeyRecord {
                tenant_id,
                key_version: version,
                wrapped_dek: wrapped_dek.to_vec(),
                kms_key_id: kms_key_id.to_owned(),
                state: "active".to_owned(),
            };
            records.push(record.clone());
            Ok(record)
        }

        async fn shred(&self, tenant_id: Uuid) -> anyhow::Result<u64> {
            let mut records = self.records.lock().unwrap();
            let mut count = 0;
            for record in records
                .iter_mut()
                .filter(|record| record.tenant_id == tenant_id)
            {
                record.state = "destroyed".to_owned();
                record.wrapped_dek.clear();
                count += 1;
            }
            Ok(count)
        }
    }

    struct FakeKms {
        decryptions: AtomicUsize,
    }

    #[async_trait]
    impl KeyWrappingService for FakeKms {
        async fn generate_data_key(&self, _tenant_id: Uuid) -> anyhow::Result<GeneratedDataKey> {
            Ok(GeneratedDataKey {
                plaintext: [5_u8; 32],
                wrapped: vec![9_u8; 48],
            })
        }

        async fn decrypt_data_key(
            &self,
            _tenant_id: Uuid,
            wrapped: &[u8],
        ) -> anyhow::Result<[u8; 32]> {
            assert_eq!(wrapped, [9_u8; 48]);
            self.decryptions.fetch_add(1, Ordering::SeqCst);
            Ok([5_u8; 32])
        }
    }

    #[test]
    fn envelope_round_trips_and_authenticates_tenant_context() {
        let tenant = Uuid::new_v4();
        let key = [7_u8; 32];
        let encrypted = encrypt_artifact(tenant, 3, &key, b"redacted crash data").unwrap();
        let (metadata, plaintext) = decrypt_artifact(tenant, &key, &encrypted).unwrap();
        assert_eq!(metadata.key_version, 3);
        assert_eq!(plaintext, b"redacted crash data");
        assert!(decrypt_artifact(Uuid::new_v4(), &key, &encrypted).is_err());
    }

    #[test]
    fn envelope_rejects_truncation_and_ciphertext_tampering() {
        let tenant = Uuid::new_v4();
        let key = [9_u8; 32];
        let mut encrypted = encrypt_artifact(tenant, 1, &key, b"payload").unwrap();
        assert!(envelope_metadata(&encrypted[..10]).is_err());
        *encrypted.last_mut().unwrap() ^= 1;
        assert!(decrypt_artifact(tenant, &key, &encrypted).is_err());
    }

    #[tokio::test]
    async fn tenant_key_manager_creates_wraps_and_reloads_per_tenant_deks() {
        let store = Arc::new(MemoryKeyStore::default());
        let kms = Arc::new(FakeKms {
            decryptions: AtomicUsize::new(0),
        });
        let tenant = Uuid::new_v4();
        let manager = TenantKeyManager::new(store.clone(), kms.clone(), "alias/test".to_owned());
        let encrypted = manager.encrypt(tenant, b"incident").await.unwrap();
        assert_eq!(
            manager.decrypt(tenant, &encrypted).await.unwrap(),
            b"incident"
        );
        assert_eq!(kms.decryptions.load(Ordering::SeqCst), 0);

        let reloaded = TenantKeyManager::new(store, kms.clone(), "alias/test".to_owned());
        assert_eq!(
            reloaded.decrypt(tenant, &encrypted).await.unwrap(),
            b"incident"
        );
        assert_eq!(kms.decryptions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn rotation_preserves_old_reads_and_crypto_shredding_evicts_cached_keys() {
        let store = Arc::new(MemoryKeyStore::default());
        let kms = Arc::new(FakeKms {
            decryptions: AtomicUsize::new(0),
        });
        let tenant = Uuid::new_v4();
        let manager = TenantKeyManager::new(store, kms, "alias/test".to_owned());
        let old = manager.encrypt(tenant, b"old").await.unwrap();
        assert_eq!(manager.rotate(tenant).await.unwrap(), 2);
        let new = manager.encrypt(tenant, b"new").await.unwrap();
        assert_eq!(manager.decrypt(tenant, &old).await.unwrap(), b"old");
        assert_eq!(manager.decrypt(tenant, &new).await.unwrap(), b"new");
        assert_eq!(manager.shred(tenant).await.unwrap(), 2);
        assert!(manager.decrypt(tenant, &old).await.is_err());
        assert!(manager.decrypt(tenant, &new).await.is_err());
    }
}
