//! Manifest validation rules — the Rust port of
//! `lib/plugin/core/validation.ts::validatePluginManifest`. `validate_manifest`
//! is the single public entry; every `validate_*` / `check_*` sub-validator and
//! helper below is private to this module and reached only through it.

use serde_json::Value;

use super::report::{Diagnostic, Severity};
use crate::engine::contract::{
    CAPABILITY_FIELDS, CAPABILITY_MINIMUM_HOST_VERSIONS, MANIFEST_CONTRIBUTIONS,
    PLUGIN_PATH_FIELDS, RUNTIME_ENTRY_CONTRACTS, VALID_CAPABILITIES, VALID_PERMISSIONS,
    VALID_PLUGIN_TYPES,
};

// ─────────────────────────────────────────────────────────────────────────────
// Validation core
// ─────────────────────────────────────────────────────────────────────────────

/// Validate a parsed manifest. Mirrors validation.ts::validatePluginManifest
/// in the rules it enforces; the exhaustive sub-validators (configSchema,
/// dexie migrations, i18n) are scoped to the most common foot-guns to
/// keep this CLI side surface lean.
pub fn validate_manifest(manifest: &Value) -> Vec<Diagnostic> {
    let mut out = Vec::<Diagnostic>::new();
    let obj = match manifest.as_object() {
        Some(o) => o,
        None => {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: "$".into(),
                code: "manifest.invalid_type".into(),
                message: "Manifest must be a JSON object".into(),
                hint: None,
            });
            return out;
        }
    };

    // ── Required string fields ──────────────────────────────────────────
    require_string(obj, "id", "manifest.id.missing", &mut out);
    if let Some(id) = obj.get("id").and_then(Value::as_str) {
        if !is_valid_id(id) {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: "id".into(),
                code: "manifest.id.invalid_format".into(),
                message: format!(
                    "Invalid plugin ID \"{id}\". Must be lowercase alphanumeric with hyphens/underscores/dots, start with alphanumeric, end with alphanumeric"
                ),
                hint: Some("Example: `my-plugin`, `com.example.foo`.".into()),
            });
        }
    }

    require_string(obj, "name", "manifest.name.missing", &mut out);
    if let Some(name) = obj.get("name").and_then(Value::as_str) {
        if name.chars().count() > 50 {
            out.push(Diagnostic {
                severity: Severity::Warning,
                field: "name".into(),
                code: "manifest.name.long".into(),
                message: "Plugin name exceeds 50 characters".into(),
                hint: None,
            });
        }
    }

    require_string(obj, "version", "manifest.version.missing", &mut out);
    if let Some(version) = obj.get("version").and_then(Value::as_str) {
        if !is_valid_version(version) {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: "version".into(),
                code: "manifest.version.invalid_format".into(),
                message: format!(
                    "Invalid version \"{version}\". Must be semver MAJOR.MINOR.PATCH with optional `-prerelease`"
                ),
                hint: None,
            });
        }
    }

    require_string(obj, "description", "manifest.description.missing", &mut out);
    if let Some(desc) = obj.get("description").and_then(Value::as_str) {
        if desc.chars().count() > 500 {
            out.push(Diagnostic {
                severity: Severity::Warning,
                field: "description".into(),
                code: "manifest.description.long".into(),
                message: "Plugin description exceeds 500 characters".into(),
                hint: None,
            });
        }
    }

    // ── type ────────────────────────────────────────────────────────────
    require_string(obj, "type", "manifest.type.missing", &mut out);
    let plugin_type = obj.get("type").and_then(Value::as_str);
    if let Some(t) = plugin_type {
        if !VALID_PLUGIN_TYPES.contains(&t) {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: "type".into(),
                code: "manifest.type.invalid".into(),
                message: format!(
                    "Invalid plugin type \"{t}\". Must be one of: {}",
                    VALID_PLUGIN_TYPES.join(", ")
                ),
                hint: None,
            });
        }
    }

    // ── capabilities ────────────────────────────────────────────────────
    match obj.get("capabilities") {
        None => out.push(Diagnostic {
            severity: Severity::Error,
            field: "capabilities".into(),
            code: "manifest.capabilities.missing".into(),
            message: "Missing \"capabilities\" field".into(),
            hint: Some("Set to `[]` if your plugin contributes nothing yet.".into()),
        }),
        Some(v) if !v.is_array() => out.push(Diagnostic {
            severity: Severity::Error,
            field: "capabilities".into(),
            code: "manifest.capabilities.invalid_type".into(),
            message: "\"capabilities\" must be an array".into(),
            hint: None,
        }),
        Some(Value::Array(arr)) => {
            for cap in arr {
                if let Some(s) = cap.as_str() {
                    if !VALID_CAPABILITIES.contains(&s) {
                        out.push(Diagnostic {
                            severity: Severity::Error,
                            field: "capabilities".into(),
                            code: "manifest.capabilities.invalid".into(),
                            message: format!(
                                "Invalid capability \"{s}\". Must be one of: {}",
                                VALID_CAPABILITIES.join(", ")
                            ),
                            hint: None,
                        });
                    }
                } else {
                    out.push(Diagnostic {
                        severity: Severity::Error,
                        field: "capabilities".into(),
                        code: "manifest.capabilities.invalid_item".into(),
                        message: "Each capability must be a string".into(),
                        hint: None,
                    });
                }
            }
        }
        _ => {}
    }

    // ── capability ↔ field cross-check (parity with validation.ts) ──────
    let declared: Vec<&str> = obj
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if let Some(constraint) = obj
        .get("engines")
        .and_then(Value::as_object)
        .and_then(|engines| engines.get("cognia"))
        .and_then(Value::as_str)
    {
        let declared_minimum = extract_semver(constraint);
        if declared_minimum.is_none() {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: "engines.cognia".into(),
                code: "manifest.engines.cognia.invalid".into(),
                message: "engines.cognia must include a semantic version such as >=0.1.0".into(),
                hint: None,
            });
        } else {
            let required_minimum = declared
                .iter()
                .filter_map(|capability| {
                    CAPABILITY_MINIMUM_HOST_VERSIONS
                        .iter()
                        .find(|(id, _)| id == capability)
                        .and_then(|(_, version)| parse_semver(version))
                })
                .max()
                .unwrap_or([0, 0, 0]);
            if declared_minimum.is_some_and(|minimum| minimum < required_minimum) {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: "engines.cognia".into(),
                    code: "manifest.engines.cognia.capability_minimum".into(),
                    message: format!(
                        "engines.cognia is older than the minimum required by declared capabilities: {}.{}.{}",
                        required_minimum[0], required_minimum[1], required_minimum[2]
                    ),
                    hint: None,
                });
            }
        }
    }
    let is_populated_array = |field: &str| -> bool {
        match obj.get(field) {
            Some(Value::Array(a)) => !a.is_empty(),
            // `workflows` is an object block ({ nodes, triggers }), not an
            // array contribution — parity with validation.ts `hasField`.
            Some(Value::Object(block)) if field == "workflows" => {
                ["nodes", "triggers"].iter().any(|key| {
                    block
                        .get(*key)
                        .and_then(Value::as_array)
                        .map(|a| !a.is_empty())
                        .unwrap_or(false)
                })
            }
            _ => false,
        }
    };
    // declared-but-empty: capability tag present, no gating field populated.
    for (cap, fields) in CAPABILITY_FIELDS {
        if declared.contains(cap) && !fields.iter().any(|f| is_populated_array(f)) {
            out.push(Diagnostic {
                severity: Severity::Warning,
                field: "capabilities".into(),
                code: "manifest.capability.field_missing".into(),
                message: format!(
                    "Capability \"{cap}\" is declared but its contribution field(s) {} are empty.",
                    fields
                        .iter()
                        .map(|f| format!("\"{f}\""))
                        .collect::<Vec<_>>()
                        .join(" / ")
                ),
                hint: Some("Add the contribution entries, or drop the capability tag.".into()),
            });
        }
    }
    // populated-but-undeclared: field has entries, none of its caps declared.
    let mut seen_fields: Vec<&str> = Vec::new();
    for (_, fields) in CAPABILITY_FIELDS {
        for field in fields.iter() {
            if seen_fields.contains(field) {
                continue;
            }
            seen_fields.push(field);
            if !is_populated_array(field) {
                continue;
            }
            let caps: Vec<&str> = CAPABILITY_FIELDS
                .iter()
                .filter(|(_, fs)| fs.contains(field))
                .map(|(c, _)| *c)
                .collect();
            if !caps.iter().any(|c| declared.contains(c)) {
                out.push(Diagnostic {
                    severity: Severity::Warning,
                    field: "capabilities".into(),
                    code: "manifest.capability.field_undeclared".into(),
                    message: format!(
                        "Field \"{field}\" has entries but none of its capabilities ({}) is declared.",
                        caps.join(", ")
                    ),
                    hint: Some(format!("Add one of: {} to \"capabilities\".", caps.join(", "))),
                });
            }
        }
    }

    // ── type-specific entry points (canonical catalog) ─────────────────
    if let Some(plugin_type) = plugin_type {
        if let Some((_, required, _, _, required_any_of)) = RUNTIME_ENTRY_CONTRACTS
            .iter()
            .find(|(candidate, _, _, _, _)| *candidate == plugin_type)
        {
            for field in *required {
                require_string(obj, field, &format!("manifest.{field}.required"), &mut out);
            }
            if !required_any_of.is_empty()
                && !required_any_of.iter().any(|field| match obj.get(*field) {
                    Some(Value::String(value)) => !value.is_empty(),
                    Some(Value::Array(values)) => !values.is_empty(),
                    Some(Value::Object(values)) => !values.is_empty(),
                    _ => false,
                })
            {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: required_any_of[0].into(),
                    code: "manifest.runtime_entry.required_any_of".into(),
                    message: format!(
                        "Plugin type \"{plugin_type}\" requires at least one of: {}",
                        required_any_of.join(", ")
                    ),
                    hint: None,
                });
            }
        }
    }

    match plugin_type {
        Some("wasm") => {
            if let Some(wm) = obj.get("wasmMain").and_then(Value::as_str) {
                if !wm.to_lowercase().ends_with(".wasm") {
                    out.push(Diagnostic {
                        severity: Severity::Error,
                        field: "wasmMain".into(),
                        code: "manifest.wasmMain.invalid_extension".into(),
                        message: "\"wasmMain\" must point to a `.wasm` file".into(),
                        hint: None,
                    });
                }
            }
            validate_wasm_block(obj.get("wasm"), &mut out);
        }
        Some("vscode-extension") => {}
        _ => {}
    }

    // ── permissions (warn on unknown) ───────────────────────────────────
    if let Some(arr) = obj.get("permissions").and_then(Value::as_array) {
        for perm in arr {
            if let Some(p) = perm.as_str() {
                if !VALID_PERMISSIONS.contains(&p) {
                    out.push(Diagnostic {
                        severity: Severity::Warning,
                        field: "permissions".into(),
                        code: "manifest.permissions.unknown".into(),
                        message: format!("Unknown permission \"{p}\""),
                        hint: Some(format!(
                            "Use only documented permissions. Valid: {}",
                            VALID_PERMISSIONS.join(", ")
                        )),
                    });
                }
            }
        }
    }

    // ── activationEvents (each must be a string) ────────────────────────
    if let Some(value) = obj.get("activationEvents") {
        match value {
            Value::Array(arr) => {
                for (i, ev) in arr.iter().enumerate() {
                    if !ev.is_string() {
                        out.push(Diagnostic {
                            severity: Severity::Error,
                            field: format!("activationEvents[{i}]"),
                            code: "manifest.activationEvents.invalid_item".into(),
                            message: format!("Activation event at index {i} must be a string"),
                            hint: None,
                        });
                    }
                }
            }
            _ => out.push(Diagnostic {
                severity: Severity::Error,
                field: "activationEvents".into(),
                code: "manifest.activationEvents.invalid_type".into(),
                message: "\"activationEvents\" must be an array".into(),
                hint: None,
            }),
        }
    }

    // ── activateOnStartup (boolean) ─────────────────────────────────────
    if let Some(value) = obj.get("activateOnStartup") {
        if !value.is_boolean() {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: "activateOnStartup".into(),
                code: "manifest.activateOnStartup.invalid_type".into(),
                message: "\"activateOnStartup\" must be a boolean".into(),
                hint: None,
            });
        }
    }

    // ── tools[]: each must have name + description ──────────────────────
    if let Some(arr) = obj.get("tools").and_then(Value::as_array) {
        for (i, tool) in arr.iter().enumerate() {
            let to = match tool.as_object() {
                Some(o) => o,
                None => continue,
            };
            if !to.get("name").map(|v| v.is_string()).unwrap_or(false) {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("tools[{i}].name"),
                    code: "manifest.tools.name.missing".into(),
                    message: format!("Tool at index {i} missing \"name\" field"),
                    hint: None,
                });
            }
            if !to
                .get("description")
                .map(|v| v.is_string())
                .unwrap_or(false)
            {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("tools[{i}].description"),
                    code: "manifest.tools.description.missing".into(),
                    message: format!("Tool at index {i} missing \"description\" field"),
                    hint: None,
                });
            }
        }
    }

    // ── cliTools[]: declarative CLI wrappers (parity with validateCliTools
    //    in lib/plugin/core/validation.ts — keep rule-for-rule in lockstep) ─
    lint_cli_tools(obj, &mut out);

    // ── lazy-factory contribution fields: `entry` path safety ────────────
    lint_manifest_paths(obj, &mut out);

    // The backend a contribution entry executes on: an explicit per-entry
    // `backend` wins, otherwise it defaults from the plugin type — python
    // plugins default their contributions to python-backed, every other type
    // to JS. `hybrid` intentionally has no python default here so an omitted
    // backend resolves to JS (the explicit-backend rule for hybrid is enforced
    // separately in the TS validator).
    let default_backend = match plugin_type {
        Some("python") => "python",
        _ => "js",
    };
    // First field with at least one entry that genuinely needs a JS factory,
    // after per-entry python-backend opt-out. `pythonExecution == "supported" |
    // "experimental"` capabilities route python-backed entries through the
    // `plugin_python_call` seam instead of a JS module, so those entries never
    // demand a JS entry point. `unsupported` capabilities (React UI, config
    // component) stay JS-only regardless of the requested backend.
    let mut python_backed_experimental: Option<&str> = None;
    let populated_js_contribution = MANIFEST_CONTRIBUTIONS.iter().find_map(
        |(field, _, execution, entry_path, condition_path, condition_equals, python_execution)| {
            let entries: Vec<&Value> = match obj.get(*field) {
                Some(Value::Array(entries)) if !entries.is_empty() => entries.iter().collect(),
                Some(value @ Value::Object(_)) => vec![value],
                _ => return None,
            };
            let base_requires_javascript = |entry: &Value| -> bool {
                if *execution == "javascript" {
                    true
                } else if *execution == "conditional" {
                    condition_path.is_some_and(|path| {
                        let value = path
                            .split('.')
                            .try_fold(entry, |current, segment| current.get(segment));
                        match condition_equals {
                            Some(expected) => value.and_then(Value::as_str) == Some(*expected),
                            None => value.is_some_and(|value| match value {
                                Value::Null => false,
                                Value::String(value) => !value.is_empty(),
                                _ => true,
                            }),
                        }
                    })
                } else {
                    false
                }
            };
            let python_backable = *python_execution != "unsupported";
            let mut field_requires_javascript = false;
            for &entry in &entries {
                if !base_requires_javascript(entry) {
                    continue;
                }
                let backend = entry
                    .get("backend")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        // A declared JS module path is itself a declaration of
                        // JS intent — never silently ignore it on a python
                        // plugin by defaulting the backend to python.
                        entry_path
                            .and_then(|path| path.rsplit('.').next())
                            .and_then(|field| entry.get(field))
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                            .map(|_| "js")
                    })
                    .unwrap_or(default_backend);
                if python_backable && backend == "python" {
                    if *python_execution == "experimental" {
                        python_backed_experimental.get_or_insert(*field);
                    }
                    continue;
                }
                field_requires_javascript = true;
            }
            field_requires_javascript.then_some(*field)
        },
    );
    if let Some(field) = python_backed_experimental {
        out.push(Diagnostic {
            severity: Severity::Warning,
            field: field.into(),
            code: "manifest.contributions.python.experimental".into(),
            message: format!(
                "Python-backed \"{field}\" is experimental; its subprocess execution path may change"
            ),
            hint: Some(
                "Gate it behind a feature flag and verify end-to-end before relying on it.".into(),
            ),
        });
    }
    let runtime_entry_contract = plugin_type.and_then(|plugin_type| {
        RUNTIME_ENTRY_CONTRACTS
            .iter()
            .find(|(candidate, _, _, _, _)| *candidate == plugin_type)
    });
    if populated_js_contribution.is_some()
        && runtime_entry_contract
            .is_some_and(|(_, _, javascript_entry, _, _)| javascript_entry.is_none())
    {
        let is_python_only = plugin_type == Some("python");
        out.push(Diagnostic {
            severity: Severity::Error,
            field: populated_js_contribution.unwrap().into(),
            code: if is_python_only {
                "manifest.contributions.javascript.unsupported_for_python"
            } else {
                "manifest.contributions.javascript.unsupported_for_plugin_type"
            }
            .into(),
            message: format!(
                "Plugin type \"{}\" cannot declare JavaScript-executed contributions",
                plugin_type.unwrap_or("unknown")
            ),
            hint: Some(if is_python_only {
                "Change the plugin type to \"hybrid\" and add \"main\", or remove those contributions."
                    .into()
            } else {
                "Use a JavaScript-capable plugin type, or remove those contributions.".into()
            }),
        });
    } else if let (Some(plugin_type), Some(_)) = (plugin_type, populated_js_contribution) {
        if let Some((_, _, Some(javascript_entry), true, _)) = RUNTIME_ENTRY_CONTRACTS
            .iter()
            .find(|(candidate, _, _, _, _)| *candidate == plugin_type)
        {
            if obj.get(*javascript_entry).and_then(Value::as_str).is_none() {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: (*javascript_entry).into(),
                    code: format!(
                        "manifest.{javascript_entry}.required_for_js_contributions"
                    ),
                    message: format!(
                        "JavaScript-executed contributions require a relative \"{javascript_entry}\" entry point"
                    ),
                    hint: Some(format!(
                        "Add \"{javascript_entry}\", or remove JavaScript-executed contributions."
                    )),
                });
            }
        }
    }

    // ── commands[]: each must have id + name ────────────────────────────
    if let Some(arr) = obj.get("commands").and_then(Value::as_array) {
        for (i, cmd) in arr.iter().enumerate() {
            let co = match cmd.as_object() {
                Some(o) => o,
                None => continue,
            };
            if !co.get("id").map(|v| v.is_string()).unwrap_or(false) {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("commands[{i}].id"),
                    code: "manifest.commands.id.missing".into(),
                    message: format!("Command at index {i} missing \"id\" field"),
                    hint: None,
                });
            }
            if !co.get("name").map(|v| v.is_string()).unwrap_or(false) {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("commands[{i}].name"),
                    code: "manifest.commands.name.missing".into(),
                    message: format!("Command at index {i} missing \"name\" field"),
                    hint: None,
                });
            }
        }
    }

    // ── modes[]: id + name + icon required ──────────────────────────────
    if let Some(arr) = obj.get("modes").and_then(Value::as_array) {
        for (i, mode) in arr.iter().enumerate() {
            let mo = match mode.as_object() {
                Some(o) => o,
                None => continue,
            };
            for required in ["id", "name", "icon"] {
                if !mo.get(required).map(|v| v.is_string()).unwrap_or(false) {
                    out.push(Diagnostic {
                        severity: Severity::Error,
                        field: format!("modes[{i}].{required}"),
                        code: format!("manifest.modes.{required}.missing"),
                        message: format!("Mode at index {i} missing \"{required}\" field"),
                        hint: None,
                    });
                }
            }
        }
    }

    // ── minAppVersion semver ────────────────────────────────────────────
    if let Some(v) = obj.get("minAppVersion") {
        match v.as_str() {
            Some(s) if !is_valid_version(s) => out.push(Diagnostic {
                severity: Severity::Error,
                field: "minAppVersion".into(),
                code: "manifest.minAppVersion.invalid".into(),
                message: format!("Invalid \"minAppVersion\" \"{s}\". Must be semver"),
                hint: None,
            }),
            None => out.push(Diagnostic {
                severity: Severity::Error,
                field: "minAppVersion".into(),
                code: "manifest.minAppVersion.invalid".into(),
                message: "\"minAppVersion\" must be a string".into(),
                hint: None,
            }),
            _ => {}
        }
    }

    // ── dexie block: minimal sanity (full migration walk lives host-side)
    if let Some(dexie) = obj.get("dexie") {
        validate_dexie_block(dexie, &mut out);
    }

    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-validators
// ─────────────────────────────────────────────────────────────────────────────

fn validate_wasm_block(block: Option<&Value>, out: &mut Vec<Diagnostic>) {
    let block = match block {
        Some(Value::Object(o)) => o,
        Some(_) => {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: "wasm".into(),
                code: "manifest.wasm.invalid_type".into(),
                message: "\"wasm\" must be an object".into(),
                hint: None,
            });
            return;
        }
        None => {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: "wasm".into(),
                code: "manifest.wasm.required".into(),
                message: "WASM plugin must declare a \"wasm\" block with at least `apiVersion`"
                    .into(),
                hint: Some("Example: `\"wasm\": { \"apiVersion\": \"0.1.0\" }`.".into()),
            });
            return;
        }
    };
    match block.get("apiVersion").and_then(Value::as_str) {
        Some(v) if is_wasm_api_version(v) => {}
        _ => out.push(Diagnostic {
            severity: Severity::Error,
            field: "wasm.apiVersion".into(),
            code: "manifest.wasm.apiVersion.invalid".into(),
            message: "WASM `apiVersion` must be semver MAJOR.MINOR.PATCH (e.g. \"0.1.0\")".into(),
            hint: None,
        }),
    }
    if let Some(mem) = block.get("memoryLimitMb") {
        match mem.as_f64() {
            Some(n) if n > 0.0 && n <= 4096.0 => {}
            _ => out.push(Diagnostic {
                severity: Severity::Error,
                field: "wasm.memoryLimitMb".into(),
                code: "manifest.wasm.memoryLimitMb.invalid".into(),
                message: "WASM `memoryLimitMb` must be a positive number ≤ 4096".into(),
                hint: None,
            }),
        }
    }
    if let Some(t) = block.get("callTimeoutMs") {
        match t.as_f64() {
            Some(n) if n > 0.0 && n <= 600_000.0 => {}
            _ => out.push(Diagnostic {
                severity: Severity::Error,
                field: "wasm.callTimeoutMs".into(),
                code: "manifest.wasm.callTimeoutMs.invalid".into(),
                message: "WASM `callTimeoutMs` must be a positive number ≤ 600000 (10 min)".into(),
                hint: None,
            }),
        }
    }
}

fn validate_dexie_block(block: &Value, out: &mut Vec<Diagnostic>) {
    let obj = match block.as_object() {
        Some(o) => o,
        None => {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: "dexie".into(),
                code: "manifest.dexie.invalid_type".into(),
                message: "\"dexie\" must be an object if provided".into(),
                hint: None,
            });
            return;
        }
    };
    let tables = match obj.get("tables") {
        Some(Value::Array(arr)) => arr,
        _ => {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: "dexie.tables".into(),
                code: "manifest.dexie.tables.missing".into(),
                message: "\"dexie.tables\" must be an array".into(),
                hint: None,
            });
            return;
        }
    };
    if tables.is_empty() {
        out.push(Diagnostic {
            severity: Severity::Error,
            field: "dexie.tables".into(),
            code: "manifest.dexie.tables.empty".into(),
            message: "\"dexie.tables\" must not be empty".into(),
            hint: None,
        });
    }
    if tables.len() > 20 {
        out.push(Diagnostic {
            severity: Severity::Error,
            field: "dexie.tables".into(),
            code: "manifest.dexie.tables.tooMany".into(),
            message: "\"dexie.tables\" exceeds the maximum of 20".into(),
            hint: None,
        });
    }
    let mut seen = std::collections::HashSet::<String>::new();
    for (i, t) in tables.iter().enumerate() {
        let to = match t.as_object() {
            Some(o) => o,
            None => {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("dexie.tables[{i}]"),
                    code: "manifest.dexie.tables.invalid_item".into(),
                    message: format!("Table at index {i} must be an object"),
                    hint: None,
                });
                continue;
            }
        };
        let name = to.get("name").and_then(Value::as_str);
        match name {
            Some(n) if is_valid_dexie_table_name(n) => {
                if !seen.insert(n.to_string()) {
                    out.push(Diagnostic {
                        severity: Severity::Error,
                        field: format!("dexie.tables[{i}].name"),
                        code: "manifest.dexie.tables.duplicate".into(),
                        message: format!("Duplicate table name \"{n}\""),
                        hint: None,
                    });
                }
            }
            _ => out.push(Diagnostic {
                severity: Severity::Error,
                field: format!("dexie.tables[{i}].name"),
                code: "manifest.dexie.tables.nameInvalid".into(),
                message: format!(
                    "Table name at index {i} is invalid: must match ^[a-z][a-zA-Z0-9_]{{0,30}}$"
                ),
                hint: None,
            }),
        }
        match to.get("schema").and_then(Value::as_str) {
            Some(s) if !s.trim().is_empty() => {}
            _ => out.push(Diagnostic {
                severity: Severity::Error,
                field: format!("dexie.tables[{i}].schema"),
                code: "manifest.dexie.tables.schemaInvalid".into(),
                message: format!("Table at index {i} missing or empty \"schema\""),
                hint: None,
            }),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Parity arm for `validateCliTools` in `lib/plugin/core/validation.ts` —
/// the structural rules the executor's safety model relies on. Keep
/// rule-for-rule in lockstep with the TS validator.
fn lint_cli_tools(obj: &serde_json::Map<String, Value>, out: &mut Vec<Diagnostic>) {
    let Some(cli_tools) = obj.get("cliTools") else {
        return;
    };
    let Some(arr) = cli_tools.as_array() else {
        out.push(Diagnostic {
            severity: Severity::Error,
            field: "cliTools".into(),
            code: "manifest.cliTools.invalid".into(),
            message: "\"cliTools\" must be an array".into(),
            hint: None,
        });
        return;
    };

    let has_cli_execute = obj
        .get("permissions")
        .and_then(Value::as_array)
        .map(|perms| perms.iter().any(|p| p.as_str() == Some("cli:execute")))
        .unwrap_or(false);
    if !arr.is_empty() && !has_cli_execute {
        out.push(Diagnostic {
            severity: Severity::Error,
            field: "permissions".into(),
            code: "manifest.cliTools.permission.missing".into(),
            message: "cliTools entries require the \"cli:execute\" permission".into(),
            hint: Some("Add \"cli:execute\" to \"permissions\".".into()),
        });
    }

    let required_binaries: Vec<&str> = obj
        .get("requires")
        .and_then(|r| r.get("binaries"))
        .and_then(Value::as_array)
        .map(|bins| {
            bins.iter()
                .filter_map(|b| b.get("name").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();

    let mut seen_names: Vec<&str> = Vec::new();

    for (i, entry) in arr.iter().enumerate() {
        let field = format!("cliTools[{i}]");
        let Some(tool) = entry.as_object() else {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: field.clone(),
                code: "manifest.cliTools.entry.invalid".into(),
                message: format!("{field} must be an object"),
                hint: None,
            });
            continue;
        };

        match tool.get("name").and_then(Value::as_str) {
            Some(name) if is_cli_tool_name(name) => {
                if seen_names.contains(&name) {
                    out.push(Diagnostic {
                        severity: Severity::Error,
                        field: format!("{field}.name"),
                        code: "manifest.cliTools.name.duplicate".into(),
                        message: format!("{field}.name \"{name}\" is declared more than once"),
                        hint: None,
                    });
                } else {
                    seen_names.push(name);
                }
            }
            _ => out.push(Diagnostic {
                severity: Severity::Error,
                field: format!("{field}.name"),
                code: "manifest.cliTools.name.invalid".into(),
                message: format!("{field}.name must be snake_case ([a-z][a-z0-9_]*)"),
                hint: None,
            }),
        }

        if !tool
            .get("description")
            .and_then(Value::as_str)
            .map(|d| !d.is_empty())
            .unwrap_or(false)
        {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: format!("{field}.description"),
                code: "manifest.cliTools.description.missing".into(),
                message: format!("{field} requires a non-empty \"description\" string"),
                hint: None,
            });
        }

        // parameters → declared param names (JSON-schema object form)
        let declared_params: Option<Vec<&str>> = cli_declared_params(tool.get("parameters"));
        if declared_params.is_none() {
            out.push(Diagnostic {
                severity: Severity::Error,
                field: format!("{field}.parameters"),
                code: "manifest.cliTools.parameters.invalid".into(),
                message: format!(
                    "{field}.parameters must be a JSON-schema object: {{\"type\":\"object\",\"properties\":{{…}}}}"
                ),
                hint: None,
            });
        }
        let has_param = |name: &str| {
            declared_params
                .as_ref()
                .map(|params| params.contains(&name))
                .unwrap_or(false)
        };

        // binary ref
        match tool.get("binary").and_then(Value::as_object) {
            None => out.push(Diagnostic {
                severity: Severity::Error,
                field: format!("{field}.binary"),
                code: "manifest.cliTools.binary.missing".into(),
                message: format!("{field} requires a \"binary\" reference object"),
                hint: None,
            }),
            Some(binary) => match binary.get("kind").and_then(Value::as_str) {
                Some("requires") => match binary.get("name").and_then(Value::as_str) {
                    Some(name) if !name.is_empty() => {
                        if !required_binaries.contains(&name) {
                            out.push(Diagnostic {
                                severity: Severity::Error,
                                field: format!("{field}.binary.name"),
                                code: "manifest.cliTools.binary.name.undeclared".into(),
                                message: format!(
                                    "{field}.binary.name \"{name}\" is not declared in requires.binaries"
                                ),
                                hint: Some(
                                    "Add the binary to manifest.requires.binaries so the install/enable chain can probe it.".into(),
                                ),
                            });
                        }
                    }
                    _ => out.push(Diagnostic {
                        severity: Severity::Error,
                        field: format!("{field}.binary.name"),
                        code: "manifest.cliTools.binary.name.missing".into(),
                        message: format!("{field}.binary requires a non-empty \"name\""),
                        hint: None,
                    }),
                },
                Some("plugin-dir") => {
                    let rel_ok = binary
                        .get("relPath")
                        .and_then(Value::as_str)
                        .map(|p| !cli_has_path_traversal(p))
                        .unwrap_or(false);
                    if !rel_ok {
                        out.push(Diagnostic {
                            severity: Severity::Error,
                            field: format!("{field}.binary.relPath"),
                            code: "manifest.cliTools.binary.relPath.invalid".into(),
                            message: format!(
                                "{field}.binary.relPath must be a relative path inside the plugin directory (no \"..\", no absolute paths)"
                            ),
                            hint: None,
                        });
                    }
                }
                _ => out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("{field}.binary.kind"),
                    code: "manifest.cliTools.binary.kind.invalid".into(),
                    message: format!("{field}.binary.kind must be \"requires\" or \"plugin-dir\""),
                    hint: None,
                }),
            },
        }

        // argv tokens
        match tool.get("argv").and_then(Value::as_array) {
            None => out.push(Diagnostic {
                severity: Severity::Error,
                field: format!("{field}.argv"),
                code: "manifest.cliTools.argv.missing".into(),
                message: format!("{field} requires an \"argv\" token array (may be empty)"),
                hint: None,
            }),
            Some(tokens) => {
                for (j, token) in tokens.iter().enumerate() {
                    let token_field = format!("{field}.argv[{j}]");
                    let Some(tk) = token.as_object() else {
                        out.push(Diagnostic {
                            severity: Severity::Error,
                            field: token_field.clone(),
                            code: "manifest.cliTools.argv.token.invalid".into(),
                            message: format!(
                                "{token_field} must be a {{ literal }} or {{ param }} object"
                            ),
                            hint: None,
                        });
                        continue;
                    };
                    let is_literal = tk.get("literal").map(Value::is_string).unwrap_or(false);
                    let is_param = tk.get("param").map(Value::is_string).unwrap_or(false);
                    if is_literal == is_param {
                        out.push(Diagnostic {
                            severity: Severity::Error,
                            field: token_field.clone(),
                            code: "manifest.cliTools.argv.token.invalid".into(),
                            message: format!(
                                "{token_field} must have exactly one of \"literal\" (string) or \"param\" (string)"
                            ),
                            hint: None,
                        });
                        continue;
                    }
                    if is_param {
                        let param = tk.get("param").and_then(Value::as_str).unwrap_or("");
                        if !has_param(param) {
                            out.push(Diagnostic {
                                severity: Severity::Error,
                                field: format!("{token_field}.param"),
                                code: "manifest.cliTools.argv.param.undeclared".into(),
                                message: format!(
                                    "{token_field} references undeclared parameter \"{param}\""
                                ),
                                hint: None,
                            });
                        }
                    }
                }
            }
        }

        // stdin.param must be declared
        if let Some(stdin) = tool.get("stdin") {
            let ok = stdin
                .get("param")
                .and_then(Value::as_str)
                .map(has_param)
                .unwrap_or(false);
            if !ok {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("{field}.stdin"),
                    code: "manifest.cliTools.stdin.invalid".into(),
                    message: format!(
                        "{field}.stdin must be {{ \"param\": <declared parameter name> }}"
                    ),
                    hint: None,
                });
            }
        }

        // cwd policy
        if let Some(cwd) = tool.get("cwd") {
            match cwd.get("kind").and_then(Value::as_str) {
                Some("plugin-dir") | Some("workspace") | Some("none") => {}
                Some("param") => {
                    let ok = cwd
                        .get("param")
                        .and_then(Value::as_str)
                        .map(has_param)
                        .unwrap_or(false);
                    if !ok {
                        out.push(Diagnostic {
                            severity: Severity::Error,
                            field: format!("{field}.cwd.param"),
                            code: "manifest.cliTools.cwd.param.undeclared".into(),
                            message: format!("{field}.cwd references an undeclared parameter"),
                            hint: None,
                        });
                    }
                }
                _ => out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("{field}.cwd"),
                    code: "manifest.cliTools.cwd.invalid".into(),
                    message: format!(
                        "{field}.cwd.kind must be one of: plugin-dir, workspace, param, none"
                    ),
                    hint: None,
                }),
            }
        }

        // env: flat string map
        if let Some(env) = tool.get("env") {
            let ok = env
                .as_object()
                .map(|map| map.values().all(Value::is_string))
                .unwrap_or(false);
            if !ok {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("{field}.env"),
                    code: "manifest.cliTools.env.invalid".into(),
                    message: format!("{field}.env must be a flat map of string values"),
                    hint: None,
                });
            }
        }

        // numeric knobs + outputParse + successExitCodes + versionArg
        if let Some(timeout) = tool.get("timeoutMs") {
            if !timeout.as_f64().map(|t| t > 0.0).unwrap_or(false) {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("{field}.timeoutMs"),
                    code: "manifest.cliTools.timeoutMs.invalid".into(),
                    message: format!("{field}.timeoutMs must be a positive number of milliseconds"),
                    hint: None,
                });
            }
        }
        if let Some(max) = tool.get("maxOutputBytes") {
            if !max.as_i64().map(|m| m > 0).unwrap_or(false) {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("{field}.maxOutputBytes"),
                    code: "manifest.cliTools.maxOutputBytes.invalid".into(),
                    message: format!("{field}.maxOutputBytes must be a positive integer"),
                    hint: None,
                });
            }
        }
        if let Some(parse) = tool.get("outputParse") {
            if !matches!(parse.as_str(), Some("text") | Some("json") | Some("lines")) {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("{field}.outputParse"),
                    code: "manifest.cliTools.outputParse.invalid".into(),
                    message: format!("{field}.outputParse must be one of: text, json, lines"),
                    hint: None,
                });
            }
        }
        if let Some(codes) = tool.get("successExitCodes") {
            let ok = codes
                .as_array()
                .map(|arr| arr.iter().all(|c| c.as_i64().is_some()))
                .unwrap_or(false);
            if !ok {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("{field}.successExitCodes"),
                    code: "manifest.cliTools.successExitCodes.invalid".into(),
                    message: format!("{field}.successExitCodes must be an array of integers"),
                    hint: None,
                });
            }
        }
        if let Some(version_arg) = tool.get("versionArg") {
            if !version_arg.is_string() {
                out.push(Diagnostic {
                    severity: Severity::Error,
                    field: format!("{field}.versionArg"),
                    code: "manifest.cliTools.versionArg.invalid".into(),
                    message: format!("{field}.versionArg must be a string"),
                    hint: None,
                });
            }
        }
    }
}

/// `[a-z][a-z0-9_]*` — same rule as the TS validator.
fn is_cli_tool_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Declared parameter names from the JSON-schema `parameters` object.
fn cli_declared_params(parameters: Option<&Value>) -> Option<Vec<&str>> {
    let schema = parameters?.as_object()?;
    if let Some(ty) = schema.get("type") {
        if ty.as_str() != Some("object") {
            return None;
        }
    }
    let properties = schema.get("properties")?.as_object()?;
    Some(properties.keys().map(String::as_str).collect())
}

/// Absolute paths and `..` segments can escape the plugin dir.
fn cli_has_path_traversal(rel_path: &str) -> bool {
    if rel_path.is_empty() || rel_path.starts_with('/') || rel_path.starts_with('\\') {
        return true;
    }
    let bytes = rel_path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    rel_path.split(['/', '\\']).any(|segment| segment == "..")
}

/// Reject every plugin-controlled path described by the generated catalog.
fn lint_manifest_paths(obj: &serde_json::Map<String, Value>, out: &mut Vec<Diagnostic>) {
    for descriptor in PLUGIN_PATH_FIELDS {
        if let Some((array_field, nested_path)) = descriptor.split_once("[].") {
            let Some(items) = obj.get(array_field).and_then(Value::as_array) else {
                continue;
            };
            for (index, item) in items.iter().enumerate() {
                let Some(entry) = value_at_path(item, nested_path).and_then(Value::as_str) else {
                    continue;
                };
                push_path_diagnostics(
                    entry,
                    format!("{array_field}[{index}].{nested_path}"),
                    format!("{array_field}.{nested_path}"),
                    out,
                );
            }
            continue;
        }

        let Some(entry) = value_at_path_from_object(obj, descriptor).and_then(Value::as_str) else {
            continue;
        };
        let code_path = if descriptor.contains('.') {
            (*descriptor).to_string()
        } else {
            format!("{descriptor}.entry")
        };
        push_path_diagnostics(entry, (*descriptor).to_string(), code_path, out);
    }
}

fn value_at_path_from_object<'a>(
    obj: &'a serde_json::Map<String, Value>,
    path: &str,
) -> Option<&'a Value> {
    let (first, rest) = path.split_once('.').unwrap_or((path, ""));
    let value = obj.get(first)?;
    if rest.is_empty() {
        Some(value)
    } else {
        value_at_path(value, rest)
    }
}

fn value_at_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

fn push_path_diagnostics(entry: &str, field: String, code_path: String, out: &mut Vec<Diagnostic>) {
    for code in lazy_factory_entry_violations(entry) {
        out.push(Diagnostic {
            severity: Severity::Error,
            field: field.clone(),
            code: format!("manifest.{code_path}.{code}"),
            message: lazy_factory_entry_message(code),
            hint: Some("Path must stay inside the plugin directory.".into()),
        });
    }
}

/// Mirrors the `LAZY_FACTORY_ENTRY_*` regexes in `validation.ts`. Returns the
/// TS code suffix(es) an `entry` violates, in the same check order
/// (`invalid_chars`, `absolute`, `traversal`); one path can trip several.
fn lazy_factory_entry_violations(entry: &str) -> Vec<&'static str> {
    let mut codes = Vec::new();
    let encoded = entry.to_ascii_lowercase();
    if entry.chars().any(|ch| ch.is_control())
        || encoded.contains("%2e")
        || encoded.contains("%2f")
        || encoded.contains("%5c")
    {
        codes.push("invalid_chars");
    }
    let bytes = entry.as_bytes();
    let has_scheme = entry.split_once(':').is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme.as_bytes()[0].is_ascii_alphabetic()
            && scheme
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
    });
    let absolute = entry.starts_with('/')
        || entry.starts_with('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || has_scheme;
    if absolute {
        codes.push("absolute");
    }
    // LAZY_FACTORY_ENTRY_TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/
    if entry.split(['/', '\\']).any(|seg| seg == "..") {
        codes.push("traversal");
    }
    codes
}

fn lazy_factory_entry_message(code: &str) -> String {
    match code {
        "invalid_chars" => "path contains unsafe or encoded characters".into(),
        "absolute" => "path must be relative (no root, drive, UNC path, or URI scheme)".into(),
        "traversal" => "\"entry\" must not contain \"..\" path segments".into(),
        _ => "invalid \"entry\" path".into(),
    }
}

fn require_string(
    obj: &serde_json::Map<String, Value>,
    field: &str,
    code: &str,
    out: &mut Vec<Diagnostic>,
) {
    match obj.get(field) {
        Some(v) if v.is_string() && !v.as_str().unwrap_or_default().trim().is_empty() => {}
        _ => out.push(Diagnostic {
            severity: Severity::Error,
            field: field.into(),
            code: code.into(),
            message: format!("Missing or invalid \"{field}\" field"),
            hint: None,
        }),
    }
}

/// `^[a-z0-9]([a-z0-9-_.]*[a-z0-9])?$` — mirrors validation.ts:89.
fn is_valid_id(id: &str) -> bool {
    if id.is_empty()
        || id.len() > 128
        || matches!(id, ".host-state" | "_marketplace_cache" | "_backups")
    {
        return false;
    }
    let bytes = id.as_bytes();
    let starts_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
    if !starts_ok {
        return false;
    }
    if id.len() == 1 {
        return true;
    }
    let ends_ok =
        bytes[bytes.len() - 1].is_ascii_lowercase() || bytes[bytes.len() - 1].is_ascii_digit();
    if !ends_ok {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_' || c == '.')
}

/// `^\d+\.\d+\.\d+(-[a-z0-9]+)?$` — case-insensitive (matches `i` flag in TS).
fn is_valid_version(s: &str) -> bool {
    let mut iter = s.splitn(2, '-');
    let head = iter.next().unwrap_or("");
    let tail = iter.next();
    let parts: Vec<&str> = head.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    if !parts
        .iter()
        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    if let Some(pre) = tail {
        if pre.is_empty() {
            return false;
        }
        if !pre.chars().all(|c| c.is_ascii_alphanumeric()) {
            return false;
        }
    }
    true
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

/// `^\d+\.\d+\.\d+$` — strict for WASM api version (no prerelease).
fn is_wasm_api_version(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// `^[a-z][a-zA-Z0-9_]{0,30}$` — mirrors isValidPluginTableName in
/// lib/plugin/dexie-namespace.ts.
fn is_valid_dexie_table_name(s: &str) -> bool {
    if s.is_empty() || s.len() > 31 {
        return false;
    }
    let mut chars = s.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_lowercase() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lazy_factory_entry_violations_match_ts_regexes() {
        let none: Vec<&str> = Vec::new();
        assert_eq!(lazy_factory_entry_violations("dist/index.js"), none);
        assert_eq!(
            lazy_factory_entry_violations("../secret"),
            vec!["traversal"]
        );
        assert_eq!(lazy_factory_entry_violations("a/../b"), vec!["traversal"]);
        assert_eq!(
            lazy_factory_entry_violations("/etc/shadow"),
            vec!["absolute"]
        );
        assert_eq!(lazy_factory_entry_violations("C:\\win"), vec!["absolute"]);
        assert_eq!(
            lazy_factory_entry_violations("C:drive-relative"),
            vec!["absolute"]
        );
        assert_eq!(
            lazy_factory_entry_violations("\\\\server\\share"),
            vec!["absolute"]
        );
        assert_eq!(
            lazy_factory_entry_violations("dist/%2e%2e/secret"),
            vec!["invalid_chars"]
        );
        assert_eq!(
            lazy_factory_entry_violations("has\0nul"),
            vec!["invalid_chars"]
        );
        // A path can trip several checks, in TS order.
        assert_eq!(
            lazy_factory_entry_violations("/foo/../bar"),
            vec!["absolute", "traversal"]
        );
        // `..foo` is not a `..` path segment.
        assert_eq!(lazy_factory_entry_violations("..foo/bar"), none);
    }
}
