//! Install-time checks backed directly by the canonical author contract.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    contract_version: String,
    protocol: ProtocolContract,
    minimum_host_version: String,
    plugin_types: Vec<String>,
    permissions: Vec<String>,
    capabilities: Vec<Capability>,
    manifest_contributions: Vec<ManifestContribution>,
    runtime_entries: HashMap<String, RuntimeEntryRule>,
    path_fields: Vec<PathField>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolContract {
    version: String,
    sdk_version: String,
    gateway_client_version: String,
    minimum_gateway_client_version: String,
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
    #[serde(default)]
    sentinels: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestContribution {
    field: String,
    execution: String,
    javascript_when: Option<JavascriptWhen>,
}

#[derive(Deserialize)]
struct JavascriptWhen {
    path: String,
    equals: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeEntryRule {
    required: Vec<String>,
    #[serde(default)]
    required_any_of: Vec<String>,
    javascript_entry: Option<String>,
    javascript_entry_required_for_contributions: bool,
}

struct RuntimeContract {
    contract_version: String,
    protocol: ProtocolContract,
    capability_minimums: HashMap<String, [u64; 3]>,
    plugin_types: HashSet<String>,
    permissions: HashSet<String>,
    manifest_contributions: Vec<ManifestContribution>,
    runtime_entries: HashMap<String, RuntimeEntryRule>,
    path_fields: Vec<PathField>,
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
            contract_version: catalog.contract_version,
            protocol: catalog.protocol,
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
            manifest_contributions: catalog.manifest_contributions,
            runtime_entries: catalog.runtime_entries,
            path_fields: catalog.path_fields,
        }
    })
}

pub(crate) fn contract_version() -> &'static str {
    &runtime_contract().contract_version
}

pub(crate) fn protocol_version() -> &'static str {
    &runtime_contract().protocol.version
}

pub(crate) fn sdk_version() -> &'static str {
    &runtime_contract().protocol.sdk_version
}

pub(crate) fn gateway_client_version() -> &'static str {
    &runtime_contract().protocol.gateway_client_version
}

pub(crate) fn minimum_gateway_client_version() -> &'static str {
    &runtime_contract().protocol.minimum_gateway_client_version
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

pub(crate) fn validate_permission_name(permission: &str) -> Result<(), String> {
    if runtime_contract().permissions.contains(permission) {
        Ok(())
    } else {
        Err(format!("unknown plugin permission: {permission}"))
    }
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

fn validate_path_fields(manifest: &Value, fields: &[PathField]) -> Result<(), String> {
    for field in fields {
        let segments = field.path.split('.').collect::<Vec<_>>();
        let mut values = Vec::new();
        collect_path_values(manifest, &segments, &mut values);
        for value in values {
            let path = value
                .as_str()
                .ok_or_else(|| format!("manifest {} must be a string", field.path))?;
            crate::contained_path::validate_plugin_relative_path(path)
                .map_err(|error| format!("manifest {} is unsafe: {error}", field.path))?;
        }
    }
    Ok(())
}

fn nested_value<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(value, |current, segment| current.get(segment))
}

fn contribution_requires_javascript(manifest: &Value, contribution: &ManifestContribution) -> bool {
    let entries = match manifest.get(&contribution.field) {
        Some(Value::Array(entries)) if !entries.is_empty() => entries.as_slice(),
        Some(value @ Value::Object(_)) => std::slice::from_ref(value),
        _ => return false,
    };
    if contribution.execution == "javascript" {
        return true;
    }
    let Some(condition) = contribution
        .javascript_when
        .as_ref()
        .filter(|_| contribution.execution == "conditional")
    else {
        return false;
    };
    entries.iter().any(|entry| {
        let value = nested_value(entry, &condition.path);
        match condition.equals.as_deref() {
            Some(expected) => value.and_then(Value::as_str) == Some(expected),
            None => value.is_some_and(|value| match value {
                Value::Null => false,
                Value::String(value) => !value.is_empty(),
                _ => true,
            }),
        }
    })
}

/// Resolve every declared path-bearing field against an extracted/installed
/// tree. This turns the lexical catalog check into an existence, containment,
/// regular-file, and no-symlink check before any runtime sees the manifest.
pub(crate) fn validate_existing_manifest_paths(
    root: &std::path::Path,
    manifest: &Value,
) -> Result<(), String> {
    for field in &runtime_contract().path_fields {
        let segments = field.path.split('.').collect::<Vec<_>>();
        let mut values = Vec::new();
        collect_path_values(manifest, &segments, &mut values);
        for value in values {
            let path = value
                .as_str()
                .ok_or_else(|| format!("manifest {} must be a string", field.path))?;
            if field.sentinels.iter().any(|sentinel| sentinel == path) {
                continue;
            }
            crate::contained_path::resolve_existing_plugin_file(root, path).map_err(|error| {
                format!("manifest {} does not resolve safely: {error}", field.path)
            })?;
        }
    }
    crate::contained_path::validate_symlink_free_tree(root)
}

pub(crate) fn validate_manifest_contract(manifest: &Value) -> Result<(), String> {
    let contract = runtime_contract();

    let plugin_type = manifest
        .get("type")
        .ok_or_else(|| "manifest type is required".to_string())?
        .as_str()
        .ok_or_else(|| "manifest type must be a string".to_string())?;
    if !contract.plugin_types.contains(plugin_type) {
        return Err(format!("unknown plugin type: {plugin_type}"));
    }
    let plugin_id = manifest
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "manifest id is required".to_string())?;
    crate::validate_plugin_id_path_component(plugin_id).map_err(|error| error.to_string())?;
    validate_string_set(manifest, "permissions", &contract.permissions)?;
    validate_string_set(manifest, "optionalPermissions", &contract.permissions)?;
    validate_path_fields(manifest, &contract.path_fields)?;

    {
        let entry_rule = contract
            .runtime_entries
            .get(plugin_type)
            .ok_or_else(|| format!("missing runtime entry contract for {plugin_type}"))?;
        for field in &entry_rule.required {
            if manifest
                .get(field)
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err(format!(
                    "plugin type {plugin_type} requires manifest {field}"
                ));
            }
        }
        if !entry_rule.required_any_of.is_empty()
            && !entry_rule.required_any_of.iter().any(|field| {
                manifest.get(field).is_some_and(|value| match value {
                    Value::String(value) => !value.is_empty(),
                    Value::Array(values) => !values.is_empty(),
                    Value::Object(values) => !values.is_empty(),
                    _ => false,
                })
            })
        {
            return Err(format!(
                "plugin type {plugin_type} requires at least one of: {}",
                entry_rule.required_any_of.join(", ")
            ));
        }

        let populated_javascript_field = contract
            .manifest_contributions
            .iter()
            .find(|contribution| contribution_requires_javascript(manifest, contribution))
            .map(|contribution| &contribution.field);
        if entry_rule.javascript_entry.is_none() {
            if let Some(field) = populated_javascript_field {
                return Err(format!(
                    "plugin type {plugin_type} cannot declare JavaScript contribution {field}"
                ));
            }
        } else if entry_rule.javascript_entry_required_for_contributions
            && populated_javascript_field.is_some()
        {
            let javascript_entry = entry_rule.javascript_entry.as_deref().ok_or_else(|| {
                format!("runtime entry contract for {plugin_type} has no JavaScript entry")
            })?;
            if manifest
                .get(javascript_entry)
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err(format!(
                    "JavaScript contributions require manifest {javascript_entry}"
                ));
            }
        }
    }

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
    fn exposes_protocol_versions_from_the_canonical_catalog() {
        assert_eq!(contract_version(), "1.2.0");
        assert_eq!(protocol_version(), "2.0.0");
        assert_eq!(sdk_version(), "0.3.0");
        assert_eq!(gateway_client_version(), "2.0.0");
        assert_eq!(minimum_gateway_client_version(), "1.0.0");
    }

    #[test]
    fn rejects_unknown_and_host_incompatible_capabilities() {
        assert!(validate_manifest_contract(&json!({
            "id": "demo",
            "type": "frontend",
            "main": "index.js",
            "capabilities": ["unknown"]
        }))
        .unwrap_err()
        .contains("unknown"));
        assert!(validate_manifest_contract(&json!({
            "id": "demo",
            "type": "frontend",
            "main": "index.js",
            "capabilities": ["tools"],
            "engines": { "cognia": ">=0.0.9" }
        }))
        .unwrap_err()
        .contains("capability minimum"));
    }

    #[test]
    fn rejects_malformed_contract_fields() {
        assert_eq!(
            validate_manifest_contract(&json!({})).unwrap_err(),
            "manifest type is required"
        );
        assert!(validate_manifest_contract(&json!({
            "id": "demo", "type": "frontend", "main": "index.js", "capabilities": {}
        }))
        .is_err());
        assert!(validate_manifest_contract(&json!({
            "id": "demo", "type": "frontend", "main": "index.js", "engines": { "cognia": 1 }
        }))
        .is_err());
        assert!(validate_manifest_contract(&json!({ "id": "demo", "type": "unknown" })).is_err());
        assert!(validate_manifest_contract(&json!({
            "id": "demo", "type": "frontend", "main": "index.js", "permissions": ["unknown"]
        }))
        .is_err());
    }

    #[test]
    fn rejects_unsafe_paths_from_top_level_nested_and_array_fields() {
        for manifest in [
            json!({ "id": "demo", "type": "frontend", "main": "../outside.js" }),
            json!({ "id": "demo", "type": "frontend", "main": "index.js", "configComponent": { "entry": "C:\\outside.js" } }),
            json!({ "id": "demo", "type": "frontend", "main": "index.js", "contextPanels": [{ "entry": "..\\outside.js" }] }),
            json!({ "id": "demo", "type": "frontend", "main": "index.js", "runtimeCompatibility": { "mobile": { "entrypoint": "/outside.js" } } }),
            json!({ "id": "demo", "type": "frontend", "main": "index.js", "themes": [{ "vscodeJsonPath": "../../outside.json" }] }),
            json!({ "id": "demo", "type": "frontend", "main": "index.js", "vscodeExtension": { "contributes": { "chatPromptFiles": [{ "path": "..\\outside.md" }] } } }),
            json!({ "id": "demo", "type": "frontend", "main": "index.js", "fonts": [{ "files": [{ "src": "../../outside.woff2" }] }] }),
            json!({ "id": "demo", "type": "frontend", "main": "index.js", "wallpapers": [{ "source": { "relPath": "..\\outside.png" } }] }),
            json!({ "id": "demo", "type": "frontend", "main": "index.js", "cliTools": [{ "binary": { "relPath": "/bin/tool" } }] }),
            json!({ "id": "demo", "type": "frontend", "main": "index.js", "vscodeLanguages": [{ "configuration": "C:\\outside.json" }] }),
            json!({ "id": "demo", "type": "frontend", "main": "index.js", "vscodeExtension": { "contributes": { "languages": [{ "icon": { "light": "../../outside.svg", "dark": "icons/dark.svg" } }] } } }),
        ] {
            assert!(validate_manifest_contract(&manifest).is_err());
        }
    }

    #[test]
    fn enforces_catalog_runtime_entry_and_javascript_ownership_rules() {
        let hybrid_error = validate_manifest_contract(&json!({
            "id": "demo",
            "type": "hybrid",
            "main": "dist/index.js"
        }))
        .unwrap_err();
        assert!(hybrid_error.contains("pythonMain"));

        let python_error = validate_manifest_contract(&json!({
            "id": "demo",
            "type": "python",
            "pythonMain": "main.py",
            "main": "dist/index.js",
            "sessionImporters": [{ "entry": "dist/importer.js" }]
        }))
        .unwrap_err();
        assert!(python_error.contains("type python"));

        let wasm_error = validate_manifest_contract(&json!({
            "id": "demo",
            "type": "wasm",
            "wasmMain": "plugin.wasm",
            "contextPanels": [{ "entry": "dist/panel.js" }]
        }))
        .unwrap_err();
        assert!(wasm_error.contains("type wasm"));

        for field in ["ocrProviders", "aiProviders"] {
            let mut manifest = json!({
                "id": "demo",
                "type": "python",
                "pythonMain": "main.py"
            });
            manifest[field] = json!([{ "entry": "dist/provider.js" }]);
            assert!(validate_manifest_contract(&manifest)
                .unwrap_err()
                .contains("type python"));
        }

        validate_manifest_contract(&json!({
            "id": "demo",
            "type": "vscode-extension",
            "themes": [{ "vscodeJsonPath": "themes/dark.json" }]
        }))
        .unwrap();
        assert!(
            validate_manifest_contract(&json!({ "id": "demo", "type": "vscode-extension" }))
                .unwrap_err()
                .contains("requires at least one")
        );

        for contribution in [
            json!({ "protocolAdapters": [{ "spec": { "kind": "declarative" } }] }),
            json!({ "webviews": [{ "html": "<p>safe inline view</p>" }] }),
        ] {
            let mut manifest = json!({
                "id": "python-declarative",
                "type": "python",
                "pythonMain": "main.py"
            });
            manifest
                .as_object_mut()
                .unwrap()
                .extend(contribution.as_object().unwrap().clone());
            validate_manifest_contract(&manifest).unwrap();
        }

        for contribution in [
            json!({ "protocolAdapters": [{ "spec": { "kind": "code" }, "entry": "dist/adapter.js" }] }),
            json!({ "webviews": [{ "entry": "dist/view.js" }] }),
            json!({ "connectors": [{ "id": "mail" }] }),
        ] {
            let mut manifest = json!({
                "id": "python-executable",
                "type": "python",
                "pythonMain": "main.py"
            });
            manifest
                .as_object_mut()
                .unwrap()
                .extend(contribution.as_object().unwrap().clone());
            assert!(validate_manifest_contract(&manifest)
                .unwrap_err()
                .contains("type python"));
        }
    }

    #[test]
    fn accepts_known_capabilities_at_the_catalog_minimum() {
        validate_manifest_contract(&json!({
            "id": "demo",
            "type": "hybrid",
            "permissions": ["network:fetch"],
            "main": "dist/index.js",
            "pythonMain": "main.py",
            "contextPanels": [{ "entry": "dist/panel.js" }],
            "capabilities": ["tools", "context-panel"],
            "engines": { "cognia": ">=0.1.0" }
        }))
        .unwrap();
    }

    #[test]
    fn resolves_every_declared_catalog_path_in_an_installed_tree() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("dist")).unwrap();
        std::fs::create_dir_all(root.path().join("prompts")).unwrap();
        std::fs::write(root.path().join("dist/index.js"), "export default {}").unwrap();
        std::fs::write(root.path().join("prompts/chat.md"), "prompt").unwrap();
        let manifest = json!({
            "main": "dist/index.js",
            "vscodeExtension": {
                "contributes": { "chatPromptFiles": [{ "path": "prompts/chat.md" }] }
            }
        });
        validate_existing_manifest_paths(root.path(), &manifest).unwrap();

        std::fs::remove_file(root.path().join("prompts/chat.md")).unwrap();
        assert!(validate_existing_manifest_paths(root.path(), &manifest)
            .unwrap_err()
            .contains("chatPromptFiles"));
    }

    #[test]
    fn existence_validation_accepts_runtime_entrypoint_sentinels() {
        let root = tempfile::tempdir().unwrap();
        validate_existing_manifest_paths(
            root.path(),
            &json!({ "runtimeCompatibility": { "tauri": { "entrypoint": "node" } } }),
        )
        .unwrap();
    }
}
