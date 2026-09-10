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
//! Do **not** apply it to a struct that carries `skip_serializing_if`,
//! `#[serde(flatten)]`, or `default` on a field that is genuinely omitted:
//! there the derived schema is already right and this would publish a
//! requirement the host does not meet. That is why this is an opt-in
//! transform on the struct rather than a setting on the emitter.

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
