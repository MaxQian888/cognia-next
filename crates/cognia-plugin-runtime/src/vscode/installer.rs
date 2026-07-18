//! `.vsix` installation.
//!
//! The renderer's `lib/plugin/vscode-shim/vsix-installer.ts` already
//! handles the JSZip-based extraction in JavaScript. This module mirrors
//! the same behaviour in Rust so installation can happen entirely on the
//! Tauri side (out-of-band of the renderer) — useful for headless installs,
//! CI smoke tests, and the upcoming Open VSX background-fetch path
//! (Phase M2).
//!
//! The Rust implementation reads the `.vsix` ZIP, validates the
//! `extension/package.json` shape, and unpacks every file under
//! `extension/` into `<extension_install_dir>/<publisher.name>/`.
//!
//! No JSZip dep — we use the `zip` crate for the actual decompression
//! (already a transitive dep of `tauri-plugin-store`).
//!
//! `dead_code` is silenced because `install_vsix` is called from
//! `commands.rs::plugin_vscode_install_vsix`, which is itself "dead" due
//! to the `tauri::generate_handler!` macro hiding callsites.
#![allow(dead_code)]

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::ZipArchive;

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("VSIX exceeds size cap: {0} bytes")]
    TooLarge(usize),
    #[error("VSIX could not be opened as a ZIP: {0}")]
    InvalidZip(String),
    #[error("VSIX is missing extension/package.json")]
    MissingManifest,
    #[error("VSIX package.json is invalid JSON: {0}")]
    BadManifest(String),
    #[error("VSIX is missing required field: {0}")]
    MissingField(&'static str),
    /// `publisher` / `name` did not survive the strict id rule. Keeping this
    /// distinct from `MissingField` matters: an empty `publisher` used to pass
    /// the `as_str()` check and compose into a traversing id.
    #[error("VSIX has an unusable extension id: {0}")]
    InvalidId(#[from] crate::PluginIdError),
    /// The composed install path resolved outside `install_root`. Structurally
    /// unreachable once `InvalidId` is enforced — kept as a belt-and-braces
    /// assertion because the failure mode is a recursive delete of user data.
    #[error("refusing to install outside the extension root: {0}")]
    PathEscape(String),
    /// A ZIP entry name was not safely enclosed (absolute path, `..`, or a
    /// drive prefix). `enclosed_name()` is what detects this.
    #[error("VSIX contains an unsafe entry path: {0}")]
    UnsafeEntryPath(String),
    /// Decompression-bomb guard. `TooLarge` only bounds the *compressed*
    /// payload, so it cannot catch a small archive that expands unboundedly.
    #[error("VSIX expands past the uncompressed cap ({0} bytes)")]
    UncompressedTooLarge(u64),
    #[error("VSIX contains too many entries: {0}")]
    TooManyEntries(usize),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallResult {
    pub extension_id: String,
    pub install_path: PathBuf,
    pub sha256_hex: String,
    pub package_json: serde_json::Value,
}

const MAX_VSIX_BYTES: usize = 200 * 1024 * 1024;
const MANIFEST_PATH: &str = "extension/package.json";
const EXTENSION_PREFIX: &str = "extension/";
/// Directory form of [`EXTENSION_PREFIX`], for `Path::strip_prefix`.
const EXTENSION_DIR: &str = "extension";

/// Ceiling on the *uncompressed* total. [`MAX_VSIX_BYTES`] bounds only the
/// compressed payload, which a zip bomb trivially sidesteps. Generous enough
/// for the largest real extensions (rust-analyzer unpacks to well under
/// 200 MB) while still stopping pathological expansion.
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 600 * 1024 * 1024;

/// Ceiling on entry count — guards the many-tiny-files variant of the same
/// attack, where total bytes stay small but inode churn does not.
const MAX_ENTRY_COUNT: usize = 20_000;

pub fn install_vsix(payload: &[u8], install_root: &PathBuf) -> Result<InstallResult, InstallError> {
    if payload.len() > MAX_VSIX_BYTES {
        return Err(InstallError::TooLarge(payload.len()));
    }

    let mut hasher = Sha256::new();
    hasher.update(payload);
    let sha256_hex = hex::encode(hasher.finalize());

    let cursor = std::io::Cursor::new(payload);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| InstallError::InvalidZip(format!("{e}")))?;

    if archive.len() > MAX_ENTRY_COUNT {
        return Err(InstallError::TooManyEntries(archive.len()));
    }

    // Read the manifest first to derive the canonical id.
    let manifest_bytes = {
        let mut entry = archive
            .by_name(MANIFEST_PATH)
            .map_err(|_| InstallError::MissingManifest)?;
        let mut buf = Vec::new();
        // Bound the manifest read — `entry.size()` is attacker-declared, so it
        // must not drive an allocation.
        entry
            .by_ref()
            .take(MAX_TOTAL_UNCOMPRESSED_BYTES)
            .read_to_end(&mut buf)?;
        buf
    };
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| InstallError::BadManifest(format!("{e}")))?;
    let publisher = manifest
        .get("publisher")
        .and_then(|v| v.as_str())
        .ok_or(InstallError::MissingField("publisher"))?;
    let name = manifest
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or(InstallError::MissingField("name"))?;

    // Reject rather than rewrite. `sanitize_plugin_id` preserved `.` and the
    // fields were only checked for being JSON *strings* — `""` passed — so
    // `publisher: ""` + `name: "."` composed into the id `".."`, and
    // `install_root.join("..")` escaped the root ahead of a recursive delete.
    let extension_id = format!(
        "{}.{}",
        crate::sanitize_plugin_id_strict("publisher", publisher)?,
        crate::sanitize_plugin_id_strict("name", name)?
    );

    let install_path = install_root.join(&extension_id);
    ensure_direct_child(install_root, &install_path)?;

    // Unpack into staging and swap, so a mid-unpack failure leaves any
    // previously installed version intact. The old code wiped the target
    // first, which turned a failed reinstall into data loss.
    fs::create_dir_all(install_root)?;
    let staging = install_root.join(format!(".staging-{}", Uuid::new_v4()));
    if let Err(err) = unpack_extension(&mut archive, &staging, MAX_TOTAL_UNCOMPRESSED_BYTES) {
        let _ = fs::remove_dir_all(&staging);
        return Err(err);
    }
    swap_into_place(install_root, &staging, &install_path)?;

    Ok(InstallResult {
        extension_id,
        install_path,
        sha256_hex,
        package_json: manifest,
    })
}

/// Assert `candidate` is a *direct child* of `root`.
///
/// Structurally unreachable once `sanitize_plugin_id_strict` gates the id, but
/// the failure it guards is a recursive delete of the user's app data, so it
/// stays as an independent assertion rather than an inherited invariant.
fn ensure_direct_child(root: &Path, candidate: &Path) -> Result<(), InstallError> {
    if candidate.parent() != Some(root) {
        return Err(InstallError::PathEscape(candidate.display().to_string()));
    }
    Ok(())
}

/// Materialise every `extension/`-prefixed entry into `staging`.
///
/// `max_total_uncompressed` is a parameter rather than a direct read of
/// [`MAX_TOTAL_UNCOMPRESSED_BYTES`] so the bomb guard is testable without
/// actually writing 600 MB to disk.
fn unpack_extension<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    staging: &Path,
    max_total_uncompressed: u64,
) -> Result<(), InstallError> {
    fs::create_dir_all(staging)?;
    let mut total_written: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| InstallError::InvalidZip(format!("entry {i}: {e}")))?;

        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(InstallError::UnsafeEntryPath(format!(
                "{} (symbolic link)",
                entry.name()
            )));
        }

        // `enclosed_name()`, not `name()`, is what rejects absolute paths and
        // `..`. The previous `rel.contains("..")` check missed
        // `extension//etc/passwd` — `rel` became `/etc/passwd`, and
        // `Path::join` *replaces* the base when given an absolute path.
        let Some(entry_path) = entry.enclosed_name() else {
            return Err(InstallError::UnsafeEntryPath(entry.name().to_string()));
        };
        let Ok(rel) = entry_path.strip_prefix(EXTENSION_DIR) else {
            continue; // `[Content_Types].xml`, `extension.vsixmanifest`, …
        };
        if rel.as_os_str().is_empty() {
            continue;
        }

        let out_path = staging.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // Bound the copy itself rather than trusting the header's `size()` —
        // a crafted archive can under-report it.
        let budget = max_total_uncompressed.saturating_sub(total_written);
        let mut out = fs::File::create(&out_path)?;
        let written = std::io::copy(&mut entry.by_ref().take(budget + 1), &mut out)?;
        total_written = total_written.saturating_add(written);
        if total_written > max_total_uncompressed {
            return Err(InstallError::UncompressedTooLarge(max_total_uncompressed));
        }
    }
    Ok(())
}

/// Replace `final_path` with `staging` via rename, keeping the previous
/// version recoverable until the swap lands.
fn swap_into_place(
    install_root: &Path,
    staging: &Path,
    final_path: &Path,
) -> Result<(), InstallError> {
    let trash = install_root.join(format!(".trash-{}", Uuid::new_v4()));
    let had_previous = final_path.exists();
    if had_previous {
        fs::rename(final_path, &trash)?;
    }
    if let Err(err) = fs::rename(staging, final_path) {
        // Put the previous version back before surfacing the failure.
        if had_previous {
            let _ = fs::rename(&trash, final_path);
        }
        let _ = fs::remove_dir_all(staging);
        return Err(err.into());
    }
    if had_previous {
        let _ = fs::remove_dir_all(&trash);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::FileOptions;

    fn make_test_vsix() -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let options = FileOptions::<()>::default();
            zip.start_file("extension/package.json", options).unwrap();
            zip.write_all(
                br#"{ "publisher": "cognia", "name": "hello", "version": "1.0.0", "engines": { "vscode": ">=1.74.0" } }"#,
            )
            .unwrap();
            zip.start_file("extension/out/extension.js", options)
                .unwrap();
            zip.write_all(b"module.exports = { activate() {}, deactivate() {} }")
                .unwrap();
            zip.finish().unwrap();
        }
        buf
    }

    #[test]
    fn rejects_payload_over_size_cap() {
        let huge = vec![0u8; MAX_VSIX_BYTES + 1];
        let result = install_vsix(&huge, &PathBuf::from("/tmp/x"));
        assert!(matches!(result, Err(InstallError::TooLarge(_))));
    }

    #[test]
    fn rejects_non_zip_payload() {
        let result = install_vsix(b"not a zip", &PathBuf::from("/tmp/x"));
        assert!(matches!(result, Err(InstallError::InvalidZip(_))));
    }

    #[test]
    fn rejects_symlink_entries() {
        let mut bytes = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut bytes));
            let regular = FileOptions::<()>::default();
            zip.start_file("extension/package.json", regular).unwrap();
            zip.write_all(br#"{ "publisher": "cognia", "name": "hello", "version": "1.0.0" }"#)
                .unwrap();
            zip.add_symlink(
                "extension/out/extension.js",
                "../../outside.js",
                FileOptions::<()>::default(),
            )
            .unwrap();
            zip.finish().unwrap();
        }
        let root = tempfile::tempdir().unwrap();
        let error = install_vsix(&bytes, &root.path().to_path_buf()).unwrap_err();
        assert!(matches!(error, InstallError::UnsafeEntryPath(_)));
    }

    #[test]
    fn install_unpacks_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let result = install_vsix(&make_test_vsix(), &dir.path().to_path_buf()).unwrap();
        assert_eq!(result.extension_id, "cognia.hello");
        assert!(result.install_path.join("out/extension.js").exists());
        assert!(result.sha256_hex.len() == 64);
    }

    /// Build a `.vsix` whose manifest carries an arbitrary `publisher`/`name`.
    fn make_vsix_with_id(publisher: &str, name: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let options = FileOptions::<()>::default();
            zip.start_file("extension/package.json", options).unwrap();
            let manifest = serde_json::json!({
                "publisher": publisher,
                "name": name,
                "version": "1.0.0",
            });
            zip.write_all(manifest.to_string().as_bytes()).unwrap();
            zip.start_file("extension/out/extension.js", options)
                .unwrap();
            zip.write_all(b"module.exports = {}").unwrap();
            zip.finish().unwrap();
        }
        buf
    }

    /// Build a `.vsix` containing one entry with a caller-chosen raw name.
    fn make_vsix_with_entry(entry_name: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let options = FileOptions::<()>::default();
            zip.start_file("extension/package.json", options).unwrap();
            zip.write_all(br#"{ "publisher": "cognia", "name": "hello", "version": "1.0.0" }"#)
                .unwrap();
            zip.start_file(entry_name, options).unwrap();
            zip.write_all(b"pwned").unwrap();
            zip.finish().unwrap();
        }
        buf
    }

    /// THE regression test for the install-root escape.
    ///
    /// `publisher: ""` + `name: "."` composed into the id `".."`, so
    /// `install_root.join("..")` resolved to the *parent* of the extension
    /// root and `remove_dir_all` recursively deleted it — in production that
    /// parent is `<data_dir>/cognia`, i.e. the whole app data directory.
    #[test]
    fn rejects_manifest_yielding_parent_dir_id() {
        let root = tempfile::tempdir().unwrap();
        let install_root = root.path().join("vscode-extensions");
        fs::create_dir_all(&install_root).unwrap();
        // Stand-in for everything that lives beside the extension root.
        let sentinel = root.path().join("precious.db");
        fs::write(&sentinel, b"user data").unwrap();

        let result = install_vsix(&make_vsix_with_id("", "."), &install_root);

        assert!(
            matches!(result, Err(InstallError::InvalidId(_))),
            "expected InvalidId, got {result:?}"
        );
        assert!(
            sentinel.exists(),
            "install must never touch the parent of the extension root"
        );
        assert!(install_root.exists());
    }

    /// The sibling case: `publisher: ""` + `name: ""` composed into `"."`,
    /// which wiped the entire extension root.
    #[test]
    fn rejects_manifest_yielding_current_dir_id() {
        let root = tempfile::tempdir().unwrap();
        let install_root = root.path().to_path_buf();
        let existing = install_root.join("other.extension");
        fs::create_dir_all(&existing).unwrap();

        let result = install_vsix(&make_vsix_with_id("", ""), &install_root);

        assert!(matches!(result, Err(InstallError::InvalidId(_))));
        assert!(
            existing.exists(),
            "install must not wipe already-installed extensions"
        );
    }

    #[test]
    fn rejects_empty_publisher_field() {
        let dir = tempfile::tempdir().unwrap();
        let result = install_vsix(&make_vsix_with_id("", "hello"), &dir.path().to_path_buf());
        assert!(matches!(result, Err(InstallError::InvalidId(_))));
    }

    /// Separators are escaped, not honoured: the install still lands as a
    /// single directory directly under the root.
    #[test]
    fn publisher_with_path_separators_escapes_instead_of_traversing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let result = install_vsix(&make_vsix_with_id("../../etc", "passwd"), &root).unwrap();

        assert_eq!(result.extension_id, "------etc.passwd");
        assert_eq!(result.install_path.parent(), Some(root.as_path()));
        assert!(result.install_path.starts_with(&root));
    }

    #[test]
    fn install_path_must_stay_within_root() {
        let root = Path::new("/tmp/ext-root");
        assert!(ensure_direct_child(root, &root.join("ok.id")).is_ok());
        assert!(ensure_direct_child(root, Path::new("/tmp")).is_err());
        assert!(ensure_direct_child(root, Path::new("/tmp/ext-root/a/b")).is_err());
    }

    /// A `..`-bearing entry must hard-fail rather than be silently skipped.
    #[test]
    fn rejects_traversing_zip_entry() {
        let dir = tempfile::tempdir().unwrap();
        let result = install_vsix(
            &make_vsix_with_entry("extension/../../evil.js"),
            &dir.path().to_path_buf(),
        );
        assert!(
            matches!(result, Err(InstallError::UnsafeEntryPath(_))),
            "expected UnsafeEntryPath, got {result:?}"
        );
    }

    /// `extension//etc/passwd`: the old code string-sliced off the prefix,
    /// producing the *absolute* `/etc/passwd`, and `Path::join` replaces the
    /// base when handed an absolute path. Path-aware handling keeps it inside.
    #[test]
    fn absolute_looking_zip_entry_stays_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        let result = install_vsix(
            &make_vsix_with_entry("extension//etc/passwd"),
            &dir.path().to_path_buf(),
        )
        .unwrap();
        assert!(
            result.install_path.join("etc/passwd").exists(),
            "entry must land under the install path"
        );
        assert!(result.install_path.starts_with(dir.path()));
    }

    #[test]
    fn rejects_zip_bomb_over_total_uncompressed_cap() {
        let staging = tempfile::tempdir().unwrap();
        let payload = make_vsix_with_entry("extension/big.bin");
        let mut archive = ZipArchive::new(std::io::Cursor::new(payload)).unwrap();

        // "pwned" (5 bytes) + package.json blow a 4-byte budget.
        let result = unpack_extension(&mut archive, &staging.path().join("s"), 4);

        assert!(
            matches!(result, Err(InstallError::UncompressedTooLarge(4))),
            "expected UncompressedTooLarge, got {result:?}"
        );
    }

    #[test]
    fn successful_reinstall_swaps_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();

        let first = install_vsix(&make_test_vsix(), &root).unwrap();
        fs::write(first.install_path.join("stale.txt"), b"v1 leftover").unwrap();

        let second = install_vsix(&make_test_vsix(), &root).unwrap();

        assert_eq!(first.install_path, second.install_path);
        assert!(second.install_path.join("out/extension.js").exists());
        assert!(
            !second.install_path.join("stale.txt").exists(),
            "reinstall must replace the tree, not merge into it"
        );
    }

    /// A failed unpack must leave the previously installed version usable —
    /// the old wipe-then-unpack order destroyed it.
    #[test]
    fn failed_unpack_leaves_previous_version_intact() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let good = install_vsix(&make_test_vsix(), &root).unwrap();
        assert!(good.install_path.join("out/extension.js").exists());

        // Same id, but the archive traverses → unpack fails mid-flight.
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let options = FileOptions::<()>::default();
            zip.start_file("extension/package.json", options).unwrap();
            zip.write_all(br#"{ "publisher": "cognia", "name": "hello", "version": "2.0.0" }"#)
                .unwrap();
            zip.start_file("extension/../../evil.js", options).unwrap();
            zip.write_all(b"pwned").unwrap();
            zip.finish().unwrap();
        }
        let result = install_vsix(&buf, &root);

        assert!(matches!(result, Err(InstallError::UnsafeEntryPath(_))));
        assert!(
            good.install_path.join("out/extension.js").exists(),
            "the working version must survive a failed reinstall"
        );
    }

    #[test]
    fn staging_dirs_are_cleaned_on_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();

        let _ = install_vsix(&make_vsix_with_entry("extension/../../evil.js"), &root);

        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let n = e.file_name();
                let n = n.to_string_lossy();
                n.starts_with(".staging-") || n.starts_with(".trash-")
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "staging/trash dirs must not survive a failed install: {leftovers:?}"
        );
    }
}
