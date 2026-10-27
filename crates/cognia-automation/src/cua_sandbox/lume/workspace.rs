//! Lume transport glue over Task Workspace's existing source/CAS authority.
//! No source bytes are journalled; the durable manifest contains only hashes.
use cognia_desktop_guest::lume::{self, WorkspaceFile};
use cognia_task_workspace::{
    self as workspace, PathPurpose, RevisionPatch, RevisionPatchAction, RevisionPatchFile,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub root: PathBuf,
    #[serde(default)]
    pub root_identity: Option<super::journal::FileIdentity>,
    pub revision: String,
    pub files: Vec<WorkspaceFile>,
    #[serde(default)]
    pub adopted: bool,
}

#[cfg(unix)]
fn root_identity(root: &Path) -> Result<super::journal::FileIdentity, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let opened = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
        .map_err(|_| "lume_workspace_root_replaced")?;
    let metadata = opened
        .metadata()
        .map_err(|_| "lume_workspace_root_replaced")?;
    Ok(super::journal::FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}
pub fn verify_root(source: &Source) -> Result<(), String> {
    #[cfg(unix)]
    {
        if source
            .root
            .canonicalize()
            .map_err(|_| "lume_workspace_root_replaced")?
            != source.root
            || Some(root_identity(&source.root)?) != source.root_identity
        {
            return Err("lume_workspace_root_replaced".into());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = source;
        Err("lume_platform_unsupported".into())
    }
}
pub fn adopt(
    source: &Source,
    patch: &RevisionPatch,
) -> Result<workspace::RevisionApplyOutcome, String> {
    verify_root(source)?;
    workspace::apply_revision_patch_bounded(&source.root, patch)
        .map_err(|_| "lume_workspace_apply_failed".into())
}

#[cfg(all(test, not(unix)))]
mod platform_tests {
    #[test]
    fn replica_preparation_refuses_unsupported_platform() {
        assert_eq!(
            super::prepare(std::path::Path::new(".")).unwrap_err(),
            "lume_platform_unsupported"
        );
    }
}

#[cfg(not(unix))]
pub fn prepare(_root: &Path) -> Result<(Source, Vec<u8>), String> {
    Err("lume_platform_unsupported".into())
}

#[cfg(unix)]
pub fn prepare(root: &Path) -> Result<(Source, Vec<u8>), String> {
    use std::os::unix::fs::MetadataExt;
    let confined = workspace::ConfinedRoot::open(root).map_err(|_| "lume_workspace_root")?;
    let identity = root_identity(confined.path())?;
    let listing = workspace::list_revision_files_bounded(confined.path(), "", Some(5000))
        .map_err(|_| "lume_workspace_capture")?;
    if listing.truncated {
        return Err("lume_workspace_limit".into());
    }
    let mut files = Vec::new();
    let mut executable = std::collections::BTreeSet::new();
    let mut total = 0usize;
    for file in listing.files {
        if lume::workspace_excluded(&file.path) {
            continue;
        }
        // Credentials and excluded metadata never cross this boundary, even
        // when tracked by Git. Other invalid paths refuse the entire import.
        match workspace::normalize_workspace_path(&file.path, PathPurpose::Write) {
            Ok(_)
                if !file
                    .path
                    .split('/')
                    .any(|part| part.eq_ignore_ascii_case(".config")) => {}
            Ok(_) => continue,
            Err(refusal)
                if matches!(
                    refusal.code,
                    workspace::WorkspaceRefusalCode::PathSensitive
                        | workspace::WorkspaceRefusalCode::PathExcluded
                ) =>
            {
                continue
            }
            Err(_) => return Err("lume_workspace_path".into()),
        }
        if file.symlink {
            return Err("lume_workspace_symlink".into());
        }
        let (opened, size) = confined
            .open_file(&file.path)
            .map_err(|_| "lume_workspace_read")?
            .ok_or("lume_workspace_changed")?;
        let metadata = opened.metadata().map_err(|_| "lume_workspace_stat")?;
        if metadata.nlink() != 1 || size > lume::MAX_PAYLOAD as u64 {
            return Err("lume_workspace_file_type_or_limit".into());
        }
        let (_, bytes) = lume::file_operation(
            confined.path(),
            &lume::FileOperation::Read {
                path: file.path.clone(),
            },
            &[],
        )
        .map_err(|_| "lume_workspace_read")?;
        total = total.saturating_add(bytes.len());
        if total > lume::MAX_PAYLOAD || files.len() >= lume::MAX_WORKSPACE_FILES {
            return Err("lume_workspace_limit".into());
        }
        if metadata.mode() & 0o111 != 0 {
            executable.insert(file.path.clone());
        }
        files.push((file.path, bytes));
    }
    if workspace::workspace_revision_bounded(confined.path())
        .map_err(|_| "lume_workspace_capture")?
        .revision
        != listing.revision
    {
        return Err("lume_workspace_source_changed".into());
    }
    let (mut manifest, body) =
        lume::pack_workspace(files).map_err(|_| "lume_workspace_manifest")?;
    for file in &mut manifest {
        file.executable = executable.contains(&file.path);
    }
    let source = Source {
        root: confined.path().into(),
        root_identity: Some(identity),
        revision: listing.revision,
        files: manifest,
        adopted: false,
    };
    verify_root(&source)?;
    Ok((source, body))
}

pub fn changes(
    source: &Source,
    files: &[WorkspaceFile],
    body: &[u8],
) -> Result<RevisionPatch, String> {
    let unpacked = lume::unpack_workspace(files, body).map_err(|_| "lume_workspace_manifest")?;
    let before: BTreeMap<_, _> = source
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let after: BTreeMap<_, _> = files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let mut patch = RevisionPatch {
        format: workspace::REVISION_PATCH_FORMAT.into(),
        base_revision: source.revision.clone(),
        files: Vec::new(),
    };
    let mut total = 0usize;
    for file in files {
        workspace::normalize_workspace_path(&file.path, PathPurpose::Write)
            .map_err(|_| "lume_workspace_path")?;
        if let Some(old) = before.get(file.path.as_str()) {
            if old.executable != file.executable {
                return Err("lume_workspace_mode_change_unsupported".into());
            }
            if old.hash == file.hash {
                continue;
            }
        } else if file.executable {
            return Err("lume_workspace_mode_change_unsupported".into());
        }
        let bytes = &unpacked[&file.path];
        total = total.saturating_add(bytes.len());
        if bytes.len() > workspace::MAX_PATCH_FILE_BYTES || total > workspace::MAX_PATCH_TOTAL_BYTES
        {
            return Err("lume_workspace_patch_limit".into());
        }
        let content = String::from_utf8(bytes.clone())
            .map_err(|_| "lume_workspace_binary_change_requires_download")?;
        patch.files.push(RevisionPatchFile {
            path: file.path.clone(),
            action: RevisionPatchAction::Write,
            content: Some(content),
            content_sha256: Some(file.hash.clone()),
        });
    }
    for file in &source.files {
        if !after.contains_key(file.path.as_str()) {
            patch.files.push(RevisionPatchFile {
                path: file.path.clone(),
                action: RevisionPatchAction::Delete,
                content: None,
                content_sha256: None,
            });
        }
    }
    if patch.files.len() > workspace::MAX_PATCH_FILES {
        return Err("lume_workspace_patch_limit".into());
    }
    Ok(patch)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn adoption_refuses_replaced_root_even_when_contents_and_revision_match() {
        use std::os::unix::fs::symlink;
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("source");
        let other = parent.path().join("other");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&other).unwrap();
        for directory in [&root, &other] {
            std::fs::write(directory.join("a"), "old").unwrap();
        }
        let (source, _) = prepare(&root).unwrap();
        let (files, body) = lume::pack_workspace(vec![("a".into(), b"new".to_vec())]).unwrap();
        let patch = changes(&source, &files, &body).unwrap();
        std::fs::rename(&root, parent.path().join("original")).unwrap();
        symlink(&other, &root).unwrap();
        assert_eq!(
            adopt(&source, &patch).unwrap_err(),
            "lume_workspace_root_replaced"
        );
        assert_eq!(std::fs::read_to_string(other.join("a")).unwrap(), "old");
        std::fs::remove_file(&root).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a"), "old").unwrap();
        assert_eq!(
            adopt(&source, &patch).unwrap_err(),
            "lume_workspace_root_replaced"
        );
    }
    #[test]
    fn source_import_excludes_credentials_and_adoption_is_revision_bound() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("source.txt"), "old").unwrap();
        std::fs::write(root.path().join(".env.local"), "secret").unwrap();
        let (source, body) = prepare(root.path()).unwrap();
        assert!(source.revision.starts_with("wsrev1:"));
        assert_eq!(source.files.len(), 1);
        assert_eq!(body, b"old");
        let (files, body) = lume::pack_workspace(vec![
            ("source.txt".into(), b"new".to_vec()),
            ("created.txt".into(), b"added".to_vec()),
        ])
        .unwrap();
        let patch = changes(&source, &files, &body).unwrap();
        std::fs::write(root.path().join("source.txt"), "concurrent").unwrap();
        let conflict = workspace::apply_revision_patch(root.path(), &patch).unwrap();
        assert_eq!(conflict.status, workspace::RevisionApplyStatus::Conflict);
        assert!(!root.path().join("created.txt").exists());
        std::fs::write(root.path().join("source.txt"), "old").unwrap();
        assert_eq!(
            workspace::apply_revision_patch(root.path(), &patch)
                .unwrap()
                .status,
            workspace::RevisionApplyStatus::Applied
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("source.txt")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join(".env.local")).unwrap(),
            "secret"
        );
    }
    #[test]
    fn review_preserves_deletions_and_refuses_credential_and_binary_changes() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a"), "old").unwrap();
        let (source, _) = prepare(root.path()).unwrap();
        let patch = changes(&source, &[], &[]).unwrap();
        assert_eq!(patch.files[0].action, RevisionPatchAction::Delete);
        let (files, body) = lume::pack_workspace(vec![("a".into(), vec![255])]).unwrap();
        assert_eq!(
            changes(&source, &files, &body).unwrap_err(),
            "lume_workspace_binary_change_requires_download"
        );
        assert!(lume::pack_workspace(vec![("credentials.json".into(), vec![])]).is_err());
    }
}
