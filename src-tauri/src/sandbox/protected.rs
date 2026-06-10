// ADR-0028 — protected paths that stay non-writable even inside a writable
// root.
//
// Both mature reference sandboxes carve credential / VCS-control paths out of
// the writable set so a sandboxed command can't rewrite git hooks, SSH keys,
// or shell rc files to gain persistence or exfiltrate secrets
// (`anthropic-experimental/sandbox-runtime` mandatory-deny list,
// `openai/codex` `.git` / `.codex` exclusion). This module is the single
// source of truth for that list; the Linux backend re-binds these read-only
// over a writable root, and the macOS backend emits matching `(deny
// file-write*)` rules.
//
// Pure + platform-agnostic on purpose: the list and the join logic are unit
// tested on every host, while the platform backends consume it behind their
// own `cfg`.

use std::path::{Path, PathBuf};

/// Relative names (files or directories) that must never be writable even
/// when nested under a writable root. Directory entries protect the whole
/// subtree; file entries protect the single file.
pub const PROTECTED_RELATIVE: &[&str] = &[
    ".git",
    ".ssh",
    ".gnupg",
    ".aws",
    ".config/gh",
    ".docker/config.json",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".gitconfig",
    ".git-credentials",
    ".env",
    ".envrc",
    ".bashrc",
    ".zshrc",
    ".profile",
];

/// For each writable `root`, the concrete protected paths to re-deny. Only
/// the join is performed here (pure); existence is the backend's concern —
/// `bwrap --ro-bind` / SBPL `deny` both tolerate non-existent paths.
pub fn protected_paths_under(root: &Path) -> Vec<PathBuf> {
    PROTECTED_RELATIVE.iter().map(|name| root.join(name)).collect()
}

/// True when `candidate` is, or is nested under, any protected path beneath
/// one of `roots`. Used to reject an explicit write target that aims at a
/// protected path before the command is ever spawned.
pub fn is_protected(candidate: &Path, roots: &[PathBuf]) -> bool {
    for root in roots {
        for protected in protected_paths_under(root) {
            if candidate == protected || candidate.starts_with(&protected) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_list_is_non_empty_and_includes_git_and_ssh() {
        assert!(PROTECTED_RELATIVE.contains(&".git"));
        assert!(PROTECTED_RELATIVE.contains(&".ssh"));
        assert!(PROTECTED_RELATIVE.contains(&".env"));
    }

    #[test]
    fn protected_paths_join_under_root() {
        let root = PathBuf::from("/workspace");
        let paths = protected_paths_under(&root);
        assert!(paths.contains(&PathBuf::from("/workspace/.git")));
        assert!(paths.contains(&PathBuf::from("/workspace/.ssh")));
        assert_eq!(paths.len(), PROTECTED_RELATIVE.len());
    }

    #[test]
    fn is_protected_matches_exact_and_nested() {
        let roots = vec![PathBuf::from("/workspace")];
        assert!(is_protected(&PathBuf::from("/workspace/.git"), &roots));
        assert!(is_protected(&PathBuf::from("/workspace/.git/hooks/pre-commit"), &roots));
        assert!(is_protected(&PathBuf::from("/workspace/.ssh/id_rsa"), &roots));
    }

    #[test]
    fn is_protected_rejects_unrelated_paths() {
        let roots = vec![PathBuf::from("/workspace")];
        assert!(!is_protected(&PathBuf::from("/workspace/src/main.rs"), &roots));
        assert!(!is_protected(&PathBuf::from("/workspace/gitignore"), &roots));
        // A `.git` under a DIFFERENT root is not protected by this root.
        assert!(!is_protected(&PathBuf::from("/other/.git"), &roots));
    }
}
