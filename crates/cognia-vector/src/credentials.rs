//! Per-provider credential structs persisted in the OS keyring via the
//! existing `keyring_secrets` module. Each credential is serialised to
//! JSON; the keyring service name is `com.cognia.vector.<provider>/v1`
//! and the account is the user-supplied `configId`.

use serde::{Deserialize, Serialize};

use super::error::{Result, VectorError};
use super::types::VectorProvider;
use crate::credential_store::store;

fn namespace(provider: VectorProvider) -> &'static str {
    match provider {
        VectorProvider::Native => "vector.native",
        VectorProvider::Pinecone => "vector.pinecone",
        VectorProvider::Qdrant => "vector.qdrant",
        VectorProvider::Chroma => "vector.chroma",
        VectorProvider::Milvus => "vector.milvus",
        VectorProvider::Weaviate => "vector.weaviate",
    }
}

/// Tagged union of per-provider credential payloads. The `provider`
/// discriminator is also embedded in the keyring namespace (see
/// `namespace`) so a Chroma payload can never collide with a Qdrant
/// payload sharing the same `configId`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
pub enum VectorCredentials {
    Pinecone {
        api_key: String,
        index_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
    },
    Qdrant {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        collection_name: Option<String>,
    },
    Chroma {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auth_token: Option<String>,
    },
    Milvus {
        address: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        username: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        password: Option<String>,
        #[serde(default)]
        ssl: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        collection_name: Option<String>,
    },
    Weaviate {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
    },
}

impl VectorCredentials {
    pub fn provider(&self) -> VectorProvider {
        match self {
            Self::Pinecone { .. } => VectorProvider::Pinecone,
            Self::Qdrant { .. } => VectorProvider::Qdrant,
            Self::Chroma { .. } => VectorProvider::Chroma,
            Self::Milvus { .. } => VectorProvider::Milvus,
            Self::Weaviate { .. } => VectorProvider::Weaviate,
        }
    }
}

pub fn save(config_id: &str, creds: &VectorCredentials) -> Result<()> {
    if config_id.is_empty() {
        return Err(VectorError::Configuration(
            "config_id must not be empty".into(),
        ));
    }
    let json = serde_json::to_string(creds)
        .map_err(|e| VectorError::Configuration(format!("serialize creds: {e}")))?;
    store()
        .and_then(|s| s.set(namespace(creds.provider()), config_id, &json))
        .map_err(VectorError::Auth)
}

pub fn load(provider: VectorProvider, config_id: &str) -> Result<Option<VectorCredentials>> {
    if config_id.is_empty() {
        return Err(VectorError::Configuration(
            "config_id must not be empty".into(),
        ));
    }
    let raw = store()
        .and_then(|s| s.get(namespace(provider), config_id))
        .map_err(VectorError::Auth)?;
    match raw {
        None => Ok(None),
        Some(s) => {
            let creds: VectorCredentials = serde_json::from_str(&s)
                .map_err(|e| VectorError::Configuration(format!("deserialize creds: {e}")))?;
            if creds.provider() != provider {
                return Err(VectorError::Configuration(format!(
                    "credential provider mismatch: expected {:?}, got {:?}",
                    provider,
                    creds.provider()
                )));
            }
            Ok(Some(creds))
        }
    }
}

pub fn delete(provider: VectorProvider, config_id: &str) -> Result<()> {
    if config_id.is_empty() {
        return Err(VectorError::Configuration(
            "config_id must not be empty".into(),
        ));
    }
    store()
        .and_then(|s| s.clear(namespace(provider), config_id))
        .map_err(VectorError::Auth)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_config_id_rejected_for_save() {
        let creds = VectorCredentials::Pinecone {
            api_key: "k".into(),
            index_name: "i".into(),
            namespace: None,
        };
        let err = save("", &creds).expect_err("must reject empty id");
        assert!(matches!(err, VectorError::Configuration(_)));
    }

    #[test]
    fn empty_config_id_rejected_for_load() {
        let err = load(VectorProvider::Pinecone, "").expect_err("must reject");
        assert!(matches!(err, VectorError::Configuration(_)));
    }

    #[test]
    fn empty_config_id_rejected_for_delete() {
        let err = delete(VectorProvider::Pinecone, "").expect_err("must reject");
        assert!(matches!(err, VectorError::Configuration(_)));
    }

    #[test]
    fn credentials_round_trip_via_json() {
        let creds = VectorCredentials::Pinecone {
            api_key: "secret".into(),
            index_name: "rag".into(),
            namespace: Some("default".into()),
        };
        let raw = serde_json::to_string(&creds).expect("ser");
        assert!(raw.contains("\"provider\":\"pinecone\""));
        let back: VectorCredentials = serde_json::from_str(&raw).expect("de");
        assert_eq!(back.provider(), VectorProvider::Pinecone);
    }

    #[test]
    fn milvus_credentials_round_trip() {
        let creds = VectorCredentials::Milvus {
            address: "https://in03-xxx.api.gcp-us-west1.zillizcloud.com".into(),
            token: Some("token123".into()),
            username: None,
            password: None,
            ssl: true,
            collection_name: Some("docs".into()),
        };
        let raw = serde_json::to_string(&creds).expect("ser");
        assert!(raw.contains("\"provider\":\"milvus\""));
        assert!(raw.contains("\"ssl\":true"));
        let back: VectorCredentials = serde_json::from_str(&raw).expect("de");
        assert_eq!(back.provider(), VectorProvider::Milvus);
    }

    #[test]
    fn provider_namespaces_are_distinct() {
        use std::collections::HashSet;
        let all = [
            VectorProvider::Native,
            VectorProvider::Pinecone,
            VectorProvider::Qdrant,
            VectorProvider::Chroma,
            VectorProvider::Milvus,
            VectorProvider::Weaviate,
        ];
        let mut seen = HashSet::new();
        for p in all {
            assert!(seen.insert(namespace(p)), "duplicate ns for {p:?}");
        }
        assert_eq!(seen.len(), 6);
    }
}
