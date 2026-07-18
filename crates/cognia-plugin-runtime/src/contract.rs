//! Install-time checks backed directly by the canonical author contract.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    minimum_host_version: String,
    plugin_types: Vec<String>,
    permissions: Vec<String>,
    capabilities: Vec<Capability>,
    path_fields: Vec<PathField>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capability {
    id: String,
    minimum_host_version: Option<String>,
}

#[derive(Deserialize)]
struct PathField {
    path: String,
}

struct RuntimeContract {
    capability_minimums: HashMap<String, [u64; 3]>,
    plugin_types: HashSet<String>,
    permissions: HashSet<String>,
    path_fields: Vec<String>,
}

fn runtime_contract() -> &'static RuntimeContract {
    static CONTRACT: OnceLock<RuntimeContract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        let catalog: Catalog = serde_json::from_str(include_str!(
            "../../../packages/plugin-sdk/contract/catalog.json"
        ))
        .expect("canonical plugin contract must be valid JSON");
        let default_minimum = catalog.minimum_host_version.clone();
        RuntimeContract {
            capability_minimums: catalog
                .capabilities
                .into_iter()
                .map(|capability| {
                    let version = capability
                        .minimum_host_version
                        .unwrap_or_else(|| default_minimum.clone());
                    let parsed = parse_semver(&version)
                        .expect("canonical capability minimum must be semantic version");
                    (capability.id, parsed)
                })
                .collect(),
            plugin_types: catalog.plugin_types.into_iter().collect(),
            permissions: catalog.permissions.into_iter().collect(),
            path_fields: catalog
                .path_fields
                .into_iter()
                .map(|field| field.path)
                .collect(),
        }
    })
}

fn parse_semver(value: &str) -> Option<[u64; 3]> {
    let mut parts = value.split('.');
    let parsed = [
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ];
    parts.next().is_none().then_some(parsed)
}

fn extract_semver(constraint: &str) -> Option<[u64; 3]> {
    constraint
        .split(|character: char| !character.is_ascii_digit() && character != '.')
        .find_map(parse_semver)
}

fn validate_string_set(
    manifest: &Value,
    field: &str,
    allowed: &HashSet<String>,
) -> Result<(), String> {
    let Some(value) = manifest.get(field) else {
        return Ok(());
    };
    let values = value
        .as_array()
        .ok_or_else(|| format!("manifest {field} must be an array"))?;
    for value in values {
        let item = value
            .as_str()
            .ok_or_else(|| format!("manifest {field} must contain strings"))?;
        if !allowed.contains(item) {
            return Err(format!("unknown plugin {field} value: {item}"));
        }
    }
    Ok(())
}

fn collect_path_values<'a>(value: &'a Value, segments: &[&str], output: &mut Vec<&'a Value>) {
    let Some((segment, rest)) = segments.split_first() else {
        output.push(value);
        return;
    };
    if let Some(field) = segment.strip_suffix("[]") {
        if let Some(items) = value.get(field).and_then(Value::as_array) {
            for item in items {
                collect_path_values(item, rest, output);
            }
        }
    } else if let Some(next) = value.get(*segment) {
        collect_path_values(next, rest, output);
    }
}

fn validate_path_fields(manifest: &Value, fields: &[String]) -> Result<(), String> {
    for field in fields {
        let segments = field.split('.').collect::<Vec<_>>();
        let mut values = Vec::new();
        collect_path_values(manifest, &segments, &mut values);
        for value in values {
            let path = value
                .as_str()
                .ok_or_else(|| format!("manifest {field} must be a string"))?;
            crate::contained_path::validate_plugin_relative_path(path)
                .map_err(|error| format!("manifest {field} is unsafe: {error}"))?;
        }
    }
    Ok(())
}

pub(crate) fn validate_manifest_contract(manifest: &Value) -> Result<(), String> {
    let contract = runtime_contract();

    if let Some(value) = manifest.get("type") {
        let plugin_type = value
            .as_str()
            .ok_or_else(|| "manifest type must be a string".to_string())?;
        if !contract.plugin_types.contains(plugin_type) {
            return Err(format!("unknown plugin type: {plugin_type}"));
        }
    }
    validate_string_set(manifest, "permissions", &contract.permissions)?;
    validate_string_set(manifest, "optionalPermissions", &contract.permissions)?;
    validate_path_fields(manifest, &contract.path_fields)?;

    let declared = match manifest.get("capabilities") {
        None => &[][..],
        Some(value) => value
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| "manifest capabilities must be an array".to_string())?,
    };
    let mut required = [0, 0, 0];
    for capability in declared {
        let id = capability
            .as_str()
            .ok_or_else(|| "manifest capabilities must contain strings".to_string())?;
        let minimum = contract
            .capability_minimums
            .get(id)
            .ok_or_else(|| format!("unknown plugin capability: {id}"))?;
        required = required.max(*minimum);
    }

    if let Some(engines) = manifest.get("engines") {
        let engines = engines
            .as_object()
            .ok_or_else(|| "manifest engines must be an object".to_string())?;
        if let Some(value) = engines.get("cognia") {
            let constraint = value
                .as_str()
                .ok_or_else(|| "engines.cognia must be a string".to_string())?;
            let declared_minimum = extract_semver(constraint)
                .ok_or_else(|| "engines.cognia must include a semantic version".to_string())?;
            if declared_minimum < required {
                return Err(format!(
                    "engines.cognia is older than the declared capability minimum {}.{}.{}",
                    required[0], required[1], required[2]
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unknown_and_host_incompatible_capabilities() {
        assert!(
            validate_manifest_contract(&json!({ "capabilities": ["unknown"] }))
                .unwrap_err()
                .contains("unknown")
        );
        assert!(validate_manifest_contract(&json!({
            "capabilities": ["tools"],
            "engines": { "cognia": ">=0.0.9" }
        }))
        .unwrap_err()
        .contains("capability minimum"));
    }

    #[test]
    fn rejects_malformed_contract_fields() {
        assert!(validate_manifest_contract(&json!({ "capabilities": {} })).is_err());
        assert!(validate_manifest_contract(&json!({ "engines": { "cognia": 1 } })).is_err());
        assert!(validate_manifest_contract(&json!({ "type": "unknown" })).is_err());
        assert!(validate_manifest_contract(&json!({ "permissions": ["unknown"] })).is_err());
    }

    #[test]
    fn rejects_unsafe_paths_from_top_level_nested_and_array_fields() {
        for manifest in [
            json!({ "main": "../outside.js" }),
            json!({ "configComponent": { "entry": "C:\\outside.js" } }),
            json!({ "contextPanels": [{ "entry": "..\\outside.js" }] }),
            json!({ "runtimeCompatibility": { "mobile": { "entrypoint": "/outside.js" } } }),
        ] {
            assert!(validate_manifest_contract(&manifest).is_err());
        }
    }

    #[test]
    fn accepts_known_capabilities_at_the_catalog_minimum() {
        validate_manifest_contract(&json!({
            "type": "hybrid",
            "permissions": ["network:fetch"],
            "main": "dist/index.js",
            "contextPanels": [{ "entry": "dist/panel.js" }],
            "capabilities": ["tools", "context-panel"],
            "engines": { "cognia": ">=0.1.0" }
        }))
        .unwrap();
    }
}
