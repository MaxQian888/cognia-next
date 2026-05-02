//! Pure filter → SQL builder.
//!
//! `build_where(filters, mode) -> (fragment, params)` — fragment is the SQL
//! body **without** a leading `WHERE` keyword (the caller decides whether
//! to prefix `AND` or `WHERE` based on its own composition). Empty filter
//! list returns `("".to_string(), vec![])`; the caller must check for
//! emptiness before splicing.
//!
//! Op coverage matches spec §"Filter mapping" (line 198-213) — all 14
//! variants of `FilterOp` are handled; nothing falls through to
//! client-side post-filtering.

use rusqlite::types::Value;
use serde_json::Value as JsonValue;

use super::types::{Filter, FilterMode, FilterOp};

/// Validate a JSON path key. Only `[A-Za-z0-9_.]+` is allowed because the
/// key is interpolated directly into the SQL string (SQLite's JSON path
/// argument cannot be parameter-bound). Anything else is rejected.
fn is_valid_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Escape `%`, `_`, and `\` for use inside a `LIKE` pattern. SQL form is
/// `LIKE ? ESCAPE '\'`; values are escaped with a single backslash. The
/// caller is responsible for splicing the wildcards (`%` prefix/suffix).
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            other => out.push(other),
        }
    }
    out
}

fn json_to_sql_value(v: &JsonValue) -> Value {
    match v {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                Value::Real(f)
            } else {
                Value::Text(n.to_string())
            }
        }
        JsonValue::String(s) => Value::Text(s.clone()),
        // Arrays/objects pass through as their JSON serialisation. Callers
        // shouldn't pass these for scalar ops; the few ops that take
        // arrays (`in`/`not_in`) don't reach this path.
        other => Value::Text(other.to_string()),
    }
}

/// Build a SQL fragment + bound params for a list of filters.
///
/// Returns `("", vec![])` for an empty list. The fragment never has a
/// leading `WHERE` — the caller composes that with whatever else is in
/// its query.
pub fn build_where(filters: &[Filter], mode: FilterMode) -> (String, Vec<Value>) {
    if filters.is_empty() {
        return (String::new(), Vec::new());
    }

    let joiner = match mode {
        FilterMode::And => " AND ",
        FilterMode::Or => " OR ",
    };

    let mut clauses: Vec<String> = Vec::with_capacity(filters.len());
    let mut params: Vec<Value> = Vec::new();

    for filter in filters {
        match build_clause(filter) {
            Some((clause, mut clause_params)) => {
                clauses.push(clause);
                params.append(&mut clause_params);
            }
            None => {
                // Invalid key — render a tautologically-false clause so the
                // overall query stays well-formed without leaking data.
                clauses.push("FALSE".to_string());
            }
        }
    }

    let fragment = if clauses.len() == 1 {
        clauses.into_iter().next().unwrap()
    } else {
        format!("({})", clauses.join(joiner))
    };

    (fragment, params)
}

fn build_clause(filter: &Filter) -> Option<(String, Vec<Value>)> {
    if !is_valid_key(&filter.key) {
        return None;
    }
    // SQLite's JSON path can't be parameter-bound; key is validated above.
    let path = format!("'$.{}'", filter.key);
    let extract = format!("json_extract(payload_json, {})", path);

    Some(match filter.operation {
        FilterOp::Equals => (
            format!("{} = ?", extract),
            vec![json_to_sql_value(&filter.value)],
        ),
        FilterOp::NotEquals => (
            format!("{} <> ?", extract),
            vec![json_to_sql_value(&filter.value)],
        ),
        FilterOp::GreaterThan => (
            format!("{} > ?", extract),
            vec![json_to_sql_value(&filter.value)],
        ),
        FilterOp::GreaterThanOrEquals => (
            format!("{} >= ?", extract),
            vec![json_to_sql_value(&filter.value)],
        ),
        FilterOp::LessThan => (
            format!("{} < ?", extract),
            vec![json_to_sql_value(&filter.value)],
        ),
        FilterOp::LessThanOrEquals => (
            format!("{} <= ?", extract),
            vec![json_to_sql_value(&filter.value)],
        ),
        FilterOp::IsNull => (format!("{} IS NULL", extract), Vec::new()),
        FilterOp::IsNotNull => (format!("{} IS NOT NULL", extract), Vec::new()),
        FilterOp::Contains => contains_clause(&filter.value, &extract, &path, false),
        FilterOp::NotContains => contains_clause(&filter.value, &extract, &path, true),
        FilterOp::StartsWith => {
            let needle = filter.value.as_str().unwrap_or("").to_string();
            let escaped = escape_like(&needle);
            (
                format!("{} LIKE ? ESCAPE '\\'", extract),
                vec![Value::Text(format!("{}%", escaped))],
            )
        }
        FilterOp::EndsWith => {
            let needle = filter.value.as_str().unwrap_or("").to_string();
            let escaped = escape_like(&needle);
            (
                format!("{} LIKE ? ESCAPE '\\'", extract),
                vec![Value::Text(format!("%{}", escaped))],
            )
        }
        FilterOp::In => in_clause(&filter.value, &extract, false),
        FilterOp::NotIn => in_clause(&filter.value, &extract, true),
    })
}

/// `contains` is overloaded: arrays look for membership via `json_each`,
/// strings do `LIKE '%needle%'`. Mirrors the JS unified DSL semantics.
fn contains_clause(
    value: &JsonValue,
    extract: &str,
    path: &str,
    negate: bool,
) -> (String, Vec<Value>) {
    if value.is_array() {
        // Match if ANY element of payload[k] equals value (or all elements;
        // for "contains" we look for membership of any item in the array).
        // The conventional interpretation: payload[k] is an array, and we
        // check whether `value` is in it. If `value` is itself an array,
        // we test whether any of its elements is in payload[k].
        let needles: Vec<Value> = value
            .as_array()
            .unwrap()
            .iter()
            .map(json_to_sql_value)
            .collect();
        if needles.is_empty() {
            return (
                if negate {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                },
                Vec::new(),
            );
        }
        let placeholders = vec!["?"; needles.len()].join(", ");
        let exists = format!(
            "EXISTS (SELECT 1 FROM json_each(json_extract(payload_json, {})) WHERE value IN ({}))",
            path, placeholders
        );
        if negate {
            (format!("NOT {}", exists), needles)
        } else {
            (exists, needles)
        }
    } else if let Some(s) = value.as_str() {
        let escaped = escape_like(s);
        let pattern = format!("%{}%", escaped);
        if negate {
            (
                format!("{} NOT LIKE ? ESCAPE '\\'", extract),
                vec![Value::Text(pattern)],
            )
        } else {
            (
                format!("{} LIKE ? ESCAPE '\\'", extract),
                vec![Value::Text(pattern)],
            )
        }
    } else {
        // Numbers / bools / null fall back to scalar equality semantics.
        if negate {
            (
                format!("{} <> ?", extract),
                vec![json_to_sql_value(value)],
            )
        } else {
            (
                format!("{} = ?", extract),
                vec![json_to_sql_value(value)],
            )
        }
    }
}

fn in_clause(value: &JsonValue, extract: &str, negate: bool) -> (String, Vec<Value>) {
    let items: Vec<Value> = value
        .as_array()
        .map(|arr| arr.iter().map(json_to_sql_value).collect())
        .unwrap_or_default();

    if items.is_empty() {
        // An `IN (empty)` is always false; `NOT IN (empty)` always true.
        let lit = if negate { "TRUE" } else { "FALSE" };
        return (lit.to_string(), Vec::new());
    }

    let placeholders = vec!["?"; items.len()].join(", ");
    let op = if negate { "NOT IN" } else { "IN" };
    (format!("{} {} ({})", extract, op, placeholders), items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn f(key: &str, op: FilterOp, value: serde_json::Value) -> Filter {
        Filter {
            key: key.into(),
            value,
            operation: op,
        }
    }

    fn text(s: &str) -> Value {
        Value::Text(s.to_string())
    }

    #[test]
    fn build_where_with_empty_list_returns_empty() {
        let (sql, params) = build_where(&[], FilterMode::And);
        assert_eq!(sql, "");
        assert!(params.is_empty());
    }

    #[test]
    fn equals_op() {
        let (sql, params) = build_where(
            &[f("category", FilterOp::Equals, json!("docs"))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.category') = ?");
        assert_eq!(params, vec![text("docs")]);
    }

    #[test]
    fn not_equals_op() {
        let (sql, _) = build_where(
            &[f("k", FilterOp::NotEquals, json!("v"))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.k') <> ?");
    }

    #[test]
    fn greater_than_op() {
        let (sql, params) = build_where(
            &[f("score", FilterOp::GreaterThan, json!(10))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.score') > ?");
        assert_eq!(params, vec![Value::Integer(10)]);
    }

    #[test]
    fn greater_than_or_equals_op() {
        let (sql, _) = build_where(
            &[f("k", FilterOp::GreaterThanOrEquals, json!(1))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.k') >= ?");
    }

    #[test]
    fn less_than_op() {
        let (sql, _) = build_where(
            &[f("k", FilterOp::LessThan, json!(1))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.k') < ?");
    }

    #[test]
    fn less_than_or_equals_op() {
        let (sql, _) = build_where(
            &[f("k", FilterOp::LessThanOrEquals, json!(1))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.k') <= ?");
    }

    #[test]
    fn is_null_op() {
        let (sql, params) = build_where(
            &[f("k", FilterOp::IsNull, json!(null))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.k') IS NULL");
        assert!(params.is_empty());
    }

    #[test]
    fn is_not_null_op() {
        let (sql, _) = build_where(
            &[f("k", FilterOp::IsNotNull, json!(null))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.k') IS NOT NULL");
    }

    #[test]
    fn starts_with_op() {
        let (sql, params) = build_where(
            &[f("name", FilterOp::StartsWith, json!("foo"))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.name') LIKE ? ESCAPE '\\'");
        assert_eq!(params, vec![text("foo%")]);
    }

    #[test]
    fn ends_with_op() {
        let (sql, params) = build_where(
            &[f("name", FilterOp::EndsWith, json!("bar"))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.name') LIKE ? ESCAPE '\\'");
        assert_eq!(params, vec![text("%bar")]);
    }

    #[test]
    fn contains_string_op() {
        let (sql, params) = build_where(
            &[f("text", FilterOp::Contains, json!("hello"))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.text') LIKE ? ESCAPE '\\'");
        assert_eq!(params, vec![text("%hello%")]);
    }

    #[test]
    fn contains_array_op() {
        let (sql, params) = build_where(
            &[f("tags", FilterOp::Contains, json!(["a", "b"]))],
            FilterMode::And,
        );
        assert!(sql.contains("EXISTS"));
        assert!(sql.contains("json_each"));
        assert!(sql.contains("'$.tags'"));
        assert_eq!(params, vec![text("a"), text("b")]);
    }

    #[test]
    fn not_contains_string_op() {
        let (sql, params) = build_where(
            &[f("text", FilterOp::NotContains, json!("hello"))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.text') NOT LIKE ? ESCAPE '\\'");
        assert_eq!(params, vec![text("%hello%")]);
    }

    #[test]
    fn in_op() {
        let (sql, params) = build_where(
            &[f("k", FilterOp::In, json!(["a", "b", "c"]))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.k') IN (?, ?, ?)");
        assert_eq!(params, vec![text("a"), text("b"), text("c")]);
    }

    #[test]
    fn not_in_op() {
        let (sql, params) = build_where(
            &[f("k", FilterOp::NotIn, json!([1, 2]))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.k') NOT IN (?, ?)");
        assert_eq!(params, vec![Value::Integer(1), Value::Integer(2)]);
    }

    #[test]
    fn build_where_in_with_empty_array_returns_false() {
        let (sql, params) = build_where(
            &[f("k", FilterOp::In, json!([]))],
            FilterMode::And,
        );
        assert_eq!(sql, "FALSE");
        assert!(params.is_empty());
    }

    #[test]
    fn build_where_not_in_with_empty_array_returns_true() {
        let (sql, params) = build_where(
            &[f("k", FilterOp::NotIn, json!([]))],
            FilterMode::And,
        );
        assert_eq!(sql, "TRUE");
        assert!(params.is_empty());
    }

    #[test]
    fn build_where_with_and_combines_with_and_keyword() {
        let (sql, params) = build_where(
            &[
                f("a", FilterOp::Equals, json!(1)),
                f("b", FilterOp::Equals, json!(2)),
            ],
            FilterMode::And,
        );
        assert!(sql.starts_with('('));
        assert!(sql.ends_with(')'));
        assert!(sql.contains(" AND "));
        assert_eq!(params, vec![Value::Integer(1), Value::Integer(2)]);
    }

    #[test]
    fn build_where_with_or_combines_with_or_keyword() {
        let (sql, _) = build_where(
            &[
                f("a", FilterOp::Equals, json!(1)),
                f("b", FilterOp::Equals, json!(2)),
            ],
            FilterMode::Or,
        );
        assert!(sql.contains(" OR "));
        assert!(!sql.contains(" AND "));
    }

    #[test]
    fn build_where_like_escapes_special_chars() {
        let (sql, params) = build_where(
            &[f("k", FilterOp::Contains, json!("50%_off"))],
            FilterMode::And,
        );
        assert!(sql.contains("ESCAPE '\\'"));
        assert_eq!(params, vec![text("%50\\%\\_off%")]);
    }

    #[test]
    fn build_where_in_with_mixed_primitives_works() {
        let (sql, params) = build_where(
            &[f("k", FilterOp::In, json!([1, "two", 3.5, true]))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.k') IN (?, ?, ?, ?)");
        assert_eq!(
            params,
            vec![
                Value::Integer(1),
                text("two"),
                Value::Real(3.5),
                Value::Integer(1),
            ]
        );
    }

    #[test]
    fn invalid_key_renders_false() {
        // Keys with SQL-meaningful chars are rejected to avoid injection
        // through the un-parametrised JSON path.
        let (sql, params) = build_where(
            &[f("evil'; DROP--", FilterOp::Equals, json!("x"))],
            FilterMode::And,
        );
        assert_eq!(sql, "FALSE");
        assert!(params.is_empty());
    }

    #[test]
    fn nested_key_with_dots_is_allowed() {
        let (sql, _) = build_where(
            &[f("user.id", FilterOp::Equals, json!("u1"))],
            FilterMode::And,
        );
        assert_eq!(sql, "json_extract(payload_json, '$.user.id') = ?");
    }

    #[test]
    fn contains_array_empty_returns_false() {
        let (sql, params) = build_where(
            &[f("tags", FilterOp::Contains, json!([]))],
            FilterMode::And,
        );
        assert_eq!(sql, "FALSE");
        assert!(params.is_empty());
    }

    #[test]
    fn not_contains_array_empty_returns_true() {
        let (sql, params) = build_where(
            &[f("tags", FilterOp::NotContains, json!([]))],
            FilterMode::And,
        );
        assert_eq!(sql, "TRUE");
        assert!(params.is_empty());
    }
}
