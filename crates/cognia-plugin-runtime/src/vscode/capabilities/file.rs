//! Filesystem capability gate.
//!
//! Allowed paths:
//!   - `<extension_install_dir>/<extension_id>/` (the extension's own files)
//!   - `<global_storage_uri>/<extension_id>/` (cognia-managed scratch)
//!   - Paths the user has explicitly granted via the renderer's permission
//!     prompt — stored in [`super::CapabilityStore::allowed_file_paths`].
//!
//! Anything else is denied with a clear error message.
//!
//! Wired in Phase M3 — module-wide `dead_code` silence until then.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::CapabilityGrants;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FileDecision {
    Allow,
    Deny { reason: String },
}

pub fn check_path(
    grants: &CapabilityGrants,
    extension_install_root: &Path,
    extension_id: &str,
    requested: &Path,
) -> FileDecision {
    let canon = normalise(requested);
    let extension_dir = extension_install_root.join(extension_id);
    if canon.starts_with(normalise(&extension_dir)) {
        return FileDecision::Allow;
    }
    for allowed in &grants.allowed_file_paths {
        if canon.starts_with(normalise(allowed)) {
            return FileDecision::Allow;
        }
    }
    FileDecision::Deny {
        reason: format!(
            "Path {} is not in the allowlist for extension {extension_id}",
            requested.display()
        ),
    }
}

fn normalise(path: &Path) -> PathBuf {
    // Strip "." segments and trailing slashes. We intentionally do NOT
    // call `canonicalize` because the path may not exist on disk yet.
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => continue,
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_under_extension_dir() {
        let root = PathBuf::from("/tmp/ext-root");
        let grants = CapabilityGrants::default();
        let req = PathBuf::from("/tmp/ext-root/cognia.hello/out/extension.js");
        let decision = check_path(&grants, &root, "cognia.hello", &req);
        assert!(matches!(decision, FileDecision::Allow));
    }

    #[test]
    fn denies_sibling_extension() {
        let root = PathBuf::from("/tmp/ext-root");
        let grants = CapabilityGrants::default();
        let req = PathBuf::from("/tmp/ext-root/other.ext/out/extension.js");
        let decision = check_path(&grants, &root, "cognia.hello", &req);
        assert!(matches!(decision, FileDecision::Deny { .. }));
    }

    #[test]
    fn allowlist_lets_user_granted_paths_through() {
        let root = PathBuf::from("/tmp/ext-root");
        let mut grants = CapabilityGrants::default();
        grants
            .allowed_file_paths
            .push(PathBuf::from("/home/me/code"));
        let req = PathBuf::from("/home/me/code/project/src/index.ts");
        let decision = check_path(&grants, &root, "cognia.hello", &req);
        assert!(matches!(decision, FileDecision::Allow));
    }
}
