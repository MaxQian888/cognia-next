//! Filesystem confinement for revision-bound patches and reads (ADR-0188 B4).
//!
//! The delegate workflow hands a worker's patch and a reviewer's reads to the
//! host as workspace-relative strings. Three things make that dangerous, and
//! this module refuses all three at the layer where the kernel would
//! otherwise oblige:
//!
//! * `..` and absolute paths, refused lexically before any syscall;
//! * a **symlink anywhere in the path**, leaf or intermediate, refused after
//!   an `lstat` of every component. The ledger's older rule only checked that
//!   the *parent* canonicalised inside the root, which is a check made after
//!   `remove_file` had already followed the link;
//! * credential-shaped names and directories (`.env`, `id_rsa`, `.ssh`,
//!   `.aws`, …), refused by name so they never reach a model or a patch.
//!
//! The root is canonicalised once; every resolved target is the canonical
//! root joined with components proven to be real directories. A last
//! `canonicalize` of the deepest existing ancestor is the belt to that
//! braces: it catches what `lstat` alone cannot name, such as a Windows
//! junction or a bind mount pointing out of the tree.
//!
//! What this module does **not** claim: a component swapped for a symlink
//! between the check and the write. The leaf is closed with `O_NOFOLLOW`
//! (`FILE_FLAG_OPEN_REPARSE_POINT` on Windows) so a final swap is refused
//! atomically, and the caller holds the per-root lock, but an intermediate
//! directory replaced by another process in that window would need `openat2`
//! (Linux ≥ 5.6 only) to close. The worktree these functions run against is
//! written by a sandbox that has already exited, so the window has no
//! writer — that is the argument, and it is worth stating rather than
//! implying.

use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::resource::is_sensitive_resource;

/// Directories a delegate never reads or writes, whatever the scope says.
/// Mirrors `FORBIDDEN_SEGMENTS` in `packages/router-fusion/src/workflows/delegate-ports.ts`.
pub const CREDENTIAL_DIRECTORIES: [&str; 5] = [".ssh", ".aws", ".gnupg", ".kube", ".docker"];

/// Directories the workspace revision never covers, so a write into one could
/// not be compare-and-swapped against anything. `.git` is also the repository
/// itself: a patch that edits it rewrites history rather than files.
pub const UNCOVERED_DIRECTORIES: [&str; 2] = [".git", "node_modules"];

/// Why a path was refused. The spelling is the wire spelling the TypeScript
/// delegate ports use (`PATH_TRAVERSAL`, `PATH_SENSITIVE`, …) so a host
/// refusal and a package refusal read as one vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkspaceRefusalCode {
    /// Empty, whitespace-only, or nothing but `.` segments.
    PathEmpty,
    /// Absolute, drive-qualified (`C:`), or `~`-rooted.
    PathAbsolute,
    /// Contains a `..` segment.
    PathTraversal,
    /// Control characters, a NUL, or an alternate-data-stream colon.
    PathInvalid,
    /// A credential directory or a credential-shaped file name.
    PathSensitive,
    /// Inside a directory the workspace revision does not cover.
    PathExcluded,
    /// A symlink stands somewhere on the path.
    PathSymlink,
    /// The resolved location is outside the canonical root.
    PathEscape,
    /// A component that must be a directory is a file, or the target is
    /// neither a regular file nor absent.
    PathNotFile,
    /// The file exists but is not part of the revision (ignored or excluded),
    /// so a compare-and-swap could not protect it.
    PathNotCovered,
    /// The patch does not declare the format this host applies, or its base
    /// revision is not a revision this host mints.
    PatchFormat,
    /// The patch is larger than the delegate patch limits allow.
    PatchLimit,
    /// Two entries name the same file.
    PatchDuplicatePath,
    /// A write's `content_sha256` does not hash its `content`, or a delete
    /// carries content.
    PatchContentMismatch,
    /// A delete names a file that the base revision does not contain.
    PatchTargetMissing,
    /// A write would create a file that the revision already has as
    /// something other than a regular file.
    PatchTargetExists,
    /// The file is not valid UTF-8, so it is not text a model or a report
    /// parser can be handed.
    NotText,
    /// The file exists and is confined but could not be read.
    ReadFailed,
}

/// One refused path, with the code a caller switches on and a message a
/// person reads. The message never contains the host path: a refusal travels
/// to a model and to a UI, and the root is not either audience's business.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct WorkspaceRefusal {
    pub code: WorkspaceRefusalCode,
    /// The path as the caller wrote it; `None` for a refusal about the patch
    /// as a whole rather than about one file.
    pub path: Option<String>,
    pub message: String,
}

impl WorkspaceRefusal {
    /// A refusal about one path.
    pub fn new(code: WorkspaceRefusalCode, path: &str, message: impl Into<String>) -> Self {
        Self {
            code,
            path: Some(path.to_string()),
            message: message.into(),
        }
    }

    /// A refusal about the request as a whole.
    pub fn about_request(code: WorkspaceRefusalCode, message: impl Into<String>) -> Self {
        Self {
            code,
            path: None,
            message: message.into(),
        }
    }
}

/// What a path is going to be used for. A write is held to more than a read:
/// `node_modules` is readable context and an unprotectable write target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathPurpose {
    Read,
    Write,
}

/// Normalise a workspace-relative path to one spelling — forward slashes, no
/// `.` segments, no trailing slash — or say why it is refused.
pub fn normalize_workspace_path(
    raw: &str,
    purpose: PathPurpose,
) -> Result<String, WorkspaceRefusal> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(WorkspaceRefusal::new(
            WorkspaceRefusalCode::PathEmpty,
            raw,
            "the path is empty",
        ));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(WorkspaceRefusal::new(
            WorkspaceRefusalCode::PathInvalid,
            raw,
            "the path contains a control character",
        ));
    }
    let slashed = trimmed.replace('\\', "/");
    if slashed.starts_with('/') || slashed.starts_with('~') || drive_qualified(&slashed) {
        return Err(WorkspaceRefusal::new(
            WorkspaceRefusalCode::PathAbsolute,
            raw,
            "the path is absolute; workspace paths are relative to the workspace root",
        ));
    }
    let segments: Vec<&str> = slashed
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();
    if segments.is_empty() {
        return Err(WorkspaceRefusal::new(
            WorkspaceRefusalCode::PathEmpty,
            raw,
            "the path names no file",
        ));
    }
    if segments.contains(&"..") {
        return Err(WorkspaceRefusal::new(
            WorkspaceRefusalCode::PathTraversal,
            raw,
            "the path leaves the workspace with a `..` segment",
        ));
    }
    for segment in &segments {
        if segment.contains(':') {
            return Err(WorkspaceRefusal::new(
                WorkspaceRefusalCode::PathInvalid,
                raw,
                "the path contains a `:`, which names an alternate data stream on Windows",
            ));
        }
        let lower = segment.to_ascii_lowercase();
        if CREDENTIAL_DIRECTORIES.contains(&lower.as_str()) {
            return Err(WorkspaceRefusal::new(
                WorkspaceRefusalCode::PathSensitive,
                raw,
                format!("`{segment}` holds credentials and is never read or written"),
            ));
        }
        if UNCOVERED_DIRECTORIES.contains(&lower.as_str()) {
            let verb = match purpose {
                PathPurpose::Write => "written",
                PathPurpose::Read => "read",
            };
            return Err(WorkspaceRefusal::new(
                WorkspaceRefusalCode::PathExcluded,
                raw,
                format!("`{segment}` is outside the workspace revision and cannot be {verb}"),
            ));
        }
    }
    let normalized = segments.join("/");
    if is_sensitive_resource(&normalized) {
        return Err(WorkspaceRefusal::new(
            WorkspaceRefusalCode::PathSensitive,
            raw,
            "the file name is credential-shaped and is never read or written",
        ));
    }
    Ok(normalized)
}

fn drive_qualified(path: &str) -> bool {
    let mut chars = path.chars();
    matches!((chars.next(), chars.next()), (Some(c), Some(':')) if c.is_ascii_alphabetic())
}

/// What `resolve` found standing at a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetKind {
    File,
    Directory,
}

/// A path proven to live inside the root, with what is there right now.
#[derive(Debug, Clone)]
pub struct ConfinedTarget {
    /// The canonical-root-relative spelling.
    pub relative: String,
    /// The absolute path, built from the canonical root.
    pub path: PathBuf,
    /// `None` when nothing exists at the path yet.
    pub kind: Option<TargetKind>,
}

/// A canonicalised workspace root that resolves relative paths inside itself.
#[derive(Debug, Clone)]
pub struct ConfinedRoot {
    root: PathBuf,
}

impl ConfinedRoot {
    /// Canonicalise `root`, which must be an existing directory.
    pub fn open(root: &Path) -> Result<Self, String> {
        let canonical = root
            .canonicalize()
            .map_err(|error| format!("canonicalize workspace root: {error}"))?;
        if !canonical.is_dir() {
            return Err("the workspace root is not a directory".to_string());
        }
        Ok(Self { root: canonical })
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    /// Resolve an already-normalised relative path, refusing a symlink on any
    /// component and anything that resolves outside the root.
    pub fn resolve(&self, normalized: &str) -> Result<ConfinedTarget, WorkspaceRefusal> {
        let relative = Path::new(normalized);
        if relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(WorkspaceRefusal::new(
                WorkspaceRefusalCode::PathTraversal,
                normalized,
                "the path leaves the workspace",
            ));
        }

        let mut current = self.root.clone();
        let mut deepest_existing = self.root.clone();
        let mut kind = None;
        let segments: Vec<&str> = normalized.split('/').collect();
        let last = segments.len() - 1;
        let mut missing = false;
        for (index, segment) in segments.iter().enumerate() {
            current.push(segment);
            if missing {
                // Once a component is absent the rest cannot exist either, and
                // `lstat` on them says nothing. The parent chain is what the
                // write will create, and it was proven above.
                continue;
            }
            match std::fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(WorkspaceRefusal::new(
                        WorkspaceRefusalCode::PathSymlink,
                        normalized,
                        format!("`{segment}` is a symbolic link, which this path may not cross"),
                    ));
                }
                Ok(metadata) if metadata.is_dir() => {
                    deepest_existing = current.clone();
                    if index == last {
                        kind = Some(TargetKind::Directory);
                    }
                }
                Ok(metadata) if metadata.is_file() => {
                    if index != last {
                        return Err(WorkspaceRefusal::new(
                            WorkspaceRefusalCode::PathNotFile,
                            normalized,
                            format!(
                                "`{segment}` is a file and cannot contain the rest of the path"
                            ),
                        ));
                    }
                    deepest_existing = current.clone();
                    kind = Some(TargetKind::File);
                }
                Ok(_) => {
                    return Err(WorkspaceRefusal::new(
                        WorkspaceRefusalCode::PathNotFile,
                        normalized,
                        format!("`{segment}` is neither a regular file nor a directory"),
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing = true;
                }
                Err(error) => {
                    return Err(WorkspaceRefusal::new(
                        WorkspaceRefusalCode::PathNotFile,
                        normalized,
                        format!("the path could not be inspected: {error}"),
                    ));
                }
            }
        }

        // The deepest component that exists is the one the kernel will start
        // from. Resolving it catches a reparse point or mount that `lstat`
        // reported as an ordinary directory.
        let canonical = deepest_existing.canonicalize().map_err(|error| {
            WorkspaceRefusal::new(
                WorkspaceRefusalCode::PathEscape,
                normalized,
                format!("the path could not be resolved: {error}"),
            )
        })?;
        if !canonical.starts_with(&self.root) {
            return Err(WorkspaceRefusal::new(
                WorkspaceRefusalCode::PathEscape,
                normalized,
                "the path resolves outside the workspace",
            ));
        }

        Ok(ConfinedTarget {
            relative: normalized.to_string(),
            path: current,
            kind,
        })
    }

    /// Resolve and open a regular file for reading without following a final
    /// symlink. `Ok(None)` means the file is simply not there.
    pub fn open_file(&self, normalized: &str) -> Result<Option<(File, u64)>, WorkspaceRefusal> {
        let target = self.resolve(normalized)?;
        match target.kind {
            None => return Ok(None),
            Some(TargetKind::Directory) => {
                return Err(WorkspaceRefusal::new(
                    WorkspaceRefusalCode::PathNotFile,
                    normalized,
                    "the path names a directory",
                ))
            }
            Some(TargetKind::File) => {}
        }
        let file = no_follow_open(&target.path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                WorkspaceRefusal::new(
                    WorkspaceRefusalCode::PathSymlink,
                    normalized,
                    "the file was replaced while it was being opened",
                )
            } else {
                WorkspaceRefusal::new(
                    WorkspaceRefusalCode::PathNotFile,
                    normalized,
                    format!("the file could not be opened: {error}"),
                )
            }
        })?;
        let metadata = file.metadata().map_err(|error| {
            WorkspaceRefusal::new(
                WorkspaceRefusalCode::PathNotFile,
                normalized,
                format!("the file could not be inspected: {error}"),
            )
        })?;
        if !metadata.is_file() {
            return Err(WorkspaceRefusal::new(
                WorkspaceRefusalCode::PathNotFile,
                normalized,
                "the path does not name a regular file",
            ));
        }
        Ok(Some((file, metadata.len())))
    }
}

/// Open a path without following a symlink standing in its place.
///
/// `O_NOFOLLOW` fails with `ELOOP` (reported by Rust as `NotFound` on some
/// platforms and `Other`/`FilesystemLoop` on others) rather than opening the
/// target, which is the atomic half of the leaf check.
#[cfg(unix)]
fn no_follow_open(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

/// `FILE_FLAG_OPEN_REPARSE_POINT` opens the link itself rather than its
/// target; the caller's `is_file` check then refuses it, because a reparse
/// point is not a regular file.
#[cfg(windows)]
fn no_follow_open(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn no_follow_open(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

/// Whether a path's parent chain stays inside `root` once the filesystem has
/// resolved it.
///
/// The softer rule the task-workspace ledger applies: a symlinked directory
/// *inside* the workspace is ordinary (pnpm's store, a vendored checkout), so
/// only a resolved location outside the root is refused. Unlike
/// [`ConfinedRoot::resolve`] this is called on paths that predate the
/// delegate's stricter contract.
pub(crate) fn parent_stays_inside_root(root: &Path, rel_path: &str) -> Result<(), String> {
    let target = root.join(rel_path);
    let Some(parent) = target.parent() else {
        return Err(format!("invalid target path: {rel_path}"));
    };
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize root {}: {error}", root.display()))?;
    let mut existing = parent;
    loop {
        match existing.canonicalize() {
            Ok(canonical) => {
                return if canonical.starts_with(&canonical_root) {
                    Ok(())
                } else {
                    Err(format!("path escapes workspace: {rel_path}"))
                };
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match existing.parent() {
                    // A parent that does not exist yet cannot escape on its
                    // own; the first ancestor that does exist decides.
                    Some(next) if next.starts_with(&canonical_root) || next.starts_with(root) => {
                        existing = next;
                    }
                    _ => return Ok(()),
                }
            }
            Err(error) => {
                return Err(format!("canonicalize {}: {error}", existing.display()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn normalizes_separators_dot_segments_and_duplicate_slashes() {
        assert_eq!(
            normalize_workspace_path("src\\./a//b.ts", PathPurpose::Write).unwrap(),
            "src/a/b.ts"
        );
    }

    /// [ACC:DEL-05] `..`, absolute paths and drive prefixes never become a path.
    #[test]
    fn refuses_traversal_and_absolute_paths_before_any_syscall() {
        for (raw, code) in [
            ("../etc/passwd", WorkspaceRefusalCode::PathTraversal),
            ("src/../../etc/passwd", WorkspaceRefusalCode::PathTraversal),
            ("/etc/passwd", WorkspaceRefusalCode::PathAbsolute),
            ("~/.ssh/id_rsa", WorkspaceRefusalCode::PathAbsolute),
            ("C:\\Windows\\win.ini", WorkspaceRefusalCode::PathAbsolute),
            ("", WorkspaceRefusalCode::PathEmpty),
            ("./", WorkspaceRefusalCode::PathEmpty),
            ("src/a\u{0}b.ts", WorkspaceRefusalCode::PathInvalid),
            ("src/a:stream", WorkspaceRefusalCode::PathInvalid),
        ] {
            let refusal = normalize_workspace_path(raw, PathPurpose::Write).unwrap_err();
            assert_eq!(refusal.code, code, "{raw}");
        }
    }

    /// [ACC:DEL-05] Credential directories and credential-shaped names are
    /// refused by name, so a read never reaches a host secret that happens to
    /// sit inside the workspace.
    #[test]
    fn refuses_credential_directories_and_names_for_reads_and_writes() {
        for purpose in [PathPurpose::Read, PathPurpose::Write] {
            for raw in [
                ".ssh/id_rsa",
                "vendor/.aws/credentials",
                ".env",
                "a/.env.local",
                "keys/server.pem",
            ] {
                let refusal = normalize_workspace_path(raw, purpose).unwrap_err();
                assert_eq!(refusal.code, WorkspaceRefusalCode::PathSensitive, "{raw}");
            }
            for raw in [".git/config", "node_modules/left-pad/index.js"] {
                let refusal = normalize_workspace_path(raw, purpose).unwrap_err();
                assert_eq!(refusal.code, WorkspaceRefusalCode::PathExcluded, "{raw}");
            }
        }
        assert!(normalize_workspace_path("src/environment.ts", PathPurpose::Write).is_ok());
    }

    #[test]
    fn resolves_a_plain_path_and_reports_what_stands_there() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/a.ts"), "x").unwrap();
        let root = ConfinedRoot::open(dir.path()).unwrap();

        let existing = root.resolve("src/a.ts").unwrap();
        assert_eq!(existing.kind, Some(TargetKind::File));
        assert_eq!(existing.path, root.path().join("src").join("a.ts"));

        let missing = root.resolve("src/new/deep.ts").unwrap();
        assert_eq!(missing.kind, None);

        assert_eq!(
            root.resolve("src").unwrap().kind,
            Some(TargetKind::Directory)
        );
    }

    /// [ACC:DEL-05] A symlink anywhere on the path is refused — the leaf, and
    /// the directory in the middle whose target is outside the workspace.
    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_on_every_component() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("leaf.txt"),
        )
        .unwrap();
        std::os::unix::fs::symlink(".", dir.path().join("here")).unwrap();
        fs::write(dir.path().join("inside.txt"), "inside").unwrap();
        let root = ConfinedRoot::open(dir.path()).unwrap();

        for path in [
            "escape/secret.txt",
            "leaf.txt",
            "here/inside.txt",
            "escape/new.txt",
        ] {
            let refusal = root.resolve(path).unwrap_err();
            assert_eq!(refusal.code, WorkspaceRefusalCode::PathSymlink, "{path}");
        }
        assert!(root.open_file("inside.txt").unwrap().is_some());
        assert_eq!(
            root.open_file("leaf.txt").unwrap_err().code,
            WorkspaceRefusalCode::PathSymlink
        );
    }

    #[test]
    fn missing_files_read_as_absent_rather_than_refused() {
        let dir = TempDir::new().unwrap();
        let root = ConfinedRoot::open(dir.path()).unwrap();
        assert!(root.open_file("nothing.txt").unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn the_softer_ledger_rule_allows_an_inside_symlink_and_refuses_an_escape() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("real")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("inside")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();

        parent_stays_inside_root(dir.path(), "inside/file.txt").unwrap();
        let error = parent_stays_inside_root(dir.path(), "escape/file.txt").unwrap_err();
        assert!(error.contains("escapes workspace"), "{error}");
    }
}
