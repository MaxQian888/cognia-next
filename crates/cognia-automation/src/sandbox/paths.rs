// ADR-0028 — path canonicalization for sandbox policies.
//
// Every writable / readable / target path in a `SandboxPolicy` arrives as a
// raw string from the renderer-side tool call and is used VERBATIM by the
// backends: bwrap `--bind <p> <p>`, SBPL `(subpath "<p>")`, and the
// protected-path re-deny list (`protected::protected_paths_under`). Two
// problems follow from trusting the string:
//
//   * `..` / symlink components mean the path the protected-path deny list is
//     built from (`/work/.git`) can differ from the path the kernel actually
//     resolves, leaving a gap an attacker can write through.
//   * A path carrying a newline / control byte is interpolated straight into
//     the SBPL profile string; while the quote-escaping in `escape_sbpl`
//     prevents breaking *out* of the `(subpath "...")` form, a control byte
//     has no business in a real path and is rejected defensively.
//
// `safe_canonicalize` normalizes a single path: rejects control characters,
// requires an absolute path, rejects lexical `..` traversal, and (on unix)
// resolves symlinks on the longest existing ancestor so the path the policy
// reasons about is the path the kernel will. The non-existing tail (a write
// target that doesn't exist yet) is preserved.

use std::path::{Component, Path, PathBuf};

/// Why a path was rejected. Mapped to `SandboxError::InvalidPolicy` by the
/// dispatcher so the refusal happens before any spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathError {
    /// The path string contains a control character (NUL, newline, …).
    ControlChar,
    /// The path is not absolute.
    NotAbsolute,
    /// The path contains a `..` component (parent traversal).
    ParentTraversal,
}

impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathError::ControlChar => write!(f, "path contains a control character"),
            PathError::NotAbsolute => write!(f, "path is not absolute"),
            PathError::ParentTraversal => write!(f, "path contains a `..` component"),
        }
    }
}

/// Validate + normalize a single sandbox path. On unix the longest existing
/// ancestor is `fs::canonicalize`d (symlinks resolved) and the remaining
/// non-existing tail re-appended; on other platforms the validated path is
/// returned lexically unchanged (Windows confinement is the runner's job and
/// the verbatim `\\?\` prefix would confuse it).
pub fn safe_canonicalize(input: &Path) -> Result<PathBuf, PathError> {
    let raw = input.to_string_lossy();
    if raw.chars().any(|c| c.is_control()) {
        return Err(PathError::ControlChar);
    }
    // Reject `..` before the absoluteness check so a traversal attempt reports
    // the precise reason regardless of platform (`/work/..` is not "absolute"
    // on Windows, where a drive letter is required).
    if input
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(PathError::ParentTraversal);
    }
    if !input.is_absolute() {
        return Err(PathError::NotAbsolute);
    }

    #[cfg(unix)]
    {
        Ok(resolve_existing_prefix(input))
    }
    #[cfg(not(unix))]
    {
        Ok(input.to_path_buf())
    }
}

/// Walk from the deepest ancestor up until one exists, `canonicalize` it, then
/// re-join the components that did not exist yet. Falls back to the lexical
/// path when nothing in the chain exists (a target on a not-yet-mounted bind).
#[cfg(unix)]
fn resolve_existing_prefix(input: &Path) -> PathBuf {
    let mut ancestor = input;
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if let Ok(real) = ancestor.canonicalize() {
            let mut out = real;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (ancestor.parent(), ancestor.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name);
                ancestor = parent;
            }
            // Reached the root with nothing existing — keep the lexical path.
            _ => return input.to_path_buf(),
        }
    }
}

/// Canonicalize every path in a list, short-circuiting on the first rejection.
pub fn safe_canonicalize_all(paths: &[PathBuf]) -> Result<Vec<PathBuf>, PathError> {
    paths.iter().map(|p| safe_canonicalize(p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_control_characters() {
        assert_eq!(
            safe_canonicalize(Path::new("/work/\nfoo")),
            Err(PathError::ControlChar)
        );
        assert_eq!(
            safe_canonicalize(Path::new("/work/\u{0}bar")),
            Err(PathError::ControlChar)
        );
    }

    #[test]
    fn rejects_relative_paths() {
        assert_eq!(
            safe_canonicalize(Path::new("relative/path")),
            Err(PathError::NotAbsolute)
        );
    }

    #[test]
    fn rejects_parent_traversal() {
        assert_eq!(
            safe_canonicalize(Path::new("/work/../etc/passwd")),
            Err(PathError::ParentTraversal)
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_existing_prefix_and_keeps_nonexistent_tail() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        // `root` exists; `new/file.txt` does not yet.
        let target = root.join("new").join("file.txt");
        let resolved = safe_canonicalize(&target).unwrap();
        assert_eq!(resolved, root.join("new").join("file.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn resolves_symlinked_ancestor_to_its_real_path() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().canonicalize().unwrap();
        let real_sub = real.join("real");
        std::fs::create_dir(&real_sub).unwrap();
        let link = real.join("link");
        symlink(&real_sub, &link).unwrap();
        // Access via the symlink resolves to the real directory.
        let resolved = safe_canonicalize(&link.join("inner.txt")).unwrap();
        assert_eq!(resolved, real_sub.join("inner.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn nonexistent_absolute_path_returns_lexical() {
        let p = Path::new("/definitely/not/here/xyz");
        // Nothing in the chain exists, but it's a valid absolute, traversal-free
        // path — keep it rather than erroring.
        assert_eq!(safe_canonicalize(p).unwrap(), p.to_path_buf());
    }

    #[test]
    fn all_short_circuits_on_first_bad_path() {
        let paths = vec![PathBuf::from("/ok"), PathBuf::from("relative")];
        assert_eq!(safe_canonicalize_all(&paths), Err(PathError::NotAbsolute));
    }
}
