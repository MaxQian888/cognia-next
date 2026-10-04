//! The conversion overlay: the only files a converted plugin may add or change.
//!
//! `convertPluginBundle` on the TS side turns a foreign bundle (Claude Code,
//! Codex, Gemini, Cursor, Factory Droid, …) into a Cognia one by rewriting
//! `plugin.json` and emitting an entry shim. The installers copy the SOURCE
//! tree verbatim and then apply that rewrite on top, so a resource-bearing
//! skill keeps its original bytes and the renderer never gets to place
//! arbitrary files on disk.
//!
//! Conversion also has to NEUTRALIZE source files whose raw contents must not
//! survive an install: the vendor manifests and MCP configs it consumed (they
//! may hold literal credentials the canonical manifest replaced with preset
//! fields) and `.env*` files. That is the second, narrowly typed operation:
//!
//! - **generate**: `GENERATED_FILE_PATHS` only, any content up to the size cap.
//! - **neutralize**: any other relative path, but only when the file ALREADY
//!   EXISTS in the staged tree as a regular file (not a symlink, contained in
//!   the root after resolving every ancestor) and the new content is exactly
//!   one of `NEUTRALIZED_CONTENTS`. It can blank a file; it can never create
//!   one or put chosen bytes into one.
//!
//! The TS side enforces the same contract before it hands the map over
//! (`lib/plugin/convert/source-snapshot.ts:generatedFilesFrom`); keep the two
//! lists in agreement.
//!
//! The frontend is not a trust boundary, so every rule is checked here rather
//! than at each call site. Lifted out of `github::installer` when the
//! Load-unpacked path needed the same overlay. One implementation, two
//! installers.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// The only relative paths the converter may write with arbitrary content.
pub const GENERATED_FILE_PATHS: &[&str] = &["plugin.json", "dist/index.js"];

/// The only contents a neutralizing overwrite of an existing file may carry:
/// an empty JSON object (manifests, MCP configs) or a bare newline (`.env*`).
pub const NEUTRALIZED_CONTENTS: &[&str] = &["{}\n", "\n"];

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

/// Overwrite an existing regular file inside `root` with neutralized content.
fn neutralize_existing(root: &Path, path: &str, contents: &str) -> Result<(), String> {
    if !NEUTRALIZED_CONTENTS.contains(&contents) {
        return Err(format!(
            "generated conversion file is not allowlisted and is not a neutralization: {path}"
        ));
    }
    let relative = Path::new(path);
    if path.is_empty()
        || relative.is_absolute()
        || !relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(format!("invalid neutralization path: {path}"));
    }
    let destination = root.join(relative);
    let metadata = std::fs::symlink_metadata(&destination).map_err(|_| {
        format!("neutralization target does not exist in the staged plugin: {path}")
    })?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "neutralization target is not a regular file (symlinks and directories are refused): {path}"
        ));
    }
    // A hard link shares its inode with a file that may live outside the
    // staged tree; blanking it would blank that file too. Callers stage fresh
    // copies today, but this function is public, so it enforces the rule.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(format!(
                "neutralization target has other hard links and is refused: {path}"
            ));
        }
    }
    // A symlinked ancestor directory could still point the write outside the
    // staged tree: compare the resolved parent against the resolved root.
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("resolve staged plugin root {root:?}: {e}"))?;
    let parent = destination
        .parent()
        .ok_or_else(|| format!("invalid neutralization path: {path}"))?
        .canonicalize()
        .map_err(|e| format!("resolve neutralization parent for {path}: {e}"))?;
    if !parent.starts_with(&canonical_root) {
        return Err(format!(
            "neutralization target escapes the staged plugin through a symlink: {path}"
        ));
    }
    // Never write through the checked path: a symlink swapped in after the
    // checks would be followed. Write a sibling temp file in the resolved
    // parent and atomically rename it over the entry, which replaces the
    // directory entry itself rather than whatever it points to.
    let file_name = destination
        .file_name()
        .ok_or_else(|| format!("invalid neutralization path: {path}"))?;
    let target = parent.join(file_name);
    let mut staged = tempfile::NamedTempFile::new_in(&parent)
        .map_err(|e| format!("create neutralization temp file in {parent:?}: {e}"))?;
    std::io::Write::write_all(&mut staged, contents.as_bytes())
        .map_err(|e| format!("write neutralization temp file for {path}: {e}"))?;
    staged
        .persist(&target)
        .map_err(|e| format!("neutralize conversion source file {target:?}: {}", e.error))?;
    Ok(())
}

/// Apply the pure converter's output inside a staging tree.
///
/// Accepts only the files the shared converter is designed to generate, plus
/// neutralizations of source files that already exist. Source resources
/// otherwise remain untouched.
pub fn apply_generated_files(root: &Path, files: &BTreeMap<String, String>) -> Result<(), String> {
    for (path, contents) in files {
        if contents.len() > MAX_GENERATED_FILE_BYTES {
            return Err(format!(
                "generated conversion file exceeds {MAX_GENERATED_FILE_BYTES} bytes: {path}"
            ));
        }
        if !GENERATED_FILE_PATHS.contains(&path.as_str()) {
            neutralize_existing(root, path, contents)?;
            continue;
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

        let arbitrary =
            BTreeMap::from([("scripts/postinstall.sh".to_string(), "exit 0".to_string())]);
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
    fn neutralizes_existing_regular_files_only() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".claude-plugin")).unwrap();
        std::fs::write(
            tmp.path().join(".claude-plugin/plugin.json"),
            r#"{"name":"x","mcpServers":{"a":{"env":{"TOKEN":"secret"}}}}"#,
        )
        .unwrap();
        std::fs::write(tmp.path().join(".mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
        std::fs::write(tmp.path().join(".env"), "API_KEY=secret").unwrap();
        let files = BTreeMap::from([
            (".claude-plugin/plugin.json".to_string(), "{}\n".to_string()),
            (".mcp.json".to_string(), "{}\n".to_string()),
            (".env".to_string(), "\n".to_string()),
            ("plugin.json".to_string(), r#"{"id":"x"}"#.to_string()),
        ]);
        apply_generated_files(tmp.path(), &files).unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.path().join(".claude-plugin/plugin.json")).unwrap(),
            "{}\n"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join(".mcp.json")).unwrap(),
            "{}\n"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join(".env")).unwrap(),
            "\n"
        );
    }

    #[test]
    fn neutralization_refuses_missing_paths_and_arbitrary_content() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".mcp.json"), "{}").unwrap();
        let missing =
            BTreeMap::from([(".cursor-plugin/plugin.json".to_string(), "{}\n".to_string())]);
        let err = apply_generated_files(tmp.path(), &missing).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        assert!(!tmp.path().join(".cursor-plugin").exists());

        for content in ["{ }\n", "{}", "", "{\"a\":1}\n", "x"] {
            let arbitrary = BTreeMap::from([(".mcp.json".to_string(), content.to_string())]);
            let err = apply_generated_files(tmp.path(), &arbitrary).unwrap_err();
            assert!(err.contains("not allowlisted"), "{content:?}: {err}");
        }
        assert_eq!(
            std::fs::read_to_string(tmp.path().join(".mcp.json")).unwrap(),
            "{}"
        );
    }

    #[test]
    fn neutralization_refuses_traversal_and_directories() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("plugin");
        std::fs::create_dir_all(root.join("dir")).unwrap();
        std::fs::write(outer.path().join("victim.json"), "keep").unwrap();
        for path in ["../victim.json", "/etc/passwd", "./dir/../x", "dir", ""] {
            let files = BTreeMap::from([(path.to_string(), "{}\n".to_string())]);
            assert!(apply_generated_files(&root, &files).is_err(), "{path}");
        }
        assert_eq!(
            std::fs::read_to_string(outer.path().join("victim.json")).unwrap(),
            "keep"
        );
    }

    #[cfg(unix)]
    #[test]
    fn neutralization_refuses_symlinks_and_symlinked_ancestors() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("plugin");
        let elsewhere = outer.path().join("elsewhere");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("secret.json"), "keep").unwrap();
        std::os::unix::fs::symlink(elsewhere.join("secret.json"), root.join("link.json")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("linked-dir")).unwrap();
        for path in ["link.json", "linked-dir/secret.json"] {
            let files = BTreeMap::from([(path.to_string(), "{}\n".to_string())]);
            let err = apply_generated_files(&root, &files).unwrap_err();
            assert!(err.contains("symlink"), "{path}: {err}");
        }
        assert_eq!(
            std::fs::read_to_string(elsewhere.join("secret.json")).unwrap(),
            "keep"
        );
    }

    #[cfg(unix)]
    #[test]
    fn neutralization_refuses_hard_linked_targets() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("plugin");
        std::fs::create_dir_all(&root).unwrap();
        let outside = outer.path().join("outside.json");
        std::fs::write(&outside, "keep").unwrap();
        std::fs::hard_link(&outside, root.join(".mcp.json")).unwrap();
        let files = BTreeMap::from([(".mcp.json".to_string(), "{}\n".to_string())]);
        let err = apply_generated_files(&root, &files).unwrap_err();
        assert!(err.contains("hard links"), "{err}");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
        assert_eq!(
            std::fs::read_to_string(root.join(".mcp.json")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn neutralization_replaces_the_entry_atomically() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("config")).unwrap();
        std::fs::write(
            tmp.path().join("config/servers.json"),
            r#"{"token":"secret"}"#,
        )
        .unwrap();
        let files = BTreeMap::from([("config/servers.json".to_string(), "{}\n".to_string())]);
        apply_generated_files(tmp.path(), &files).unwrap();
        assert_eq!(
            std::fs::read(tmp.path().join("config/servers.json")).unwrap(),
            b"{}\n"
        );
        // The temp file was renamed into place, not left beside it.
        let entries: Vec<_> = std::fs::read_dir(tmp.path().join("config"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("servers.json")]);
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
