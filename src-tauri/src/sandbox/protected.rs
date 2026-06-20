// ADR-0028 — protected paths that stay non-writable (and, for credential
// stores, non-readable) even inside a writable root, plus the system / app
// directories that may never be a sandbox writable root at all.
//
// Both mature reference sandboxes carve credential / VCS-control paths out of
// the writable set so a sandboxed command can't rewrite git hooks, SSH keys,
// or shell rc files to gain persistence or exfiltrate secrets
// (`anthropic-experimental/sandbox-runtime` mandatory-deny list,
// `openai/codex` `.git` / `.codex` exclusion). This module is the single
// source of truth for that list; the Linux backend re-binds these read-only
// (or empty, for secrets / non-existent paths) over a writable root, and the
// macOS backend emits matching `(deny file-write*)` / `(deny file-read*)`
// rules.
//
// Two tiers (the audit's read-vs-write distinction):
//   * SECRET — credential stores (`.ssh`, `.aws`, `.git-credentials`, …): a
//     sandboxed command must neither READ nor WRITE these; read is itself the
//     exfiltration threat. Linux binds an empty read-only source over them so
//     the contents are hidden; macOS emits `(deny file-read*)` + `(deny
//     file-write*)`.
//   * WRITE-PROTECTED — VCS control + shell rc + project config (`.git`,
//     `.bashrc`, `.env`, …): readable (a build legitimately reads them) but
//     never writable (persistence / hook-injection threat).
//
// Pure + platform-agnostic on purpose: the list and the join logic are unit
// tested on every host, while the platform backends consume it behind their
// own `cfg`.

use std::path::{Path, PathBuf};

/// Whether a protected entry is conventionally a directory or a single file.
/// The Linux backend uses this to pick the empty source it binds over a
/// non-existent / secret path (`/dev/null` for a file, an empty read-only
/// directory for a directory) so creation is blocked regardless of existence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtKind {
    Dir,
    File,
}

/// A protected entry relative to a writable root.
#[derive(Debug, Clone, Copy)]
pub struct Protected {
    /// Path relative to a writable root (may contain separators, e.g.
    /// `.config/gh`).
    pub rel: &'static str,
    /// Directory vs single file — drives the empty-source choice on Linux.
    pub kind: ProtKind,
    /// `true` for credential stores that must be unreadable as well as
    /// unwritable; `false` for write-protected-but-readable control files.
    pub secret: bool,
}

/// The single source of truth. Directory entries protect the whole subtree;
/// file entries protect the single file. `secret` entries are denied read too,
/// and are blocked even when they don't exist yet (creating `~/.ssh/...` is
/// always hostile); write-protected entries are existence-gated so a fresh
/// `git init` / creating a new rc file still works (the threat is REWRITING an
/// existing repo's hooks / rc, not creating one). `.env` is deliberately NOT
/// listed — it is commonly a project file the agent legitimately edits.
pub const PROTECTED: &[Protected] = &[
    // ── Write-protected (readable, never re-writable): VCS + shell rc.
    Protected { rel: ".git", kind: ProtKind::Dir, secret: false },
    Protected { rel: ".gitconfig", kind: ProtKind::File, secret: false },
    Protected { rel: ".bashrc", kind: ProtKind::File, secret: false },
    Protected { rel: ".bash_profile", kind: ProtKind::File, secret: false },
    Protected { rel: ".zshrc", kind: ProtKind::File, secret: false },
    Protected { rel: ".profile", kind: ProtKind::File, secret: false },
    Protected { rel: ".terraformrc", kind: ProtKind::File, secret: false },
    // ── Secret credential stores (neither readable nor writable).
    Protected { rel: ".ssh", kind: ProtKind::Dir, secret: true },
    Protected { rel: ".gnupg", kind: ProtKind::Dir, secret: true },
    Protected { rel: ".aws", kind: ProtKind::Dir, secret: true },
    Protected { rel: ".git-credentials", kind: ProtKind::File, secret: true },
    Protected { rel: ".netrc", kind: ProtKind::File, secret: true },
    Protected { rel: ".npmrc", kind: ProtKind::File, secret: true },
    Protected { rel: ".pypirc", kind: ProtKind::File, secret: true },
    Protected { rel: ".pgpass", kind: ProtKind::File, secret: true },
    Protected { rel: ".docker/config.json", kind: ProtKind::File, secret: true },
    Protected { rel: ".config/gh", kind: ProtKind::Dir, secret: true },
    Protected { rel: ".config/gcloud", kind: ProtKind::Dir, secret: true },
    Protected { rel: ".kube/config", kind: ProtKind::File, secret: true },
    Protected { rel: ".cargo/credentials", kind: ProtKind::File, secret: true },
    Protected { rel: ".cargo/credentials.toml", kind: ProtKind::File, secret: true },
    Protected { rel: ".gem/credentials", kind: ProtKind::File, secret: true },
    // ── cognia's own per-platform app-data dir (OAuth credential configs,
    // keyring markers, native vector store). Re-denied when a writable root is
    // an ancestor (e.g. the user's home). The configurable writable-root
    // ceiling is the primary defence; this is belt-and-suspenders.
    Protected { rel: ".local/share/cognia", kind: ProtKind::Dir, secret: true },
    Protected { rel: ".config/cognia", kind: ProtKind::Dir, secret: true },
    Protected { rel: "Library/Application Support/cognia", kind: ProtKind::Dir, secret: true },
    Protected { rel: "AppData/Roaming/cognia", kind: ProtKind::Dir, secret: true },
    Protected { rel: "AppData/Local/cognia", kind: ProtKind::Dir, secret: true },
];

/// For each writable `root`, the concrete protected entries (joined path +
/// kind + secret flag). Only the join is performed here (pure); existence is
/// the backend's concern.
pub fn protected_entries_under(root: &Path) -> Vec<(PathBuf, ProtKind, bool)> {
    PROTECTED
        .iter()
        .map(|p| (root.join(p.rel), p.kind, p.secret))
        .collect()
}

/// Back-compat helper: the joined protected paths (both tiers) under `root`.
pub fn protected_paths_under(root: &Path) -> Vec<PathBuf> {
    PROTECTED.iter().map(|p| root.join(p.rel)).collect()
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

/// System directories that must never be a sandbox writable root, regardless
/// of policy. Containment-based: a writable path that IS or is UNDER one of
/// these is rejected. The filesystem root itself (`/`, `C:\`) is handled
/// separately in [`is_forbidden_writable`] because every absolute path
/// "starts with" it. The OS temp dir and the user's home are deliberately
/// absent (they are legitimate sandbox roots — Python scratch uses temp).
pub fn system_forbidden_roots() -> Vec<PathBuf> {
    #[cfg(unix)]
    {
        [
            "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/proc", "/sys",
            "/dev", "/run", "/var/run",
        ]
        .iter()
        .map(PathBuf::from)
        .collect()
    }
    #[cfg(windows)]
    {
        let mut roots = Vec::new();
        for var in ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
            if let Some(v) = std::env::var_os(var) {
                if !v.is_empty() {
                    roots.push(PathBuf::from(v));
                }
            }
        }
        if roots.is_empty() {
            // Last-resort defaults if the environment is stripped.
            roots.push(PathBuf::from("C:\\Windows"));
            roots.push(PathBuf::from("C:\\Program Files"));
        }
        roots
    }
    #[cfg(not(any(unix, windows)))]
    {
        Vec::new()
    }
}

/// Lower-cased `Normal` components of a path (drops root / prefix / `.` / `..`,
/// the last two already rejected by canonicalization).
fn normal_components_lower(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect()
}

/// True when `needle` appears as a contiguous run inside `haystack`.
fn contains_run(haystack: &[String], needle: &[String]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// True when ANY protected entry appears as a path segment anywhere in
/// `candidate` (e.g. `.git` / `.ssh` as a component, or `.config/gh` as two
/// consecutive components). Used to reject a single-file write target
/// (Edit/Write/TextEditor) that aims into a credential / VCS-control location
/// regardless of which root it claims — file tools have no writable root for
/// the per-root re-deny to key on, so this is their floor. Case-insensitive.
pub fn is_protected_anywhere(candidate: &Path) -> bool {
    let comps = normal_components_lower(candidate);
    PROTECTED.iter().any(|p| {
        let needle = normal_components_lower(Path::new(p.rel));
        contains_run(&comps, &needle)
    })
}

/// True when `candidate` may not be a sandbox writable root: it is the
/// filesystem root itself, or it is / is-under any of `deny_roots`. Paths are
/// compared after canonicalization by the dispatcher, so symlink / `..` tricks
/// are already resolved by the time this runs.
pub fn is_forbidden_writable(candidate: &Path, deny_roots: &[PathBuf]) -> bool {
    // The filesystem root (`/` on unix, `C:\` on Windows) has no parent.
    if candidate.parent().is_none() {
        return true;
    }
    deny_roots
        .iter()
        .any(|r| candidate == r.as_path() || candidate.starts_with(r))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_list_is_non_empty_and_includes_git_and_ssh() {
        assert!(PROTECTED.iter().any(|p| p.rel == ".git" && !p.secret));
        assert!(PROTECTED.iter().any(|p| p.rel == ".ssh" && p.secret));
        // `.env` is intentionally NOT protected (project files get edited).
        assert!(!PROTECTED.iter().any(|p| p.rel == ".env"));
    }

    #[test]
    fn secret_entries_are_marked_and_write_protected_are_not() {
        let ssh = PROTECTED.iter().find(|p| p.rel == ".ssh").unwrap();
        assert!(ssh.secret);
        assert_eq!(ssh.kind, ProtKind::Dir);
        let git_creds = PROTECTED.iter().find(|p| p.rel == ".git-credentials").unwrap();
        assert!(git_creds.secret);
        assert_eq!(git_creds.kind, ProtKind::File);
        let git = PROTECTED.iter().find(|p| p.rel == ".git").unwrap();
        assert!(!git.secret);
    }

    #[test]
    fn protected_entries_join_under_root_with_kind_and_secret() {
        let root = PathBuf::from("/workspace");
        let entries = protected_entries_under(&root);
        assert!(entries
            .iter()
            .any(|(p, k, s)| p == &PathBuf::from("/workspace/.ssh") && *k == ProtKind::Dir && *s));
        assert!(entries
            .iter()
            .any(|(p, _, s)| p == &PathBuf::from("/workspace/.git") && !*s));
        assert_eq!(entries.len(), PROTECTED.len());
    }

    #[test]
    fn protected_paths_join_under_root() {
        let root = PathBuf::from("/workspace");
        let paths = protected_paths_under(&root);
        assert!(paths.contains(&PathBuf::from("/workspace/.git")));
        assert!(paths.contains(&PathBuf::from("/workspace/.ssh")));
        assert_eq!(paths.len(), PROTECTED.len());
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
        assert!(!is_protected(&PathBuf::from("/other/.git"), &roots));
    }

    #[test]
    fn forbidden_writable_rejects_root_and_system_dirs() {
        let deny = vec![PathBuf::from("/etc"), PathBuf::from("/usr")];
        // Filesystem root itself.
        #[cfg(unix)]
        assert!(is_forbidden_writable(Path::new("/"), &deny));
        assert!(is_forbidden_writable(Path::new("/etc"), &deny));
        assert!(is_forbidden_writable(Path::new("/etc/cron.d"), &deny));
        assert!(is_forbidden_writable(Path::new("/usr/local/lib"), &deny));
    }

    #[test]
    fn forbidden_writable_allows_workspace_and_temp() {
        let deny = vec![PathBuf::from("/etc"), PathBuf::from("/usr")];
        assert!(!is_forbidden_writable(Path::new("/home/u/project"), &deny));
        assert!(!is_forbidden_writable(Path::new("/tmp/scratch"), &deny));
        // A path whose name merely starts with a denied dir's string but is a
        // sibling (different component) must not be falsely rejected.
        assert!(!is_forbidden_writable(Path::new("/etcetera"), &deny));
    }

    #[test]
    fn is_protected_anywhere_catches_credential_and_vcs_segments() {
        assert!(is_protected_anywhere(Path::new("/home/u/.ssh/authorized_keys")));
        assert!(is_protected_anywhere(Path::new("/workspace/.git/hooks/pre-commit")));
        assert!(is_protected_anywhere(Path::new("/home/u/.config/gh/hosts.yml")));
        assert!(is_protected_anywhere(Path::new("/home/u/.aws/credentials")));
        // Case-insensitive.
        assert!(is_protected_anywhere(Path::new("/home/u/.SSH/id_rsa")));
    }

    #[test]
    fn is_protected_anywhere_allows_ordinary_and_lookalike_paths() {
        assert!(!is_protected_anywhere(Path::new("/workspace/src/main.rs")));
        assert!(!is_protected_anywhere(Path::new("/workspace/.env"))); // not listed
        assert!(!is_protected_anywhere(Path::new("/home/u/.config/myapp/x"))); // .config/gh only
        assert!(!is_protected_anywhere(Path::new("/workspace/gitignore")));
    }

    #[test]
    fn system_forbidden_roots_is_non_empty_on_supported_os() {
        let roots = system_forbidden_roots();
        #[cfg(any(unix, windows))]
        assert!(!roots.is_empty());
        let _ = roots;
    }
}
