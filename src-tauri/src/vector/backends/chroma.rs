//! Chroma backend stub — real impl lands in Task 9.

use crate::vector::backend::VectorBackend;
use crate::vector::db::ScrollPage;
use crate::vector::error::{Result, VectorError};
use crate::vector::types::*;

pub struct ChromaBackend {
    _url: String,
    _auth_token: Option<String>,
}

impl ChromaBackend {
    pub fn new(url: String, auth_token: Option<String>) -> Result<Self> {
        Ok(Self {
            _url: url,
            _auth_token: auth_token,
        })
    }
}

fn stub<T>() -> Result<T> {
    Err(VectorError::NotAvailable(
        "chroma backend stub — implementation lands in Task 9".into(),
    ))
}

#[async_trait::async_trait]
impl VectorBackend for ChromaBackend {
    fn provider(&self) -> VectorProvider {
        VectorProvider::Chroma
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
            reason: "chroma stub".into(),
        })
    }
}
