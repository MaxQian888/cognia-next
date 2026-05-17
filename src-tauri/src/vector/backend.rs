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
    /// Delete every point in a collection without dropping the collection
    /// itself. Returns the number of points deleted when the provider can
    /// report it; otherwise 0.
    async fn truncate(&self, collection: &str) -> Result<u64>;
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
    use super::*;
    use super::super::types::*;
    use async_trait::async_trait;

    /// Minimal mock — covers the trait's invariants so the
    /// `VectorBackend::provider()` contract has a unit test that doesn't
    /// require a live cloud account. Each call panics with a helpful
    /// message so any accidental use of the unused methods surfaces.
    struct MockBackend {
        decl: VectorProvider,
    }

    #[async_trait]
    impl VectorBackend for MockBackend {
        fn provider(&self) -> VectorProvider {
            self.decl
        }

        async fn create_collection(&self, _: CreateCollectionRequest) -> super::Result<()> {
            unreachable!("MockBackend exercises provider() only")
        }
        async fn delete_collection(&self, _: &str) -> super::Result<()> {
            unreachable!()
        }
        async fn list_collections(&self) -> super::Result<Vec<Collection>> {
            unreachable!()
        }
        async fn get_collection(&self, _: &str) -> super::Result<Collection> {
            unreachable!()
        }
        async fn upsert(&self, _: &str, _: Vec<Point>) -> super::Result<()> {
            unreachable!()
        }
        async fn delete_points(&self, _: &str, _: Vec<String>) -> super::Result<()> {
            unreachable!()
        }
        async fn get_points(&self, _: &str, _: Vec<String>) -> super::Result<Vec<Point>> {
            unreachable!()
        }
        async fn truncate(&self, _: &str) -> super::Result<u64> {
            unreachable!()
        }
        async fn query(
            &self,
            _: &str,
            _: Vec<f32>,
            _: SearchOptions,
        ) -> super::Result<SearchResponse> {
            unreachable!()
        }
        async fn scroll(
            &self,
            _: &str,
            _: ScrollOptions,
        ) -> super::Result<super::super::db::ScrollPage> {
            unreachable!()
        }
        async fn count(&self, _: &str, _: Option<Vec<Filter>>) -> super::Result<u64> {
            unreachable!()
        }
        async fn health_check(&self) -> super::Result<HealthStatus> {
            unreachable!()
        }
    }

    #[test]
    fn provider_method_is_object_safe_and_returns_declared_variant() {
        // Erasing through `Arc<dyn VectorBackend>` is exactly how the
        // registry stores backends. The cast verifies the trait stays
        // object-safe — adding an associated type or a generic method
        // to the trait without the `dyn`-compat bounds would fail here.
        let b: std::sync::Arc<dyn VectorBackend> =
            std::sync::Arc::new(MockBackend { decl: VectorProvider::Qdrant });
        assert_eq!(b.provider(), VectorProvider::Qdrant);

        let b2: std::sync::Arc<dyn VectorBackend> =
            std::sync::Arc::new(MockBackend { decl: VectorProvider::Chroma });
        assert_eq!(b2.provider(), VectorProvider::Chroma);
    }

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
