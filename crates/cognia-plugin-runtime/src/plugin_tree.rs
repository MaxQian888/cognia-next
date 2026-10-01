//! An installed plugin's files as data, both ways (ADR-0209).
//!
//! **Export** reads an installed plugin's tree for a cogpack.
//! A cogpack embeds a plugin that has no re-fetchable origin (a local
//! directory, a hand-imported manifest). The importer installs it with the same
//! directory installer a "Load unpacked" uses, so this reads the tree with the
//! same rules that installer applies: regular files only, symbolic links
//! skipped, nothing outside the plugin's own install directory. Version-control
//! metadata (`.git`) is not part of a plugin and is left out.
//!
//! The walk is bounded so a runaway directory fails here, before the renderer
//! allocates it, with limits that match the cogpack's own archive limits.
//!
//! **Import** writes an embedded plugin's files into a staging directory the
//! directory installer then installs. The webview cannot do that itself: its
//! file-system scope does not reach a temp directory. Every path is checked
//! here, before anything is written: relative, no `..`, no absolute or drive
//! prefix, no Windows stream or device names, and no two paths that one
//! case-insensitive file system (APFS, NTFS) would store as the same file.

use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

#[cfg(feature = "tauri-host")]
use tauri::State;

use super::{PluginError, PluginRuntimeState, Result};

/// Directories that are never part of a plugin's installable tree.
const SKIP_DIRS: &[&str] = &[".git"];
/// Matches `COGPACK_LIMITS.maxFiles` in `lib/plugin/cogpack/package.ts`.
pub const MAX_EXPORT_FILES: usize = 8192;
/// Matches `COGPACK_LIMITS.maxExpandedBytes`.
pub const MAX_EXPORT_BYTES: u64 = 300 * 1024 * 1024;

/// How much one plugin tree may hold, in either direction.
#[derive(Debug, Clone, Copy)]
struct TreeLimits {
    files: usize,
    bytes: u64,
}

const COGPACK_TREE_LIMITS: TreeLimits = TreeLimits {
    files: MAX_EXPORT_FILES,
    bytes: MAX_EXPORT_BYTES,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportedPluginFile {
    /// Path relative to the plugin root, `/`-separated.
    pub path: String,
    pub base64: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportedPluginTree {
    pub plugin_id: String,
    pub files: Vec<ExportedPluginFile>,
    pub total_bytes: u64,
}

fn collect(dir: &Path, limits: TreeLimits, out: &mut Vec<PathBuf>, total: &mut u64) -> Result<()> {
    let mut entries = std::fs::read_dir(dir)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(PluginError::from)?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if SKIP_DIRS
                .iter()
                .any(|skip| entry.file_name() == std::ffi::OsStr::new(skip))
            {
                continue;
            }
            collect(&path, limits, out, total)?;
        } else if file_type.is_file() {
            *total += entry.metadata()?.len();
            out.push(path);
            if out.len() > limits.files {
                return Err(too_many_files(limits));
            }
            if *total > limits.bytes {
                return Err(too_large(limits));
            }
        }
    }
    Ok(())
}

fn too_many_files(limits: TreeLimits) -> PluginError {
    PluginError::Internal(format!(
        "a plugin in a cogpack may carry at most {} files",
        limits.files
    ))
}

fn too_large(limits: TreeLimits) -> PluginError {
    PluginError::Internal(format!(
        "a plugin in a cogpack may carry at most {} bytes",
        limits.bytes
    ))
}

/// Read `plugin_dir` as the importer would install it.
pub fn read_plugin_tree(plugin_id: &str, plugin_dir: &Path) -> Result<ExportedPluginTree> {
    read_plugin_tree_within(plugin_id, plugin_dir, COGPACK_TREE_LIMITS)
}

fn read_plugin_tree_within(
    plugin_id: &str,
    plugin_dir: &Path,
    limits: TreeLimits,
) -> Result<ExportedPluginTree> {
    if !plugin_dir.is_dir() {
        return Err(PluginError::NotFound(plugin_id.to_string()));
    }
    let root = plugin_dir.canonicalize()?;
    let mut paths = Vec::new();
    let mut total = 0u64;
    collect(&root, limits, &mut paths, &mut total)?;
    if !paths.iter().any(|path| path == &root.join("plugin.json")) {
        return Err(PluginError::Internal(format!(
            "plugin {plugin_id} has no plugin.json at its root"
        )));
    }
    let engine = base64::engine::general_purpose::STANDARD;
    // The walk sized the tree from metadata; the files are read afterwards, so
    // the read enforces the limit again on the bytes it actually gets.
    let mut read_total = 0u64;
    let files = paths
        .into_iter()
        .map(|path| {
            let bytes =
                read_regular_file(&path, limits.bytes - read_total).map_err(
                    |error| match error {
                        PluginError::Internal(ref message) if message == GREW => too_large(limits),
                        other => other,
                    },
                )?;
            read_total += bytes.len() as u64;
            let relative = path
                .strip_prefix(&root)
                .map_err(|_| {
                    PluginError::Internal(format!("plugin file escaped its root: {path:?}"))
                })?
                .components()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            Ok(ExportedPluginFile {
                path: relative,
                size: bytes.len() as u64,
                base64: engine.encode(&bytes),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ExportedPluginTree {
        plugin_id: plugin_id.to_string(),
        files,
        total_bytes: read_total,
    })
}

/// Read `path` only if it is still the regular file the walk found, and at
/// most `limit` bytes of it.
///
/// A running plugin can write into its own install directory, so between the
/// walk and this read a file may have been swapped for a symbolic link (which
/// would export whatever it points at) or grown past the cogpack's limit. The
/// file is checked without following links, then opened, and the opened
/// handle must be the same file the check saw.
const GREW: &str = "plugin file grew past the cogpack limit while it was exported";

fn read_regular_file(path: &Path, limit: u64) -> Result<Vec<u8>> {
    use std::io::Read as _;
    let before = std::fs::symlink_metadata(path)?;
    if !before.file_type().is_file() {
        return Err(PluginError::Internal(format!(
            "plugin file changed while it was exported: {path:?}"
        )));
    }
    let file = open_no_follow(path)?;
    let opened = file.metadata()?;
    if !opened.file_type().is_file() || !same_file(&before, &opened) {
        return Err(PluginError::Internal(format!(
            "plugin file changed while it was exported: {path:?}"
        )));
    }
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(PluginError::Internal(GREW.to_string()));
    }
    Ok(bytes)
}

#[cfg(windows)]
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt as _;
    // FILE_FLAG_OPEN_REPARSE_POINT: open a link itself, never its target.
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(0x0020_0000)
        .open(path)
}

#[cfg(not(windows))]
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

#[cfg(unix)]
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(unix))]
fn same_file(_: &std::fs::Metadata, _: &std::fs::Metadata) -> bool {
    // No stable file identity in std here. Opened with
    // FILE_FLAG_OPEN_REPARSE_POINT, a swapped-in link opens as itself and
    // reports as one, which the `is_file` check on the handle refuses.
    true
}

/// One embedded file on the way in: a package-relative path and its bytes.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedPluginFile {
    pub path: String,
    pub base64: String,
}

/// Names Windows reserves for devices, with or without an extension.
const WINDOWS_DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Whether one path segment is a name every host stores as itself: no NTFS
/// stream (`a.js:x`), no device name (`CON`, `nul.js`), no trailing dot or
/// space (Windows drops them, so `a.js.` would land on `a.js`).
fn portable_segment(part: &str) -> bool {
    if part.contains(':') || part.ends_with('.') || part.ends_with(' ') {
        return false;
    }
    let stem = part.split('.').next().unwrap_or(part).to_ascii_lowercase();
    !WINDOWS_DEVICE_NAMES.contains(&stem.as_str())
}

/// The relative path `input` names, or an error when it could leave `root`
/// or would not be stored as written.
fn safe_relative_path(input: &str) -> Result<PathBuf> {
    let unsafe_path =
        || PluginError::Internal(format!("embedded plugin path is unsafe: {input:?}"));
    let normalized = input.replace('\\', "/");
    let path = Path::new(&normalized);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_str().ok_or_else(unsafe_path)?;
                if !portable_segment(text) {
                    return Err(unsafe_path());
                }
                out.push(part)
            }
            Component::CurDir => {}
            _ => return Err(unsafe_path()),
        }
    }
    if out.as_os_str().is_empty() || normalized.contains('\0') {
        return Err(PluginError::Internal(format!(
            "embedded plugin path is unsafe: {input:?}"
        )));
    }
    Ok(out)
}

/// Write `files` under `dir`, which must exist and be empty of these paths.
pub fn materialize_plugin_tree(files: &[EmbeddedPluginFile], dir: &Path) -> Result<()> {
    materialize_within(files, dir, COGPACK_TREE_LIMITS)
}

fn materialize_within(files: &[EmbeddedPluginFile], dir: &Path, limits: TreeLimits) -> Result<()> {
    if files.len() > limits.files {
        return Err(too_many_files(limits));
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    let mut has_manifest = false;
    let mut decoded = Vec::with_capacity(files.len());
    for file in files {
        let relative = safe_relative_path(&file.path)?;
        // APFS and NTFS ignore case: `PLUGIN.JSON` would overwrite the
        // `plugin.json` the import review read, so a case-only twin is refused.
        let key = relative.to_string_lossy().to_lowercase();
        if !seen.insert(key) {
            return Err(PluginError::Internal(format!(
                "embedded plugin lists {:?} twice",
                file.path
            )));
        }
        if relative == Path::new("plugin.json") {
            has_manifest = true;
        }
        // Refuse before decoding: one oversized entry must not be allocated.
        let estimate = (file.base64.len() as u64 / 4).saturating_mul(3);
        if total.saturating_add(estimate) > limits.bytes + 2 {
            return Err(too_large(limits));
        }
        let bytes = engine.decode(file.base64.as_bytes()).map_err(|error| {
            PluginError::Internal(format!("{}: invalid base64: {error}", file.path))
        })?;
        total += bytes.len() as u64;
        if total > limits.bytes {
            return Err(too_large(limits));
        }
        decoded.push((relative, bytes));
    }
    if !has_manifest {
        return Err(PluginError::Internal(
            "an embedded plugin must carry plugin.json at its root".to_string(),
        ));
    }
    for (relative, bytes) in decoded {
        let target = dir.join(&relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, bytes)?;
    }
    Ok(())
}

/// Host-neutral entry point: the plugin id names the directory, never a path.
pub async fn plugin_export_tree_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
) -> Result<ExportedPluginTree> {
    crate::validate_plugin_id_path_component(&plugin_id)?;
    let plugin_dir = state.plugin_dir(&plugin_id);
    tokio::task::spawn_blocking(move || read_plugin_tree(&plugin_id, &plugin_dir))
        .await
        .map_err(|error| PluginError::Internal(format!("export task failed: {error}")))?
}

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_export_tree(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
) -> Result<ExportedPluginTree> {
    plugin_export_tree_for_state(state.inner(), plugin_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("plugin.json"), br#"{"id":"x"}"#).unwrap();
        std::fs::create_dir_all(dir.path().join("dist/nested")).unwrap();
        std::fs::write(dir.path().join("dist/nested/a.js"), b"export {}").unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), b"ref").unwrap();
        dir
    }

    #[test]
    fn reads_regular_files_relative_to_the_root_and_skips_vcs_metadata() {
        let dir = tree();
        let exported = read_plugin_tree("x", dir.path()).unwrap();
        let paths: Vec<_> = exported.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["dist/nested/a.js", "plugin.json"]);
        let js = exported
            .files
            .iter()
            .find(|f| f.path == "dist/nested/a.js")
            .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&js.base64)
                .unwrap(),
            b"export {}"
        );
        assert_eq!(js.size, 9);
        assert_eq!(exported.total_bytes, 9 + 10);
    }

    #[cfg(unix)]
    #[test]
    fn skips_symbolic_links() {
        let dir = tree();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"s").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), dir.path().join("link")).unwrap();
        let exported = read_plugin_tree("x", dir.path()).unwrap();
        assert!(exported.files.iter().all(|f| f.path != "link"));
    }

    fn embedded(path: &str, bytes: &[u8]) -> EmbeddedPluginFile {
        EmbeddedPluginFile {
            path: path.to_string(),
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }

    #[test]
    fn materializes_what_it_exported() {
        let source = tree();
        let exported = read_plugin_tree("x", source.path()).unwrap();
        let files: Vec<_> = exported
            .files
            .iter()
            .map(|f| EmbeddedPluginFile {
                path: f.path.clone(),
                base64: f.base64.clone(),
            })
            .collect();
        let target = tempfile::tempdir().unwrap();
        materialize_plugin_tree(&files, target.path()).unwrap();
        assert_eq!(
            std::fs::read(target.path().join("dist/nested/a.js")).unwrap(),
            b"export {}"
        );
        assert!(target.path().join("plugin.json").is_file());
    }

    #[test]
    fn refuses_unsafe_duplicate_and_manifestless_trees() {
        let target = tempfile::tempdir().unwrap();
        for bad in ["../evil.js", "/etc/passwd", "a/../../b"] {
            let files = vec![embedded("plugin.json", b"{}"), embedded(bad, b"x")];
            assert!(
                materialize_plugin_tree(&files, target.path()).is_err(),
                "{bad}"
            );
        }
        let duplicate = vec![
            embedded("plugin.json", b"{}"),
            embedded("./plugin.json", b"{}"),
        ];
        assert!(materialize_plugin_tree(&duplicate, target.path()).is_err());
        assert!(materialize_plugin_tree(&[embedded("a.js", b"x")], target.path()).is_err());
        let bad_base64 = vec![EmbeddedPluginFile {
            path: "plugin.json".into(),
            base64: "%%%".into(),
        }];
        assert!(materialize_plugin_tree(&bad_base64, target.path()).is_err());
        // Nothing was written for any refused tree.
        assert!(std::fs::read_dir(target.path()).unwrap().next().is_none());
    }

    #[test]
    fn refuses_case_twins_backslash_traversal_and_non_portable_names() {
        let target = tempfile::tempdir().unwrap();
        // `PLUGIN.JSON` would overwrite the reviewed `plugin.json` on APFS / NTFS.
        let twin = vec![
            embedded("plugin.json", b"{}"),
            embedded("PLUGIN.JSON", b"{}"),
        ];
        assert!(materialize_plugin_tree(&twin, target.path()).is_err());
        let nested_twin = vec![
            embedded("plugin.json", b"{}"),
            embedded("dist/a.js", b"x"),
            embedded("Dist/A.js", b"y"),
        ];
        assert!(materialize_plugin_tree(&nested_twin, target.path()).is_err());
        for bad in [
            "a\\..\\..\\b",
            "a.js:stream",
            "CON",
            "nul.js",
            "lib/Com1.txt",
            "a.js.",
            "a.js ",
        ] {
            let files = vec![embedded("plugin.json", b"{}"), embedded(bad, b"x")];
            assert!(
                materialize_plugin_tree(&files, target.path()).is_err(),
                "{bad}"
            );
        }
        // Lookalikes of device names are ordinary files.
        let fine = vec![embedded("plugin.json", b"{}"), embedded("console.js", b"x")];
        materialize_plugin_tree(&fine, target.path()).unwrap();
        assert!(target.path().join("console.js").is_file());
    }

    const SMALL: TreeLimits = TreeLimits {
        files: 3,
        bytes: 16,
    };

    #[test]
    fn enforces_the_file_count_and_size_limits_both_ways() {
        let target = tempfile::tempdir().unwrap();
        let too_many: Vec<_> = std::iter::once(embedded("plugin.json", b"{}"))
            .chain((0..3).map(|i| embedded(&format!("f{i}"), b"")))
            .collect();
        assert!(materialize_within(&too_many, target.path(), SMALL).is_err());
        let too_large = vec![embedded("plugin.json", b"{}"), embedded("a", &[0u8; 15])];
        assert!(materialize_within(&too_large, target.path(), SMALL).is_err());
        // An entry whose base64 alone exceeds the budget is refused before decoding,
        // even when that base64 is not valid.
        let oversized = EmbeddedPluginFile {
            path: "big.bin".into(),
            base64: "%".repeat(64),
        };
        let error = materialize_within(
            &[embedded("plugin.json", b"{}"), oversized],
            target.path(),
            SMALL,
        )
        .unwrap_err();
        assert!(error.to_string().contains("at most 16 bytes"), "{error}");
        assert!(std::fs::read_dir(target.path()).unwrap().next().is_none());
        let fits = vec![embedded("plugin.json", b"{}"), embedded("a", &[0u8; 14])];
        materialize_within(&fits, target.path(), SMALL).unwrap();

        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("plugin.json"), b"{}").unwrap();
        for i in 0..3 {
            std::fs::write(source.path().join(format!("f{i}")), b"").unwrap();
        }
        assert!(read_plugin_tree_within("x", source.path(), SMALL).is_err());
        let heavy = tempfile::tempdir().unwrap();
        std::fs::write(heavy.path().join("plugin.json"), [b' '; 17]).unwrap();
        assert!(read_plugin_tree_within("x", heavy.path(), SMALL).is_err());
        assert!(read_plugin_tree_within("x", heavy.path(), COGPACK_TREE_LIMITS).is_ok());
    }

    #[test]
    fn reads_at_most_the_budget_it_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("grown.bin");
        std::fs::write(&path, vec![0u8; 16]).unwrap();
        assert_eq!(read_regular_file(&path, 16).unwrap().len(), 16);
        assert!(read_regular_file(&path, 15).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_file_swapped_for_a_link_after_the_walk() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"s").unwrap();
        let path = dir.path().join("a.js");
        std::os::unix::fs::symlink(outside.path().join("secret"), &path).unwrap();
        assert!(read_regular_file(&path, 1024).is_err());
    }

    #[tokio::test]
    async fn export_refuses_a_plugin_id_that_is_a_path() {
        let root = tempfile::tempdir().unwrap();
        let state = PluginRuntimeState::new(root.path().to_path_buf());
        for bad in ["../x", "a/b", "..", ""] {
            assert!(
                plugin_export_tree_for_state(&state, bad.to_string())
                    .await
                    .is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn refuses_a_tree_without_a_manifest_and_a_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.js"), b"x").unwrap();
        assert!(read_plugin_tree("x", dir.path()).is_err());
        assert!(matches!(
            read_plugin_tree("x", &dir.path().join("absent")),
            Err(PluginError::NotFound(_))
        ));
    }
}
