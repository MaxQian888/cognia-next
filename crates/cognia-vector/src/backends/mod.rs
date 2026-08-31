//! Cloud `VectorBackend` implementations. Each module owns one provider's
//! HTTP wire format + filter translation.

pub mod chroma;
pub mod http_helpers;
pub mod milvus;
pub mod pinecone;
pub mod qdrant;
pub mod weaviate;

#[cfg(test)]
pub(crate) fn initialize_direct_proxy() {
    cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default())
        .expect("initialize direct proxy policy for local backend tests");
}
