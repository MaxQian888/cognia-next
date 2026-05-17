//! `cognia plugin new <name> [--kind wasm|ts]` — stamp the bundled template
//! into a new directory.
//!
//! Two kinds ship today:
//!   * `wasm` (default): Rust + cargo-component starter for a WASM
//!     Component Model plugin.
//!   * `ts`: TypeScript frontend plugin with esbuild + jest already wired.

use anyhow::{bail, Context, Result};
use std::path::PathBuf;

use crate::template::{files_for, next_steps, TemplateKind};

const ID_PATTERN_HINT: &str = "lowercase alphanumeric plus -_.";

pub fn run(name: String, dir: Option<PathBuf>, kind: TemplateKind) -> Result<()> {
    validate_name(&name)?;
    let target_dir = dir.unwrap_or_else(|| PathBuf::from(&name));
    if target_dir.exists() {
        let entries = std::fs::read_dir(&target_dir)
            .ok()
            .map(|d| d.count())
            .unwrap_or(0);
        if entries > 0 {
            bail!("{} already exists and is not empty", target_dir.display());
        }
    }
    std::fs::create_dir_all(&target_dir)
        .with_context(|| format!("create target dir {}", target_dir.display()))?;

    for file in files_for(kind, &name) {
        let dest = target_dir.join(&file.rel_path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("mkdir {}", parent.display()))?;
        }
        std::fs::write(&dest, file.content.as_bytes())
            .with_context(|| format!("write {}", dest.display()))?;
    }

    println!(
        "Created {} plugin at {}",
        match kind {
            TemplateKind::Wasm => "WASM",
            TemplateKind::Ts => "frontend TypeScript",
        },
        target_dir.display()
    );
    println!();
    println!("Next steps:");
    for step in next_steps(kind, &target_dir) {
        println!("  {step}");
    }
    Ok(())
}

pub(crate) fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        bail!("plugin name is empty");
    }
    if name.len() > 64 {
        bail!("plugin name must be ≤ 64 characters");
    }
    let valid = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && name
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic() || c.is_ascii_digit())
            .unwrap_or(false);
    if !valid {
        bail!("plugin name must be {} (got `{}`)", ID_PATTERN_HINT, name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn validate_name_accepts_clean_ids() {
        assert!(validate_name("my-plugin").is_ok());
        assert!(validate_name("foo.bar_1").is_ok());
        assert!(validate_name("0plugin").is_ok());
    }

    #[test]
    fn validate_name_rejects_bad_ids() {
        assert!(validate_name("").is_err());
        assert!(validate_name("has space").is_err());
        assert!(validate_name("!banged").is_err());
        assert!(validate_name(&"a".repeat(100)).is_err());
    }

    #[test]
    fn new_stamps_wasm_template_by_default() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("hello-wasm");
        run("hello-wasm".into(), Some(target.clone()), TemplateKind::Wasm).unwrap();
        for relpath in [
            "Cargo.toml",
            "src/lib.rs",
            "plugin.json",
            "wit/world.wit",
            "README.md",
        ] {
            assert!(target.join(relpath).exists(), "missing: {relpath}");
        }
        let cargo = std::fs::read_to_string(target.join("Cargo.toml")).unwrap();
        assert!(cargo.contains(r#"name = "hello-wasm""#));
        let manifest = std::fs::read_to_string(target.join("plugin.json")).unwrap();
        assert!(manifest.contains(r#""id": "hello-wasm""#));
    }

    #[test]
    fn new_stamps_ts_template_when_kind_ts() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("hello-ts");
        run("hello-ts".into(), Some(target.clone()), TemplateKind::Ts).unwrap();
        for relpath in [
            "package.json",
            "tsconfig.json",
            "jest.config.cjs",
            "plugin.json",
            "src/index.ts",
            "src/index.test.ts",
            "src/__shims__/types/plugin.ts",
            "src/__shims__/lib/chat/slash-command-registry.ts",
            "README.md",
        ] {
            assert!(target.join(relpath).exists(), "missing: {relpath}");
        }
        let pkg = std::fs::read_to_string(target.join("package.json")).unwrap();
        assert!(pkg.contains(r#""name": "hello-ts""#));
        let manifest = std::fs::read_to_string(target.join("plugin.json")).unwrap();
        assert!(manifest.contains(r#""id": "hello-ts""#));
        assert!(manifest.contains(r#""type": "frontend""#));
    }

    #[test]
    fn new_rejects_non_empty_target() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("occupied");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("seed"), "x").unwrap();
        let err = run("occupied".into(), Some(target), TemplateKind::Wasm).unwrap_err();
        assert!(err.to_string().contains("not empty"));
    }

    #[test]
    fn new_creates_target_dir_when_missing() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("nested").join("dir").join("plugin");
        run("plugin".into(), Some(target.clone()), TemplateKind::Ts).unwrap();
        assert!(target.exists());
        assert!(target.join("package.json").exists());
    }
}
