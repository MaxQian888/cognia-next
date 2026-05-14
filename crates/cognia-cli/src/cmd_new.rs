//! `cognia plugin new <name>` — stamp the bundled template into a new dir.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

use crate::template;

const ID_PATTERN_HINT: &str = "lowercase alphanumeric plus -_.";

pub fn run(name: String, dir: Option<PathBuf>) -> Result<()> {
    validate_name(&name)?;
    let target_dir = dir.unwrap_or_else(|| PathBuf::from(&name));
    if target_dir.exists() {
        let entries = std::fs::read_dir(&target_dir)
            .ok()
            .map(|d| d.count())
            .unwrap_or(0);
        if entries > 0 {
            bail!(
                "{} already exists and is not empty",
                target_dir.display()
            );
        }
    }
    std::fs::create_dir_all(&target_dir).with_context(|| {
        format!("create target dir {}", target_dir.display())
    })?;
    write_file(&target_dir, "Cargo.toml", &template::substitute_name(template::CARGO_TOML, &name))?;
    write_file(
        &target_dir.join("src"),
        "lib.rs",
        &template::substitute_name(template::SRC_LIB_RS, &name),
    )?;
    write_file(
        &target_dir,
        "plugin.json",
        &template::substitute_name(template::PLUGIN_JSON, &name),
    )?;
    write_file(&target_dir.join("wit"), "world.wit", template::WIT_WORLD)?;
    write_file(&target_dir, "README.md", template::README)?;
    write_file(&target_dir, ".gitignore", template::GITIGNORE)?;
    println!("Created plugin at {}", target_dir.display());
    println!();
    println!("Next steps:");
    println!("  cd {}", target_dir.display());
    println!("  rustup target add wasm32-wasip2");
    println!("  cargo install --locked cargo-component");
    println!("  cognia plugin build");
    Ok(())
}

fn write_file(dir: &Path, name: &str, content: &str) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("mkdir {}", dir.display()))?;
    let path = dir.join(name);
    std::fs::write(&path, content).with_context(|| format!("write {}", path.display()))?;
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
    fn new_stamps_template_into_dir() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("hello-wasm");
        run("hello-wasm".into(), Some(target.clone())).unwrap();
        for relpath in [
            "Cargo.toml",
            "src/lib.rs",
            "plugin.json",
            "wit/world.wit",
            "README.md",
        ] {
            assert!(target.join(relpath).exists(), "missing: {relpath}");
        }
        let cargo =
            std::fs::read_to_string(target.join("Cargo.toml")).unwrap();
        assert!(cargo.contains(r#"name = "hello-wasm""#));
        let manifest =
            std::fs::read_to_string(target.join("plugin.json")).unwrap();
        assert!(manifest.contains(r#""id": "hello-wasm""#));
    }

    #[test]
    fn new_rejects_non_empty_target() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("occupied");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("seed"), "x").unwrap();
        let err = run("occupied".into(), Some(target)).unwrap_err();
        assert!(err.to_string().contains("not empty"));
    }
}
