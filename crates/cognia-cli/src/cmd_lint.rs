//! `cognia plugin lint` — validate `plugin.json` against the host's schema.
//!
//! Rust port of `lib/plugin/core/validation.ts::validatePluginManifest`.
//! Catches malformed manifests before they hit the host so authors get a
//! fast, local feedback loop. Returns exit 0 if no errors, 1 otherwise.
//!
//! `cognia plugin build` calls this implicitly before invoking the
//! per-type build path, so a single command suffices for the common
//! "validate + build" flow.

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::read_plugin_manifest;

// ─────────────────────────────────────────────────────────────────────────────
// Whitelist constants — keep in sync with lib/plugin/core/validation.ts
// ─────────────────────────────────────────────────────────────────────────────

/// 19 host-side permissions (validation.ts lines 62-82). Update if the
/// TS list changes; the duplicate is deliberate so the CLI can validate
/// offline without pulling the TS source.
const VALID_PERMISSIONS: &[&str] = &[
    "filesystem:read",
    "filesystem:write",
    "network:fetch",
    "network:websocket",
    "clipboard:read",
    "clipboard:write",
    "notification",
    "shell:execute",
    "process:spawn",
    "database:read",
    "database:write",
    "settings:read",
    "settings:write",
    "session:read",
    "session:write",
    "agent:control",
    "python:execute",
    "secrets:read",
    "secrets:write",
];

/// Canonical plugin capabilities (mirrors the type union in
/// types/plugin/plugin.ts plus the contracts list in
/// lib/plugin/contracts/plugin-capabilities.ts).
const VALID_CAPABILITIES: &[&str] = &[
    "tools",
    "native-anthropic-tool",
    "components",
    "modes",
    "skills",
    "media",
    "canvas",
    "ai-provider",
    "themes",
    "commands",
    "hooks",
    "processors",
    "providers",
    "exporters",
    "importers",
    "a2ui",
    "python",
    "scheduler",
    "external-agent-preset",
    "mcp-server-preset",
    "connectors",
    "workflow",
    "workflow-trigger",
    "tray",
];

const VALID_PLUGIN_TYPES: &[&str] =
    &["frontend", "python", "hybrid", "wasm", "vscode-extension"];

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub severity: Severity,
    pub field: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LintReport {
    pub manifest_path: PathBuf,
    pub valid: bool,
    pub diagnostics: Vec<Diagnostic>,
}

impl LintReport {
    pub fn error_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Error)
            .count()
    }

    pub fn warning_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Warning)
            .count()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

/// CLI entry: `cognia plugin lint`. Prints human-readable diagnostics by
/// default or JSON when `as_json` is true.
pub fn run(path: PathBuf, as_json: bool) -> Result<()> {
    let crate_root = path
        .canonicalize()
        .with_context(|| format!("resolve {}", path.display()))?;
    let (manifest, manifest_path) = read_plugin_manifest(&crate_root)?;
    let diagnostics = validate_manifest(&manifest);
    let report = LintReport {
        manifest_path,
        valid: !diagnostics.iter().any(|d| d.severity == Severity::Error),
        diagnostics,
    };
    if as_json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print_human(&report);
    }
    if report.valid {
        Ok(())
    } else {
        std::process::exit(1);
    }
}

/// Library entry used by `cmd_build::run` to pre-validate before building.
/// Does not exit the process; returns the report so the caller can print
/// it in context and abort the build itself.
pub fn validate_at(path: &Path) -> Result<LintReport> {
    let (manifest, manifest_path) = read_plugin_manifest(path)?;
    let diagnostics = validate_manifest(&manifest);
    Ok(LintReport {
        manifest_path,
        valid: !diagnostics.iter().any(|d| d.severity == Severity::Error),
        diagnostics,
    })
}

fn print_human(report: &LintReport) {
    println!("Validating {}", report.manifest_path.display());
    if report.diagnostics.is_empty() {
        println!("✓ no problems found");
        return;
    }
    for d in &report.diagnostics {
        let tag = match d.severity {
            Severity::Error => "ERROR",
            Severity::Warning => "WARN ",
        };
        println!("  [{tag}] {}: {}", d.field, d.message);
        if let Some(hint) = &d.hint {
            println!("         hint: {hint}");
        }
        println!("         code: {}", d.code);
    }
    println!();
    println!(
        "{} error(s), {} warning(s)",
        report.error_count(),
        report.warning_count()
    );
}

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

    // ── type-specific entry points ──────────────────────────────────────
    match plugin_type {
        Some("frontend") => {
            require_string(obj, "main", "manifest.main.required", &mut out);
        }
        Some("python") => {
            require_string(obj, "pythonMain", "manifest.pythonMain.required", &mut out);
        }
        Some("wasm") => {
            require_string(obj, "wasmMain", "manifest.wasmMain.required", &mut out);
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
        Some("vscode-extension") => {
            require_string(obj, "vscodeMain", "manifest.vscodeMain.required", &mut out);
        }
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
            if !to.get("description").map(|v| v.is_string()).unwrap_or(false) {
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
                message: "WASM plugin must declare a \"wasm\" block with at least `apiVersion`".into(),
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
    if id.is_empty() {
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
    let ends_ok = bytes[bytes.len() - 1].is_ascii_lowercase()
        || bytes[bytes.len() - 1].is_ascii_digit();
    if !ends_ok {
        return false;
    }
    id.chars().all(|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_' || c == '.'
    })
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
    if !parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assert_clean(manifest: Value) {
        let diags = validate_manifest(&manifest);
        assert!(
            diags.iter().all(|d| d.severity != Severity::Error),
            "expected no errors, got: {diags:?}"
        );
    }

    fn assert_has_error_code(manifest: Value, code: &str) {
        let diags = validate_manifest(&manifest);
        assert!(
            diags
                .iter()
                .any(|d| d.severity == Severity::Error && d.code == code),
            "expected error code {code}, got: {diags:?}"
        );
    }

    fn minimal_frontend() -> Value {
        json!({
            "id": "hello-plugin",
            "name": "Hello",
            "version": "0.1.0",
            "description": "A plugin",
            "type": "frontend",
            "capabilities": ["tools"],
            "main": "dist/index.js"
        })
    }

    fn minimal_wasm() -> Value {
        json!({
            "id": "hello-wasm",
            "name": "Hello",
            "version": "0.1.0",
            "description": "A plugin",
            "type": "wasm",
            "capabilities": ["tools"],
            "wasmMain": "hello.wasm",
            "wasm": { "apiVersion": "0.1.0" }
        })
    }

    #[test]
    fn minimal_frontend_is_valid() {
        assert_clean(minimal_frontend());
    }

    #[test]
    fn minimal_wasm_is_valid() {
        assert_clean(minimal_wasm());
    }

    #[test]
    fn missing_id_is_error() {
        let mut m = minimal_frontend();
        m.as_object_mut().unwrap().remove("id");
        assert_has_error_code(m, "manifest.id.missing");
    }

    #[test]
    fn bad_id_format_is_error() {
        let mut m = minimal_frontend();
        m["id"] = json!("Has Space");
        assert_has_error_code(m, "manifest.id.invalid_format");
    }

    #[test]
    fn id_must_start_with_alphanumeric() {
        let mut m = minimal_frontend();
        m["id"] = json!("-leading-dash");
        assert_has_error_code(m, "manifest.id.invalid_format");
    }

    #[test]
    fn id_must_end_with_alphanumeric() {
        let mut m = minimal_frontend();
        m["id"] = json!("trailing-dash-");
        assert_has_error_code(m, "manifest.id.invalid_format");
    }

    #[test]
    fn id_accepts_single_char() {
        let mut m = minimal_frontend();
        m["id"] = json!("a");
        assert_clean(m);
    }

    #[test]
    fn bad_version_is_error() {
        let mut m = minimal_frontend();
        m["version"] = json!("v1.0");
        assert_has_error_code(m, "manifest.version.invalid_format");
    }

    #[test]
    fn version_with_prerelease_is_valid() {
        let mut m = minimal_frontend();
        m["version"] = json!("1.2.3-beta");
        assert_clean(m);
    }

    #[test]
    fn unknown_type_is_error() {
        let mut m = minimal_frontend();
        m["type"] = json!("widget");
        assert_has_error_code(m, "manifest.type.invalid");
    }

    #[test]
    fn unknown_capability_is_error() {
        let mut m = minimal_frontend();
        m["capabilities"] = json!(["telepathy"]);
        assert_has_error_code(m, "manifest.capabilities.invalid");
    }

    #[test]
    fn frontend_without_main_is_error() {
        let mut m = minimal_frontend();
        m.as_object_mut().unwrap().remove("main");
        assert_has_error_code(m, "manifest.main.required");
    }

    #[test]
    fn wasm_without_wasm_main_is_error() {
        let mut m = minimal_wasm();
        m.as_object_mut().unwrap().remove("wasmMain");
        assert_has_error_code(m, "manifest.wasmMain.required");
    }

    #[test]
    fn wasm_main_non_wasm_extension_is_error() {
        let mut m = minimal_wasm();
        m["wasmMain"] = json!("dist/index.js");
        assert_has_error_code(m, "manifest.wasmMain.invalid_extension");
    }

    #[test]
    fn wasm_without_api_version_is_error() {
        let mut m = minimal_wasm();
        m.as_object_mut().unwrap().remove("wasm");
        assert_has_error_code(m, "manifest.wasm.required");
    }

    #[test]
    fn wasm_api_version_with_prerelease_is_error() {
        let mut m = minimal_wasm();
        m["wasm"]["apiVersion"] = json!("0.1.0-beta");
        assert_has_error_code(m, "manifest.wasm.apiVersion.invalid");
    }

    #[test]
    fn wasm_memory_limit_above_4096_is_error() {
        let mut m = minimal_wasm();
        m["wasm"]["memoryLimitMb"] = json!(5000);
        assert_has_error_code(m, "manifest.wasm.memoryLimitMb.invalid");
    }

    #[test]
    fn wasm_call_timeout_above_10min_is_error() {
        let mut m = minimal_wasm();
        m["wasm"]["callTimeoutMs"] = json!(700_000);
        assert_has_error_code(m, "manifest.wasm.callTimeoutMs.invalid");
    }

    #[test]
    fn unknown_permission_is_warning_not_error() {
        let mut m = minimal_frontend();
        m["permissions"] = json!(["mind:read"]);
        let diags = validate_manifest(&m);
        assert!(diags.iter().any(|d| d.severity == Severity::Warning
            && d.code == "manifest.permissions.unknown"));
        assert!(diags.iter().all(|d| d.severity != Severity::Error));
    }

    #[test]
    fn activation_events_must_be_array() {
        let mut m = minimal_frontend();
        m["activationEvents"] = json!("onStartup");
        assert_has_error_code(m, "manifest.activationEvents.invalid_type");
    }

    #[test]
    fn activation_events_items_must_be_strings() {
        let mut m = minimal_frontend();
        m["activationEvents"] = json!(["onStartup", 42]);
        assert_has_error_code(m, "manifest.activationEvents.invalid_item");
    }

    #[test]
    fn tools_missing_name_is_error() {
        let mut m = minimal_frontend();
        m["tools"] = json!([{ "description": "noname" }]);
        assert_has_error_code(m, "manifest.tools.name.missing");
    }

    #[test]
    fn commands_missing_id_is_error() {
        let mut m = minimal_frontend();
        m["commands"] = json!([{ "name": "Foo" }]);
        assert_has_error_code(m, "manifest.commands.id.missing");
    }

    #[test]
    fn dexie_tables_must_not_be_empty() {
        let mut m = minimal_frontend();
        m["dexie"] = json!({ "tables": [] });
        assert_has_error_code(m, "manifest.dexie.tables.empty");
    }

    #[test]
    fn dexie_table_name_must_be_valid() {
        let mut m = minimal_frontend();
        m["dexie"] = json!({ "tables": [{ "name": "Bad-Name", "schema": "++id" }] });
        assert_has_error_code(m, "manifest.dexie.tables.nameInvalid");
    }

    #[test]
    fn dexie_duplicate_table_is_error() {
        let mut m = minimal_frontend();
        m["dexie"] = json!({
            "tables": [
                { "name": "items", "schema": "++id" },
                { "name": "items", "schema": "++id, name" }
            ]
        });
        assert_has_error_code(m, "manifest.dexie.tables.duplicate");
    }

    #[test]
    fn dexie_too_many_tables_is_error() {
        let mut tables = Vec::new();
        for i in 0..21 {
            tables.push(json!({ "name": format!("t{i}"), "schema": "++id" }));
        }
        let mut m = minimal_frontend();
        m["dexie"] = json!({ "tables": tables });
        assert_has_error_code(m, "manifest.dexie.tables.tooMany");
    }

    #[test]
    fn name_over_50_chars_warns() {
        let mut m = minimal_frontend();
        m["name"] = json!("a".repeat(51));
        let diags = validate_manifest(&m);
        assert!(diags
            .iter()
            .any(|d| d.severity == Severity::Warning && d.code == "manifest.name.long"));
    }

    #[test]
    fn validate_at_returns_report() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("plugin.json");
        std::fs::write(&p, serde_json::to_vec_pretty(&minimal_frontend()).unwrap()).unwrap();
        let report = validate_at(tmp.path()).unwrap();
        assert!(report.valid);
        assert_eq!(report.error_count(), 0);
    }

    #[test]
    fn vscode_extension_requires_vscode_main() {
        let mut m = minimal_frontend();
        m["type"] = json!("vscode-extension");
        m.as_object_mut().unwrap().remove("main");
        assert_has_error_code(m, "manifest.vscodeMain.required");
    }

    #[test]
    fn report_serializes_to_json() {
        let report = LintReport {
            manifest_path: PathBuf::from("/tmp/plugin.json"),
            valid: false,
            diagnostics: vec![Diagnostic {
                severity: Severity::Error,
                field: "id".into(),
                code: "manifest.id.missing".into(),
                message: "Missing id".into(),
                hint: None,
            }],
        };
        let json_str = serde_json::to_string(&report).unwrap();
        assert!(json_str.contains("\"valid\":false"));
        assert!(json_str.contains("\"severity\":\"error\""));
    }
}
