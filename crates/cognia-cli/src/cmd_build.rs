//! `cognia plugin build` — validate, then dispatch on manifest.type.
//!
//! Two paths today:
//!   * `wasm`: run `cargo component build --release`, embed the
//!     `cognia:api-version` custom section, zip the artifact with the
//!     manifest. Unchanged from the original implementation.
//!   * `frontend`: invoke esbuild on src/index.ts → dist/index.js, then
//!     zip the bundle.
//!
//! In both cases `cmd_lint::validate_at` runs first so authors don't
//! waste a build cycle on a malformed manifest.

use anyhow::{anyhow, bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{
    build_ts, cmd_lint,
    cmd_lint::Severity,
    packaging, read_plugin_manifest, run_streaming,
};

pub fn run(path: PathBuf, out: Option<PathBuf>, skip_build: bool) -> Result<()> {
    let crate_root = path
        .canonicalize()
        .with_context(|| format!("resolve {}", path.display()))?;
    let (manifest, _) = read_plugin_manifest(&crate_root)?;

    // ── lint first ─────────────────────────────────────────────────────
    let lint = cmd_lint::validate_at(&crate_root)?;
    let errors: Vec<&cmd_lint::Diagnostic> = lint
        .diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    if !errors.is_empty() {
        eprintln!("Manifest validation failed ({} error(s)):", errors.len());
        for d in &errors {
            eprintln!("  [{}] {}: {}", d.code, d.field, d.message);
            if let Some(h) = &d.hint {
                eprintln!("       hint: {h}");
            }
        }
        bail!(
            "fix manifest issues before building; run `cognia plugin lint` for full report"
        );
    }
    for d in lint.diagnostics.iter().filter(|d| d.severity == Severity::Warning) {
        eprintln!("warning: {} — {}", d.field, d.message);
    }

    // ── dispatch on type ───────────────────────────────────────────────
    let plugin_type = manifest
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing `type`"))?;
    match plugin_type {
        "wasm" => build_wasm(&crate_root, &manifest, out, skip_build),
        "frontend" => {
            let _ = build_ts::build_and_pack(&crate_root, &manifest, out, skip_build)?;
            Ok(())
        }
        other => bail!(
            "cognia plugin build does not (yet) support `type: \"{other}\"`. Supported: wasm, frontend"
        ),
    }
}

fn build_wasm(
    crate_root: &Path,
    manifest: &serde_json::Value,
    out: Option<PathBuf>,
    skip_build: bool,
) -> Result<()> {
    if !crate_root.join("Cargo.toml").exists() {
        bail!("Cargo.toml not found under {}", crate_root.display());
    }
    let api_version = manifest
        .get("wasm")
        .and_then(|v| v.get("apiVersion"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing wasm.apiVersion"))?
        .to_string();

    if !skip_build {
        run_cargo_component_build(crate_root)?;
    }

    let plan = packaging::plan_bundle(crate_root, manifest)?;

    let wasm_bytes = std::fs::read(&plan.wasm_path)
        .with_context(|| format!("read {}", plan.wasm_path.display()))?;
    let patched = packaging::embed_api_version(&wasm_bytes, &api_version)?;
    let patched_path = plan.wasm_path.clone();
    std::fs::write(&patched_path, &patched)
        .with_context(|| format!("write {}", patched_path.display()))?;

    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing id"))?;
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing version"))?;

    let bundle_path = out.unwrap_or_else(|| {
        crate_root
            .join("target")
            .join("cognia")
            .join(format!("{id}-{version}.zip"))
    });
    packaging::write_bundle(&bundle_path, &plan, manifest)?;

    println!("Built {id} v{version} → {}", bundle_path.display());
    Ok(())
}

fn run_cargo_component_build(crate_root: &Path) -> Result<()> {
    let mut cmd = Command::new("cargo");
    cmd.current_dir(crate_root)
        .arg("component")
        .arg("build")
        .arg("--release");
    run_streaming(cmd, "cargo component build")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn write_plugin_json(root: &Path, manifest: &serde_json::Value) {
        std::fs::write(
            root.join("plugin.json"),
            serde_json::to_vec_pretty(manifest).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn build_errors_when_plugin_json_missing() {
        let tmp = tempdir().unwrap();
        // No plugin.json present → read_plugin_manifest errors out first.
        let err = run(tmp.path().to_path_buf(), None, true).unwrap_err();
        assert!(err.to_string().contains("plugin.json"));
    }

    #[test]
    fn build_aborts_on_lint_error() {
        let tmp = tempdir().unwrap();
        // Manifest is well-formed JSON but missing required fields.
        write_plugin_json(
            tmp.path(),
            &json!({
                "id": "x",
                // missing name, version, description, type, capabilities
            }),
        );
        let err = run(tmp.path().to_path_buf(), None, true).unwrap_err();
        assert!(
            err.to_string().contains("fix manifest issues"),
            "got: {err}"
        );
    }

    #[test]
    fn build_dispatches_to_frontend_for_type_frontend() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/index.js"), "x").unwrap();
        write_plugin_json(
            root,
            &json!({
                "id": "hello-ts",
                "name": "Hello",
                "version": "0.1.0",
                "description": "TS plugin",
                "type": "frontend",
                "capabilities": ["tools"],
                "main": "dist/index.js"
            }),
        );
        let out = root.join("hello-ts.zip");
        // skip_build=true bypasses the esbuild call so we don't need npx in tests.
        run(root.to_path_buf(), Some(out.clone()), true).unwrap();
        assert!(out.exists());
    }

    #[test]
    fn build_rejects_unsupported_type() {
        let tmp = tempdir().unwrap();
        write_plugin_json(
            tmp.path(),
            &json!({
                "id": "py",
                "name": "Py",
                "version": "0.1.0",
                "description": "py",
                "type": "python",
                "capabilities": [],
                "pythonMain": "main.py"
            }),
        );
        let err = run(tmp.path().to_path_buf(), None, true).unwrap_err();
        assert!(err.to_string().contains("does not (yet) support"), "got: {err}");
    }
}
