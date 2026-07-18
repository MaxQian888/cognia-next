use crate::resource::{is_sensitive_resource, media_type_for};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub path: String,
    pub kind: EntryKind,
    pub hash: String,
    pub size: u64,
    pub mode: Option<u32>,
    pub binary: bool,
    pub media_type: String,
    pub sensitive: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    pub entries: BTreeMap<String, SnapshotEntry>,
}

pub fn capture(root: &Path) -> Result<(WorkspaceSnapshot, HashMap<String, Vec<u8>>), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize root {}: {error}", root.display()))?;
    let mut entries = BTreeMap::new();
    let mut blobs = HashMap::new();
    let mut builder = WalkBuilder::new(&canonical_root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .ignore(true)
        .parents(true)
        .require_git(false)
        .follow_links(false);

    for item in builder.build() {
        let entry = item.map_err(|error| format!("walk {}: {error}", canonical_root.display()))?;
        let path = entry.path();
        if path == canonical_root || excluded(path, &canonical_root) {
            continue;
        }
        let file_type = entry
            .file_type()
            .ok_or_else(|| format!("missing file type: {}", path.display()))?;
        if file_type.is_dir() {
            continue;
        }
        let rel = path
            .strip_prefix(&canonical_root)
            .map_err(|_| format!("path escapes workspace: {}", path.display()))?;
        let rel_path = rel.to_string_lossy().replace('\\', "/");
        let (kind, bytes) = if file_type.is_symlink() {
            let target = fs::read_link(path)
                .map_err(|error| format!("read link {}: {error}", path.display()))?;
            validate_symlink_target(rel, &target)?;
            (
                EntryKind::Symlink,
                target.to_string_lossy().as_bytes().to_vec(),
            )
        } else if file_type.is_file() {
            (
                EntryKind::File,
                fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?,
            )
        } else {
            continue;
        };
        let hash = hex::encode(Sha256::digest(&bytes));
        let binary = kind == EntryKind::File && detect_binary(&bytes);
        let mode = file_mode(path);
        entries.insert(
            rel_path.clone(),
            SnapshotEntry {
                path: rel_path,
                kind,
                hash: hash.clone(),
                size: bytes.len() as u64,
                mode,
                binary,
                media_type: media_type_for(rel.to_string_lossy().as_ref(), binary).to_string(),
                sensitive: is_sensitive_resource(rel.to_string_lossy().as_ref()),
            },
        );
        blobs.entry(hash).or_insert(bytes);
    }
    Ok((WorkspaceSnapshot { entries }, blobs))
}

fn validate_symlink_target(link_path: &Path, target: &Path) -> Result<(), String> {
    use std::path::Component;
    if target.is_absolute() {
        return Err(format!(
            "symlink escapes workspace: {} -> {}",
            link_path.display(),
            target.display()
        ));
    }
    let mut depth = link_path
        .parent()
        .map_or(0, |parent| parent.components().count());
    for component in target.components() {
        match component {
            Component::ParentDir if depth == 0 => {
                return Err(format!(
                    "symlink escapes workspace: {} -> {}",
                    link_path.display(),
                    target.display()
                ));
            }
            Component::ParentDir => depth -= 1,
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => {
                return Err("absolute symlink target is not allowed".into());
            }
        }
    }
    Ok(())
}

fn excluded(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    rel.components().any(|component| {
        matches!(
            component.as_os_str().to_str(),
            Some(".git" | "node_modules" | ".next" | "dist" | "target")
        )
    })
}

pub fn materialize(
    root: &Path,
    snapshot: &WorkspaceSnapshot,
    blobs: &HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("create {}: {error}", root.display()))?;
    for entry in snapshot.entries.values() {
        let target = root.join(PathBuf::from(&entry.path));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        let bytes = blobs
            .get(&entry.hash)
            .ok_or_else(|| format!("missing blob {}", entry.hash))?;
        match entry.kind {
            EntryKind::File => {
                fs::write(&target, bytes)
                    .map_err(|error| format!("write {}: {error}", target.display()))?;
                apply_mode(&target, entry.mode)?;
            }
            EntryKind::Symlink => create_symlink(&target, bytes)?,
        }
    }
    Ok(())
}

pub fn detect_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    sample.contains(&0) || std::str::from_utf8(sample).is_err()
}

#[cfg(unix)]
fn file_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    path.symlink_metadata()
        .ok()
        .map(|meta| meta.permissions().mode())
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Option<u32> {
    None
}

#[cfg(unix)]
fn apply_mode(path: &Path, mode: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|error| format!("chmod {}: {error}", path.display()))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn apply_mode(_path: &Path, _mode: Option<u32>) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn create_symlink(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::symlink;
    let target =
        String::from_utf8(bytes.to_vec()).map_err(|_| "invalid symlink target".to_string())?;
    symlink(target, path).map_err(|error| format!("symlink {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    #[test]
    fn capture_rejects_symlinks_that_escape_the_workspace() {
        use std::os::unix::fs::symlink;
        let root = TempDir::new().unwrap();
        symlink("../../outside", root.path().join("escape")).unwrap();
        assert!(capture(root.path())
            .unwrap_err()
            .contains("escapes workspace"));
    }
}

#[cfg(windows)]
fn create_symlink(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::windows::fs::symlink_file;
    let target =
        String::from_utf8(bytes.to_vec()).map_err(|_| "invalid symlink target".to_string())?;
    symlink_file(target, path).map_err(|error| format!("symlink {}: {error}", path.display()))
}
