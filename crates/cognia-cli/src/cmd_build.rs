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
    ui::{progress, style, RuntimeUi},
};

/// `cognia plugin build` — validate, then dispatch on manifest.type.
///
/// Phase 4 wraps the three logical steps (lint → build → pack) in
/// `indicatif` spinners. The cargo / esbuild subprocess output still
/// streams underneath the spinner, but each stage finishes with a
/// `✓ done in <elapsed>` line so the user sees clean state transitions
/// even on a many-minute WASM compile.
pub fn run(
    path: PathBuf,
    out: Option<PathBuf>,
    skip_build: bool,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let crate_root = path
        .canonicalize()
        .with_context(|| format!("resolve {}", path.display()))?;
    let (manifest, _) = read_plugin_manifest(&crate_root)?;

    // ── lint first ─────────────────────────────────────────────────────
    let lint_spinner = progress::make_spinner(ui, "Validating plugin.json");
    let lint = cmd_lint::validate_at(&crate_root)?;
    let errors: Vec<&cmd_lint::Diagnostic> = lint
        .diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    if !errors.is_empty() {
        lint_spinner.finish_and_clear();
        eprintln!(
            "{}{} ({} error(s)):",
            style::error_prefix(),
            style::error("Manifest validation failed"),
            errors.len()
        );
        for d in &errors {
            eprintln!(
                "  [{}] {}: {}",
                style::dim(&d.code),
                style::bold(&d.field),
                d.message
            );
            if let Some(h) = &d.hint {
                eprintln!("       {}{}", style::hint_prefix(), h);
            }
        }
        bail!(
            "fix manifest issues before building; run `cognia plugin lint` for the full report"
        );
    }
    let warn_count = lint
        .diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Warning)
        .count();
    lint_spinner.finish_with_message(format!(
        "{}lint passed ({} warning{})",
        style::success_prefix(),
        warn_count,
        if warn_count == 1 { "" } else { "s" }
    ));
    for d in lint.diagnostics.iter().filter(|d| d.severity == Severity::Warning) {
        eprintln!(
            "  {}{} — {}",
            style::warn_prefix(),
            style::bold(&d.field),
            d.message
        );
    }

    // ── dispatch on type ───────────────────────────────────────────────
    let plugin_type = manifest
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing `type`"))?;
    match plugin_type {
        "wasm" => build_wasm(&crate_root, &manifest, out, skip_build, ui),
        "frontend" => build_frontend(&crate_root, &manifest, out, skip_build, ui),
        other => bail!(
            "cognia plugin build does not (yet) support `type: \"{other}\"`. Supported: wasm, frontend"
        ),
    }
}

fn build_frontend(
    crate_root: &Path,
    manifest: &serde_json::Value,
    out: Option<PathBuf>,
    skip_build: bool,
    ui: &mut RuntimeUi,
) -> Result<()> {
    if skip_build {
        let pack_spinner = progress::make_spinner(ui, "Packing bundle (skipping esbuild)");
        let path = build_ts::build_and_pack(crate_root, manifest, out, true)?;
        pack_spinner.finish_with_message(format!(
            "{}packed {}",
            style::success_prefix(),
            style::bold(path.display().to_string())
        ));
        return Ok(());
    }
    let build_spinner = progress::make_spinner(ui, "Building frontend (esbuild)");
    // `build_and_pack` runs both esbuild AND packing under one helper.
    // We split the spinner messaging at the boundaries we can observe.
    let bundle_path = build_ts::build_and_pack(crate_root, manifest, out, false)?;
    build_spinner.finish_with_message(format!(
        "{}built + packed {}",
        style::success_prefix(),
        style::bold(bundle_path.display().to_string())
    ));
    Ok(())
}

fn build_wasm(
    crate_root: &Path,
    manifest: &serde_json::Value,
    out: Option<PathBuf>,
    skip_build: bool,
    ui: &mut RuntimeUi,
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
        // Spinner sits at the bottom while cargo's own output streams
        // above it. `finish_with_message` clears the spinner before the
        // success line lands, so the final state is a clean "✓ ...".
        let build_spinner = progress::make_spinner(ui, "Building WASM component (cargo component build)");
        let result = run_cargo_component_build(crate_root);
        match &result {
            Ok(_) => build_spinner.finish_with_message(format!(
                "{}WASM component built",
                style::success_prefix()
            )),
            Err(_) => build_spinner.finish_and_clear(),
        }
        result?;
    }

    let pack_spinner = progress::make_spinner(ui, "Packing bundle");
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
    pack_spinner.finish_with_message(format!(
        "{}packed {}",
        style::success_prefix(),
        style::bold(bundle_path.display().to_string())
    ));

    println!(
        "{}Built {} v{} → {}",
        style::success_prefix(),
        style::bold(id),
        style::bold(version),
        style::dim(bundle_path.display().to_string())
    );
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
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        let err = run(tmp.path().to_path_buf(), None, true, &mut ui).unwrap_err();
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
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        let err = run(tmp.path().to_path_buf(), None, true, &mut ui).unwrap_err();
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
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        run(root.to_path_buf(), Some(out.clone()), true, &mut ui).unwrap();
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
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        let err = run(tmp.path().to_path_buf(), None, true, &mut ui).unwrap_err();
        assert!(err.to_string().contains("does not (yet) support"), "got: {err}");
    }
}
