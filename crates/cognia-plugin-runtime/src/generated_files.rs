//! The conversion overlay: the only files a converted plugin may add.
//!
//! `convertPluginBundle` on the TS side turns a Claude Code / Codex / Gemini
//! bundle into a Cognia one by rewriting `plugin.json` and emitting an entry
//! shim. The installers copy the SOURCE tree verbatim and then apply that
//! rewrite on top, so a resource-bearing skill keeps its original bytes and the
//! renderer never gets to place arbitrary files on disk.
//!
//! The frontend is not a trust boundary. Two rules enforce that: the path must
//! be one of `GENERATED_FILE_PATHS`, and it must resolve inside the staging
//! root. Both are checked here rather than at each call site.
//!
//! Lifted out of `github::installer` when the Load-unpacked path needed the
//! same overlay. One implementation, two installers.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// The only relative paths the converter may write.
pub const GENERATED_FILE_PATHS: &[&str] = &["plugin.json", "dist/index.js"];

/// Ceiling on one generated file.
pub const MAX_GENERATED_FILE_BYTES: usize = 2 * 1024 * 1024;

/// Join `subdir` onto `base`, rejecting absolute paths and `..` traversal.
pub fn safe_join(base: &Path, subdir: &str) -> Result<PathBuf, String> {
    let rel = Path::new(subdir);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("invalid subdir '{subdir}'"));
    }
    Ok(base.join(rel))
}

/// Apply the pure converter's output inside a staging tree.
///
/// Accepts only the files the shared converter is designed to generate. Source
/// resources remain untouched.
pub fn apply_generated_files(root: &Path, files: &BTreeMap<String, String>) -> Result<(), String> {
    for (path, contents) in files {
        if !GENERATED_FILE_PATHS.contains(&path.as_str()) {
            return Err(format!(
                "generated conversion file is not allowlisted: {path}"
            ));
        }
        if contents.len() > MAX_GENERATED_FILE_BYTES {
            return Err(format!(
                "generated conversion file exceeds {MAX_GENERATED_FILE_BYTES} bytes: {path}"
            ));
        }
        let destination = safe_join(root, path)?;
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir generated file parent {parent:?}: {e}"))?;
        }
        std::fs::write(&destination, contents)
            .map_err(|e| format!("write generated conversion file {destination:?}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(safe_join(tmp.path(), "../etc").is_err());
        assert!(safe_join(tmp.path(), "a/b").is_ok());
    }

    #[test]
    fn generated_conversion_files_are_confined_and_allowlisted() {
        let tmp = tempfile::tempdir().unwrap();
        let files = BTreeMap::from([
            (
                "plugin.json".to_string(),
                r#"{"id":"converted"}"#.to_string(),
            ),
            (
                "dist/index.js".to_string(),
                "module.exports = {};".to_string(),
            ),
        ]);
        apply_generated_files(tmp.path(), &files).unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("plugin.json")).unwrap(),
            r#"{"id":"converted"}"#
        );
        assert!(tmp.path().join("dist/index.js").exists());

        let traversal = BTreeMap::from([("../plugin.json".to_string(), "{}".to_string())]);
        assert!(apply_generated_files(tmp.path(), &traversal).is_err());

        let arbitrary = BTreeMap::from([(
            "scripts/postinstall.sh".to_string(),
            "exit 0".to_string(),
        )]);
        assert!(apply_generated_files(tmp.path(), &arbitrary).is_err());
    }

    #[test]
    fn oversized_generated_file_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let files = BTreeMap::from([(
            "plugin.json".to_string(),
            "x".repeat(MAX_GENERATED_FILE_BYTES + 1),
        )]);
        assert!(apply_generated_files(tmp.path(), &files).is_err());
    }

    #[test]
    fn empty_overlay_writes_nothing() {
        // The directory installer passes an empty map on the native path, and
        // that must stay byte-for-byte what it did before the overlay existed.
        let tmp = tempfile::tempdir().unwrap();
        apply_generated_files(tmp.path(), &BTreeMap::new()).unwrap();
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }
}
