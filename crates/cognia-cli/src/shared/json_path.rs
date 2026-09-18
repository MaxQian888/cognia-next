//! Minimal dot-path projection used by `--query` (`--select` alias) on the
//! host and plugin commands.
//!
//! Grammar: `.a.b[0].c` or `a.b[0]` — dot-separated object keys with
//! optional `[N]` array indices and `[]`/`[*]` array wildcards that map the
//! remaining path over every element (`.plugins[].id` → `["a","b"]`). A
//! leading `.` and a bare `.` (selecting the whole document) are accepted.
//! Wildcards collect, they do not flatten: `a[].b[]` yields an array of
//! arrays. This is deliberately not jq: no pipes, filters, or
//! construction — only traversal — so it needs no new dependency. For
//! anything richer the emitted JSON pipes cleanly into a real `jq`.

use serde_json::Value;

enum Segment {
    Key(String),
    Index(usize),
    Each,
}

/// Walk `document` along `expression`, returning the selected value.
/// Wildcard segments build new arrays, so the result is owned. Errors are
/// human-readable and name the failing segment.
pub(crate) fn project(document: &Value, expression: &str) -> Result<Value, String> {
    let segments = parse(expression)?;
    project_at(document, &segments, expression, 0)
}

fn project_at(
    value: &Value,
    segments: &[Segment],
    expression: &str,
    position: usize,
) -> Result<Value, String> {
    let Some((segment, rest)) = segments.split_first() else {
        return Ok(value.clone());
    };
    match segment {
        Segment::Key(key) => {
            let next = value.get(key).ok_or_else(|| {
                format!("--query `{expression}`: segment {position} has no key `{key}`")
            })?;
            project_at(next, rest, expression, position + 1)
        }
        Segment::Index(index) => {
            let next = value.get(*index).ok_or_else(|| {
                format!("--query `{expression}`: segment {position} has no index [{index}]")
            })?;
            project_at(next, rest, expression, position + 1)
        }
        Segment::Each => {
            let elements = value.as_array().ok_or_else(|| {
                format!("--query `{expression}`: segment {position} `[]` needs an array")
            })?;
            elements
                .iter()
                .map(|element| project_at(element, rest, expression, position + 1))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
    }
}

/// Validate an expression without a document — used to reject malformed
/// `--query` values before a stream starts emitting frames.
pub(crate) fn validate(expression: &str) -> Result<(), String> {
    parse(expression).map(|_| ())
}

fn parse(expression: &str) -> Result<Vec<Segment>, String> {
    let expression = expression.strip_prefix('.').unwrap_or(expression);
    if expression.is_empty() {
        return Ok(Vec::new());
    }
    let mut segments = Vec::new();
    for part in expression.split('.') {
        let key_end = part.find('[').unwrap_or(part.len());
        let key = &part[..key_end];
        if !key.is_empty() {
            segments.push(Segment::Key(key.to_string()));
        }
        let mut rest = &part[key_end..];
        if key.is_empty() && !rest.starts_with('[') {
            return Err(format!("--query `{expression}` has an empty key"));
        }
        while let Some(after) = rest.strip_prefix('[') {
            let close = after.find(']').ok_or_else(|| {
                format!("--query `{expression}` has an unclosed `[`")
            })?;
            let inner = &after[..close];
            if inner == "*" || inner.is_empty() {
                segments.push(Segment::Each);
            } else {
                let index: usize = inner.parse().map_err(|_| {
                    format!("--query `{expression}` has a non-numeric array index")
                })?;
                segments.push(Segment::Index(index));
            }
            rest = &after[close + 1..];
            if !rest.is_empty() && !rest.starts_with('[') {
                return Err(format!(
                    "--query `{expression}` has trailing characters after `]`"
                ));
            }
        }
        if !rest.is_empty() {
            return Err(format!(
                "--query `{expression}` has a malformed segment `{part}`"
            ));
        }
    }
    Ok(segments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc() -> Value {
        json!({
            "schemaVersion": 1,
            "data": {
                "id": "abc",
                "items": [
                    {"name": "first"},
                    {"name": "second"},
                ],
            },
            "ok": true,
        })
    }

    #[test]
    fn projects_nested_keys_and_indices() {
        let document = doc();
        assert_eq!(project(&document, ".data.id").unwrap(), json!("abc"));
        assert_eq!(project(&document, "data.id").unwrap(), json!("abc"));
        assert_eq!(
            project(&document, ".data.items[1].name").unwrap(),
            json!("second")
        );
        assert_eq!(project(&document, ".ok").unwrap(), json!(true));
    }

    #[test]
    fn bare_dot_selects_the_whole_document() {
        let document = doc();
        assert_eq!(project(&document, ".").unwrap(), document);
        assert_eq!(project(&document, "").unwrap(), document);
    }

    #[test]
    fn wildcard_maps_the_remaining_path_over_each_element() {
        let document = doc();
        assert_eq!(
            project(&document, ".data.items[].name").unwrap(),
            json!(["first", "second"])
        );
        assert_eq!(
            project(&document, ".data.items[*].name").unwrap(),
            json!(["first", "second"])
        );
        // Terminal `[]` unwraps to the same elements.
        assert_eq!(
            project(&document, ".data.items[]").unwrap(),
            json!([{"name": "first"}, {"name": "second"}])
        );
    }

    #[test]
    fn wildcard_errors_on_non_arrays_and_missing_keys() {
        let document = doc();
        let scalar = project(&document, ".data.id[]").unwrap_err();
        assert!(scalar.contains("needs an array"), "got: {scalar}");
        let missing = project(&document, ".data.items[].missing").unwrap_err();
        assert!(missing.contains("no key `missing`"), "got: {missing}");
    }

    #[test]
    fn rejects_missing_keys_and_out_of_range_indices() {
        let document = doc();
        let missing = project(&document, ".data.missing").unwrap_err();
        assert!(missing.contains("no key `missing`"), "got: {missing}");
        let range = project(&document, ".data.items[9]").unwrap_err();
        assert!(range.contains("no index [9]"), "got: {range}");
        let into_scalar = project(&document, ".data.id.x").unwrap_err();
        assert!(into_scalar.contains("no key `x`"), "got: {into_scalar}");
    }

    #[test]
    fn rejects_malformed_expressions() {
        let document = doc();
        for expression in [".a..b", ".a[", ".a[x]", ".a[0]x", ".."] {
            assert!(
                project(&document, expression).is_err(),
                "expected rejection for {expression}"
            );
        }
    }
}
