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
use std::fmt;
use std::path::{Path, PathBuf};

use crate::read_plugin_manifest;
use crate::ui::RuntimeUi;

#[path = "generated_plugin_contract.rs"]
mod generated_plugin_contract;
use generated_plugin_contract::{
    CAPABILITY_FIELDS, CAPABILITY_MINIMUM_HOST_VERSIONS, EXECUTABLE_CONTRIBUTION_FIELDS,
    PLUGIN_PATH_FIELDS, VALID_CAPABILITIES, VALID_PERMISSIONS, VALID_PLUGIN_TYPES,
};

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    /// Informational tier: surfaced, but never gates — not even under
    /// `--warnings-as-errors`. Reserved for advisory rules (e.g. the
    /// version-compatibility notices in W3.4). No production rule emits one
    /// yet; tests construct it to pin the non-gating behavior.
    #[allow(dead_code)]
    Notice,
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
    /// Bumped for breaking changes to the JSON shape so consumers can
    /// version-pin without parsing the whole payload speculatively.
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub ok: bool,
    pub action: &'static str,
    /// Which stage produced this payload. `"validate"` for a real lint result;
    /// the input-failure payload carries `"input"`. Always present so a `--json`
    /// consumer can bucket on `.stage` uniformly across success and failure.
    pub stage: &'static str,
    #[serde(rename = "manifestPath")]
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

    pub fn notice_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Notice)
            .count()
    }
}

#[derive(Debug, Clone)]
pub struct LintError {
    pub report: LintReport,
}

impl LintError {
    pub fn error_count(&self) -> usize {
        self.report.error_count()
    }

    pub fn warning_count(&self) -> usize {
        self.report.warning_count()
    }
}

impl fmt::Display for LintError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "manifest lint failed: {} error(s), {} warning(s)",
            self.error_count(),
            self.warning_count()
        )
    }
}

impl std::error::Error for LintError {}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

/// CLI entry: `cognia plugin lint`. Prints human-readable diagnostics by
/// default or JSON when `as_json` is true, and returns `LintError` when
/// diagnostics contain errors so callers can choose their own exit policy.
///
/// `_ui` is accepted but unused in Phase 1; Phase 2 paints diagnostics
/// with severity color and uses `ui.json()` instead of the bool argument.
pub fn run(
    path: PathBuf,
    as_json: bool,
    warnings_as_errors: bool,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let crate_root = match path.canonicalize() {
        Ok(root) => root,
        Err(err) if as_json => {
            return emit_json_input_failure(
                &path,
                format!("resolve {}: {err}", path.display()),
                "lint.input.unreadable",
            );
        }
        Err(err) => return Err(err).with_context(|| format!("resolve {}", path.display())),
    };
    let (manifest, manifest_path) = match read_plugin_manifest(&crate_root) {
        Ok(manifest) => manifest,
        Err(err) if as_json => {
            return emit_json_input_failure(&crate_root, err.to_string(), "lint.input.manifest");
        }
        Err(err) => return Err(err),
    };
    let diagnostics = validate_manifest(&manifest);
    // `valid` describes the manifest (no errors); `ok` describes this run's
    // gate. Under `--warnings-as-errors`, warnings escalate the exit but do
    // not change `valid`. Notices never gate on either axis.
    let valid = !diagnostics.iter().any(|d| d.severity == Severity::Error);
    let ok = run_passes(&diagnostics, warnings_as_errors);
    let report = LintReport {
        schema_version: 2,
        ok,
        action: "lint",
        stage: "validate",
        manifest_path,
        valid,
        diagnostics,
    };
    if as_json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else if !ui.flags.quiet || !ok {
        print_human(&report);
    }
    if ok {
        Ok(())
    } else {
        Err(LintError { report }.into())
    }
}

/// Whether a lint run passes its gate. Errors always gate; warnings gate only
/// under `--warnings-as-errors`; notices never gate on either axis.
fn run_passes(diagnostics: &[Diagnostic], warnings_as_errors: bool) -> bool {
    let has_error = diagnostics.iter().any(|d| d.severity == Severity::Error);
    let has_warning = diagnostics.iter().any(|d| d.severity == Severity::Warning);
    !has_error && !(warnings_as_errors && has_warning)
}

#[derive(Debug, Serialize)]
struct LintFailureReport {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    /// Same key as the success payload's `manifestPath`, so a `--json` consumer
    /// reads one field for "the manifest this run was about" on both shapes.
    #[serde(rename = "manifestPath")]
    path: PathBuf,
    valid: bool,
    diagnostics: Vec<Diagnostic>,
}

fn emit_json_input_failure(path: &Path, error: String, code: &'static str) -> Result<()> {
    let report = LintFailureReport {
        schema_version: 2,
        ok: false,
        action: "lint",
        stage: "input",
        path: path.to_path_buf(),
        valid: false,
        diagnostics: vec![Diagnostic {
            severity: Severity::Error,
            field: "path".into(),
            code: code.into(),
            message: error,
            hint: Some("Pass --path pointing at a plugin directory containing plugin.json.".into()),
        }],
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Err(crate::JsonFailureExit.into())
}

/// Library entry used by `cmd_build::run` to pre-validate before building.
/// Does not exit the process; returns the report so the caller can print
/// it in context and abort the build itself.
pub fn validate_at(path: &Path) -> Result<LintReport> {
    let (manifest, manifest_path) = read_plugin_manifest(path)?;
    let diagnostics = validate_manifest(&manifest);
    let valid = !diagnostics.iter().any(|d| d.severity == Severity::Error);
    Ok(LintReport {
        schema_version: 2,
        ok: valid,
        action: "lint",
        stage: "validate",
        manifest_path,
        valid,
        diagnostics,
    })
}

fn print_human(report: &LintReport) {
    use crate::ui::style;
    println!(
        "Validating {}",
        style::bold(report.manifest_path.display().to_string())
    );
    if report.diagnostics.is_empty() {
        println!("{}no problems found", style::success_prefix());
        return;
    }
    for d in &report.diagnostics {
        let tag = match d.severity {
            Severity::Error => style::error("ERROR"),
            Severity::Warning => style::warn("WARN "),
            Severity::Notice => style::dim("NOTE "),
        };
        println!("  [{tag}] {}: {}", style::bold(&d.field), d.message);
        if let Some(hint) = &d.hint {
            println!("         {}{hint}", style::hint_prefix());
        }
        println!("         code: {}", style::dim(&d.code));
    }
    println!();
    let mut summary = format!(
        "{} error(s), {} warning(s)",
        report.error_count(),
        report.warning_count()
    );
    if report.notice_count() > 0 {
        summary.push_str(&format!(", {} notice(s)", report.notice_count()));
    }
    if !report.valid {
        println!("{}", style::error(&summary));
    } else if !report.ok {
        // No errors, but `--warnings-as-errors` escalated the warnings.
        println!("{} (--warnings-as-errors)", style::error(&summary));
    } else if report.warning_count() > 0 {
        println!("{}", style::warn(&summary));
    } else {
        // Notices only — passes cleanly.
        println!("{}{summary}", style::success_prefix());
    }
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

    let has_js_contributions = EXECUTABLE_CONTRIBUTION_FIELDS.iter().any(|field| {
        obj.get(*field)
            .and_then(Value::as_array)
            .is_some_and(|entries| !entries.is_empty())
    }) || obj.get("configComponent").is_some();
    if obj.get("type").and_then(Value::as_str) != Some("frontend")
        && has_js_contributions
        && obj.get("main").and_then(Value::as_str).is_none()
    {
        out.push(Diagnostic {
            severity: Severity::Error,
            field: "main".into(),
            code: "manifest.main.required_for_js_contributions".into(),
            message: "JavaScript-executed contributions require a relative \"main\" entry point"
                .into(),
            hint: Some(
                "Use a hybrid plugin with \"main\", or remove JavaScript-executed contributions."
                    .into(),
            ),
        });
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

    fn assert_has_warning_code(manifest: Value, code: &str) {
        let diags = validate_manifest(&manifest);
        assert!(
            diags
                .iter()
                .any(|d| d.severity == Severity::Warning && d.code == code),
            "expected warning code {code}, got: {diags:?}"
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

    fn cli_manifest() -> Value {
        json!({
            "id": "cli-demo",
            "name": "CLI Demo",
            "version": "0.1.0",
            "description": "demo",
            "type": "frontend",
            "capabilities": ["cli-tools"],
            "main": "dist/index.js",
            "permissions": ["cli:execute"],
            "requires": { "binaries": [{ "name": "rg" }] },
            "cliTools": [{
                "name": "ripgrep_search",
                "description": "Search files",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string" },
                        "globs": { "type": "array" }
                    }
                },
                "binary": { "kind": "requires", "name": "rg" },
                "argv": [
                    { "literal": "--json" },
                    { "param": "globs", "eachPrefixedBy": "--glob", "omitWhenEmpty": true },
                    { "param": "pattern" }
                ],
                "outputParse": "lines",
                "successExitCodes": [0, 1]
            }]
        })
    }

    #[test]
    fn runtime_combinations_enforce_javascript_entry_ownership() {
        let contribution = json!([{
            "id": "sessions",
            "entry": "dist/importer.js",
            "export": "createImporter"
        }]);
        let python_only = json!({
            "id": "python-only",
            "name": "Python only",
            "version": "0.1.0",
            "description": "Python plugin",
            "type": "python",
            "capabilities": ["python", "session-importer"],
            "pythonMain": "main.py",
            "sessionImporters": contribution
        });
        assert_has_error_code(python_only, "manifest.main.required_for_js_contributions");

        let hybrid = json!({
            "id": "hybrid-plugin",
            "name": "Hybrid",
            "version": "0.1.0",
            "description": "Hybrid plugin",
            "type": "hybrid",
            "capabilities": ["python", "session-importer"],
            "main": "dist/index.js",
            "pythonMain": "main.py",
            "sessionImporters": contribution
        });
        assert_clean(hybrid);

        let javascript = json!({
            "id": "javascript-plugin",
            "name": "JavaScript",
            "version": "0.1.0",
            "description": "JavaScript plugin",
            "type": "frontend",
            "capabilities": ["session-importer"],
            "main": "dist/index.js",
            "sessionImporters": contribution
        });
        assert_clean(javascript);
    }

    #[test]
    fn engines_cognia_must_cover_declared_capability_minimums() {
        let mut manifest = minimal_frontend();
        manifest["engines"] = json!({ "cognia": ">=0.0.9" });
        assert_has_error_code(
            manifest.clone(),
            "manifest.engines.cognia.capability_minimum",
        );

        manifest["engines"] = json!({ "cognia": ">=0.1.0" });
        assert_clean(manifest);
    }

    #[test]
    fn cli_tools_valid_manifest_is_clean() {
        assert_clean(cli_manifest());
    }

    #[test]
    fn cli_tools_require_cli_execute_permission() {
        let mut m = cli_manifest();
        m["permissions"] = json!([]);
        assert_has_error_code(m, "manifest.cliTools.permission.missing");
    }

    #[test]
    fn cli_tools_reject_undeclared_requires_binary() {
        let mut m = cli_manifest();
        m["cliTools"][0]["binary"]["name"] = json!("ffmpeg");
        assert_has_error_code(m, "manifest.cliTools.binary.name.undeclared");
    }

    #[test]
    fn cli_tools_reject_plugin_dir_traversal() {
        for bad in ["../evil.exe", "/usr/bin/evil", "C:\\evil.exe", "a/../../b"] {
            let mut m = cli_manifest();
            m["cliTools"][0]["binary"] = json!({ "kind": "plugin-dir", "relPath": bad });
            assert_has_error_code(m, "manifest.cliTools.binary.relPath.invalid");
        }
        let mut m = cli_manifest();
        m["cliTools"][0]["binary"] = json!({ "kind": "plugin-dir", "relPath": "bin/tool.exe" });
        assert_clean(m);
    }

    #[test]
    fn cli_tools_reject_undeclared_argv_param_and_bad_tokens() {
        let mut m = cli_manifest();
        m["cliTools"][0]["argv"] = json!([
            { "param": "ghost" },
            { "literal": "-x", "param": "pattern" },
            {}
        ]);
        assert_has_error_code(m.clone(), "manifest.cliTools.argv.param.undeclared");
        assert_has_error_code(m, "manifest.cliTools.argv.token.invalid");
    }

    #[test]
    fn cli_tools_reject_bad_stdin_cwd_env_and_knobs() {
        let mut m = cli_manifest();
        m["cliTools"][0]["stdin"] = json!({ "param": "ghost" });
        m["cliTools"][0]["cwd"] = json!({ "kind": "anywhere" });
        m["cliTools"][0]["env"] = json!({ "GOOD": "1", "BAD": 2 });
        m["cliTools"][0]["timeoutMs"] = json!(-5);
        m["cliTools"][0]["maxOutputBytes"] = json!(1.5);
        m["cliTools"][0]["outputParse"] = json!("yaml");
        m["cliTools"][0]["successExitCodes"] = json!([0, "ok"]);
        for code in [
            "manifest.cliTools.stdin.invalid",
            "manifest.cliTools.cwd.invalid",
            "manifest.cliTools.env.invalid",
            "manifest.cliTools.timeoutMs.invalid",
            "manifest.cliTools.maxOutputBytes.invalid",
            "manifest.cliTools.outputParse.invalid",
            "manifest.cliTools.successExitCodes.invalid",
        ] {
            assert_has_error_code(m.clone(), code);
        }
    }

    #[test]
    fn cli_tools_reject_duplicates_bad_name_and_parameters_shape() {
        let mut m = cli_manifest();
        let dup = m["cliTools"][0].clone();
        m["cliTools"].as_array_mut().unwrap().push(dup);
        assert_has_error_code(m, "manifest.cliTools.name.duplicate");

        let mut m = cli_manifest();
        m["cliTools"][0]["name"] = json!("Bad-Name");
        assert_has_error_code(m, "manifest.cliTools.name.invalid");

        let mut m = cli_manifest();
        m["cliTools"][0]["parameters"] = json!({ "type": "string" });
        assert_has_error_code(m, "manifest.cliTools.parameters.invalid");
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
    fn newly_contracted_capabilities_are_valid() {
        for cap in [
            "theme-pack",
            "fonts",
            "wallpapers",
            "subagent",
            "agent-team-template",
            "shared-memory-adapter",
            "workflow-template",
            "lsp-server",
            "character-pack",
            "workspace-backend",
            "message-renderer",
            "density-preset",
            "chat-middleware",
            "modal-mount",
            "terminal-completion",
            "routing-strategy",
            "deployment-filter",
            "protocol-adapter",
            "tool-route",
            "context-provider",
        ] {
            let mut m = minimal_frontend();
            m["capabilities"] = json!([cap]);
            let diags = validate_manifest(&m);
            assert!(
                !diags
                    .iter()
                    .any(|d| d.code == "manifest.capabilities.invalid"),
                "capability {cap} should be valid, got: {diags:?}"
            );
        }
    }

    #[test]
    fn declared_capability_without_field_warns() {
        let mut m = minimal_frontend();
        m["capabilities"] = json!(["scheduler"]);
        assert_has_warning_code(m, "manifest.capability.field_missing");
    }

    #[test]
    fn populated_field_without_capability_warns() {
        let mut m = minimal_frontend();
        m["capabilities"] = json!(["tools"]);
        m["tools"] = json!([{ "name": "t", "description": "d", "parametersSchema": {} }]);
        m["fonts"] = json!([{ "family": "X", "files": [{ "weight": 400, "src": "a.woff2" }] }]);
        assert_has_warning_code(m, "manifest.capability.field_undeclared");
    }

    #[test]
    fn workflows_object_block_counts_as_populated() {
        let mut m = minimal_frontend();
        m["capabilities"] = json!(["workflow"]);
        m["workflows"] =
            json!({ "nodes": [{ "kind": "demo.node", "entry": "src/index.ts", "export": "n" }] });
        let diags = validate_manifest(&m);
        assert!(
            !diags
                .iter()
                .any(|d| d.code == "manifest.capability.field_missing"
                    && d.message.contains("workflows")),
            "populated workflows block should satisfy the workflow capability, got: {diags:?}"
        );
    }

    #[test]
    fn empty_workflows_object_block_counts_as_missing() {
        let mut m = minimal_frontend();
        m["capabilities"] = json!(["workflow"]);
        m["workflows"] = json!({ "nodes": [], "triggers": [] });
        assert_has_warning_code(m, "manifest.capability.field_missing");
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
        assert!(diags
            .iter()
            .any(|d| d.severity == Severity::Warning && d.code == "manifest.permissions.unknown"));
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
    fn lint_rejects_lazy_factory_entry_traversal() {
        let mut m = minimal_frontend();
        m["capabilities"] = json!(["message-renderer"]);
        m["messageRenderers"] = json!([
            { "id": "evil", "partType": "x", "entry": "../../../../etc/passwd", "export": "default" }
        ]);
        assert_has_error_code(m, "manifest.messageRenderers.entry.traversal");
    }

    #[test]
    fn lint_rejects_lazy_factory_entry_absolute() {
        let mut m = minimal_frontend();
        m["capabilities"] = json!(["workspace-backend"]);
        m["workspaceBackends"] = json!([
            { "id": "evil2", "label": "L", "entry": "/etc/shadow", "export": "default" }
        ]);
        assert_has_error_code(m, "manifest.workspaceBackends.entry.absolute");
    }

    #[test]
    fn lint_accepts_relative_lazy_factory_entry() {
        let mut m = minimal_frontend();
        m["capabilities"] = json!(["modal-mount"]);
        m["modalMounts"] = json!([
            { "id": "ok", "label": "L", "entry": "dist/mount.js", "export": "default" }
        ]);
        let diags = validate_manifest(&m);
        assert!(
            !diags
                .iter()
                .any(|d| d.code.starts_with("manifest.modalMounts.entry.")),
            "a clean relative entry must not trip a path-safety code, got: {diags:?}"
        );
    }

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

    #[test]
    fn notices_never_gate_even_with_warnings_as_errors() {
        let notice = Diagnostic {
            severity: Severity::Notice,
            field: "x".into(),
            code: "manifest.demo.notice".into(),
            message: "informational".into(),
            hint: None,
        };
        // A notice passes the gate on both axes.
        assert!(run_passes(std::slice::from_ref(&notice), false));
        assert!(
            run_passes(std::slice::from_ref(&notice), true),
            "a notice must not gate even under --warnings-as-errors"
        );

        let warning = Diagnostic {
            severity: Severity::Warning,
            ..notice.clone()
        };
        assert!(run_passes(std::slice::from_ref(&warning), false));
        assert!(
            !run_passes(std::slice::from_ref(&warning), true),
            "--warnings-as-errors must escalate a warning"
        );

        let error = Diagnostic {
            severity: Severity::Error,
            ..notice
        };
        assert!(!run_passes(std::slice::from_ref(&error), false));
        assert!(!run_passes(std::slice::from_ref(&error), true));
    }

    #[test]
    fn warnings_as_errors_flips_the_exit_on_a_warning() {
        // A manifest with exactly one warning (long name) and no errors.
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags {
            json: true,
            ..crate::ui::runtime::UiFlags::default()
        });
        let tmp = tempfile::tempdir().unwrap();
        let mut m = minimal_frontend();
        m["name"] = json!("a".repeat(60));
        std::fs::write(
            tmp.path().join("plugin.json"),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();

        // Without -W: the warning does not gate → Ok.
        run(tmp.path().to_path_buf(), true, false, &mut ui)
            .expect("a warning alone must not fail lint");
        // With -W: the same warning gates → Err.
        let err = run(tmp.path().to_path_buf(), true, true, &mut ui).unwrap_err();
        assert!(
            err.is::<LintError>(),
            "--warnings-as-errors must fail on a warning"
        );
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
    fn run_returns_error_instead_of_exiting_on_invalid_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("plugin.json"), r#"{"id":"x"}"#).unwrap();
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags {
            json: true,
            ..crate::ui::runtime::UiFlags::default()
        });

        let err = run(tmp.path().to_path_buf(), true, false, &mut ui).unwrap_err();
        let err = err
            .downcast_ref::<LintError>()
            .expect("invalid lint reports should return a downcastable LintError");

        assert_eq!(err.error_count(), err.report.error_count());
        assert!(err.error_count() >= 5);
        assert_eq!(err.warning_count(), 0);
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
            schema_version: 2,
            ok: false,
            action: "lint",
            stage: "validate",
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
        assert!(json_str.contains("\"ok\":false"));
        assert!(json_str.contains("\"action\":\"lint\""));
        assert!(json_str.contains("\"valid\":false"));
        assert!(json_str.contains("\"severity\":\"error\""));
        assert!(json_str.contains("\"schemaVersion\":2"), "got: {json_str}");
        // Unified shape: camelCase manifestPath + always-present stage.
        assert!(json_str.contains("\"manifestPath\":"), "got: {json_str}");
        assert!(
            json_str.contains("\"stage\":\"validate\""),
            "got: {json_str}"
        );
    }
}
