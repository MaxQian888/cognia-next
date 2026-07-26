//! `cognia plugin sync-types [--path DIR] [--check]` — refresh the vendored
//! `@cognia/*` TypeScript declarations in an existing plugin project.
//!
//! No `@cognia/*` package is published to any registry, so `plugin new` writes
//! the declarations straight into the project and `tsconfig.json` points at them
//! with `paths`. That works, but it freezes them: an author who upgrades the CLI
//! keeps type-checking against whatever host surface shipped when they
//! scaffolded, and the mismatch only shows up at load time.
//!
//! This command rewrites those files from the CLI's own embedded bundle — the
//! same one `plugin new` stamps. Nothing else is touched; the `paths` entries
//! that reference them belong to the author.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

use crate::engine::template::author_type_files;
use crate::ui::{style, RuntimeUi};

pub fn run(path: &Path, check: bool, ui: &mut RuntimeUi) -> Result<()> {
    let files = author_type_files();

    let mut changed: Vec<String> = Vec::new();
    for file in &files {
        let target = path.join(&file.rel_path);
        // A byte comparison rather than a timestamp: the bundle is regenerated
        // on every CLI build, so mtimes churn even when the contents do not.
        let current = fs::read_to_string(&target).ok();
        if current.as_deref() != Some(file.content.as_str()) {
            changed.push(file.rel_path.to_string_lossy().into_owned());
        }
    }

    if changed.is_empty() {
        println!(
            "{} declarations already up to date ({} files)",
            style::success_prefix(),
            files.len()
        );
        return Ok(());
    }

    if check {
        for rel in &changed {
            ui.verbose(format!("stale: {rel}"));
        }
        anyhow::bail!(
            "{} vendored declaration(s) are stale — run `cognia plugin sync-types`",
            changed.len()
        );
    }

    for file in &files {
        let target = path.join(&file.rel_path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
        }
        fs::write(&target, &file.content)
            .with_context(|| format!("writing {}", target.display()))?;
    }

    println!(
        "{} synced {} declarations ({} changed)",
        style::success_prefix(),
        files.len(),
        changed.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::UiFlags;

    fn ui() -> RuntimeUi {
        RuntimeUi::new(UiFlags::default())
    }

    #[test]
    fn writes_every_declaration_into_a_fresh_project() {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), false, &mut ui()).unwrap();

        // The two entry points an author imports, plus one transitive file that
        // only exists because the SDK's public types reach into provider-core.
        for expected in [
            "types/cognia-plugin-sdk.d.ts",
            "types/cognia-plugin-ui.d.ts",
            "types/provider-core/core/client.d.ts",
        ] {
            let rel: std::path::PathBuf = expected.split('/').collect();
            assert!(dir.path().join(rel).is_file(), "missing {expected}");
        }
    }

    #[test]
    fn check_fails_on_a_stale_file_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), false, &mut ui()).unwrap();

        let victim = dir.path().join("types").join("cognia-plugin-ui.d.ts");
        fs::write(&victim, "// drifted").unwrap();

        assert!(run(dir.path(), true, &mut ui()).is_err());
        // --check must not repair what it reports.
        assert_eq!(fs::read_to_string(&victim).unwrap(), "// drifted");
    }

    #[test]
    fn sync_repairs_a_drifted_file() {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), false, &mut ui()).unwrap();

        let victim = dir.path().join("types").join("cognia-plugin-ui.d.ts");
        fs::write(&victim, "// drifted").unwrap();
        run(dir.path(), false, &mut ui()).unwrap();

        assert_ne!(fs::read_to_string(&victim).unwrap(), "// drifted");
        assert!(run(dir.path(), true, &mut ui()).is_ok());
    }
}
