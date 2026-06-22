//! Milvus / Zilliz Cloud HTTP backend (Milvus 2.4+ `/v2/vectordb/*` API).
//!
//! Wire reference: <https://milvus.io/api-reference/restful>
//! Auth: `Authorization: Bearer <token>` (Zilliz Cloud uses token; self-hosted
//! Milvus uses `Bearer username:password`).

use reqwest::{header, Client};
use serde::Serialize;

use super::http_helpers::{build_client, http_err, read_body};
use crate::vector::error::{Result, VectorError};
use crate::vector::types::*;
use crate::vector::{ScrollPage, VectorBackend};

pub struct MilvusBackend {
    base_url: String,
    client: Client,
    db_name: String,
}

impl MilvusBackend {
    pub async fn new(
        address: String,
        token: Option<String>,
        username: Option<String>,
        password: Option<String>,
        ssl: bool,
    ) -> Result<Self> {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );
        let auth = if let Some(t) = token {
            Some(format!("Bearer {t}"))
        } else if let (Some(u), Some(p)) = (username, password) {
            Some(format!("Bearer {u}:{p}"))
        } else {
            None
        };
        if let Some(a) = auth {
            headers.insert(
                header::AUTHORIZATION,
                header::HeaderValue::from_str(&a)
                    .map_err(|e| VectorError::Configuration(format!("auth header: {e}")))?,
            );
        }
        let base = if address.starts_with("http://") || address.starts_with("https://") {
            address.trim_end_matches('/').to_string()
        } else {
            let scheme = if ssl { "https" } else { "http" };
            format!("{scheme}://{}", address.trim_end_matches('/'))
        };
        Ok(Self {
            base_url: base,
            client: build_client(Some(headers))?,
            db_name: "default".into(),
        })
    }

    fn translate_filter(filters: &[Filter], mode: FilterMode) -> String {
        let parts: Vec<String> = filters
            .iter()
            .filter_map(|f| {
                let op = match f.operation {
                    FilterOp::Equals => "==",
                    FilterOp::NotEquals => "!=",
                    FilterOp::GreaterThan => ">",
                    FilterOp::GreaterThanOrEquals => ">=",
                    FilterOp::LessThan => "<",
                    FilterOp::LessThanOrEquals => "<=",
                    _ => return None,
                };
                Some(format!("payload[\"{}\"] {op} {}", f.key, f.value))
            })
            .collect();
        parts.join(match mode {
            FilterMode::And => " && ",
            FilterMode::Or => " || ",
        })
    }

    async fn post<T: Serialize>(&self, path: &str, body: &T) -> Result<serde_json::Value> {
        let url = format!("{}{path}", self.base_url);
        let resp = self
            .client
            .post(&url)
            .json(body)
            .send()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        let status = resp.status();
        let text = read_body(resp).await?;
        if !status.is_success() {
            return Err(http_err(status, &text));
        }
        serde_json::from_str(&text).map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode: {e} (body: {text})"),
        })
    }
}

#[async_trait::async_trait]
impl VectorBackend for MilvusBackend {
    fn provider(&self) -> VectorProvider {
        VectorProvider::Milvus
    }

    async fn create_collection(&self, req: CreateCollectionRequest) -> Result<()> {
        let body = serde_json::json!({
            "dbName": self.db_name,
            "collectionName": req.name,
            "dimension": req.dimension,
            "metricType": "COSINE",
        });
        self.post("/v2/vectordb/collections/create", &body)
            .await
            .map(|_| ())
    }

    async fn delete_collection(&self, name: &str) -> Result<()> {
        let body = serde_json::json!({ "dbName": self.db_name, "collectionName": name });
        self.post("/v2/vectordb/collections/drop", &body)
            .await
            .map(|_| ())
    }

    async fn list_collections(&self) -> Result<Vec<Collection>> {
        let body = serde_json::json!({ "dbName": self.db_name });
        let raw = self.post("/v2/vectordb/collections/list", &body).await?;
        let names: Vec<String> = raw
            .get("data")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let now = chrono::Utc::now().to_rfc3339();
        Ok(names
            .into_iter()
            .map(|n| Collection {
                name: n,
                dimension: 0,
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
        let body = serde_json::json!({ "dbName": self.db_name, "collectionName": name });
        let raw = self
            .post("/v2/vectordb/collections/describe", &body)
            .await?;
        let dim = raw
            .pointer("/data/fields")
            .and_then(|fs| fs.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|f| f.get("type").and_then(|v| v.as_str()) == Some("FloatVector"))
            })
            .and_then(|f| f.pointer("/typeParams/dim"))
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        let now = chrono::Utc::now().to_rfc3339();
        Ok(Collection {
            name: name.to_string(),
            dimension: dim,
            description: None,
            embedding_model: None,
            embedding_provider: None,
            metadata: None,
            document_count: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    async fn upsert(&self, collection: &str, points: Vec<Point>) -> Result<()> {
        let data: Vec<serde_json::Value> = points
            .into_iter()
            .map(|p| {
                serde_json::json!({
                    "id": p.id,
                    "vector": p.vector,
                    "payload": p.payload.unwrap_or(serde_json::json!({})),
                })
            })
            .collect();
        let body = serde_json::json!({
            "dbName": self.db_name,
            "collectionName": collection,
            "data": data,
        });
        self.post("/v2/vectordb/entities/upsert", &body)
            .await
            .map(|_| ())
    }

    async fn delete_points(&self, collection: &str, ids: Vec<String>) -> Result<()> {
        let filter = format!(
            "id in [{}]",
            ids.iter()
                .map(|i| format!("\"{i}\""))
                .collect::<Vec<_>>()
                .join(",")
        );
        let body = serde_json::json!({
            "dbName": self.db_name,
            "collectionName": collection,
            "filter": filter,
        });
        self.post("/v2/vectordb/entities/delete", &body)
            .await
            .map(|_| ())
    }

    async fn get_points(&self, collection: &str, ids: Vec<String>) -> Result<Vec<Point>> {
        let body = serde_json::json!({
            "dbName": self.db_name,
            "collectionName": collection,
            "id": ids,
            "outputFields": ["id", "vector", "payload"],
        });
        let raw = self.post("/v2/vectordb/entities/get", &body).await?;
        let arr = raw
            .get("data")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(arr
            .into_iter()
            .map(|h| Point {
                id: h
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                vector: h
                    .get("vector")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|n| n.as_f64().map(|f| f as f32))
                            .collect()
                    })
                    .unwrap_or_default(),
                payload: h.get("payload").cloned(),
            })
            .collect())
    }

    async fn query(
        &self,
        collection: &str,
        query_vector: Vec<f32>,
        opts: SearchOptions,
    ) -> Result<SearchResponse> {
        let filter = opts
            .filter
            .as_ref()
            .map(|f| Self::translate_filter(f, opts.filter_mode))
            .unwrap_or_default();
        let body = serde_json::json!({
            "dbName": self.db_name,
            "collectionName": collection,
            "data": [query_vector],
            "limit": opts.limit + opts.offset,
            "filter": filter,
            "outputFields": ["id", "payload"],
        });
        let raw = self.post("/v2/vectordb/entities/search", &body).await?;
        let arr = raw
            .get("data")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let total = arr.len();
        let results: Vec<SearchHit> = arr
            .into_iter()
            .skip(opts.offset)
            .take(opts.limit)
            .map(|h| {
                let id = h
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let score = h.get("distance").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                let payload = h.get("payload").cloned();
                SearchHit {
                    id,
                    score,
                    content: if opts.include_content {
                        payload.as_ref().and_then(|v| {
                            v.get("content").and_then(|v| v.as_str()).map(String::from)
                        })
                    } else {
                        None
                    },
                    payload: if opts.include_payload { payload } else { None },
                }
            })
            .collect();
        Ok(SearchResponse {
            total,
            offset: opts.offset,
            limit: opts.limit,
            results,
        })
    }

    async fn truncate(&self, collection: &str) -> Result<u64> {
        // Milvus: empty filter `id != ""` matches everything; the v2 API
        // accepts a `filter` body and reports row count via /entities/query
        // first if a precise count is needed.
        let body = serde_json::json!({
            "dbName": self.db_name,
            "collectionName": collection,
            "filter": "id != \"\"",
        });
        self.post("/v2/vectordb/entities/delete", &body)
            .await
            .map(|_| 0)
    }

    async fn scroll(&self, _collection: &str, _opts: ScrollOptions) -> Result<ScrollPage> {
        Err(VectorError::NotAvailable(
            "milvus scroll not implemented; use query".into(),
        ))
    }

    async fn count(&self, collection: &str, _filter: Option<Vec<Filter>>) -> Result<u64> {
        let body = serde_json::json!({
            "dbName": self.db_name,
            "collectionName": collection,
            "outputFields": ["count(*)"],
            "filter": "",
        });
        let raw = self.post("/v2/vectordb/entities/query", &body).await?;
        let n = raw
            .pointer("/data/0/count(*)")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        Ok(n)
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

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn create_collection_posts_v2_endpoint() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/vectordb/collections/create"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"code": 0})))
            .mount(&server)
            .await;
        let b = MilvusBackend::new(server.uri(), Some("tok".into()), None, None, false)
            .await
            .expect("build");
        b.create_collection(CreateCollectionRequest {
            name: "docs".into(),
            dimension: 128,
            description: None,
            embedding_model: None,
            embedding_provider: None,
            metadata: None,
        })
        .await
        .expect("create");
    }

    #[tokio::test]
    async fn search_returns_translated_hits() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/vectordb/entities/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": 0,
                "data": [{ "id": "a", "distance": 0.05, "payload": { "content": "hi" } }]
            })))
            .mount(&server)
            .await;
        let b = MilvusBackend::new(server.uri(), Some("tok".into()), None, None, false)
            .await
            .expect("build");
        let resp = b
            .query(
                "docs",
                vec![0.1; 4],
                SearchOptions {
                    limit: 10,
                    include_payload: true,
                    include_content: true,
                    ..Default::default()
                },
            )
            .await
            .expect("query");
        assert_eq!(resp.results.len(), 1);
        assert_eq!(resp.results[0].id, "a");
        assert_eq!(resp.results[0].content.as_deref(), Some("hi"));
    }

    #[test]
    fn translate_filter_emits_milvus_expression() {
        let filters = vec![Filter {
            key: "category".into(),
            value: serde_json::json!("rust"),
            operation: FilterOp::Equals,
        }];
        let s = MilvusBackend::translate_filter(&filters, FilterMode::And);
        assert!(s.contains("payload[\"category\"] == \"rust\""));
    }
}
