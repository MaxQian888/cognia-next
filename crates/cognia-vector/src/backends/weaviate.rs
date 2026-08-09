//! Weaviate HTTP backend.
//!
//! Wire reference: <https://weaviate.io/developers/weaviate/api/rest>
//! Schema management via `/v1/schema/*`; bulk upsert via `/v1/batch/objects`;
//! query via GraphQL at `/v1/graphql`. Auth: `Authorization: Bearer <key>`.

use reqwest::{header, Client};
use serde::{Deserialize, Serialize};

use super::http_helpers::{build_client, http_err, read_body};
use crate::error::{Result, VectorError};
use crate::types::*;
use crate::{ScrollPage, VectorBackend};

pub struct WeaviateBackend {
    base_url: String,
    client: Client,
}

impl WeaviateBackend {
    pub fn new(url: String, api_key: Option<String>) -> Result<Self> {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );
        if let Some(k) = api_key {
            let v = format!("Bearer {k}");
            headers.insert(
                header::AUTHORIZATION,
                header::HeaderValue::from_str(&v)
                    .map_err(|e| VectorError::Configuration(format!("auth header: {e}")))?,
            );
        }
        Ok(Self {
            base_url: url.trim_end_matches('/').to_string(),
            client: build_client(&url, Some(headers))?,
        })
    }

    fn translate_filter_graphql(filters: &[Filter], mode: FilterMode) -> String {
        let operands: Vec<String> = filters
            .iter()
            .filter_map(|f| {
                let op = match f.operation {
                    FilterOp::Equals => "Equal",
                    FilterOp::NotEquals => "NotEqual",
                    FilterOp::GreaterThan => "GreaterThan",
                    FilterOp::GreaterThanOrEquals => "GreaterThanEqual",
                    FilterOp::LessThan => "LessThan",
                    FilterOp::LessThanOrEquals => "LessThanEqual",
                    _ => return None,
                };
                let val = if let Some(s) = f.value.as_str() {
                    format!("valueText: \"{s}\"")
                } else if f.value.is_number() {
                    format!("valueNumber: {}", f.value)
                } else if let Some(b) = f.value.as_bool() {
                    format!("valueBoolean: {b}")
                } else {
                    return None;
                };
                Some(format!(
                    "{{ path: [\"{}\"], operator: {op}, {val} }}",
                    f.key
                ))
            })
            .collect();
        let op = match mode {
            FilterMode::And => "And",
            FilterMode::Or => "Or",
        };
        format!("{{ operator: {op}, operands: [{}] }}", operands.join(","))
    }
}

#[derive(Serialize)]
struct ClassSchema<'a> {
    class: &'a str,
    vectorizer: &'a str,
}

#[derive(Serialize)]
struct BatchObj<'a> {
    class: &'a str,
    id: &'a str,
    properties: &'a serde_json::Value,
    vector: &'a [f32],
}

#[derive(Serialize)]
struct BatchReq<'a> {
    objects: Vec<BatchObj<'a>>,
}

#[async_trait::async_trait]
impl VectorBackend for WeaviateBackend {
    fn provider(&self) -> VectorProvider {
        VectorProvider::Weaviate
    }

    async fn create_collection(&self, req: CreateCollectionRequest) -> Result<()> {
        let url = format!("{}/v1/schema", self.base_url);
        let body = ClassSchema {
            class: &req.name,
            vectorizer: "none",
        };
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
        let url = format!("{}/v1/schema/{name}", self.base_url);
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
        struct Schema {
            classes: Vec<ClassInfo>,
        }
        #[derive(Deserialize)]
        struct ClassInfo {
            class: String,
        }
        let url = format!("{}/v1/schema", self.base_url);
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
        let s: Schema = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode schema: {e}"),
        })?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(s.classes
            .into_iter()
            .map(|c| Collection {
                name: c.class,
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
        #[derive(Deserialize)]
        struct ClassInfo {
            class: String,
            #[serde(default)]
            description: Option<String>,
        }
        let url = format!("{}/v1/schema/{name}", self.base_url);
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
        let c: ClassInfo = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode class: {e}"),
        })?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(Collection {
            name: c.class,
            dimension: 0,
            description: c.description,
            embedding_model: None,
            embedding_provider: None,
            metadata: None,
            document_count: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    async fn upsert(&self, collection: &str, points: Vec<Point>) -> Result<()> {
        let url = format!("{}/v1/batch/objects", self.base_url);
        let empty_props = serde_json::json!({});
        let objects: Vec<BatchObj> = points
            .iter()
            .map(|p| BatchObj {
                class: collection,
                id: &p.id,
                properties: p.payload.as_ref().unwrap_or(&empty_props),
                vector: &p.vector,
            })
            .collect();
        let resp = self
            .client
            .post(&url)
            .json(&BatchReq { objects })
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
        for id in ids {
            let url = format!("{}/v1/objects/{collection}/{id}", self.base_url);
            let resp = self
                .client
                .delete(&url)
                .send()
                .await
                .map_err(|e| VectorError::Http {
                    status: 0,
                    message: e.to_string(),
                })?;
            if !resp.status().is_success() && resp.status() != reqwest::StatusCode::NOT_FOUND {
                let status = resp.status();
                let body = read_body(resp).await.unwrap_or_default();
                return Err(http_err(status, &body));
            }
        }
        Ok(())
    }

    async fn get_points(&self, collection: &str, ids: Vec<String>) -> Result<Vec<Point>> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let url = format!(
                "{}/v1/objects/{collection}/{id}?include=vector",
                self.base_url
            );
            let resp = self
                .client
                .get(&url)
                .send()
                .await
                .map_err(|e| VectorError::Http {
                    status: 0,
                    message: e.to_string(),
                })?;
            if resp.status() == reqwest::StatusCode::NOT_FOUND {
                continue;
            }
            if !resp.status().is_success() {
                let status = resp.status();
                let body = read_body(resp).await.unwrap_or_default();
                return Err(http_err(status, &body));
            }
            let v: serde_json::Value = resp.json().await.map_err(|e| VectorError::Http {
                status: 0,
                message: format!("decode get: {e}"),
            })?;
            out.push(Point {
                id: v
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                vector: v
                    .get("vector")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|n| n.as_f64().map(|f| f as f32))
                            .collect()
                    })
                    .unwrap_or_default(),
                payload: v.get("properties").cloned(),
            });
        }
        Ok(out)
    }

    async fn query(
        &self,
        collection: &str,
        query_vector: Vec<f32>,
        opts: SearchOptions,
    ) -> Result<SearchResponse> {
        let where_clause = opts
            .filter
            .as_ref()
            .map(|f| {
                format!(
                    ", where: {}",
                    Self::translate_filter_graphql(f, opts.filter_mode)
                )
            })
            .unwrap_or_default();
        let vec_str = query_vector
            .iter()
            .map(|f| f.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let gql = format!(
            "{{ Get {{ {collection} (nearVector: {{ vector: [{vec_str}] }}, limit: {}{where_clause}) {{ _additional {{ id distance }} }} }} }}",
            opts.limit + opts.offset
        );
        let url = format!("{}/v1/graphql", self.base_url);
        let resp = self
            .client
            .post(&url)
            .json(&serde_json::json!({ "query": gql }))
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
        let raw: serde_json::Value = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode graphql: {e}"),
        })?;
        let arr = raw
            .pointer(&format!("/data/Get/{collection}"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let total = arr.len();
        let results: Vec<SearchHit> = arr
            .into_iter()
            .skip(opts.offset)
            .take(opts.limit)
            .map(|obj| {
                let id = obj
                    .pointer("/_additional/id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let distance = obj
                    .pointer("/_additional/distance")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let content = if opts.include_content {
                    obj.get("content")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                } else {
                    None
                };
                SearchHit {
                    id,
                    score: 1.0 - distance as f32,
                    payload: if opts.include_payload {
                        Some(obj.clone())
                    } else {
                        None
                    },
                    content,
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
        // Weaviate: batch delete via GraphQL where-match-all is unreliable
        // across versions; drop + recreate is the lowest-risk path.
        let info = self.get_collection(collection).await?;
        self.delete_collection(collection).await?;
        self.create_collection(CreateCollectionRequest {
            name: collection.to_string(),
            dimension: info.dimension,
            description: info.description,
            embedding_model: info.embedding_model,
            embedding_provider: info.embedding_provider,
            metadata: info.metadata,
        })
        .await?;
        Ok(0)
    }

    async fn scroll(&self, _collection: &str, _opts: ScrollOptions) -> Result<ScrollPage> {
        Err(VectorError::NotAvailable(
            "weaviate scroll not implemented; use cursor-based GraphQL".into(),
        ))
    }

    async fn count(&self, collection: &str, _filter: Option<Vec<Filter>>) -> Result<u64> {
        let gql = format!("{{ Aggregate {{ {collection} {{ meta {{ count }} }} }} }}");
        let url = format!("{}/v1/graphql", self.base_url);
        let resp = self
            .client
            .post(&url)
            .json(&serde_json::json!({ "query": gql }))
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
        let raw: serde_json::Value = resp.json().await.map_err(|e| VectorError::Http {
            status: 0,
            message: format!("decode count: {e}"),
        })?;
        let n = raw
            .pointer(&format!("/data/Aggregate/{collection}/0/meta/count"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        Ok(n)
    }

    async fn health_check(&self) -> Result<HealthStatus> {
        let url = format!("{}/v1/.well-known/ready", self.base_url);
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
    async fn create_collection_posts_to_schema() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/schema"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;
        let b = WeaviateBackend::new(server.uri(), None).expect("build");
        b.create_collection(CreateCollectionRequest {
            name: "Article".into(),
            dimension: 3,
            description: None,
            embedding_model: None,
            embedding_provider: None,
            metadata: None,
        })
        .await
        .expect("create");
    }

    #[test]
    fn graphql_filter_emits_operator() {
        let filters = vec![Filter {
            key: "topic".into(),
            value: serde_json::json!("rust"),
            operation: FilterOp::Equals,
        }];
        let s = WeaviateBackend::translate_filter_graphql(&filters, FilterMode::And);
        assert!(s.contains("operator: And"));
        assert!(s.contains("Equal"));
        assert!(s.contains("rust"));
    }

    #[test]
    fn graphql_filter_or_mode() {
        let filters = vec![Filter {
            key: "score".into(),
            value: serde_json::json!(0.5),
            operation: FilterOp::GreaterThanOrEquals,
        }];
        let s = WeaviateBackend::translate_filter_graphql(&filters, FilterMode::Or);
        assert!(s.contains("operator: Or"));
        assert!(s.contains("GreaterThanEqual"));
        assert!(s.contains("valueNumber"));
    }
}
