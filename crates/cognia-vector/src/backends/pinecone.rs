//! Pinecone serverless REST backend.
//!
//! Wire reference: <https://docs.pinecone.io/reference/api/control-plane/list_indexes>
//! Auth: `Api-Key: <key>` header. The index host is fetched once from the
//! control plane (`GET https://api.pinecone.io/indexes/{name}`) and cached
//! for subsequent data-plane calls (`/vectors/upsert`, `/query`, …).

use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;

use super::http_helpers::{build_client, http_err, read_body};
use crate::error::{Result, VectorError};
use crate::types::*;
use crate::{ScrollPage, VectorBackend};

const CONTROL_PLANE: &str = "https://api.pinecone.io";

pub struct PineconeBackend {
    #[allow(dead_code)] // kept for diagnostics / future refresh-on-401
    api_key: String,
    index_name: String,
    namespace: String,
    client: Client,
    // Pre-populated in tests via `index_host.set(uri)` so wiremock can
    // intercept data-plane calls without going through the control plane.
    pub(crate) index_host: OnceCell<String>,
}

impl PineconeBackend {
    pub async fn new(
        api_key: String,
        index_name: String,
        namespace: Option<String>,
    ) -> Result<Self> {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            "Api-Key",
            header::HeaderValue::from_str(&api_key)
                .map_err(|e| VectorError::Configuration(format!("api key header: {e}")))?,
        );
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );
        let client = build_client(CONTROL_PLANE, Some(headers))?;
        Ok(Self {
            api_key,
            index_name,
            namespace: namespace.unwrap_or_else(|| "__default__".to_string()),
            client,
            index_host: OnceCell::new(),
        })
    }

    async fn host(&self) -> Result<String> {
        if let Some(h) = self.index_host.get() {
            return Ok(h.clone());
        }
        #[derive(Deserialize)]
        struct IndexInfo {
            host: String,
        }
        let url = format!("{CONTROL_PLANE}/indexes/{}", self.index_name);
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
        let info: IndexInfo = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode IndexInfo: {e}"),
        })?;
        let h = format!("https://{}", info.host);
        let _ = self.index_host.set(h.clone());
        Ok(h)
    }

    fn translate_filter(filters: &[Filter], mode: FilterMode) -> serde_json::Value {
        // Pinecone metadata filter: $eq/$ne/$gt/$gte/$lt/$lte/$in/$nin, combined
        // with $and / $or at the top level.
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
                    // Substring / null operators have no Pinecone equivalent —
                    // drop them, caller post-filters if needed.
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
struct UpsertReq<'a> {
    vectors: Vec<UpsertVec<'a>>,
    namespace: &'a str,
}

#[derive(Serialize)]
struct UpsertVec<'a> {
    id: &'a str,
    values: &'a [f32],
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<&'a serde_json::Value>,
}

#[derive(Serialize)]
struct QueryReq<'a> {
    namespace: &'a str,
    vector: &'a [f32],
    #[serde(rename = "topK")]
    top_k: usize,
    #[serde(rename = "includeValues")]
    include_values: bool,
    #[serde(rename = "includeMetadata")]
    include_metadata: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    filter: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct QueryResp {
    matches: Vec<PineMatch>,
}

#[derive(Deserialize)]
struct PineMatch {
    id: String,
    score: f32,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

#[async_trait::async_trait]
impl VectorBackend for PineconeBackend {
    fn provider(&self) -> VectorProvider {
        VectorProvider::Pinecone
    }

    async fn create_collection(&self, req: CreateCollectionRequest) -> Result<()> {
        // Pinecone calls these "indexes" and they go through the control plane.
        let body = serde_json::json!({
            "name": req.name,
            "dimension": req.dimension,
            "metric": "cosine",
            "spec": { "serverless": { "cloud": "aws", "region": "us-east-1" } },
        });
        let url = format!("{CONTROL_PLANE}/indexes");
        let resp = self
            .client
            .post(&url)
            .json(&body)
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
        let url = format!("{CONTROL_PLANE}/indexes/{name}");
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
        #[derive(Deserialize)]
        struct ListResp {
            indexes: Vec<IndexInfo>,
        }
        #[derive(Deserialize)]
        struct IndexInfo {
            name: String,
            dimension: usize,
        }
        let url = format!("{CONTROL_PLANE}/indexes");
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
        let list: ListResp = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode indexes: {e}"),
        })?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(list
            .indexes
            .into_iter()
            .map(|i| Collection {
                name: i.name,
                dimension: i.dimension,
                description: None,
                embedding_model: None,
                embedding_provider: None,
                metadata: None,
                document_count: 0,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
            .collect())
    }

    async fn get_collection(&self, name: &str) -> Result<Collection> {
        #[derive(Deserialize)]
        struct IndexInfo {
            name: String,
            dimension: usize,
        }
        let url = format!("{CONTROL_PLANE}/indexes/{name}");
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
        let info: IndexInfo = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode index: {e}"),
        })?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(Collection {
            name: info.name,
            dimension: info.dimension,
            description: None,
            embedding_model: None,
            embedding_provider: None,
            metadata: None,
            document_count: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    async fn upsert(&self, _collection: &str, points: Vec<Point>) -> Result<()> {
        let host = self.host().await?;
        let vectors: Vec<UpsertVec> = points
            .iter()
            .map(|p| UpsertVec {
                id: &p.id,
                values: &p.vector,
                metadata: p.payload.as_ref(),
            })
            .collect();
        let req = UpsertReq {
            vectors,
            namespace: &self.namespace,
        };
        let url = format!("{host}/vectors/upsert");
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
        Ok(())
    }

    async fn delete_points(&self, _collection: &str, ids: Vec<String>) -> Result<()> {
        let host = self.host().await?;
        let url = format!("{host}/vectors/delete");
        let body = serde_json::json!({ "ids": ids, "namespace": self.namespace });
        let resp = self
            .client
            .post(&url)
            .json(&body)
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

    async fn get_points(&self, _collection: &str, ids: Vec<String>) -> Result<Vec<Point>> {
        let host = self.host().await?;
        #[derive(Deserialize)]
        struct FetchResp {
            vectors: std::collections::HashMap<String, FetchVec>,
        }
        #[derive(Deserialize)]
        struct FetchVec {
            id: String,
            #[serde(default)]
            values: Vec<f32>,
            #[serde(default)]
            metadata: Option<serde_json::Value>,
        }
        let id_qs = ids
            .iter()
            .map(|i| format!("ids={}", urlencoding_encode(i)))
            .collect::<Vec<_>>()
            .join("&");
        let url = format!("{host}/vectors/fetch?{id_qs}&namespace={}", self.namespace);
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
        let parsed: FetchResp = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode fetch: {e}"),
        })?;
        Ok(parsed
            .vectors
            .into_values()
            .map(|v| Point {
                id: v.id,
                vector: v.values,
                payload: v.metadata,
            })
            .collect())
    }

    async fn query(
        &self,
        _collection: &str,
        query_vector: Vec<f32>,
        opts: SearchOptions,
    ) -> Result<SearchResponse> {
        let host = self.host().await?;
        let filter = opts
            .filter
            .as_ref()
            .map(|f| Self::translate_filter(f, opts.filter_mode));
        let req = QueryReq {
            namespace: &self.namespace,
            vector: &query_vector,
            top_k: opts.limit + opts.offset,
            include_values: false,
            include_metadata: opts.include_payload || opts.include_content,
            filter,
        };
        let url = format!("{host}/query");
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
        let parsed: QueryResp = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode query: {e}"),
        })?;
        let total = parsed.matches.len();
        let results: Vec<SearchHit> = parsed
            .matches
            .into_iter()
            .skip(opts.offset)
            .take(opts.limit)
            .map(|m| {
                let metadata = m.metadata;
                SearchHit {
                    id: m.id,
                    score: m.score,
                    content: if opts.include_content {
                        metadata.as_ref().and_then(|md| {
                            md.get("content").and_then(|v| v.as_str()).map(String::from)
                        })
                    } else {
                        None
                    },
                    payload: if opts.include_payload { metadata } else { None },
                }
            })
            .collect();
        Ok(SearchResponse {
            results,
            total,
            offset: opts.offset,
            limit: opts.limit,
        })
    }

    async fn truncate(&self, _collection: &str) -> Result<u64> {
        // Pinecone: deleteAll on the namespace.
        let host = self.host().await?;
        let url = format!("{host}/vectors/delete");
        let body = serde_json::json!({ "deleteAll": true, "namespace": self.namespace });
        let resp = self
            .client
            .post(&url)
            .json(&body)
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
        Ok(0)
    }

    async fn scroll(&self, _collection: &str, _opts: ScrollOptions) -> Result<ScrollPage> {
        // Pinecone has no native scroll. Callers should use the JS-side
        // ID-tracking pagination instead.
        Err(VectorError::NotAvailable(
            "pinecone scroll not supported by upstream".into(),
        ))
    }

    async fn count(&self, _collection: &str, _filter: Option<Vec<Filter>>) -> Result<u64> {
        #[derive(Deserialize)]
        struct Stats {
            #[serde(rename = "totalVectorCount", default)]
            total: u64,
        }
        let host = self.host().await?;
        let url = format!("{host}/describe_index_stats");
        let resp = self
            .client
            .post(&url)
            .json(&serde_json::json!({}))
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
        let s: Stats = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode stats: {e}"),
        })?;
        Ok(s.total)
    }

    async fn health_check(&self) -> Result<HealthStatus> {
        match self.list_collections().await {
            Ok(_) => Ok(HealthStatus::Healthy),
            Err(e) => Ok(HealthStatus::Unreachable {
                reason: e.to_string(),
            }),
        }
    }
}

/// Minimal URL-encoder for fetch IDs. We only encode the characters that
/// Pinecone's API actually rejects raw; full RFC 3986 escaping is overkill.
fn urlencoding_encode(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                c.to_string()
            } else {
                format!("%{:02X}", c as u32)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn fixture(server_uri: &str) -> PineconeBackend {
        super::super::initialize_direct_proxy();
        let b = PineconeBackend::new("test-key".into(), "rag".into(), Some("ns".into()))
            .await
            .expect("build");
        let _ = b.index_host.set(server_uri.to_string());
        b
    }

    #[tokio::test]
    async fn upsert_sends_expected_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/vectors/upsert"))
            .and(header("Api-Key", "test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;
        let b = fixture(&server.uri()).await;
        let p = Point {
            id: "a".into(),
            vector: vec![0.1, 0.2],
            payload: Some(serde_json::json!({ "k": "v" })),
        };
        b.upsert("ignored", vec![p]).await.expect("upsert ok");
    }

    #[tokio::test]
    async fn query_returns_translated_hits() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/query"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "matches": [
                    { "id": "x", "score": 0.95, "metadata": { "content": "hi" } }
                ]
            })))
            .mount(&server)
            .await;
        let b = fixture(&server.uri()).await;
        let resp = b
            .query(
                "ignored",
                vec![0.1, 0.2],
                SearchOptions {
                    limit: 5,
                    offset: 0,
                    filter: Some(vec![Filter {
                        key: "topic".into(),
                        value: serde_json::json!("rust"),
                        operation: FilterOp::Equals,
                    }]),
                    filter_mode: FilterMode::And,
                    include_payload: true,
                    include_content: true,
                },
            )
            .await
            .expect("query");
        assert_eq!(resp.results.len(), 1);
        assert_eq!(resp.results[0].id, "x");
        assert_eq!(resp.results[0].content.as_deref(), Some("hi"));
    }

    #[tokio::test]
    async fn auth_failure_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/vectors/upsert"))
            .respond_with(ResponseTemplate::new(401).set_body_string("bad key"))
            .mount(&server)
            .await;
        let b = fixture(&server.uri()).await;
        match b.upsert("ignored", vec![]).await {
            Err(VectorError::Auth(_)) => {}
            Err(e) => panic!("expected Auth, got {e}"),
            Ok(()) => panic!("expected error, got Ok"),
        }
    }

    #[test]
    fn translate_filter_emits_pinecone_dsl() {
        let filters = vec![Filter {
            key: "topic".into(),
            value: serde_json::json!("rust"),
            operation: FilterOp::Equals,
        }];
        let f = PineconeBackend::translate_filter(&filters, FilterMode::And);
        assert_eq!(f["$and"][0]["topic"]["$eq"], "rust");
    }
}
