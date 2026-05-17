//! Async backend trait shared by the native sqlite-vec store and the
//! cloud HTTP backends. Object-safe; concrete backends live behind
//! `Arc<dyn VectorBackend>` inside the registry.

use async_trait::async_trait;

use super::db::ScrollPage;
use super::types::{
    Collection, CreateCollectionRequest, Filter, HealthStatus, Point, ScrollOptions, SearchOptions,
    SearchResponse, VectorProvider,
};
use super::Result;

#[async_trait]
pub trait VectorBackend: Send + Sync + 'static {
    fn provider(&self) -> VectorProvider;

    async fn create_collection(&self, req: CreateCollectionRequest) -> Result<()>;
    async fn delete_collection(&self, name: &str) -> Result<()>;
    async fn list_collections(&self) -> Result<Vec<Collection>>;
    async fn get_collection(&self, name: &str) -> Result<Collection>;

    async fn upsert(&self, collection: &str, points: Vec<Point>) -> Result<()>;
    async fn delete_points(&self, collection: &str, ids: Vec<String>) -> Result<()>;
    async fn get_points(&self, collection: &str, ids: Vec<String>) -> Result<Vec<Point>>;
    async fn query(
        &self,
        collection: &str,
        query_vector: Vec<f32>,
        opts: SearchOptions,
    ) -> Result<SearchResponse>;
    async fn scroll(&self, collection: &str, opts: ScrollOptions) -> Result<ScrollPage>;
    async fn count(&self, collection: &str, filter: Option<Vec<Filter>>) -> Result<u64>;

    async fn health_check(&self) -> Result<HealthStatus>;
}

#[cfg(test)]
mod tests {
    use super::super::types::*;

    #[test]
    fn provider_round_trips_snake_case() {
        let raw = "\"pinecone\"";
        let p: VectorProvider = serde_json::from_str(raw).expect("parse");
        assert!(matches!(p, VectorProvider::Pinecone));
        assert_eq!(serde_json::to_string(&p).expect("ser"), raw);
    }

    #[test]
    fn search_options_defaults_via_serde() {
        let opts: SearchOptions = serde_json::from_str("{}").expect("parse");
        assert_eq!(opts.limit, 10);
        assert_eq!(opts.offset, 0);
        assert!(opts.filter.is_none());
        assert!(!opts.include_payload);
    }

    #[test]
    fn create_collection_request_round_trips() {
        let raw = serde_json::json!({
            "name": "rag",
            "dimension": 1536,
            "embedding_model": "text-embedding-3-small",
        });
        let r: CreateCollectionRequest = serde_json::from_value(raw).expect("parse");
        assert_eq!(r.name, "rag");
        assert_eq!(r.dimension, 1536);
        assert_eq!(r.embedding_model.as_deref(), Some("text-embedding-3-small"));
        assert!(r.metadata.is_none());
    }

    #[test]
    fn health_status_serializes_as_tagged_enum() {
        let s = HealthStatus::Degraded { reason: "slow".into() };
        let json = serde_json::to_value(&s).expect("ser");
        assert_eq!(json["degraded"]["reason"], "slow");
        let healthy = HealthStatus::Healthy;
        let json = serde_json::to_value(&healthy).expect("ser");
        assert_eq!(json, serde_json::json!("healthy"));
    }
}
