//! Schema conventions for the types the RPC face answers with (ADR-0175 B4).
//!
//! `schemars` describes a Rust type the way `serde` would *accept* it. The
//! companion output contract describes what the host *writes*, and on the
//! headless and mobile planes it is enforced: a response that does not match
//! its published schema is refused with `contract_output_violation` rather
//! than delivered. The two readings differ in exactly two places, and both
//! differences make the derived schema the looser one.
//!
//! 1. **`Option<T>` is not `required`.** `schemars` leaves an `Option` field
//!    out of `required`, which promises "this key may be absent". A wire
//!    struct with no `skip_serializing_if` always writes the key, with `null`
//!    for `None`. "Always present, sometimes null" is the stronger promise and
//!    the true one, and a client that reads `exitCode === null` to mean
//!    "signalled" depends on it.
//! 2. **Unknown properties are allowed.** `schemars` only writes
//!    `additionalProperties: false` for `deny_unknown_fields`, which is a
//!    *deserialisation* instruction and says nothing about what is serialised.
//!    A struct writes its declared fields and no others.
//!
//! [`closed_object`] states both. Apply it to a wire struct whose every field
//! is written on every answer:
//!
//! ```ignore
//! #[derive(Serialize, schemars::JsonSchema)]
//! #[serde(rename_all = "camelCase")]
//! #[schemars(transform = cognia_problem::wire_schema::closed_object)]
//! pub struct TerminalExecResult { /* … */ }
//! ```
//!
//! A struct that really does omit a key, through `skip_serializing_if`,
//! `skip_serializing` or `serde(flatten)`, takes [`closed_sparse_object`]
//! instead: the object is still closed, and schemars is already right about
//! which fields may be absent. Stating `closed_object` there would publish a
//! requirement the host does not meet. Nothing at runtime can catch that
//! confusion, because by the time the transform sees the schema the omitted
//! field is simply gone, so [`closed_object_pairing_violations`] reads the
//! source instead and each crate scans its own.
//!
//! `#[serde(default)]` is not in that list. It changes what serde will
//! *accept*, never what it writes, so a `default` field is still written on
//! every answer and [`closed_object`] is right about it. schemars leaves it
//! out of `required`, which is the third place the derived schema is looser
//! than the truth.

use schemars::Schema;
use serde_json::Value;

/// Declare a wire object closed: every property it declares is written, and
/// no other property ever is.
///
/// A no-op on anything that is not an object schema with properties, so it is
/// safe on a newtype or an enum variant that resolves to something else.
///
/// The `null` member of an `Option<T>`'s type stays. `#[schemars(required)]`
/// would also put the field in `required`, but it does it by describing the
/// field as a bare `T`, which drops `null` from the type and turns a
/// legitimate `null` answer into a contract violation.
pub fn closed_object(schema: &mut Schema) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    let Some(properties) = object.get("properties").and_then(Value::as_object) else {
        return;
    };
    if properties.is_empty() {
        return;
    }
    let declared: Vec<Value> = properties
        .keys()
        .map(|key| Value::from(key.clone()))
        .collect();
    object.insert("required".to_string(), Value::Array(declared));
    object.insert("additionalProperties".to_string(), Value::Bool(false));
}

/// Declare a wire object closed while leaving `required` to schemars.
///
/// For a struct that really does omit a key sometimes, through
/// `skip_serializing_if` or `skip_serializing`. Half of [`closed_object`]
/// still holds there: the struct writes its declared fields and no others.
/// The other half does not, and schemars is already right about which fields
/// may be absent.
pub fn closed_sparse_object(schema: &mut Schema) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    if object
        .get("properties")
        .and_then(Value::as_object)
        .is_none_or(|properties| properties.is_empty())
    {
        return;
    }
    object.insert("additionalProperties".to_string(), Value::Bool(false));
}

/// Structs that claim [`closed_object`] while a field of theirs is omitted
/// from the wire.
///
/// The transform runs on the finished schema, where a `skip_serializing_if`
/// field is simply absent, so it cannot notice the contradiction itself. A
/// crate that applies these transforms scans its own sources with this and
/// fails its own test, which is the only place the pairing is visible.
///
/// Returns one line per offending struct, naming the field and the attribute.
pub fn closed_object_pairing_violations(file: &str, source: &str) -> Vec<String> {
    const OMITTERS: [&str; 3] = ["skip_serializing_if", "skip_serializing]", "serde(flatten)"];
    let mut violations = Vec::new();
    let lines: Vec<&str> = source.lines().collect();
    let mut index = 0;

    while index < lines.len() {
        let trimmed = lines[index].trim_start();
        let is_struct_head = trimmed.starts_with("pub struct ") || trimmed.starts_with("struct ");
        if !is_struct_head {
            index += 1;
            continue;
        }

        // Walk back over the attribute block that belongs to this struct.
        let mut attributes_start = index;
        while attributes_start > 0 {
            let previous = lines[attributes_start - 1].trim_start();
            if previous.starts_with('#')
                || previous.starts_with("///")
                || previous.starts_with("//")
            {
                attributes_start -= 1;
            } else {
                break;
            }
        }
        let declares_closed = lines[attributes_start..index]
            .iter()
            .any(|line| line.contains("closed_object"));
        if !declares_closed {
            index += 1;
            continue;
        }

        let name = trimmed
            .trim_start_matches("pub ")
            .trim_start_matches("struct ")
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .next()
            .unwrap_or("<unnamed>")
            .to_string();

        // The body, by brace depth, so a nested type cannot end it early.
        let mut depth = 0usize;
        let mut cursor = index;
        loop {
            depth += lines[cursor].matches('{').count();
            depth -= lines[cursor].matches('}').count().min(depth);
            for omitter in OMITTERS {
                if lines[cursor].contains(omitter) {
                    violations.push(format!(
                        "{file}:{} {name} states closed_object and omits a field: {}",
                        cursor + 1,
                        lines[cursor].trim()
                    ));
                }
            }
            if depth == 0 && cursor > index {
                break;
            }
            cursor += 1;
            if cursor >= lines.len() {
                break;
            }
        }
        index = cursor + 1;
    }

    violations
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;

    #[derive(Serialize, schemars::JsonSchema)]
    #[serde(rename_all = "camelCase")]
    #[schemars(transform = closed_object)]
    struct Sample {
        name: String,
        exit_code: Option<i32>,
    }

    #[derive(schemars::JsonSchema)]
    #[schemars(transform = closed_object)]
    struct Empty {}

    fn schema_value<T: schemars::JsonSchema>() -> Value {
        serde_json::to_value(schemars::schema_for!(T)).unwrap()
    }

    #[test]
    fn every_declared_property_is_required() {
        let schema = schema_value::<Sample>();
        let mut required: Vec<&str> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        required.sort_unstable();
        assert_eq!(required, ["exitCode", "name"]);
    }

    #[test]
    fn an_optional_field_keeps_its_null() {
        // The whole point of not using `#[schemars(required)]`: the field is
        // always present AND may be null, and both halves have to survive.
        let schema = schema_value::<Sample>();
        assert_eq!(
            schema["properties"]["exitCode"]["type"],
            serde_json::json!(["integer", "null"])
        );
    }

    #[test]
    fn the_object_is_closed() {
        assert_eq!(
            schema_value::<Sample>()["additionalProperties"],
            Value::Bool(false)
        );
    }

    #[test]
    fn a_property_less_object_is_left_alone() {
        // An empty struct writes `{}`, and saying `required: []` plus
        // `additionalProperties: false` about it would be true but noisy. More
        // importantly it proves the guard: the transform never invents a
        // `required` key on a schema that has no `properties` at all, which is
        // what it would do to a newtype or an enum.
        let schema = schema_value::<Empty>();
        assert!(schema.get("required").is_none());
    }

    #[derive(Serialize, schemars::JsonSchema)]
    #[serde(rename_all = "camelCase")]
    #[schemars(transform = closed_sparse_object)]
    struct Sparse {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    }

    #[test]
    fn a_sparse_object_is_closed_but_keeps_its_optional_field_optional() {
        let schema = schema_value::<Sparse>();
        assert_eq!(schema["additionalProperties"], Value::Bool(false));
        assert_eq!(schema["required"], serde_json::json!(["name"]));
    }

    #[test]
    fn pairing_violations_name_the_struct_the_field_and_the_line() {
        let source = "\
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct Wrong {
    pub name: String,
    #[serde(skip_serializing_if = \"Option::is_none\")]
    pub note: Option<String>,
}
";
        let found = closed_object_pairing_violations("types.rs", source);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains("types.rs:4"), "{}", found[0]);
        assert!(found[0].contains("Wrong"), "{}", found[0]);
    }

    #[test]
    fn pairing_leaves_the_sparse_transform_and_untransformed_structs_alone() {
        let source = "\
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct Sparse {
    #[serde(skip_serializing_if = \"Option::is_none\")]
    pub note: Option<String>,
}

pub struct Plain {
    #[serde(skip_serializing_if = \"Option::is_none\")]
    pub note: Option<String>,
}

#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct Fine {
    pub name: String,
}
";
        assert_eq!(
            closed_object_pairing_violations("types.rs", source),
            Vec::<String>::new()
        );
    }

    #[test]
    fn pairing_does_not_end_a_struct_at_a_nested_brace() {
        // A field whose type carries braces used to close the body early, so
        // an offending field below it was never scanned.
        let source = "\
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct Nested {
    pub map: BTreeMap<String, Vec<String>>,
    pub inner: Option<fn() -> ()>,
    #[serde(skip_serializing_if = \"Vec::is_empty\")]
    pub rest: Vec<String>,
}
";
        assert_eq!(
            closed_object_pairing_violations("types.rs", source).len(),
            1
        );
    }

    #[test]
    fn a_non_object_schema_is_untouched() {
        let mut schema = Schema::try_from(serde_json::json!({ "type": "string" })).unwrap();
        closed_object(&mut schema);
        assert_eq!(
            serde_json::to_value(&schema).unwrap(),
            serde_json::json!({ "type": "string" })
        );
    }
}
