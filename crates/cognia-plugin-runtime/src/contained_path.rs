//! Contained-path validation for executable files declared by plugins.

use std::path::{Component, Path, PathBuf};
use std::{
    ffi::OsString,
    io::{Read, Write},
};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};

pub(crate) fn validate_plugin_relative_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("plugin path must not be empty".into());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("plugin path contains a control character".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if ["%2e", "%2f", "%5c"]
        .iter()
        .any(|encoded| lower.contains(encoded))
    {
        return Err("plugin path contains encoded traversal characters".into());
    }
    if trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.starts_with("//")
        || trimmed.starts_with("\\\\")
        || trimmed
            .as_bytes()
            .get(1)
            .is_some_and(|separator| *separator == b':')
    {
        return Err("plugin path must be relative".into());
    }
    if trimmed
        .split(['/', '\\'])
        .any(|component| component == "..")
    {
        return Err("plugin path contains parent traversal".into());
    }
    if trimmed.find(':').is_some_and(|colon| {
        let scheme = &trimmed[..colon];
        !scheme.is_empty()
            && scheme
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
    }) {
        return Err("plugin path must not be a URI".into());
    }

    let normalized = trimmed
        .replace('\\', "/")
        .split('/')
        .filter(|component| !component.is_empty() && *component != ".")
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        return Err("plugin path must not be empty".into());
    }
    let relative = PathBuf::from(normalized);
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("plugin path escapes its root".into());
    }
    Ok(relative)
}

/// Resolve an existing regular file under `root`, rejecting every symlinked
/// segment. Callers invoke this immediately before loading so development
/// directories are revalidated on every load.
pub(crate) fn resolve_existing_plugin_file(root: &Path, value: &str) -> Result<PathBuf, String> {
    let relative = validate_plugin_relative_path(value)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize plugin root {root:?}: {error}"))?;

    let mut cursor = canonical_root.clone();
    for component in relative.components() {
        cursor.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&cursor)
            .map_err(|error| format!("stat plugin path {cursor:?}: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("plugin path traverses a symbolic link: {cursor:?}"));
        }
    }

    let canonical_target = cursor
        .canonicalize()
        .map_err(|error| format!("canonicalize plugin path {cursor:?}: {error}"))?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err("plugin path escapes its root after canonicalization".into());
    }
    if !canonical_target.is_file() {
        return Err(format!(
            "plugin path is not a regular file: {canonical_target:?}"
        ));
    }
    Ok(canonical_target)
}

/// Resolve the caller's claimed root against the host-owned install location.
/// The plugin directory itself must be a real directory, never a symlink.
pub(crate) fn validate_claimed_plugin_root(
    expected: &Path,
    claimed: &Path,
) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(expected)
        .map_err(|error| format!("stat registered plugin root {expected:?}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("registered plugin root must be a non-symlink directory".into());
    }
    let expected = expected
        .canonicalize()
        .map_err(|error| format!("canonicalize registered plugin root: {error}"))?;
    let claimed = claimed
        .canonicalize()
        .map_err(|error| format!("canonicalize claimed plugin root: {error}"))?;
    if claimed != expected {
        return Err("claimed plugin root does not match the host install location".into());
    }
    Ok(expected)
}

fn open_parent_dir(root: &Path, relative: &Path, create: bool) -> Result<(Dir, OsString), String> {
    let mut components = relative.components().peekable();
    let final_name = components
        .next_back()
        .ok_or_else(|| "plugin path must name a file".to_string())?
        .as_os_str()
        .to_os_string();
    let mut dir = Dir::open_ambient_dir(root, ambient_authority())
        .map_err(|error| format!("open plugin root handle {root:?}: {error}"))?;
    for component in components {
        let name = component.as_os_str();
        if create {
            match dir.create_dir(name) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(format!("create plugin directory {name:?}: {error}"));
                }
            }
        }
        dir = dir
            .open_dir_nofollow(name)
            .map_err(|error| format!("open plugin directory without following links: {error}"))?;
    }
    Ok((dir, final_name))
}

/// Resolve and read a native plugin entry through the same no-follow handle.
pub(crate) fn read_existing_plugin_file(root: &Path, value: &str) -> Result<Vec<u8>, String> {
    let relative = validate_plugin_relative_path(value)?;
    let (dir, file_name) = open_parent_dir(root, &relative, false)?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = dir
        .open_with(&file_name, &options)
        .map_err(|error| format!("open plugin file without following links: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("stat opened plugin file: {error}"))?;
    if !metadata.is_file() {
        return Err("opened plugin entry is not a regular file".into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("read opened plugin file: {error}"))?;
    Ok(bytes)
}

/// Write a plugin-owned file through a no-follow final handle. Callers must
/// validate parent segments immediately before invoking this operation.
pub(crate) fn write_plugin_file(root: &Path, value: &str, bytes: &[u8]) -> Result<(), String> {
    let relative = validate_plugin_relative_path(value)?;
    let (dir, file_name) = open_parent_dir(root, &relative, true)?;
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create(true)
        .truncate(true)
        .follow(FollowSymlinks::No);
    let mut file = dir
        .open_with(&file_name, &options)
        .map_err(|error| format!("open plugin file without following links: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("write plugin file {file_name:?}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixtures {
        schema_version: u32,
        valid: Vec<ValidFixture>,
        invalid: Vec<String>,
    }

    #[derive(Deserialize)]
    struct ValidFixture {
        input: String,
        normalized: String,
    }

    fn fixtures() -> Fixtures {
        serde_json::from_str(include_str!(
            "../../../packages/plugin-sdk/contract/path-fixtures.json"
        ))
        .unwrap()
    }

    #[test]
    fn rejects_cross_platform_escape_shapes() {
        let fixtures = fixtures();
        assert_eq!(fixtures.schema_version, 1);
        for value in fixtures.invalid {
            assert!(
                validate_plugin_relative_path(&value).is_err(),
                "expected {value:?} to be rejected"
            );
        }
    }

    #[test]
    fn normalizes_the_shared_valid_fixture_corpus() {
        for fixture in fixtures().valid {
            let actual = validate_plugin_relative_path(&fixture.input).unwrap();
            assert_eq!(actual.to_string_lossy(), fixture.normalized);
        }
    }

    #[test]
    fn resolves_valid_nested_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("dist/nested")).unwrap();
        std::fs::write(
            root.path().join("dist/nested/index.js"),
            "export default {}",
        )
        .unwrap();
        let resolved = resolve_existing_plugin_file(root.path(), "dist\\nested/index.js").unwrap();
        assert!(resolved.ends_with("dist/nested/index.js"));
    }

    #[test]
    fn rejects_a_claimed_root_outside_the_registered_install() {
        let registered = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        assert!(validate_claimed_plugin_root(registered.path(), outside.path()).is_err());
        assert_eq!(
            validate_claimed_plugin_root(registered.path(), registered.path()).unwrap(),
            registered.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn reads_valid_files_from_the_resolved_handle() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("entry.wasm"), b"component").unwrap();
        assert_eq!(
            read_existing_plugin_file(root.path(), "entry.wasm").unwrap(),
            b"component"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_segments_even_when_the_target_stays_inside() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("real")).unwrap();
        std::fs::write(root.path().join("real/index.js"), "export default {}").unwrap();
        symlink(root.path().join("real"), root.path().join("linked")).unwrap();
        let error = resolve_existing_plugin_file(root.path(), "linked/index.js").unwrap_err();
        assert!(error.contains("symbolic link"));
    }
}
