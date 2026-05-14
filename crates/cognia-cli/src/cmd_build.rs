//! `cognia plugin build` — run cargo-component then package the bundle.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{packaging, read_plugin_manifest, run_streaming};

pub fn run(path: PathBuf, out: Option<PathBuf>, skip_build: bool) -> Result<()> {
    let crate_root = path.canonicalize().with_context(|| format!("resolve {}", path.display()))?;
    if !crate_root.join("Cargo.toml").exists() {
        bail!("Cargo.toml not found under {}", crate_root.display());
    }
    let (manifest, _) = read_plugin_manifest(&crate_root)?;
    let api_version = manifest
        .get("wasm")
        .and_then(|v| v.get("apiVersion"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("plugin.json is missing wasm.apiVersion"))?
        .to_string();

    if !skip_build {
        run_cargo_component_build(&crate_root)?;
    }

    let plan = packaging::plan_bundle(&crate_root, &manifest)?;

    // Inject the api-version custom section into the produced wasm.
    let wasm_bytes = std::fs::read(&plan.wasm_path)
        .with_context(|| format!("read {}", plan.wasm_path.display()))?;
    let patched = packaging::embed_api_version(&wasm_bytes, &api_version)?;
    let patched_path = plan.wasm_path.clone();
    std::fs::write(&patched_path, &patched)
        .with_context(|| format!("write {}", patched_path.display()))?;

    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("plugin.json is missing id"))?;
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("plugin.json is missing version"))?;

    let bundle_path = out.unwrap_or_else(|| {
        crate_root
            .join("target")
            .join("cognia")
            .join(format!("{id}-{version}.zip"))
    });
    packaging::write_bundle(&bundle_path, &plan, &manifest)?;

    println!("Built {} v{} → {}", id, version, bundle_path.display());
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
    use tempfile::tempdir;

    #[test]
    fn build_errors_when_cargo_toml_missing() {
        let tmp = tempdir().unwrap();
        let err = run(tmp.path().to_path_buf(), None, true).unwrap_err();
        assert!(err.to_string().contains("Cargo.toml"));
    }

    #[test]
    fn build_errors_when_plugin_json_missing() {
        let tmp = tempdir().unwrap();
        std::fs::write(tmp.path().join("Cargo.toml"), "[package]\nname = \"x\"").unwrap();
        let err = run(tmp.path().to_path_buf(), None, true).unwrap_err();
        assert!(err.to_string().contains("plugin.json"));
    }
}
