//! `cognia plugin build` — validate, then dispatch on manifest.type.
//!
//! Runtime-specific paths today:
//!   * `wasm`: run `cargo component build --release`, embed the
//!     `cognia:api-version` custom section, zip the artifact with the
//!     manifest. Unchanged from the original implementation.
//!   * `frontend`: invoke esbuild on src/index.ts → dist/index.js, then
//!     zip the bundle.
//!   * `python`, `hybrid`, `vscode-extension`: package manifest-declared
//!     prebuilt entry files and `bundle_include[]`. The host treats these
//!     runtimes as build-free local installs, so the CLI does not invent a
//!     compiler step.
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
        bail!("fix manifest issues before building; run `cognia plugin lint` for the full report");
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
    for d in lint
        .diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Warning)
    {
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
        "python" => build_existing_entry_bundle(&crate_root, &manifest, out, "python", &["pythonMain"], ui),
        "hybrid" => build_existing_entry_bundle(
            &crate_root,
            &manifest,
            out,
            "hybrid",
            &["main", "pythonMain", "styles"],
            ui,
        ),
        "vscode-extension" => build_existing_entry_bundle(
            &crate_root,
            &manifest,
            out,
            "vscode-extension",
            &["vscodeMain", "styles"],
            ui,
        ),
        other => bail!(
            "cognia plugin build does not support `type: \"{other}\"`. Supported: wasm, frontend, python, hybrid, vscode-extension"
        ),
    }
}

fn build_existing_entry_bundle(
    crate_root: &Path,
    manifest: &serde_json::Value,
    out: Option<PathBuf>,
    plugin_type: &str,
    entry_fields: &[&str],
    ui: &mut RuntimeUi,
) -> Result<()> {
    let pack_spinner = progress::make_spinner(ui, format!("Packing {plugin_type} bundle"));
    let path = packaging::pack_existing_entry_bundle(crate_root, manifest, out, entry_fields);
    match &path {
        Ok(bundle_path) => pack_spinner.finish_with_message(format!(
            "{}packed {}",
            style::success_prefix(),
            style::bold(bundle_path.display().to_string())
        )),
        Err(_) => pack_spinner.finish_and_clear(),
    }
    let bundle_path = path?;
    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing id"))?;
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing version"))?;
    println!(
        "{}Built {} v{} → {}",
        style::success_prefix(),
        style::bold(id),
        style::bold(version),
        style::dim(bundle_path.display().to_string())
    );
    Ok(())
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
        // Preflight the toolchain BEFORE shelling out to cargo so a missing
        // cargo-component / wasm32-wasip2 target surfaces actionable install
        // guidance instead of cargo's bare `no such command: component`.
        preflight_wasm_toolchain()?;
        // Spinner sits at the bottom while cargo's own output streams
        // above it. `finish_with_message` clears the spinner before the
        // success line lands, so the final state is a clean "✓ ...".
        let build_spinner =
            progress::make_spinner(ui, "Building WASM component (cargo component build)");
        let result = run_cargo_component_build(crate_root);
        match &result {
            Ok(_) => build_spinner
                .finish_with_message(format!("{}WASM component built", style::success_prefix())),
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

/// Probe the host for the WASM build toolchain and bail with an actionable
/// message if it's incomplete. Checks (a) `cargo component` is runnable and
/// (b) the `wasm32-wasip2` rustup target is installed (only when `rustup`
/// itself is present — non-rustup installs are left to cargo-component).
fn preflight_wasm_toolchain() -> Result<()> {
    let cargo_component_ok = Command::new("cargo")
        .args(["component", "--version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    // `rustup target list --installed` is the only portable way to confirm
    // the target. If rustup is absent we can't (and shouldn't) assert on it.
    let installed_targets = Command::new("rustup")
        .args(["target", "list", "--installed"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    if let Some(problem) = wasm_toolchain_problem(cargo_component_ok, installed_targets.as_deref())
    {
        bail!("{problem}");
    }
    Ok(())
}

/// Pure decision core for `preflight_wasm_toolchain` — kept separate so the
/// guidance text can be unit-tested without depending on what's installed
/// on the test machine.
fn wasm_toolchain_problem(
    cargo_component_ok: bool,
    installed_targets: Option<&str>,
) -> Option<String> {
    if !cargo_component_ok {
        return Some(
            "cargo-component is required to build WASM plugins but was not found.\n\
             Install it with:\n    cargo install --locked cargo-component\n\
             then re-run `cognia plugin build`."
                .to_string(),
        );
    }
    if let Some(list) = installed_targets {
        let has_target = list.lines().any(|line| line.trim() == "wasm32-wasip2");
        if !has_target {
            return Some(
                "the wasm32-wasip2 compilation target is not installed.\n\
                 Add it with:\n    rustup target add wasm32-wasip2\n\
                 then re-run `cognia plugin build`."
                    .to_string(),
            );
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Read;
    use tempfile::tempdir;

    fn write_plugin_json(root: &Path, manifest: &serde_json::Value) {
        std::fs::write(
            root.join("plugin.json"),
            serde_json::to_vec_pretty(manifest).unwrap(),
        )
        .unwrap();
    }

    fn zip_entry_names(path: &Path) -> Vec<String> {
        let bytes = std::fs::read(path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
            .collect();
        names.sort();
        names
    }

    fn zip_entry_text(path: &Path, entry: &str) -> String {
        let bytes = std::fs::read(path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut file = archive.by_name(entry).unwrap();
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        text
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
    fn wasm_preflight_flags_missing_cargo_component() {
        let problem = wasm_toolchain_problem(false, Some("wasm32-wasip2\n"));
        let msg = problem.expect("missing cargo-component should be flagged");
        assert!(msg.contains("cargo-component"), "got: {msg}");
        assert!(msg.contains("cargo install"), "got: {msg}");
    }

    #[test]
    fn wasm_preflight_flags_missing_target() {
        let problem = wasm_toolchain_problem(
            true,
            Some("wasm32-unknown-unknown\nx86_64-pc-windows-msvc\n"),
        );
        let msg = problem.expect("missing target should be flagged");
        assert!(msg.contains("wasm32-wasip2"), "got: {msg}");
        assert!(msg.contains("rustup target add"), "got: {msg}");
    }

    #[test]
    fn wasm_preflight_passes_when_toolchain_complete() {
        assert!(
            wasm_toolchain_problem(true, Some("wasm32-wasip2\nx86_64-pc-windows-msvc\n")).is_none()
        );
    }

    #[test]
    fn wasm_preflight_skips_target_check_without_rustup() {
        // rustup absent → `installed_targets` is None → we can't assert on
        // the target, only on cargo-component being present.
        assert!(wasm_toolchain_problem(true, None).is_none());
        assert!(wasm_toolchain_problem(false, None).is_some());
    }

    #[test]
    fn build_packages_python_plugin_existing_entry_files() {
        let tmp = tempdir().unwrap();
        std::fs::write(tmp.path().join("main.py"), "def activate(ctx): pass\n").unwrap();
        std::fs::write(tmp.path().join("README.md"), "# python plugin\n").unwrap();
        write_plugin_json(
            tmp.path(),
            &json!({
                "id": "py",
                "name": "Python",
                "version": "0.1.0",
                "description": "Python plugin",
                "type": "python",
                "capabilities": ["python"],
                "pythonMain": "main.py",
                "bundle_include": ["README.md"]
            }),
        );
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        let out = tmp.path().join("py.zip");
        run(tmp.path().to_path_buf(), Some(out.clone()), true, &mut ui).unwrap();

        assert_eq!(
            zip_entry_names(&out),
            vec!["README.md", "main.py", "plugin.json"]
        );
        assert!(zip_entry_text(&out, "main.py").contains("activate"));
    }

    #[test]
    fn build_packages_hybrid_plugin_existing_frontend_python_and_styles() {
        let tmp = tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("dist")).unwrap();
        std::fs::create_dir_all(tmp.path().join("backend")).unwrap();
        std::fs::write(
            tmp.path().join("dist/index.js"),
            "exports.activate = () => {}\n",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("backend/main.py"),
            "def activate(ctx): pass\n",
        )
        .unwrap();
        std::fs::write(tmp.path().join("styles.css"), ".plugin { color: red; }\n").unwrap();
        write_plugin_json(
            tmp.path(),
            &json!({
                "id": "hybrid",
                "name": "Hybrid",
                "version": "0.1.0",
                "description": "Hybrid plugin",
                "type": "hybrid",
                "capabilities": ["python"],
                "main": "dist/index.js",
                "pythonMain": "backend/main.py",
                "styles": "styles.css"
            }),
        );
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        let out = tmp.path().join("hybrid.zip");
        run(tmp.path().to_path_buf(), Some(out.clone()), true, &mut ui).unwrap();

        assert_eq!(
            zip_entry_names(&out),
            vec![
                "backend/main.py",
                "dist/index.js",
                "plugin.json",
                "styles.css"
            ]
        );
    }

    #[test]
    fn build_packages_vscode_extension_existing_entry_files() {
        let tmp = tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("extension/out")).unwrap();
        std::fs::write(
            tmp.path().join("extension/out/extension.js"),
            "exports.activate = () => {}\n",
        )
        .unwrap();
        write_plugin_json(
            tmp.path(),
            &json!({
                "id": "vscode-demo",
                "name": "VS Code Demo",
                "version": "0.1.0",
                "description": "VS Code extension",
                "type": "vscode-extension",
                "capabilities": [],
                "vscodeMain": "extension/out/extension.js"
            }),
        );
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        let out = tmp.path().join("vscode.zip");
        run(tmp.path().to_path_buf(), Some(out.clone()), true, &mut ui).unwrap();

        assert_eq!(
            zip_entry_names(&out),
            vec!["extension/out/extension.js", "plugin.json"]
        );
    }
}
