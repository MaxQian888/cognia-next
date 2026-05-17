//! Milvus backend stub — real impl (HTTP, no SDK) lands in Task 10.

use crate::vector::backend::VectorBackend;
use crate::vector::db::ScrollPage;
use crate::vector::error::{Result, VectorError};
use crate::vector::types::*;

pub struct MilvusBackend {
    _address: String,
    _token: Option<String>,
    _username: Option<String>,
    _password: Option<String>,
    _ssl: bool,
}

impl MilvusBackend {
    pub async fn new(
        address: String,
        token: Option<String>,
        username: Option<String>,
        password: Option<String>,
        ssl: bool,
    ) -> Result<Self> {
        Ok(Self {
            _address: address,
            _token: token,
            _username: username,
            _password: password,
            _ssl: ssl,
        })
    }
}

fn stub<T>() -> Result<T> {
    Err(VectorError::NotAvailable(
        "milvus backend stub — implementation lands in Task 10".into(),
    ))
}

#[async_trait::async_trait]
impl VectorBackend for MilvusBackend {
    fn provider(&self) -> VectorProvider {
        VectorProvider::Milvus
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
            reason: "milvus stub".into(),
        })
    }
}
