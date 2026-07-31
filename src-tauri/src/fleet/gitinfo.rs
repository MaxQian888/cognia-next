//! Best-effort git branch capture for a fleet session's working directory.
//!
//! Kept out of the pure [`super::registry`] fold because it does live process
//! I/O. [`current_branch`] runs a single bounded `git rev-parse` (no network),
//! and [`parse_branch`] is the pure, unit-tested normalizer of its output.

use std::process::Command;

/// Longest branch label kept — a hostile ref name can be arbitrarily long, and
/// the island only has room for a short chip.
const MAX_BRANCH_CHARS: usize = 60;

/// Normalize `git rev-parse --abbrev-ref HEAD` stdout into a display branch:
/// trims whitespace, treats an empty result or a detached `HEAD` as "no
/// branch", and caps the length. Pure — the unit-testable core.
pub fn parse_branch(stdout: &str) -> Option<String> {
    let name = stdout.trim();
    // `HEAD` means a detached checkout — there is no current branch to show.
    if name.is_empty() || name == "HEAD" {
        return None;
    }
    if name.chars().count() > MAX_BRANCH_CHARS {
        let mut capped: String = name.chars().take(MAX_BRANCH_CHARS).collect();
        capped.push('…');
        return Some(capped);
    }
    Some(name.to_owned())
}

/// Current git branch of `cwd`, or `None` when `cwd` is not a repo / git is
/// unavailable / the checkout is detached. Bounded and synchronous — the caller
/// runs it off the pure fold (see [`super::FleetRuntime::ingest`]).
pub fn current_branch(cwd: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_branch(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_branch_trims_a_normal_branch() {
        assert_eq!(parse_branch("main\n"), Some("main".to_string()));
        assert_eq!(parse_branch("  feature/x  "), Some("feature/x".to_string()));
    }

    #[test]
    fn parse_branch_rejects_detached_and_empty() {
        assert_eq!(parse_branch("HEAD\n"), None);
        assert_eq!(parse_branch(""), None);
        assert_eq!(parse_branch("   \n"), None);
    }

    #[test]
    fn parse_branch_caps_an_overlong_ref() {
        let long = "a".repeat(MAX_BRANCH_CHARS + 20);
        let capped = parse_branch(&long).expect("some");
        assert_eq!(capped.chars().count(), MAX_BRANCH_CHARS + 1); // + ellipsis
        assert!(capped.ends_with('…'));
    }

    #[test]
    fn current_branch_of_non_repo_is_none() {
        // A path that is not a git repository (and almost certainly absent)
        // fast-fails to `None` without panicking.
        assert_eq!(current_branch("/definitely/not/a/git/repo/xyzzy"), None);
    }

    #[test]
    fn current_branch_of_the_crate_dir_does_not_panic() {
        // The crate lives inside the repo, so this usually returns Some(branch),
        // but a detached-HEAD CI checkout returns None — assert only that it
        // runs and yields an Option, exercising the success path.
        let _ = current_branch(env!("CARGO_MANIFEST_DIR"));
    }
}
