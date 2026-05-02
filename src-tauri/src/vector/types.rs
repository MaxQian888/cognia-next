//! Vector store type definitions.
//!
//! Mirrors the serde patterns in `scheduler/types.rs`:
//! - `#[serde(rename_all = "snake_case")]` per enum (NOT a global default).
//!   The TypeScript caller already sends snake_case keys
//!   (see `lib/vector/store.ts` payload builders).
//! - Tagged unions use `#[serde(tag = "type", rename_all = "snake_case")]`
//!   when needed.
//!
//! The 14-variant `FilterOp` matches `FilterOperation` in
//! `lib/vector/store.ts:428-442`.

use serde::{Deserialize, Serialize};

/// A point stored in a collection.
///
/// Wire shape used in both directions (upsert request, get response):
/// `{ id, vector, payload }`. `payload` is an arbitrary JSON object that
/// the Rust side persists verbatim to `points.payload_json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub id: String,
    pub vector: Vec<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

/// Public collection metadata returned by `list`/`get`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub name: String,
    pub dimension: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    pub document_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

/// One result row from `vector_search_points`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: String,
    /// `1.0 - distance / 2.0` for unit-normalised L2 vectors;
    /// see `db.rs::search_points` for derivation and rationale.
    pub score: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    /// Convenience copy of the underlying `points.content` column;
    /// frontends that don't dig into `payload` can read this directly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

/// Combine multiple filters with `AND` (default) or `OR`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FilterMode {
    #[default]
    And,
    Or,
}

/// 14 filter operations matching `FilterOperation` in
/// `lib/vector/store.ts:428-442`. Each maps to a SQL fragment in
/// `filters.rs::build_where`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Equals,
    NotEquals,
    Contains,
    NotContains,
    GreaterThan,
    GreaterThanOrEquals,
    LessThan,
    LessThanOrEquals,
    IsNull,
    IsNotNull,
    StartsWith,
    EndsWith,
    In,
    NotIn,
}

/// Single filter clause. Wire shape comes from
/// `lib/vector/store.ts` `PayloadFilter` (key/value/operation).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Filter {
    pub key: String,
    /// Untyped JSON — the SQL builder coerces per-op. `null` is fine for
    /// `is_null` / `is_not_null`; arrays for `in` / `not_in`; primitives
    /// for the comparison/like ops.
    #[serde(default)]
    pub value: serde_json::Value,
    pub operation: FilterOp,
}

/// `vector_search_points` response. `total` is populated for callers that
/// need pagination context; offset/limit echo the request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub results: Vec<SearchHit>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_op_serializes_snake_case() {
        let op = FilterOp::GreaterThanOrEquals;
        let json = serde_json::to_string(&op).expect("serialize");
        assert_eq!(json, "\"greater_than_or_equals\"");
    }

    #[test]
    fn filter_mode_default_is_and() {
        assert_eq!(FilterMode::default(), FilterMode::And);
        let json = serde_json::to_string(&FilterMode::Or).expect("serialize");
        assert_eq!(json, "\"or\"");
    }

    #[test]
    fn filter_round_trips_through_json() {
        let raw = r#"{"key":"category","value":"x","operation":"equals"}"#;
        let f: Filter = serde_json::from_str(raw).expect("parse");
        assert_eq!(f.key, "category");
        assert_eq!(f.operation, FilterOp::Equals);
        assert_eq!(f.value, serde_json::json!("x"));
    }

    #[test]
    fn point_round_trips() {
        let p = Point {
            id: "abc".into(),
            vector: vec![0.1, 0.2, 0.3],
            payload: Some(serde_json::json!({"k": "v"})),
        };
        let json = serde_json::to_string(&p).expect("serialize");
        let back: Point = serde_json::from_str(&json).expect("parse");
        assert_eq!(back.id, "abc");
        assert_eq!(back.vector.len(), 3);
        assert_eq!(back.payload, Some(serde_json::json!({"k": "v"})));
    }

    #[test]
    fn all_14_filter_ops_serialize_distinctly() {
        let ops = [
            FilterOp::Equals,
            FilterOp::NotEquals,
            FilterOp::Contains,
            FilterOp::NotContains,
            FilterOp::GreaterThan,
            FilterOp::GreaterThanOrEquals,
            FilterOp::LessThan,
            FilterOp::LessThanOrEquals,
            FilterOp::IsNull,
            FilterOp::IsNotNull,
            FilterOp::StartsWith,
            FilterOp::EndsWith,
            FilterOp::In,
            FilterOp::NotIn,
        ];
        let mut seen = std::collections::HashSet::new();
        for op in ops {
            let s = serde_json::to_string(&op).expect("serialize");
            assert!(seen.insert(s.clone()), "duplicate variant: {}", s);
        }
        assert_eq!(seen.len(), 14);
    }
}
