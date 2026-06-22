//! Chroma HTTP backend.
//!
//! Wire reference: <https://docs.trychroma.com/reference/server>
//! Endpoints under `/api/v1/collections/*`. Optional bearer auth.

use reqwest::{header, Client};
use serde::{Deserialize, Serialize};

use super::http_helpers::{build_client, http_err, read_body};
use crate::vector::error::{Result, VectorError};
use crate::vector::types::*;
use crate::vector::{ScrollPage, VectorBackend};

pub struct ChromaBackend {
    base_url: String,
    client: Client,
}

impl ChromaBackend {
    pub fn new(url: String, auth_token: Option<String>) -> Result<Self> {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );
        if let Some(t) = auth_token {
            let v = format!("Bearer {t}");
            headers.insert(
                header::AUTHORIZATION,
                header::HeaderValue::from_str(&v)
                    .map_err(|e| VectorError::Configuration(format!("auth header: {e}")))?,
            );
        }
        Ok(Self {
            base_url: url.trim_end_matches('/').to_string(),
            client: build_client(Some(headers))?,
        })
    }

    fn translate_filter(filters: &[Filter], mode: FilterMode) -> serde_json::Value {
        let clauses: Vec<serde_json::Value> = filters
            .iter()
            .filter_map(|f| {
                let op = match f.operation {
                    FilterOp::Equals => "$eq",
                    FilterOp::NotEquals => "$ne",
                    FilterOp::GreaterThan => "$gt",
                    FilterOp::GreaterThanOrEquals => "$gte",
                    FilterOp::LessThan => "$lt",
                    FilterOp::LessThanOrEquals => "$lte",
                    FilterOp::In => "$in",
                    FilterOp::NotIn => "$nin",
                    _ => return None,
                };
                Some(serde_json::json!({ &f.key: { op: &f.value } }))
            })
            .collect();
        match mode {
            FilterMode::And => serde_json::json!({ "$and": clauses }),
            FilterMode::Or => serde_json::json!({ "$or": clauses }),
        }
    }
}

#[derive(Serialize)]
struct CreateReq<'a> {
    name: &'a str,
    metadata: serde_json::Value,
    get_or_create: bool,
}

#[derive(Deserialize)]
struct CollectionResp {
    #[allow(dead_code)]
    id: Option<String>,
    name: String,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct UpsertReq<'a> {
    ids: Vec<&'a str>,
    embeddings: Vec<&'a [f32]>,
    metadatas: Vec<Option<&'a serde_json::Value>>,
    documents: Vec<Option<String>>,
}

#[derive(Serialize)]
struct QueryReq<'a> {
    query_embeddings: Vec<&'a [f32]>,
    n_results: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    r#where: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct QueryResp {
    ids: Vec<Vec<String>>,
    #[serde(default)]
    distances: Option<Vec<Vec<f32>>>,
    #[serde(default)]
    metadatas: Option<Vec<Vec<Option<serde_json::Value>>>>,
    #[serde(default)]
    documents: Option<Vec<Vec<Option<String>>>>,
}

#[derive(Serialize)]
struct DeleteReq {
    ids: Vec<String>,
}

#[derive(Deserialize)]
struct CountResp {
    #[serde(default)]
    count: u64,
}

#[derive(Serialize)]
struct GetReq<'a> {
    ids: &'a [String],
    #[serde(default)]
    include: Vec<&'static str>,
}

#[derive(Deserialize)]
struct GetResp {
    ids: Vec<String>,
    #[serde(default)]
    embeddings: Option<Vec<Vec<f32>>>,
    #[serde(default)]
    metadatas: Option<Vec<Option<serde_json::Value>>>,
}

#[async_trait::async_trait]
impl VectorBackend for ChromaBackend {
    fn provider(&self) -> VectorProvider {
        VectorProvider::Chroma
    }

    async fn create_collection(&self, req: CreateCollectionRequest) -> Result<()> {
        let url = format!("{}/api/v1/collections", self.base_url);
        let meta = req
            .metadata
            .unwrap_or(serde_json::json!({"hnsw:space": "cosine"}));
        let resp = self
            .client
            .post(&url)
            .json(&CreateReq {
                name: &req.name,
                metadata: meta,
                // Match the legacy TS `getOrCreateCollection` semantics —
                // create_collection retries must succeed on existing.
                get_or_create: true,
            })
            .send()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = read_body(resp).await.unwrap_or_default();
            return Err(http_err(status, &body));
        }
        Ok(())
    }

    async fn delete_collection(&self, name: &str) -> Result<()> {
        let url = format!("{}/api/v1/collections/{name}", self.base_url);
        let resp = self
            .client
            .delete(&url)
            .send()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = read_body(resp).await.unwrap_or_default();
            return Err(http_err(status, &body));
        }
        Ok(())
    }

    async fn list_collections(&self) -> Result<Vec<Collection>> {
        let url = format!("{}/api/v1/collections", self.base_url);
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = read_body(resp).await.unwrap_or_default();
            return Err(http_err(status, &body));
        }
        let list: Vec<CollectionResp> = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode list: {e}"),
        })?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(list
            .into_iter()
            .map(|c| Collection {
                name: c.name,
                dimension: 0,
                description: None,
                embedding_model: None,
                embedding_provider: None,
                metadata: c.metadata,
                document_count: 0,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
            .collect())
    }

    async fn get_collection(&self, name: &str) -> Result<Collection> {
        let url = format!("{}/api/v1/collections/{name}", self.base_url);
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = read_body(resp).await.unwrap_or_default();
            return Err(http_err(status, &body));
        }
        let c: CollectionResp = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode get: {e}"),
        })?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(Collection {
            name: c.name,
            dimension: 0,
            description: None,
            embedding_model: None,
            embedding_provider: None,
            metadata: c.metadata,
            document_count: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    async fn upsert(&self, collection: &str, points: Vec<Point>) -> Result<()> {
        let url = format!("{}/api/v1/collections/{collection}/upsert", self.base_url);
        let ids: Vec<&str> = points.iter().map(|p| p.id.as_str()).collect();
        let embeddings: Vec<&[f32]> = points.iter().map(|p| p.vector.as_slice()).collect();
        let metadatas: Vec<Option<&serde_json::Value>> =
            points.iter().map(|p| p.payload.as_ref()).collect();
        let documents: Vec<Option<String>> = points
            .iter()
            .map(|p| {
                p.payload
                    .as_ref()
                    .and_then(|v| v.get("content"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .collect();
        let resp = self
            .client
            .post(&url)
            .json(&UpsertReq {
                ids,
                embeddings,
                metadatas,
                documents,
            })
            .send()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = read_body(resp).await.unwrap_or_default();
            return Err(http_err(status, &body));
        }
        Ok(())
    }

    async fn delete_points(&self, collection: &str, ids: Vec<String>) -> Result<()> {
        let url = format!("{}/api/v1/collections/{collection}/delete", self.base_url);
        let resp = self
            .client
            .post(&url)
            .json(&DeleteReq { ids })
            .send()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = read_body(resp).await.unwrap_or_default();
            return Err(http_err(status, &body));
        }
        Ok(())
    }

    async fn get_points(&self, collection: &str, ids: Vec<String>) -> Result<Vec<Point>> {
        let url = format!("{}/api/v1/collections/{collection}/get", self.base_url);
        let req = GetReq {
            ids: &ids,
            include: vec!["embeddings", "metadatas"],
        };
        let resp = self
            .client
            .post(&url)
            .json(&req)
            .send()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = read_body(resp).await.unwrap_or_default();
            return Err(http_err(status, &body));
        }
        let g: GetResp = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode get: {e}"),
        })?;
        Ok(g.ids
            .into_iter()
            .enumerate()
            .map(|(i, id)| Point {
                id,
                vector: g
                    .embeddings
                    .as_ref()
                    .and_then(|e| e.get(i).cloned())
                    .unwrap_or_default(),
                payload: g
                    .metadatas
                    .as_ref()
                    .and_then(|m| m.get(i).cloned())
                    .flatten(),
            })
            .collect())
    }

    async fn query(
        &self,
        collection: &str,
        query_vector: Vec<f32>,
        opts: SearchOptions,
    ) -> Result<SearchResponse> {
        let url = format!("{}/api/v1/collections/{collection}/query", self.base_url);
        let where_filter = opts
            .filter
            .as_ref()
            .map(|f| Self::translate_filter(f, opts.filter_mode));
        let req = QueryReq {
            query_embeddings: vec![&query_vector],
            n_results: opts.limit + opts.offset,
            r#where: where_filter,
        };
        let resp = self
            .client
            .post(&url)
            .json(&req)
            .send()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = read_body(resp).await.unwrap_or_default();
            return Err(http_err(status, &body));
        }
        let q: QueryResp = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode query: {e}"),
        })?;
        let ids = q.ids.into_iter().next().unwrap_or_default();
        let dists = q
            .distances
            .and_then(|d| d.into_iter().next())
            .unwrap_or_default();
        let metas = q
            .metadatas
            .and_then(|m| m.into_iter().next())
            .unwrap_or_default();
        let docs = q
            .documents
            .and_then(|d| d.into_iter().next())
            .unwrap_or_default();
        let results: Vec<SearchHit> = ids
            .into_iter()
            .enumerate()
            .skip(opts.offset)
            .take(opts.limit)
            .map(|(i, id)| SearchHit {
                id,
                score: 1.0 - dists.get(i).copied().unwrap_or(0.0),
                payload: if opts.include_payload {
                    metas.get(i).cloned().flatten()
                } else {
                    None
                },
                content: if opts.include_content {
                    docs.get(i).cloned().flatten()
                } else {
                    None
                },
            })
            .collect();
        Ok(SearchResponse {
            total: results.len(),
            offset: opts.offset,
            limit: opts.limit,
            results,
        })
    }

    async fn truncate(&self, collection: &str) -> Result<u64> {
        // Chroma: there's no native truncate; we delete all IDs via get-all
        // then delete-by-ids. For collections >100k this is slow, but
        // accurate.
        let url = format!("{}/api/v1/collections/{collection}/get", self.base_url);
        let resp = self
            .client
            .post(&url)
            .json(&serde_json::json!({ "include": [] }))
            .send()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = read_body(resp).await.unwrap_or_default();
            return Err(http_err(status, &body));
        }
        #[derive(serde::Deserialize)]
        struct IdsResp {
            ids: Vec<String>,
        }
        let body: IdsResp = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode get: {e}"),
        })?;
        if body.ids.is_empty() {
            return Ok(0);
        }
        let n = body.ids.len() as u64;
        self.delete_points(collection, body.ids).await?;
        Ok(n)
    }

    async fn scroll(&self, _collection: &str, _opts: ScrollOptions) -> Result<ScrollPage> {
        Err(VectorError::NotAvailable(
            "chroma scroll not implemented; use get/query".into(),
        ))
    }

    async fn count(&self, collection: &str, _filter: Option<Vec<Filter>>) -> Result<u64> {
        let url = format!("{}/api/v1/collections/{collection}/count", self.base_url);
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = read_body(resp).await.unwrap_or_default();
            return Err(http_err(status, &body));
        }
        // Chroma sometimes returns a bare integer, sometimes `{"count": N}`.
        let text = read_body(resp).await?;
        if let Ok(n) = text.trim().parse::<u64>() {
            return Ok(n);
        }
        let c: CountResp = serde_json::from_str(&text).map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode count: {e}"),
        })?;
        Ok(c.count)
    }

    async fn health_check(&self) -> Result<HealthStatus> {
        let url = format!("{}/api/v1/heartbeat", self.base_url);
        match self.client.get(&url).send().await {
            Ok(r) if r.status().is_success() => Ok(HealthStatus::Healthy),
            Ok(r) => Ok(HealthStatus::Degraded {
                reason: format!("status {}", r.status()),
            }),
            Err(e) => Ok(HealthStatus::Unreachable {
                reason: e.to_string(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn create_collection_posts_to_v1_collections() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/collections"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"id": "x", "name": "c"})),
            )
            .mount(&server)
            .await;
        let b = ChromaBackend::new(server.uri(), None).expect("build");
        b.create_collection(CreateCollectionRequest {
            name: "c".into(),
            dimension: 3,
            description: None,
            embedding_model: None,
            embedding_provider: None,
            metadata: None,
        })
        .await
        .expect("create");
    }

    #[tokio::test]
    async fn query_distances_become_scores() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/collections/c/query"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ids": [["a"]],
                "distances": [[0.1]],
                "metadatas": [[{"k": "v"}]],
                "documents": [["hi"]]
            })))
            .mount(&server)
            .await;
        let b = ChromaBackend::new(server.uri(), None).expect("build");
        let resp = b
            .query(
                "c",
                vec![0.1, 0.2],
                SearchOptions {
                    limit: 5,
                    include_payload: true,
                    include_content: true,
                    ..Default::default()
                },
            )
            .await
            .expect("query");
        assert_eq!(resp.results.len(), 1);
        assert!((resp.results[0].score - 0.9).abs() < 1e-6);
        assert_eq!(resp.results[0].content.as_deref(), Some("hi"));
    }

    #[test]
    fn translate_filter_emits_chroma_dsl() {
        let filters = vec![Filter {
            key: "topic".into(),
            value: serde_json::json!("rust"),
            operation: FilterOp::Equals,
        }];
        let f = ChromaBackend::translate_filter(&filters, FilterMode::And);
        assert_eq!(f["$and"][0]["topic"]["$eq"], "rust");
    }
}
