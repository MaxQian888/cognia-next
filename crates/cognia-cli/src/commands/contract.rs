//! Read-only access to the canonical Cognia plugin contract catalog.

use std::collections::HashSet;

use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};

use crate::engine::contract::AUTHORING_CATALOG_JSON;
use crate::shared::JsonFailureExit;
use crate::ui::RuntimeUi;

const REPORT_SCHEMA_VERSION: u32 = 2;

#[derive(Default)]
pub(crate) struct ContractFilters {
    pub(crate) capabilities: Vec<String>,
    pub(crate) contributions: Vec<String>,
    pub(crate) plugin_types: Vec<String>,
    pub(crate) points: Vec<String>,
    pub(crate) point_kinds: Vec<String>,
    pub(crate) permissions: Vec<String>,
}

pub(crate) fn run(
    filters: ContractFilters,
    json_output: bool,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let catalog: Value = serde_json::from_str(AUTHORING_CATALOG_JSON)
        .context("embedded plugin contract catalog is invalid")?;
    let report = match build_report(&catalog, filters) {
        Ok(report) => report,
        Err(error) if json_output => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "schemaVersion": REPORT_SCHEMA_VERSION,
                    "ok": false,
                    "action": "contract",
                    "stage": "input",
                    "error": error,
                }))?
            );
            return Err(JsonFailureExit.into());
        }
        Err(error) => bail!(error),
    };

    if json_output {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else if !ui.flags.quiet {
        print_human(&report);
    }
    Ok(())
}

fn build_report(
    catalog: &Value,
    filters: ContractFilters,
) -> std::result::Result<Value, String> {
    let capability_filters = unique(filters.capabilities);
    let contribution_filters = unique(filters.contributions);
    let plugin_type_filters = unique(filters.plugin_types);
    let point_filters = unique(filters.points);
    let point_kind_filters = unique(filters.point_kinds);
    let permission_filters = unique(filters.permissions);

    let all_plugin_types = string_array(catalog, "pluginTypes")?;
    let all_capabilities = object_array(catalog, "capabilities")?;
    let all_contributions = object_array(catalog, "manifestContributions")?;
    let all_permissions = string_array(catalog, "permissions")?;
    let all_path_fields = object_array(catalog, "pathFields")?;
    let all_plugin_points = object_array(catalog, "pluginPoints")?;
    let all_runtime_entries = catalog
        .get("runtimeEntries")
        .and_then(Value::as_object)
        .ok_or_else(|| "catalog.runtimeEntries must be an object".to_string())?;

    validate_filters(
        "capability",
        &capability_filters,
        all_capabilities.iter().filter_map(|item| field(item, "id")),
    )?;
    validate_filters(
        "contribution",
        &contribution_filters,
        all_contributions
            .iter()
            .filter_map(|item| field(item, "field")),
    )?;
    validate_filters(
        "plugin type",
        &plugin_type_filters,
        all_plugin_types.iter().copied(),
    )?;
    validate_filters(
        "plugin point",
        &point_filters,
        all_plugin_points.iter().filter_map(|item| field(item, "id")),
    )?;
    validate_filters(
        "plugin point kind",
        &point_kind_filters,
        all_plugin_points.iter().filter_map(|item| field(item, "kind")),
    )?;
    validate_filters(
        "permission",
        &permission_filters,
        all_permissions.iter().copied(),
    )?;

    let capability_filter_set: HashSet<&str> =
        capability_filters.iter().map(String::as_str).collect();
    let contribution_filter_set: HashSet<&str> =
        contribution_filters.iter().map(String::as_str).collect();
    let plugin_type_filter_set: HashSet<&str> =
        plugin_type_filters.iter().map(String::as_str).collect();
    let point_filter_set: HashSet<&str> = point_filters.iter().map(String::as_str).collect();
    let point_kind_filter_set: HashSet<&str> =
        point_kind_filters.iter().map(String::as_str).collect();
    let permission_filter_set: HashSet<&str> =
        permission_filters.iter().map(String::as_str).collect();

    let related_capabilities: HashSet<&str> = all_contributions
        .iter()
        .filter(|item| {
            field(item, "field").is_some_and(|name| contribution_filter_set.contains(name))
        })
        .flat_map(|item| contribution_capabilities(item))
        .collect();

    let filter_contract_records =
        !capability_filter_set.is_empty() || !contribution_filter_set.is_empty();
    let selected_capabilities: Vec<Value> = all_capabilities
        .iter()
        .filter(|item| {
            !filter_contract_records
                || field(item, "id").is_some_and(|id| {
                    capability_filter_set.contains(id) || related_capabilities.contains(id)
                })
        })
        .map(|item| (*item).clone())
        .collect();
    let selected_contributions: Vec<Value> = all_contributions
        .iter()
        .filter(|item| {
            !filter_contract_records
                || field(item, "field").is_some_and(|name| contribution_filter_set.contains(name))
                || contribution_capabilities(item)
                    .any(|capability| capability_filter_set.contains(capability))
        })
        .map(|item| (*item).clone())
        .collect();
    let selected_plugin_types: Vec<&str> = all_plugin_types
        .iter()
        .copied()
        .filter(|plugin_type| {
            plugin_type_filter_set.is_empty() || plugin_type_filter_set.contains(plugin_type)
        })
        .collect();
    let selected_runtime_entries: Map<String, Value> = all_runtime_entries
        .iter()
        .filter(|(plugin_type, _)| {
            plugin_type_filter_set.is_empty()
                || plugin_type_filter_set.contains(plugin_type.as_str())
        })
        .map(|(plugin_type, contract)| (plugin_type.clone(), contract.clone()))
        .collect();
    let filter_point_records = !point_filter_set.is_empty() || !point_kind_filter_set.is_empty();
    let selected_plugin_points: Vec<Value> = all_plugin_points
        .iter()
        .filter(|item| {
            !filter_point_records
                || (point_filter_set.is_empty()
                    || field(item, "id").is_some_and(|id| point_filter_set.contains(id)))
                    && (point_kind_filter_set.is_empty()
                        || field(item, "kind")
                            .is_some_and(|kind| point_kind_filter_set.contains(kind)))
        })
        .map(|item| (*item).clone())
        .collect();
    let selected_permissions: Vec<&str> = all_permissions
        .iter()
        .copied()
        .filter(|permission| {
            permission_filter_set.is_empty() || permission_filter_set.contains(permission)
        })
        .collect();

    let catalog_counts = json!({
        "pluginTypes": all_plugin_types.len(),
        "capabilities": all_capabilities.len(),
        "manifestContributions": all_contributions.len(),
        "permissions": all_permissions.len(),
        "runtimeEntries": all_runtime_entries.len(),
        "pathFields": all_path_fields.len(),
        "pluginPoints": all_plugin_points.len(),
    });
    let selection_counts = json!({
        "pluginTypes": selected_plugin_types.len(),
        "capabilities": selected_capabilities.len(),
        "manifestContributions": selected_contributions.len(),
        "permissions": selected_permissions.len(),
        "runtimeEntries": selected_runtime_entries.len(),
        "pathFields": all_path_fields.len(),
        "pluginPoints": selected_plugin_points.len(),
    });

    Ok(json!({
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "ok": true,
        "action": "contract",
        "catalogSchemaVersion": catalog.get("schemaVersion").cloned().unwrap_or(Value::Null),
        "pluginPointSchemaVersion": catalog.get("pluginPointSchemaVersion").cloned().unwrap_or(Value::Null),
        "minimumHostVersion": catalog.get("minimumHostVersion").cloned().unwrap_or(Value::Null),
        "filters": {
            "capabilities": capability_filters,
            "manifestContributions": contribution_filters,
            "pluginTypes": plugin_type_filters,
            "pluginPoints": point_filters,
            "pluginPointKinds": point_kind_filters,
            "permissions": permission_filters,
        },
        "catalogCounts": catalog_counts,
        "selectionCounts": selection_counts,
        "pluginTypes": selected_plugin_types,
        "capabilities": selected_capabilities,
        "manifestContributions": selected_contributions,
        "permissions": selected_permissions,
        "runtimeEntries": selected_runtime_entries,
        "pathFields": all_path_fields,
        "pluginPoints": selected_plugin_points,
    }))
}

fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn string_array<'a>(catalog: &'a Value, key: &str) -> std::result::Result<Vec<&'a str>, String> {
    catalog
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("catalog.{key} must be an array"))?
        .iter()
        .map(|item| {
            item.as_str()
                .ok_or_else(|| format!("catalog.{key} entries must be strings"))
        })
        .collect()
}

fn object_array<'a>(catalog: &'a Value, key: &str) -> std::result::Result<Vec<&'a Value>, String> {
    let values = catalog
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("catalog.{key} must be an array"))?;
    if values.iter().any(|item| !item.is_object()) {
        return Err(format!("catalog.{key} entries must be objects"));
    }
    Ok(values.iter().collect())
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn contribution_capabilities(value: &Value) -> impl Iterator<Item = &str> {
    value
        .get("capabilities")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

fn validate_filters<'a>(
    selector: &str,
    filters: &[String],
    valid: impl Iterator<Item = &'a str>,
) -> std::result::Result<(), String> {
    let valid: HashSet<&str> = valid.collect();
    if let Some(unknown) = filters
        .iter()
        .find(|candidate| !valid.contains(candidate.as_str()))
    {
        return Err(format!("unknown {selector} `{unknown}`"));
    }
    Ok(())
}

fn print_human(report: &Value) {
    println!(
        "Cognia plugin contract (catalog schema {}, minimum host {})",
        report["catalogSchemaVersion"], report["minimumHostVersion"]
    );
    print_array("Plugin types", &report["pluginTypes"]);
    print_array("Capabilities", &report["capabilities"]);
    print_array("Manifest contributions", &report["manifestContributions"]);
    print_array("Permissions", &report["permissions"]);
    println!("Runtime entries:");
    if let Some(entries) = report["runtimeEntries"].as_object() {
        for (plugin_type, contract) in entries {
            println!("  {plugin_type}: {contract}");
        }
    }
    print_array("Path fields", &report["pathFields"]);
    print_array("Plugin points", &report["pluginPoints"]);
}

fn print_array(label: &str, value: &Value) {
    println!("{label}:");
    if let Some(items) = value.as_array() {
        for item in items {
            println!("  {item}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Value {
        serde_json::from_str(AUTHORING_CATALOG_JSON).unwrap()
    }

    #[test]
    fn unfiltered_report_preserves_every_catalog_record() {
        let catalog = catalog();
        let report = build_report(&catalog, ContractFilters::default()).unwrap();

        assert_eq!(report["schemaVersion"], 2);
        assert_eq!(report["catalogCounts"], report["selectionCounts"]);
        assert_eq!(report["capabilities"], catalog["capabilities"]);
        assert_eq!(
            report["manifestContributions"],
            catalog["manifestContributions"]
        );
        assert_eq!(report["permissions"], catalog["permissions"]);
        assert_eq!(report["runtimeEntries"], catalog["runtimeEntries"]);
        assert_eq!(report["pathFields"], catalog["pathFields"]);
        assert_eq!(report["pluginPoints"], catalog["pluginPoints"]);
    }

    #[test]
    fn contribution_filter_includes_its_required_capabilities() {
        let report = build_report(
            &catalog(),
            ContractFilters {
                contributions: vec!["contextPanels".into()],
                plugin_types: vec!["hybrid".into()],
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(report["pluginTypes"], json!(["hybrid"]));
        assert_eq!(report["capabilities"][0]["id"], "context-panel");
        assert_eq!(report["manifestContributions"][0]["field"], "contextPanels");
    }

    #[test]
    fn unknown_selector_is_rejected() {
        let error = build_report(
            &catalog(),
            ContractFilters {
                capabilities: vec!["not-a-capability".into()],
                ..Default::default()
            },
        )
        .unwrap_err();

        assert_eq!(error, "unknown capability `not-a-capability`");
    }

    #[test]
    fn point_kind_and_permission_filters_select_authoring_records() {
        let report = build_report(
            &catalog(),
            ContractFilters {
                points: vec!["chat.input.actions".into()],
                point_kinds: vec!["ui-slot".into()],
                permissions: vec!["extension:ui".into()],
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(report["schemaVersion"], 2);
        assert_eq!(report["pluginPointSchemaVersion"], 1);
        assert_eq!(report["selectionCounts"]["pluginPoints"], 1);
        assert_eq!(report["selectionCounts"]["permissions"], 1);
        assert_eq!(report["pluginPoints"][0]["id"], "chat.input.actions");
        assert_eq!(report["pluginPoints"][0]["formFactor"], "row");
        assert_eq!(report["permissions"], json!(["extension:ui"]));
    }

    #[test]
    fn every_new_selector_rejects_unknown_values() {
        let cases = [
            (
                ContractFilters {
                    points: vec!["missing.point".into()],
                    ..Default::default()
                },
                "unknown plugin point `missing.point`",
            ),
            (
                ContractFilters {
                    point_kinds: vec!["missing-kind".into()],
                    ..Default::default()
                },
                "unknown plugin point kind `missing-kind`",
            ),
            (
                ContractFilters {
                    permissions: vec!["missing:permission".into()],
                    ..Default::default()
                },
                "unknown permission `missing:permission`",
            ),
        ];

        for (filters, expected) in cases {
            assert_eq!(build_report(&catalog(), filters).unwrap_err(), expected);
        }
    }

    #[test]
    fn future_catalog_records_flow_into_the_report_without_command_changes() {
        let mut catalog = catalog();
        catalog["pluginTypes"]
            .as_array_mut()
            .unwrap()
            .push(json!("future-runtime"));
        catalog["capabilities"].as_array_mut().unwrap().push(json!({
            "id": "future-capability",
            "support": "experimental",
            "manifestFields": ["futureEntries"],
            "introducedIn": "9.0.0",
            "minimumHostVersion": "9.0.0"
        }));
        catalog["manifestContributions"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "field": "futureEntries",
                "capabilities": ["future-capability"],
                "execution": "javascript",
                "entryPath": "futureEntries[].entry"
            }));
        catalog["permissions"]
            .as_array_mut()
            .unwrap()
            .push(json!("future:permission"));
        catalog["runtimeEntries"].as_object_mut().unwrap().insert(
            "future-runtime".into(),
            json!({
                "required": ["futureMain"],
                "javascriptEntry": "futureMain",
                "javascriptEntryRequiredForContributions": true
            }),
        );
        catalog["pathFields"].as_array_mut().unwrap().push(json!({
            "path": "futureMain",
            "runtime": "javascript",
            "requiredFor": ["future-runtime"],
            "executable": true
        }));
        catalog["pluginPoints"].as_array_mut().unwrap().push(json!({
            "id": "future.authoring-point",
            "kind": "runtime",
            "stability": "experimental",
            "status": "implemented",
            "introducedIn": "9.0.0",
            "permission": "future:permission"
        }));

        let report = build_report(&catalog, ContractFilters::default()).unwrap();
        assert_eq!(report["catalogCounts"], report["selectionCounts"]);
        assert!(report["pluginTypes"]
            .as_array()
            .unwrap()
            .contains(&json!("future-runtime")));
        assert!(report["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["id"] == "future-capability"));
        assert!(report["manifestContributions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["field"] == "futureEntries"));
        assert!(report["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("future:permission")));
        assert!(report["runtimeEntries"].get("future-runtime").is_some());
        assert!(report["pathFields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["path"] == "futureMain"));
        assert!(report["pluginPoints"]
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["id"] == "future.authoring-point"));
    }
}
