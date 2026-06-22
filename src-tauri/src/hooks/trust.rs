// Workspace-trust gate for project/local-scope hooks.
//
// Project- and local-scope settings (`<cwd>/.claude/settings.json` and
// `settings.local.json`) can contain command/webhook hooks that run arbitrary
// shell commands. Loading them from an UNtrusted directory would let any repo a
// user merely opens execute code. The frontend owns the trust ledger
// (`lib/db/trusted-workspaces.ts`, surfaced by the WorkspaceTrustDialog), but
// enforcement must live in Rust: the hooks runtime resolves a project `cwd` to
// user-scope-only unless the path is in this process-global trusted set, so a
// compromised renderer cannot bypass the gate by simply passing a cwd.
//
// The set is seeded/refreshed from the Dexie ledger via the
// `set_trusted_workspaces` command on startup and whenever trust changes.

use std::collections::HashSet;
use std::sync::{OnceLock, RwLock};

fn registry() -> &'static RwLock<HashSet<String>> {
    static REG: OnceLock<RwLock<HashSet<String>>> = OnceLock::new();
    REG.get_or_init(|| RwLock::new(HashSet::new()))
}

/// Normalize a workspace path to a stable comparison key: trim, unify
/// separators to `/`, and drop a trailing slash. Both the trusted set and the
/// lookups go through this so Windows `\` vs `/` and trailing slashes never
/// cause a false mismatch.
fn normalize(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

/// Replace the trusted-path set wholesale with the frontend's current ledger.
pub fn set_trusted_paths(paths: Vec<String>) {
    let normalized: HashSet<String> = paths
        .iter()
        .map(|p| normalize(p))
        .filter(|p| !p.is_empty())
        .collect();
    if let Ok(mut guard) = registry().write() {
        *guard = normalized;
    }
}

/// True when `path` is a trusted workspace root.
pub fn is_trusted(path: &str) -> bool {
    let key = normalize(path);
    if key.is_empty() {
        return false;
    }
    registry().read().map(|g| g.contains(&key)).unwrap_or(false)
}

/// Return `cwd` only when it is trusted; otherwise `None`, which makes the
/// hooks runtime load user-scope settings only. This is the single chokepoint
/// every project-scoped hook load must pass through.
pub fn resolve_trusted_cwd(cwd: Option<&str>) -> Option<String> {
    match cwd {
        Some(c) if is_trusted(c) => Some(c.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The trusted set is a process-global static; keep all assertions in one
    // sequential test so cargo's parallel runner can't interleave mutations.
    #[test]
    fn trust_gate_behaviour() {
        // Untrusted by default.
        set_trusted_paths(vec![]);
        assert_eq!(resolve_trusted_cwd(Some("/repo/untrusted")), None);
        assert!(!is_trusted("/repo/untrusted"));

        // Trusted cwd resolves through.
        set_trusted_paths(vec!["/repo/trusted".to_string()]);
        assert_eq!(
            resolve_trusted_cwd(Some("/repo/trusted")),
            Some("/repo/trusted".to_string())
        );
        assert!(is_trusted("/repo/trusted"));

        // Separator + trailing-slash normalization.
        set_trusted_paths(vec!["C:\\Users\\me\\proj\\".to_string()]);
        assert!(is_trusted("C:/Users/me/proj"));
        assert!(is_trusted("C:\\Users\\me\\proj"));

        // None / empty cwd are never trusted.
        set_trusted_paths(vec!["/x".to_string()]);
        assert_eq!(resolve_trusted_cwd(None), None);
        assert_eq!(resolve_trusted_cwd(Some("")), None);

        // set replaces wholesale.
        set_trusted_paths(vec!["/a".to_string()]);
        set_trusted_paths(vec!["/b".to_string()]);
        assert!(!is_trusted("/a"));
        assert!(is_trusted("/b"));
    }
}
