//! Qdrant backend via the official `qdrant-client` crate (gRPC).
//!
//! Connection: `Qdrant::from_url(url).api_key(key).build()` — the URL must
//! point at the gRPC port (default 6334), not the REST port (6333).

use qdrant_client::qdrant::{
    self, condition::ConditionOneOf, point_id, Condition, CreateCollectionBuilder,
    DeletePointsBuilder, Distance, FieldCondition, Match, PointId, PointStruct, PointsIdsList,
    Range, ScrollPointsBuilder, SearchPointsBuilder, UpsertPointsBuilder, VectorParamsBuilder,
};
use qdrant_client::{Payload, Qdrant};

use crate::vector::error::{Result, VectorError};
use crate::vector::types::*;
use crate::vector::{ScrollPage, VectorBackend};

pub struct QdrantBackend {
    client: Qdrant,
}

impl QdrantBackend {
    pub fn new(url: String, api_key: Option<String>) -> Result<Self> {
        let mut builder = Qdrant::from_url(&url);
        if let Some(k) = api_key {
            builder = builder.api_key(k);
        }
        let client = builder
            .build()
            .map_err(|e| VectorError::Configuration(format!("qdrant client: {e}")))?;
        Ok(Self { client })
    }

    fn id_to_string(id: Option<PointId>) -> String {
        id.and_then(|p| p.point_id_options)
            .map(|opt| match opt {
                point_id::PointIdOptions::Uuid(u) => u,
                point_id::PointIdOptions::Num(n) => n.to_string(),
            })
            .unwrap_or_default()
    }

    fn json_value_to_match(value: &serde_json::Value) -> Option<qdrant::r#match::MatchValue> {
        if let Some(s) = value.as_str() {
            Some(qdrant::r#match::MatchValue::Keyword(s.to_string()))
        } else if let Some(i) = value.as_i64() {
            Some(qdrant::r#match::MatchValue::Integer(i))
        } else if let Some(b) = value.as_bool() {
            Some(qdrant::r#match::MatchValue::Boolean(b))
        } else {
            None
        }
    }

    fn translate_filter(filters: &[Filter], mode: FilterMode) -> qdrant::Filter {
        let mut must: Vec<Condition> = Vec::new();
        let mut must_not: Vec<Condition> = Vec::new();
        let mut should: Vec<Condition> = Vec::new();

        for f in filters {
            let cond = match f.operation {
                FilterOp::Equals => Self::json_value_to_match(&f.value).map(|m| Condition {
                    condition_one_of: Some(ConditionOneOf::Field(FieldCondition {
                        key: f.key.clone(),
                        r#match: Some(Match { match_value: Some(m) }),
                        ..Default::default()
                    })),
                }),
                FilterOp::NotEquals => {
                    let neg = Self::json_value_to_match(&f.value).map(|m| Condition {
                        condition_one_of: Some(ConditionOneOf::Field(FieldCondition {
                            key: f.key.clone(),
                            r#match: Some(Match { match_value: Some(m) }),
                            ..Default::default()
                        })),
                    });
                    if let Some(c) = neg {
                        must_not.push(c);
                    }
                    continue;
                }
                FilterOp::GreaterThan
                | FilterOp::GreaterThanOrEquals
                | FilterOp::LessThan
                | FilterOp::LessThanOrEquals => {
                    let v = f.value.as_f64();
                    if let Some(v) = v {
                        let mut range = Range::default();
                        match f.operation {
                            FilterOp::GreaterThan => range.gt = Some(v),
                            FilterOp::GreaterThanOrEquals => range.gte = Some(v),
                            FilterOp::LessThan => range.lt = Some(v),
                            FilterOp::LessThanOrEquals => range.lte = Some(v),
                            _ => unreachable!(),
                        }
                        Some(Condition {
                            condition_one_of: Some(ConditionOneOf::Field(FieldCondition {
                                key: f.key.clone(),
                                range: Some(range),
                                ..Default::default()
                            })),
                        })
                    } else {
                        None
                    }
                }
                FilterOp::In => {
                    let keywords: Vec<String> = f
                        .value
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    if keywords.is_empty() {
                        None
                    } else {
                        Some(Condition {
                            condition_one_of: Some(ConditionOneOf::Field(FieldCondition {
                                key: f.key.clone(),
                                r#match: Some(Match {
                                    match_value: Some(qdrant::r#match::MatchValue::Keywords(
                                        qdrant::RepeatedStrings { strings: keywords },
                                    )),
                                }),
                                ..Default::default()
                            })),
                        })
                    }
                }
                // Unsupported ops on this provider degrade silently. The
                // JS caller can post-filter for substring / null patterns.
                _ => None,
            };

            if let Some(c) = cond {
                match mode {
                    FilterMode::And => must.push(c),
                    FilterMode::Or => should.push(c),
                }
            }
        }

        qdrant::Filter {
            must,
            must_not,
            should,
            min_should: None,
        }
    }

    fn payload_from_json(v: serde_json::Value) -> Payload {
        // Payload is essentially HashMap<String, qdrant::Value>;
        // its `from` impls cover the JSON object case.
        match v {
            serde_json::Value::Object(_) => Payload::try_from(v).unwrap_or_default(),
            _ => Payload::default(),
        }
    }
}

#[async_trait::async_trait]
impl VectorBackend for QdrantBackend {
    fn provider(&self) -> VectorProvider {
        VectorProvider::Qdrant
    }

    async fn create_collection(&self, req: CreateCollectionRequest) -> Result<()> {
        let params = VectorParamsBuilder::new(req.dimension as u64, Distance::Cosine).build();
        self.client
            .create_collection(CreateCollectionBuilder::new(req.name).vectors_config(params))
            .await
            .map(|_| ())
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })
    }

    async fn delete_collection(&self, name: &str) -> Result<()> {
        self.client
            .delete_collection(name)
            .await
            .map(|_| ())
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })
    }

    async fn list_collections(&self) -> Result<Vec<Collection>> {
        let resp = self
            .client
            .list_collections()
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(resp
            .collections
            .into_iter()
            .map(|c| Collection {
                name: c.name,
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
        let info = self
            .client
            .collection_info(name)
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        let dim = info
            .result
            .and_then(|r| r.config)
            .and_then(|c| c.params)
            .and_then(|p| p.vectors_config)
            .and_then(|vc| vc.config)
            .and_then(|c| match c {
                qdrant::vectors_config::Config::Params(p) => Some(p.size as usize),
                _ => None,
            })
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
        let pts: Vec<PointStruct> = points
            .into_iter()
            .map(|p| {
                let payload = p.payload.map(Self::payload_from_json).unwrap_or_default();
                PointStruct::new(p.id, p.vector, payload)
            })
            .collect();
        self.client
            .upsert_points(UpsertPointsBuilder::new(collection, pts))
            .await
            .map(|_| ())
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })
    }

    async fn delete_points(&self, collection: &str, ids: Vec<String>) -> Result<()> {
        let point_ids: Vec<PointId> = ids
            .into_iter()
            .map(|s| {
                if let Ok(n) = s.parse::<u64>() {
                    PointId {
                        point_id_options: Some(point_id::PointIdOptions::Num(n)),
                    }
                } else {
                    PointId {
                        point_id_options: Some(point_id::PointIdOptions::Uuid(s)),
                    }
                }
            })
            .collect();
        self.client
            .delete_points(
                DeletePointsBuilder::new(collection).points(PointsIdsList { ids: point_ids }),
            )
            .await
            .map(|_| ())
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })
    }

    async fn get_points(&self, _collection: &str, _ids: Vec<String>) -> Result<Vec<Point>> {
        // qdrant-client 1.18 exposes `client.get_points` via a builder; not
        // strictly required for the migration's MVP scope. JS-side callers
        // can fall back to scroll-with-id-filter if they really need this.
        Err(VectorError::NotAvailable(
            "qdrant get_points not implemented in this iteration".into(),
        ))
    }

    async fn query(
        &self,
        collection: &str,
        query_vector: Vec<f32>,
        opts: SearchOptions,
    ) -> Result<SearchResponse> {
        let mut builder = SearchPointsBuilder::new(collection, query_vector, opts.limit as u64)
            .offset(opts.offset as u64)
            .with_payload(opts.include_payload || opts.include_content);
        if let Some(ref filters) = opts.filter {
            builder = builder.filter(Self::translate_filter(filters, opts.filter_mode));
        }
        let resp = self
            .client
            .search_points(builder)
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        let results: Vec<SearchHit> = resp
            .result
            .into_iter()
            .map(|r| {
                let id = Self::id_to_string(r.id);
                let payload_value: Option<serde_json::Value> = if opts.include_payload || opts.include_content {
                    let payload = Payload::from(r.payload.clone());
                    Some(serde_json::Value::from(payload))
                } else {
                    None
                };
                let content = if opts.include_content {
                    payload_value
                        .as_ref()
                        .and_then(|v| v.get("content"))
                        .and_then(|v| v.as_str())
                        .map(String::from)
                } else {
                    None
                };
                SearchHit {
                    id,
                    score: r.score,
                    payload: if opts.include_payload {
                        payload_value
                    } else {
                        None
                    },
                    content,
                }
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
        // Qdrant: drop + recreate is the cleanest truncate. We preserve
        // the dimension by reading collection_info first.
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

    async fn scroll(&self, collection: &str, opts: ScrollOptions) -> Result<ScrollPage> {
        let mut builder = ScrollPointsBuilder::new(collection)
            .limit(opts.limit as u32)
            .with_payload(true);
        if let Some(ref filters) = opts.filter {
            builder = builder.filter(Self::translate_filter(filters, opts.filter_mode));
        }
        if let Some(c) = opts.cursor.as_ref() {
            let offset_id = if let Ok(n) = c.parse::<u64>() {
                PointId {
                    point_id_options: Some(point_id::PointIdOptions::Num(n)),
                }
            } else {
                PointId {
                    point_id_options: Some(point_id::PointIdOptions::Uuid(c.clone())),
                }
            };
            builder = builder.offset(offset_id);
        }
        let resp = self
            .client
            .scroll(builder)
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        let next_cursor = resp.next_page_offset.map(|id| Self::id_to_string(Some(id)));
        let has_more = next_cursor.is_some();
        let points: Vec<Point> = resp
            .result
            .into_iter()
            .map(|r| {
                let id = Self::id_to_string(r.id);
                let payload = Payload::from(r.payload);
                Point {
                    id,
                    vector: Vec::new(),
                    payload: Some(serde_json::Value::from(payload)),
                }
            })
            .collect();
        Ok(ScrollPage {
            points,
            next_cursor,
            has_more,
        })
    }

    async fn count(&self, collection: &str, _filter: Option<Vec<Filter>>) -> Result<u64> {
        let resp = self
            .client
            .count(qdrant::CountPoints {
                collection_name: collection.to_string(),
                ..Default::default()
            })
            .await
            .map_err(|e| VectorError::Http {
                status: 0,
                message: e.to_string(),
            })?;
        Ok(resp.result.map(|r| r.count).unwrap_or(0))
    }

    async fn health_check(&self) -> Result<HealthStatus> {
        match self.client.health_check().await {
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

    #[test]
    fn translate_and_filter_pushes_to_must() {
        let filters = vec![Filter {
            key: "topic".into(),
            value: serde_json::json!("rust"),
            operation: FilterOp::Equals,
        }];
        let f = QdrantBackend::translate_filter(&filters, FilterMode::And);
        assert_eq!(f.must.len(), 1);
        assert!(f.should.is_empty());
        assert!(f.must_not.is_empty());
    }

    #[test]
    fn translate_or_filter_pushes_to_should() {
        let filters = vec![Filter {
            key: "topic".into(),
            value: serde_json::json!("rust"),
            operation: FilterOp::Equals,
        }];
        let f = QdrantBackend::translate_filter(&filters, FilterMode::Or);
        assert!(f.must.is_empty());
        assert_eq!(f.should.len(), 1);
    }

    #[test]
    fn translate_not_equals_pushes_to_must_not() {
        let filters = vec![Filter {
            key: "status".into(),
            value: serde_json::json!("archived"),
            operation: FilterOp::NotEquals,
        }];
        let f = QdrantBackend::translate_filter(&filters, FilterMode::And);
        assert!(f.must.is_empty());
        assert_eq!(f.must_not.len(), 1);
    }

    #[test]
    fn translate_range_filter_uses_range_condition() {
        let filters = vec![Filter {
            key: "score".into(),
            value: serde_json::json!(0.5),
            operation: FilterOp::GreaterThanOrEquals,
        }];
        let f = QdrantBackend::translate_filter(&filters, FilterMode::And);
        assert_eq!(f.must.len(), 1);
        match &f.must[0].condition_one_of {
            Some(ConditionOneOf::Field(fc)) => {
                assert_eq!(fc.key, "score");
                assert!(fc.range.is_some());
                let r = fc.range.as_ref().unwrap();
                assert_eq!(r.gte, Some(0.5));
            }
            other => panic!("expected Field/range condition, got {other:?}"),
        }
    }
}
