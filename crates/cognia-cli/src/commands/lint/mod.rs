//! `cognia plugin lint` — validate `plugin.json` against the host's schema.
//!
//! Rust port of `lib/plugin/core/validation.ts::validatePluginManifest`.
//! Catches malformed manifests before they hit the host so authors get a
//! fast, local feedback loop. Returns exit 0 if no errors, 1 otherwise.
//!
//! `cognia plugin build` calls this implicitly before invoking the
//! per-type build path, so a single command suffices for the common
//! "validate + build" flow.
//!
//! This module is the orchestration seam: [`run`] (CLI entry) and
//! [`validate_at`] (library entry used by `commands::build`). The diagnostic
//! types and rendering live in [`report`]; the rule set lives in [`rules`].

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

use crate::shared::read_plugin_manifest;
use crate::ui::RuntimeUi;

mod report;
mod rules;

pub use report::{Diagnostic, LintError, LintReport, Severity};
pub use rules::validate_manifest;

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
            return report::emit_json_input_failure(
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
            return report::emit_json_input_failure(
                &crate_root,
                err.to_string(),
                "lint.input.manifest",
            );
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
        report::print_human(&report);
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

/// Library entry used by `commands::build::run` to pre-validate before building.
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

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
        // A JS-only (React) contribution — `views` (tree-view) has no Python
        // execution path, so a pure-Python plugin cannot own it.
        let js_only = json!([{
            "id": "tree",
            "entry": "dist/view.js",
            "export": "createView"
        }]);
        let python_js_only = json!({
            "id": "python-views",
            "name": "Python views",
            "version": "0.1.0",
            "description": "Python plugin",
            "type": "python",
            "capabilities": ["python", "tree-view"],
            "pythonMain": "main.py",
            "views": js_only.clone()
        });
        assert_has_error_code(
            python_js_only,
            "manifest.contributions.javascript.unsupported_for_python",
        );

        // A python-backable contribution (`sessionImporters`, pythonExecution
        // "supported") with the backend defaulted from the plugin type routes
        // through the plugin_python_call seam — no JS entry required.
        let python_backed = json!({
            "id": "python-importer",
            "name": "Python importer",
            "version": "0.1.0",
            "description": "Python plugin",
            "type": "python",
            "capabilities": ["python", "session-importer"],
            "pythonMain": "main.py",
            "sessionImporters": [{ "id": "sessions" }]
        });
        assert_clean(python_backed);

        // …but an explicit `backend: "js"` on a python plugin still needs a JS
        // runtime the python type cannot provide.
        let python_backend_js = json!({
            "id": "python-importer-js",
            "name": "Python importer",
            "version": "0.1.0",
            "description": "Python plugin",
            "type": "python",
            "capabilities": ["python", "session-importer"],
            "pythonMain": "main.py",
            "sessionImporters": [{
                "id": "sessions",
                "backend": "js",
                "entry": "dist/importer.js",
                "export": "createImporter"
            }]
        });
        assert_has_error_code(
            python_backend_js,
            "manifest.contributions.javascript.unsupported_for_python",
        );

        // Experimental python-backed capabilities (connectors) load, but warn.
        let python_connector = json!({
            "id": "python-connector",
            "name": "Python connector",
            "version": "0.1.0",
            "description": "Python plugin",
            "type": "python",
            "capabilities": ["python", "connectors"],
            "pythonMain": "main.py",
            "connectors": [{ "id": "mail" }]
        });
        assert_has_warning_code(
            python_connector.clone(),
            "manifest.contributions.python.experimental",
        );
        assert_clean(python_connector);

        // hybrid can own JS contributions (it declares `main`).
        let hybrid = json!({
            "id": "hybrid-plugin",
            "name": "Hybrid",
            "version": "0.1.0",
            "description": "Hybrid plugin",
            "type": "hybrid",
            "capabilities": ["python", "tree-view"],
            "main": "dist/index.js",
            "pythonMain": "main.py",
            "views": js_only.clone()
        });
        assert_clean(hybrid);

        let hybrid_without_python = json!({
            "id": "hybrid-without-python",
            "name": "Hybrid",
            "version": "0.1.0",
            "description": "Hybrid plugin",
            "type": "hybrid",
            "capabilities": ["tree-view"],
            "main": "dist/index.js",
            "views": js_only.clone()
        });
        assert_has_error_code(hybrid_without_python, "manifest.pythonMain.required");

        // frontend owns JS contributions natively.
        let javascript = json!({
            "id": "javascript-plugin",
            "name": "JavaScript",
            "version": "0.1.0",
            "description": "JavaScript plugin",
            "type": "frontend",
            "capabilities": ["tree-view"],
            "main": "dist/index.js",
            "views": js_only
        });
        assert_clean(javascript);

        // Host-rendered / declarative / python-backable contributions never
        // demand a JS entry point on a python plugin.
        for contribution in [
            json!({ "protocolAdapters": [{ "spec": { "kind": "declarative" } }] }),
            json!({ "webviews": [{ "html": "<p>safe inline view</p>" }] }),
            // protocolAdapters code-kind is python-backable (pythonExecution
            // "supported"); with no JS `entry` declared the backend defaults to
            // python for a python plugin.
            json!({ "protocolAdapters": [{ "spec": { "kind": "code" } }] }),
        ] {
            let mut manifest = json!({
                "id": "python-declarative",
                "name": "Python declarative",
                "version": "0.1.0",
                "description": "Host-rendered contribution",
                "type": "python",
                "capabilities": [],
                "pythonMain": "main.py"
            });
            manifest
                .as_object_mut()
                .unwrap()
                .extend(contribution.as_object().unwrap().clone());
            assert_clean(manifest);
        }

        // JS-executed contributions still block a pure-Python plugin: webviews
        // with a JS `entry`, React message renderers, and any python-backable
        // field that declares a JS module path (writing an `entry` is itself a
        // declaration of JS intent).
        for contribution in [
            json!({ "webviews": [{ "entry": "dist/view.js" }] }),
            json!({ "messageRenderers": [{ "id": "r", "entry": "dist/r.js", "export": "render" }] }),
            json!({ "protocolAdapters": [{ "spec": { "kind": "code" }, "entry": "dist/adapter.js" }] }),
        ] {
            let mut manifest = json!({
                "id": "python-executable",
                "name": "Python executable",
                "version": "0.1.0",
                "description": "Executable contribution",
                "type": "python",
                "capabilities": [],
                "pythonMain": "main.py"
            });
            manifest
                .as_object_mut()
                .unwrap()
                .extend(contribution.as_object().unwrap().clone());
            assert_has_error_code(
                manifest,
                "manifest.contributions.javascript.unsupported_for_python",
            );
        }
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
    fn id_rejects_host_reserved_and_overlong_names() {
        for id in [
            ".host-state".to_string(),
            "_marketplace_cache".to_string(),
            "_backups".to_string(),
            "a".repeat(129),
        ] {
            let mut manifest = minimal_frontend();
            manifest["id"] = json!(id);
            assert_has_error_code(manifest, "manifest.id.invalid_format");
        }
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
    fn lint_rejects_tool_renderer_entry_traversal() {
        // `toolRenderers` is a lazy-factory field like `messageRenderers`, so it
        // must inherit the same path-escape guard rather than being a hole.
        let mut m = minimal_frontend();
        m["capabilities"] = json!(["tool-renderer"]);
        m["toolRenderers"] = json!([
            { "toolName": "evil", "entry": "../../../../etc/passwd", "export": "default" }
        ]);
        assert_has_error_code(m, "manifest.toolRenderers.entry.traversal");
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
    fn vscode_extension_requires_runtime_or_declarative_contribution() {
        let mut m = minimal_frontend();
        m["type"] = json!("vscode-extension");
        m.as_object_mut().unwrap().remove("main");
        assert_has_error_code(m, "manifest.runtime_entry.required_any_of");
    }

    #[test]
    fn vscode_extension_accepts_declarative_theme_without_vscode_main() {
        let mut m = minimal_frontend();
        m["type"] = json!("vscode-extension");
        m.as_object_mut().unwrap().remove("main");
        m["themes"] = json!([{
            "id": "dark",
            "name": "Dark",
            "vscodeJsonPath": "themes/dark.json"
        }]);
        let diagnostics = validate_manifest(&m);
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code != "manifest.runtime_entry.required_any_of"),
            "declarative extension should not require vscodeMain: {diagnostics:?}"
        );
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
