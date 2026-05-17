//! Pinecone HTTP backend — implementation in Task 7. Stub returns
//! `NotAvailable` for every operation so `cargo check` is green between
//! the registry landing (this commit) and the real impl.

use crate::vector::backend::VectorBackend;
use crate::vector::db::ScrollPage;
use crate::vector::error::{Result, VectorError};
use crate::vector::types::*;

pub struct PineconeBackend {
    _api_key: String,
    _index_name: String,
    _namespace: Option<String>,
}

impl PineconeBackend {
    pub async fn new(
        api_key: String,
        index_name: String,
        namespace: Option<String>,
    ) -> Result<Self> {
        Ok(Self {
            _api_key: api_key,
            _index_name: index_name,
            _namespace: namespace,
        })
    }
}

fn stub<T>() -> Result<T> {
    Err(VectorError::NotAvailable(
        "pinecone backend stub — implementation lands in Task 7".into(),
    ))
}

#[async_trait::async_trait]
impl VectorBackend for PineconeBackend {
    fn provider(&self) -> VectorProvider {
        VectorProvider::Pinecone
    }

    async fn create_collection(&self, _req: CreateCollectionRequest) -> Result<()> {
        stub()
    }
    async fn delete_collection(&self, _name: &str) -> Result<()> {
        stub()
    }
    async fn list_collections(&self) -> Result<Vec<Collection>> {
        stub()
    }
    async fn get_collection(&self, _name: &str) -> Result<Collection> {
        stub()
    }
    async fn upsert(&self, _collection: &str, _points: Vec<Point>) -> Result<()> {
        stub()
    }
    async fn delete_points(&self, _collection: &str, _ids: Vec<String>) -> Result<()> {
        stub()
    }
    async fn get_points(&self, _collection: &str, _ids: Vec<String>) -> Result<Vec<Point>> {
        stub()
    }
    async fn query(
        &self,
        _collection: &str,
        _vec: Vec<f32>,
        _opts: SearchOptions,
    ) -> Result<SearchResponse> {
        stub()
    }
    async fn scroll(&self, _collection: &str, _opts: ScrollOptions) -> Result<ScrollPage> {
        stub()
    }
    async fn count(&self, _collection: &str, _filter: Option<Vec<Filter>>) -> Result<u64> {
        stub()
    }
    async fn health_check(&self) -> Result<HealthStatus> {
        Ok(HealthStatus::Unreachable {
            reason: "pinecone stub".into(),
        })
    }
}
