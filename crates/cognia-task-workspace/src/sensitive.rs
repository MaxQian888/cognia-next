//! ADR-0111 sensitive-resource classification and grants.
//!
//! Two responsibilities:
//!
//! 1. Reject include patterns that could escape the workspace root (`..`,
//!    absolute paths, escaping symlinks). See [`validate_include_pattern`].
//! 2. Track per-path grants for interactive sessions. Background tasks may
//!    only use paths that have already been granted; missing grants fail
//!    closed. See [`SensitiveGrantStore`].
//!
//! The audit trail lives in `workspace_sensitive_audit` (created by
//! `store.rs::apply_registry_migration`). This module is I/O-free and
//! deterministic — callers must persist the grant / audit rows themselves.

use crate::WorkspaceOwnerType;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
};

/// Reason a sensitive-path decision was taken. Recorded on every grant and
/// every refusal so audit history is complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SensitiveDecision {
    /// User explicitly authorized this path from an interactive surface.
    Granted,
    /// A grant already existed and was reused (no user prompt fired).
    ReusedGrant,
    /// Automatic refusal — no interactive user was present to grant.
    RefusedBackground,
    /// Interactive refusal (user clicked deny).
    RefusedInteractive,
    /// The include pattern itself was rejected before any grant lookup.
    RefusedPattern,
}

impl SensitiveDecision {
    /// `true` iff the caller is allowed to proceed with the sensitive copy.
    pub fn is_allowed(self) -> bool {
        matches!(
            self,
            SensitiveDecision::Granted | SensitiveDecision::ReusedGrant
        )
    }
}

/// Reason an include pattern was rejected. Distinguishes escape attempts so
/// UI can display a specific error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum IncludePatternError {
    /// Pattern was empty or whitespace-only.
    Empty,
    /// Absolute path (starts with `/` on unix or a drive letter on windows).
    Absolute(String),
    /// Pattern contains a `..` component.
    ParentTraversal(String),
    /// Pattern would resolve outside `workspace_root` via a symlink.
    EscapingSymlink(String),
    /// Non-UTF8 or unrenderable component.
    Malformed(String),
}

impl IncludePatternError {
    /// Short human-facing description used in audit rows and error strings.
    pub fn describe(&self) -> String {
        match self {
            IncludePatternError::Empty => "include pattern is empty".into(),
            IncludePatternError::Absolute(value) => {
                format!("include pattern {value:?} must be relative")
            }
            IncludePatternError::ParentTraversal(value) => {
                format!("include pattern {value:?} contains `..`")
            }
            IncludePatternError::EscapingSymlink(value) => {
                format!("include pattern {value:?} resolves outside the workspace")
            }
            IncludePatternError::Malformed(value) => {
                format!("include pattern {value:?} is malformed")
            }
        }
    }
}

/// Validate an include pattern against the workspace root.
///
/// The pattern must be relative and free of `..` traversal. When
/// `workspace_root` is provided and exists on disk, symlink targets are
/// resolved and any escape is rejected. When it is absent (unit-test paths,
/// portable configs), only the string-level checks fire.
///
/// Returns the normalized relative path that callers should store, so the
/// pattern used to look up grants is canonical.
pub fn validate_include_pattern(
    pattern: &str,
    workspace_root: Option<&Path>,
) -> Result<PathBuf, IncludePatternError> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err(IncludePatternError::Empty);
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return Err(IncludePatternError::Absolute(trimmed.to_string()));
    }
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                if part.to_str().is_none() {
                    return Err(IncludePatternError::Malformed(trimmed.to_string()));
                }
                normalized.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(IncludePatternError::ParentTraversal(trimmed.to_string()));
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(IncludePatternError::Absolute(trimmed.to_string()));
            }
        }
    }
    if let Some(root) = workspace_root {
        // Best-effort escape check: if the pattern names a real symlink,
        // ensure its canonical target still lives inside the workspace.
        let joined = root.join(&normalized);
        if joined.exists() {
            let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
            match joined.canonicalize() {
                Ok(resolved) => {
                    if !resolved.starts_with(&canonical_root) {
                        return Err(IncludePatternError::EscapingSymlink(trimmed.to_string()));
                    }
                }
                Err(_) => {
                    // The path exists but cannot be canonicalized — treat as
                    // malformed rather than assume-safe.
                    return Err(IncludePatternError::Malformed(trimmed.to_string()));
                }
            }
        }
    }
    Ok(normalized)
}

/// One recorded sensitive-path grant. Stored per workspace + logical path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveGrant {
    pub workspace_id: String,
    pub relative_path: String,
    pub granted_by_owner_type: WorkspaceOwnerType,
    pub granted_by_owner_ref: Option<String>,
    pub granted_at: i64,
}

/// One audit row appended on every decision. Persisted, never mutated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveAuditEntry {
    pub audit_id: String,
    pub workspace_id: String,
    pub relative_path: String,
    pub decision: SensitiveDecision,
    pub requester_owner_type: WorkspaceOwnerType,
    pub requester_owner_ref: Option<String>,
    pub decided_at: i64,
    pub reason: Option<String>,
}

/// In-memory index over grants, so callers can decide without an SQL round
/// trip on the hot path.
///
/// `SensitiveGrantStore` is deterministic and thread-unsafe by design: the
/// caller (`registry.rs`) owns the lock. Callers hand in the workspace
/// grants they loaded from SQLite; the store never reads from disk.
#[derive(Debug, Default)]
pub struct SensitiveGrantStore {
    /// Map from `workspace_id` → set of granted normalized relative paths.
    grants: HashMap<String, HashSet<String>>,
}

impl SensitiveGrantStore {
    /// Create a new empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Load previously-persisted grants (typically at Registry init).
    pub fn seed(&mut self, grants: impl IntoIterator<Item = SensitiveGrant>) {
        for grant in grants {
            self.grants
                .entry(grant.workspace_id)
                .or_default()
                .insert(grant.relative_path);
        }
    }

    /// Record a new grant. Returns `true` if the grant was newly-added,
    /// `false` if a matching grant already existed.
    pub fn insert(&mut self, workspace_id: &str, relative_path: &str) -> bool {
        self.grants
            .entry(workspace_id.to_string())
            .or_default()
            .insert(relative_path.to_string())
    }

    /// Look up whether a specific (workspace, path) has been granted.
    pub fn is_granted(&self, workspace_id: &str, relative_path: &str) -> bool {
        self.grants
            .get(workspace_id)
            .is_some_and(|set| set.contains(relative_path))
    }

    /// Total number of grants across all workspaces (for tests + metrics).
    pub fn grant_count(&self) -> usize {
        self.grants.values().map(|set| set.len()).sum()
    }
}

/// Decide whether a sensitive-path access is allowed, honoring the ADR-0111
/// interactivity rule: only foreground callers may create new grants.
///
/// Callers are responsible for persisting the returned decision and, when
/// `Granted`, storing the resulting `SensitiveGrant`.
pub fn decide_access(
    store: &SensitiveGrantStore,
    workspace_id: &str,
    relative_path: &str,
    is_interactive: bool,
    user_granted_now: bool,
) -> SensitiveDecision {
    if store.is_granted(workspace_id, relative_path) {
        return SensitiveDecision::ReusedGrant;
    }
    if !is_interactive {
        return SensitiveDecision::RefusedBackground;
    }
    if user_granted_now {
        SensitiveDecision::Granted
    } else {
        SensitiveDecision::RefusedInteractive
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_pattern_is_rejected() {
        let error = validate_include_pattern("   ", None).expect_err("must reject empty");
        assert!(matches!(error, IncludePatternError::Empty));
    }

    #[test]
    fn absolute_pattern_is_rejected() {
        let error =
            validate_include_pattern("/etc/passwd", None).expect_err("must reject absolute");
        assert!(matches!(error, IncludePatternError::Absolute(_)));
    }

    #[test]
    fn parent_traversal_is_rejected() {
        let error =
            validate_include_pattern("../secrets.env", None).expect_err("must reject traversal");
        assert!(matches!(error, IncludePatternError::ParentTraversal(_)));
    }

    #[test]
    fn valid_relative_pattern_is_normalized() {
        let normalized =
            validate_include_pattern("./src/./lib.rs", None).expect("must accept normalized path");
        assert_eq!(normalized, PathBuf::from("src/lib.rs"));
    }

    #[test]
    fn escaping_symlink_is_rejected() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, workspace.join("escape"))
                .expect("symlink creation");
            let error = validate_include_pattern("escape", Some(&workspace))
                .expect_err("must reject symlink escape");
            assert!(
                matches!(error, IncludePatternError::EscapingSymlink(_)),
                "unexpected error {error:?}"
            );
        }
    }

    #[test]
    fn background_task_without_grant_is_refused_fail_closed() {
        let store = SensitiveGrantStore::new();
        let decision = decide_access(&store, "ws-1", "secrets.env", false, false);
        assert_eq!(decision, SensitiveDecision::RefusedBackground);
        assert!(!decision.is_allowed());
    }

    #[test]
    fn background_task_reuses_existing_grant() {
        let mut store = SensitiveGrantStore::new();
        store.insert("ws-1", "secrets.env");
        let decision = decide_access(&store, "ws-1", "secrets.env", false, false);
        assert_eq!(decision, SensitiveDecision::ReusedGrant);
        assert!(decision.is_allowed());
    }

    #[test]
    fn interactive_grant_and_deny_are_distinguished() {
        let store = SensitiveGrantStore::new();
        let granted = decide_access(&store, "ws-1", "secrets.env", true, true);
        let denied = decide_access(&store, "ws-1", "secrets.env", true, false);
        assert_eq!(granted, SensitiveDecision::Granted);
        assert_eq!(denied, SensitiveDecision::RefusedInteractive);
        assert!(granted.is_allowed());
        assert!(!denied.is_allowed());
    }

    #[test]
    fn seed_and_grant_count_reflect_all_workspaces() {
        let mut store = SensitiveGrantStore::new();
        store.seed(vec![
            SensitiveGrant {
                workspace_id: "ws-1".into(),
                relative_path: "a".into(),
                granted_by_owner_type: WorkspaceOwnerType::User,
                granted_by_owner_ref: None,
                granted_at: 0,
            },
            SensitiveGrant {
                workspace_id: "ws-2".into(),
                relative_path: "b".into(),
                granted_by_owner_type: WorkspaceOwnerType::Session,
                granted_by_owner_ref: Some("session-1".into()),
                granted_at: 1,
            },
        ]);
        assert_eq!(store.grant_count(), 2);
        assert!(store.is_granted("ws-1", "a"));
        assert!(!store.is_granted("ws-1", "b"));
        assert!(store.is_granted("ws-2", "b"));
    }
}
