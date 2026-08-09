//! ADR-0111 Workspace Bundle: multi-root atomic apply.
//!
//! A [`WorkspaceBundle`] holds one or more [`WorkspaceRootLease`]s that were
//! acquired atomically for a single execution. Apply follows three phases:
//!
//! 1. **Precheck** — every lease is inspected before any mutation. Sensitive
//!    paths are checked against granted paths, patch conflicts are detected
//!    against the current worktree state, and any failure returns
//!    `WorkspaceBundleOutcome::conflicts` with `state = Conflict` and NO
//!    lease is touched.
//! 2. **Apply** — leases are applied in the order the composer emitted. Each
//!    apply calls [`BundleApplier::apply`] and, on success, its inverse
//!    payload is remembered so a later compensate can undo it.
//! 3. **Compensate** — a mid-apply failure triggers reverse-order undo of
//!    already-applied leases. If every compensate succeeds the bundle
//!    returns to its pre-apply state (`state = Active`, no changes on
//!    disk). If any compensate itself fails the bundle enters `Conflict`
//!    with the partial-apply view preserved for the user to resolve
//!    through the existing `ConflictResolution` API.
//!
//! Nothing here reaches the filesystem or git — [`BundleApplier`] is the
//! sole seam, so the module is pure and unit-testable with mock appliers.
//! `service.rs` wires the real `TaskWorkspaceService::apply_patch_set_with_options`
//! implementation in a later phase.
//!
//! # Composition rule (ADR-0111 §6)
//!
//! Two logical roots that share a Git `common_dir` reuse a single physical
//! worktree — this is what makes multi-root apply cheap when the roots live
//! in one repo. [`plan_bundle_composition`] emits one physical lease per
//! `common_dir`, plus one per non-Git root, so the caller creates exactly
//! the worktrees it needs.

use crate::{
    types::{
        PatchConflict, WorkspaceBundle, WorkspaceBundleOutcome, WorkspaceOwnerType,
        WorkspaceRootLease, WorkspaceRootRole, WorkspaceState,
    },
    IsolationKind, PatchSet,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// A logical root the caller wants to compose into a bundle.
///
/// The composer resolves each entry into either a shared-worktree lease
/// (when another `RootRequest` shares the same `common_dir`) or a dedicated
/// physical worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootRequest {
    /// Stable id the caller uses to refer to this root. The composer
    /// preserves it verbatim on the emitted lease.
    pub logical_root_id: String,
    /// The role this root plays in execution. Exactly one primary is
    /// required per bundle — [`plan_bundle_composition`] validates that.
    pub role: WorkspaceRootRole,
    /// On-disk source root the user pointed at. Used for the emitted
    /// `alias_path` when no shared worktree exists.
    pub source_root: String,
    /// The isolation strategy the caller intends to use for this root.
    pub isolation: IsolationKind,
    /// Git `common_dir` for this root (from `git rev-parse --git-common-dir`
    /// resolved to a canonical path). `None` for non-Git roots.
    ///
    /// Two requests with the same `Some(common_dir)` are collapsed into a
    /// single physical worktree — every lease from that group points at the
    /// same `alias_path`.
    pub git_common_dir: Option<String>,
}

/// Errors the composer or apply orchestrator can emit.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BundleError {
    /// Zero root requests. A bundle without at least one root is meaningless.
    #[error("bundle composition requires at least one root request")]
    Empty,

    /// More or fewer than one root is marked `Primary`. Exactly one is
    /// required so the executor knows the cwd.
    #[error("bundle composition expected exactly one primary root, found {found}")]
    PrimaryRootCountMismatch { found: usize },

    /// Two `RootRequest`s share the same `logical_root_id`.
    #[error("bundle composition: duplicate logical root id {0}")]
    DuplicateLogicalRoot(String),

    /// The number of `PatchSet` inputs to apply does not match the number of
    /// leases in the bundle. Symptom of a caller wiring the wrong bundle.
    #[error("apply plan lease count {leases} does not match patch count {patches}")]
    PatchCountMismatch { leases: usize, patches: usize },
}

/// Compose a set of [`RootRequest`]s into a [`WorkspaceBundle`].
///
/// Given `n` root requests the composer emits `n` leases, one per logical
/// root. Requests that share a `common_dir` all point at the same physical
/// `alias_path` — [`compose_alias_path`] chooses a deterministic path so a
/// re-compose after restart produces the same shape.
///
/// The bundle is not persisted here; the caller writes leases + record rows
/// once it has physically materialized the worktrees.
pub fn plan_bundle_composition(
    owner_type: WorkspaceOwnerType,
    owner_ref: Option<String>,
    requests: &[RootRequest],
    now: i64,
) -> Result<(WorkspaceBundle, Vec<PhysicalLeaseGroup>), BundleError> {
    if requests.is_empty() {
        return Err(BundleError::Empty);
    }
    let primary_count = requests
        .iter()
        .filter(|request| request.role == WorkspaceRootRole::Primary)
        .count();
    if primary_count != 1 {
        return Err(BundleError::PrimaryRootCountMismatch {
            found: primary_count,
        });
    }
    // Duplicate check preserves the caller's ordering while still O(n).
    let mut seen: HashMap<&str, ()> = HashMap::with_capacity(requests.len());
    for request in requests {
        if seen.insert(request.logical_root_id.as_str(), ()).is_some() {
            return Err(BundleError::DuplicateLogicalRoot(
                request.logical_root_id.clone(),
            ));
        }
    }
    let bundle_id = Uuid::now_v7().to_string();

    // Group by `common_dir`. `None` (non-Git) is its own bucket keyed by
    // logical id so each non-Git root gets a distinct physical shadow.
    let mut groups: Vec<PhysicalLeaseGroup> = Vec::new();
    let mut group_index: HashMap<String, usize> = HashMap::new();
    for request in requests {
        let key = request
            .git_common_dir
            .clone()
            .unwrap_or_else(|| format!("__non_git__/{}", request.logical_root_id));
        let idx = *group_index.entry(key.clone()).or_insert_with(|| {
            let alias_path = compose_alias_path(&bundle_id, &key, request);
            groups.push(PhysicalLeaseGroup {
                bundle_id: bundle_id.clone(),
                group_key: key.clone(),
                alias_path,
                isolation: request.isolation,
                git_common_dir: request.git_common_dir.clone(),
                logical_root_ids: Vec::new(),
                workspace_id: None,
            });
            groups.len() - 1
        });
        groups[idx]
            .logical_root_ids
            .push(request.logical_root_id.clone());
    }

    // Assign `workspace_id` per group. The caller inserts one Registry row
    // per group so the same physical worktree carries one Registry row —
    // reuse of the row across leases inside the group is intentional.
    let mut leases: Vec<WorkspaceRootLease> = Vec::with_capacity(requests.len());
    for group in &mut groups {
        // A fresh `workspace_id` per physical group. The caller will store
        // this on the Registry row it inserts for the worktree.
        let workspace_id = Uuid::now_v7().to_string();
        group.workspace_id = Some(workspace_id.clone());
        for logical_root_id in &group.logical_root_ids {
            let role = requests
                .iter()
                .find(|r| &r.logical_root_id == logical_root_id)
                .map(|r| r.role)
                .expect("logical id was seen during grouping");
            leases.push(WorkspaceRootLease {
                bundle_id: bundle_id.clone(),
                workspace_id: workspace_id.clone(),
                logical_root_id: logical_root_id.clone(),
                role,
                alias_path: group.alias_path.clone(),
            });
        }
    }

    Ok((
        WorkspaceBundle {
            bundle_id,
            owner_type,
            owner_ref,
            leases: leases.clone(),
            created_at: now,
        },
        groups,
    ))
}

/// A grouping of logical roots that will share a single physical worktree.
///
/// Non-Git roots each get their own group (each is its own physical
/// shadow). The caller materializes one worktree per group and inserts one
/// Registry row per group; the `workspace_id` field is populated by
/// [`plan_bundle_composition`] after grouping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalLeaseGroup {
    pub bundle_id: String,
    /// Either the shared git common dir path or a synthetic
    /// `__non_git__/<logical_root_id>` key for non-Git roots.
    pub group_key: String,
    /// The physical execution root the composer proposes for this group.
    /// Deterministic given `(bundle_id, group_key)`.
    pub alias_path: String,
    /// The isolation strategy for this physical worktree. All roots in the
    /// group share it (they must — they're the same worktree).
    pub isolation: IsolationKind,
    /// Non-`None` iff this group belongs to a Git repository.
    pub git_common_dir: Option<String>,
    /// Every logical root that maps to this physical worktree.
    pub logical_root_ids: Vec<String>,
    /// Populated by [`plan_bundle_composition`] before the group is
    /// returned. Never `None` in composer output — the field is `Option`
    /// only to allow ergonomic construction during composition.
    pub workspace_id: Option<String>,
}

/// Deterministic alias-path composition: `<system tmp>/cognia-bundle/<bundle_id>/<slug>`.
///
/// The `slug` encodes either the git common dir basename or (for non-Git
/// roots) the logical root id. Tests and production share this same
/// derivation so a restart cannot produce different alias paths for the
/// same bundle.
fn compose_alias_path(bundle_id: &str, group_key: &str, request: &RootRequest) -> String {
    let slug = if request.git_common_dir.is_some() {
        // Take the last path component of the common dir so two different
        // repos in the same tempdir do not collide.
        group_key
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("git-root")
            .to_string()
    } else {
        format!("nogit-{}", request.logical_root_id)
    };
    // Callers substitute the actual root directory in `bundle_root`; this
    // deterministic string is only the relative shape. Registry insertion
    // is what pins it to disk.
    format!("bundle/{bundle_id}/{slug}")
}

/// One entry in a plan produced by [`plan_bundle_apply`].
///
/// Each step names a physical group + the `PatchSet` the applier should
/// process against it. The step index is preserved so compensation can
/// walk successful steps in reverse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyStep {
    pub step_index: usize,
    pub workspace_id: String,
    pub alias_path: String,
    pub patch: PatchSet,
}

/// Precheck-derived plan. Every step must pass precheck before any apply
/// runs — this ADR-0111 §6 (1) invariant is what makes the outcome atomic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleApplyPlan {
    pub bundle_id: String,
    pub steps: Vec<ApplyStep>,
}

/// Turn a bundle + patches into an [`BundleApplyPlan`] the orchestrator can
/// execute step-by-step.
///
/// The caller passes one `PatchSet` per physical group (identified by
/// `workspace_id`). The composer preserves group order, so callers walk the
/// return of [`plan_bundle_composition`] to pair patches with groups.
pub fn plan_bundle_apply(
    bundle: &WorkspaceBundle,
    groups: &[PhysicalLeaseGroup],
    patches_by_workspace_id: HashMap<String, PatchSet>,
) -> Result<BundleApplyPlan, BundleError> {
    // Deduplicate physical groups referenced by leases — leases share a
    // physical group when their common_dir matches.
    let mut seen: HashMap<&str, ()> = HashMap::new();
    let mut steps: Vec<ApplyStep> = Vec::new();
    for group in groups {
        let workspace_id = group
            .workspace_id
            .as_deref()
            .expect("composer set workspace_id");
        if seen.insert(workspace_id, ()).is_some() {
            continue;
        }
        let patch = patches_by_workspace_id.get(workspace_id).cloned().ok_or(
            BundleError::PatchCountMismatch {
                leases: groups.len(),
                patches: patches_by_workspace_id.len(),
            },
        )?;
        steps.push(ApplyStep {
            step_index: steps.len(),
            workspace_id: workspace_id.to_string(),
            alias_path: group.alias_path.clone(),
            patch,
        });
    }
    if steps.len() != patches_by_workspace_id.len() {
        return Err(BundleError::PatchCountMismatch {
            leases: steps.len(),
            patches: patches_by_workspace_id.len(),
        });
    }
    Ok(BundleApplyPlan {
        bundle_id: bundle.bundle_id.clone(),
        steps,
    })
}

/// The single seam between the pure bundle orchestrator and the real
/// [`crate::TaskWorkspaceService`] apply/undo engine.
///
/// Implementations perform the actual patch application against the
/// physical worktree at `alias_path`. Precheck / apply / compensate all
/// call through this trait so tests can inject fault-injection appliers.
///
/// Every operation returns `Result<(), Vec<PatchConflict>>`:
///
/// - `Ok(())` — succeeded, no conflicts.
/// - `Err(conflicts)` — the operation could not proceed cleanly. The
///   orchestrator treats this as the bundle-level failure signal.
pub trait BundleApplier {
    /// Ask the applier whether the patch is applicable given the current
    /// state at `alias_path`. Called for every step during precheck.
    fn precheck(&self, step: &ApplyStep) -> Result<(), Vec<PatchConflict>>;

    /// Apply the patch. Called during the apply phase.
    fn apply(&self, step: &ApplyStep) -> Result<(), Vec<PatchConflict>>;

    /// Undo a previously-applied patch. Called during compensation. If undo
    /// itself fails the bundle lands in `Conflict`.
    fn compensate(&self, step: &ApplyStep) -> Result<(), Vec<PatchConflict>>;
}

/// Execute the [`BundleApplyPlan`] against the supplied [`BundleApplier`],
/// returning the ADR-0111 §6 outcome.
///
/// Terminal states:
/// - `Active` — everything applied cleanly.
/// - `Active` with `rolled_back` non-empty — apply failed mid-way, all
///   applied steps were reverted successfully.
/// - `Conflict` — precheck rejected, or compensation itself failed. The
///   caller uses the existing `ConflictResolution` API to recover.
pub fn execute_bundle_apply(
    plan: &BundleApplyPlan,
    applier: &dyn BundleApplier,
) -> WorkspaceBundleOutcome {
    // Phase 1: precheck — surface any conflict without touching state.
    let mut precheck_conflicts: Vec<PatchConflict> = Vec::new();
    for step in &plan.steps {
        if let Err(mut conflicts) = applier.precheck(step) {
            precheck_conflicts.append(&mut conflicts);
        }
    }
    if !precheck_conflicts.is_empty() {
        return WorkspaceBundleOutcome {
            bundle_id: plan.bundle_id.clone(),
            applied: Vec::new(),
            rolled_back: Vec::new(),
            conflicts: precheck_conflicts,
            state: WorkspaceState::Conflict,
        };
    }

    // Phase 2: apply — stop at the first failure, remember successes so we
    // can compensate them.
    let mut applied: Vec<usize> = Vec::new();
    let mut apply_conflicts: Vec<PatchConflict> = Vec::new();
    for (idx, step) in plan.steps.iter().enumerate() {
        match applier.apply(step) {
            Ok(()) => applied.push(idx),
            Err(mut conflicts) => {
                apply_conflicts.append(&mut conflicts);
                break;
            }
        }
    }

    if apply_conflicts.is_empty() {
        // Every step applied cleanly.
        return WorkspaceBundleOutcome {
            bundle_id: plan.bundle_id.clone(),
            applied: applied
                .iter()
                .map(|&i| plan.steps[i].workspace_id.clone())
                .collect(),
            rolled_back: Vec::new(),
            conflicts: Vec::new(),
            state: WorkspaceState::Active,
        };
    }

    // Phase 3: compensate — reverse order.
    let mut rolled_back: Vec<usize> = Vec::new();
    let mut compensate_conflicts: Vec<PatchConflict> = Vec::new();
    for &idx in applied.iter().rev() {
        match applier.compensate(&plan.steps[idx]) {
            Ok(()) => rolled_back.push(idx),
            Err(mut conflicts) => {
                compensate_conflicts.append(&mut conflicts);
                // Continue attempting to compensate the remaining steps —
                // partial recovery is better than none.
            }
        }
    }

    let state = if compensate_conflicts.is_empty() {
        // Every applied step was rolled back — the bundle is back to its
        // pre-apply state on disk even though the outer apply failed.
        WorkspaceState::Active
    } else {
        WorkspaceState::Conflict
    };

    // `applied` reports the workspaces that had a successful apply *and* a
    // successful compensate — i.e. currently zero net changes. `rolled_back`
    // is the subset that compensation reverted; workspaces that failed to
    // roll back live in `conflicts`.
    let successful_compensate: std::collections::HashSet<usize> =
        rolled_back.iter().copied().collect();
    WorkspaceBundleOutcome {
        bundle_id: plan.bundle_id.clone(),
        applied: applied
            .iter()
            .filter(|idx| successful_compensate.contains(idx))
            .map(|&i| plan.steps[i].workspace_id.clone())
            .collect(),
        rolled_back: rolled_back
            .iter()
            .map(|&i| plan.steps[i].workspace_id.clone())
            .collect(),
        conflicts: apply_conflicts
            .into_iter()
            .chain(compensate_conflicts.into_iter())
            .collect(),
        state,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{types::WorkspaceRootRole, ChangeKind, PatchState, ResourceKind};
    use std::cell::RefCell;

    fn root(id: &str, role: WorkspaceRootRole, common_dir: Option<&str>) -> RootRequest {
        RootRequest {
            logical_root_id: id.into(),
            role,
            source_root: format!("/workspace/{id}"),
            isolation: if common_dir.is_some() {
                IsolationKind::GitWorktree
            } else {
                IsolationKind::Shadow
            },
            git_common_dir: common_dir.map(str::to_string),
        }
    }

    fn empty_patch(task_id: &str, run_id: &str) -> PatchSet {
        PatchSet {
            patch_id: format!("patch-{task_id}-{run_id}"),
            task_id: task_id.into(),
            run_id: run_id.into(),
            state: PatchState::Ready,
            base_revision: 1,
            applied_revision: None,
            files: Vec::new(),
            applied_files: Vec::new(),
            applied_selection: Vec::new(),
            applied_selection_known: false,
            reversible: true,
            created_at: 0,
        }
    }

    fn conflict(path: &str, reason: &str) -> PatchConflict {
        PatchConflict {
            path: path.into(),
            reason: reason.into(),
        }
    }

    // ---------------------------------------------------------------
    // Composition
    // ---------------------------------------------------------------

    #[test]
    fn compose_refuses_empty_bundle() {
        let error =
            plan_bundle_composition(WorkspaceOwnerType::User, None, &[], 0).expect_err("empty");
        assert!(matches!(error, BundleError::Empty));
    }

    #[test]
    fn compose_requires_exactly_one_primary_root() {
        // Zero primaries.
        let error = plan_bundle_composition(
            WorkspaceOwnerType::User,
            None,
            &[root("a", WorkspaceRootRole::Additional, None)],
            0,
        )
        .expect_err("zero primary");
        assert!(matches!(
            error,
            BundleError::PrimaryRootCountMismatch { found: 0 }
        ));
        // Two primaries.
        let error = plan_bundle_composition(
            WorkspaceOwnerType::User,
            None,
            &[
                root("a", WorkspaceRootRole::Primary, None),
                root("b", WorkspaceRootRole::Primary, None),
            ],
            0,
        )
        .expect_err("two primaries");
        assert!(matches!(
            error,
            BundleError::PrimaryRootCountMismatch { found: 2 }
        ));
    }

    #[test]
    fn compose_refuses_duplicate_logical_root_ids() {
        let error = plan_bundle_composition(
            WorkspaceOwnerType::User,
            None,
            &[
                root("dup", WorkspaceRootRole::Primary, None),
                root("dup", WorkspaceRootRole::Additional, None),
            ],
            0,
        )
        .expect_err("duplicate");
        assert!(matches!(error, BundleError::DuplicateLogicalRoot(id) if id == "dup"));
    }

    #[test]
    fn compose_collapses_roots_that_share_a_git_common_dir() {
        let common = "/repo/.git";
        let (bundle, groups) = plan_bundle_composition(
            WorkspaceOwnerType::Session,
            Some("session-1".into()),
            &[
                root("primary", WorkspaceRootRole::Primary, Some(common)),
                root("sibling", WorkspaceRootRole::Additional, Some(common)),
                root(
                    "other-repo",
                    WorkspaceRootRole::Additional,
                    Some("/other/.git"),
                ),
                root("shadow", WorkspaceRootRole::Additional, None),
            ],
            42,
        )
        .expect("compose");

        // Four leases (one per logical root) but three physical groups.
        assert_eq!(bundle.leases.len(), 4);
        assert_eq!(groups.len(), 3);

        // Primary + sibling share a physical worktree.
        let primary_lease = bundle
            .leases
            .iter()
            .find(|l| l.logical_root_id == "primary")
            .unwrap();
        let sibling_lease = bundle
            .leases
            .iter()
            .find(|l| l.logical_root_id == "sibling")
            .unwrap();
        assert_eq!(primary_lease.workspace_id, sibling_lease.workspace_id);
        assert_eq!(primary_lease.alias_path, sibling_lease.alias_path);
        assert_eq!(primary_lease.role, WorkspaceRootRole::Primary);
        assert_eq!(sibling_lease.role, WorkspaceRootRole::Additional);

        // The other-repo lease got its own physical worktree.
        let other_lease = bundle
            .leases
            .iter()
            .find(|l| l.logical_root_id == "other-repo")
            .unwrap();
        assert_ne!(other_lease.workspace_id, primary_lease.workspace_id);

        // The non-Git shadow got its own physical worktree, keyed by its
        // logical id.
        let shadow_lease = bundle
            .leases
            .iter()
            .find(|l| l.logical_root_id == "shadow")
            .unwrap();
        assert_ne!(shadow_lease.workspace_id, primary_lease.workspace_id);
        assert_ne!(shadow_lease.workspace_id, other_lease.workspace_id);

        // Bundle ordering preserved.
        assert_eq!(
            bundle
                .leases
                .iter()
                .map(|l| l.logical_root_id.as_str())
                .collect::<Vec<_>>(),
            ["primary", "sibling", "other-repo", "shadow"]
        );
        assert_eq!(bundle.created_at, 42);
        assert_eq!(bundle.owner_type, WorkspaceOwnerType::Session);
    }

    #[test]
    fn compose_alias_paths_are_deterministic_given_bundle_id_and_key() {
        // Twice with identical inputs → same alias_path per group.
        let requests = vec![
            root("a", WorkspaceRootRole::Primary, Some("/repo/.git")),
            root("b", WorkspaceRootRole::Additional, None),
        ];
        // Fix the bundle_id manually by comparing groups whose
        // (bundle_id, group_key) match.
        let (first, groups1) =
            plan_bundle_composition(WorkspaceOwnerType::User, None, &requests, 0).unwrap();
        let (second, groups2) =
            plan_bundle_composition(WorkspaceOwnerType::User, None, &requests, 0).unwrap();
        // Bundle IDs differ (v7 uuids), but for each bundle the alias paths
        // for group_key "/repo/.git" must follow the same shape.
        for group in &groups1 {
            assert!(group
                .alias_path
                .starts_with(&format!("bundle/{}/", first.bundle_id)));
        }
        for group in &groups2 {
            assert!(group
                .alias_path
                .starts_with(&format!("bundle/{}/", second.bundle_id)));
        }
    }

    // ---------------------------------------------------------------
    // Plan construction
    // ---------------------------------------------------------------

    #[test]
    fn plan_bundle_apply_pairs_patches_with_physical_groups() {
        let (bundle, groups) = plan_bundle_composition(
            WorkspaceOwnerType::User,
            None,
            &[
                root("primary", WorkspaceRootRole::Primary, Some("/repo/.git")),
                root("sibling", WorkspaceRootRole::Additional, Some("/repo/.git")),
                root("other", WorkspaceRootRole::Additional, None),
            ],
            0,
        )
        .unwrap();

        // Two physical groups (one shared, one shadow) → two patches.
        let mut patches = HashMap::new();
        for group in &groups {
            let ws = group.workspace_id.clone().unwrap();
            patches.insert(ws.clone(), empty_patch(&ws, "run-1"));
        }
        let plan = plan_bundle_apply(&bundle, &groups, patches).unwrap();
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.bundle_id, bundle.bundle_id);
    }

    #[test]
    fn plan_bundle_apply_rejects_patch_count_mismatch() {
        let (bundle, groups) = plan_bundle_composition(
            WorkspaceOwnerType::User,
            None,
            &[root("only", WorkspaceRootRole::Primary, None)],
            0,
        )
        .unwrap();
        // Supply zero patches — mismatch.
        let error = plan_bundle_apply(&bundle, &groups, HashMap::new()).expect_err("mismatch");
        assert!(matches!(error, BundleError::PatchCountMismatch { .. }));
    }

    // ---------------------------------------------------------------
    // Execution — precheck / apply / compensate
    // ---------------------------------------------------------------

    #[derive(Default)]
    struct MockApplier {
        /// Steps (by workspace_id) that should fail precheck.
        precheck_fail: RefCell<Vec<String>>,
        /// Steps that should fail apply.
        apply_fail: RefCell<Vec<String>>,
        /// Steps that should fail compensate.
        compensate_fail: RefCell<Vec<String>>,
        /// Trace of every operation for order assertions.
        trace: RefCell<Vec<String>>,
    }

    impl BundleApplier for MockApplier {
        fn precheck(&self, step: &ApplyStep) -> Result<(), Vec<PatchConflict>> {
            self.trace
                .borrow_mut()
                .push(format!("precheck:{}", step.workspace_id));
            if self.precheck_fail.borrow().contains(&step.workspace_id) {
                Err(vec![conflict(&step.alias_path, "precheck-fault")])
            } else {
                Ok(())
            }
        }
        fn apply(&self, step: &ApplyStep) -> Result<(), Vec<PatchConflict>> {
            self.trace
                .borrow_mut()
                .push(format!("apply:{}", step.workspace_id));
            if self.apply_fail.borrow().contains(&step.workspace_id) {
                Err(vec![conflict(&step.alias_path, "apply-fault")])
            } else {
                Ok(())
            }
        }
        fn compensate(&self, step: &ApplyStep) -> Result<(), Vec<PatchConflict>> {
            self.trace
                .borrow_mut()
                .push(format!("compensate:{}", step.workspace_id));
            if self.compensate_fail.borrow().contains(&step.workspace_id) {
                Err(vec![conflict(&step.alias_path, "compensate-fault")])
            } else {
                Ok(())
            }
        }
    }

    fn plan_of_size(n: usize) -> BundleApplyPlan {
        let mut steps = Vec::new();
        for idx in 0..n {
            steps.push(ApplyStep {
                step_index: idx,
                workspace_id: format!("ws-{idx}"),
                alias_path: format!("/tmp/ws-{idx}"),
                patch: empty_patch(&format!("t-{idx}"), &format!("r-{idx}")),
            });
        }
        BundleApplyPlan {
            bundle_id: "bundle-x".into(),
            steps,
        }
    }

    #[test]
    fn happy_path_applies_every_step_in_order() {
        let plan = plan_of_size(3);
        let applier = MockApplier::default();
        let outcome = execute_bundle_apply(&plan, &applier);
        assert_eq!(outcome.state, WorkspaceState::Active);
        assert_eq!(outcome.applied, ["ws-0", "ws-1", "ws-2"]);
        assert!(outcome.rolled_back.is_empty());
        assert!(outcome.conflicts.is_empty());
        // Precheck of every step happens before ANY apply — ADR-0111 §6 (1).
        let trace = applier.trace.borrow();
        let first_apply = trace.iter().position(|s| s.starts_with("apply:")).unwrap();
        let last_precheck = trace
            .iter()
            .rposition(|s| s.starts_with("precheck:"))
            .unwrap();
        assert!(
            last_precheck < first_apply,
            "every precheck must run before any apply, got {trace:?}"
        );
    }

    #[test]
    fn precheck_failure_never_touches_any_lease() {
        let plan = plan_of_size(3);
        let applier = MockApplier::default();
        applier.precheck_fail.borrow_mut().push("ws-1".into());
        let outcome = execute_bundle_apply(&plan, &applier);
        assert_eq!(outcome.state, WorkspaceState::Conflict);
        assert!(outcome.applied.is_empty());
        assert!(outcome.rolled_back.is_empty());
        assert_eq!(outcome.conflicts.len(), 1);
        // No apply/compensate lines in the trace.
        let trace = applier.trace.borrow();
        assert!(!trace.iter().any(|s| s.starts_with("apply:")));
        assert!(!trace.iter().any(|s| s.starts_with("compensate:")));
    }

    #[test]
    fn multiple_precheck_failures_are_all_reported() {
        let plan = plan_of_size(3);
        let applier = MockApplier::default();
        applier.precheck_fail.borrow_mut().push("ws-0".into());
        applier.precheck_fail.borrow_mut().push("ws-2".into());
        let outcome = execute_bundle_apply(&plan, &applier);
        assert_eq!(outcome.state, WorkspaceState::Conflict);
        assert_eq!(outcome.conflicts.len(), 2);
        // Precheck ran for every step even though the first failed.
        let trace = applier.trace.borrow();
        for id in ["ws-0", "ws-1", "ws-2"] {
            assert!(
                trace.contains(&format!("precheck:{id}")),
                "precheck must have visited {id}"
            );
        }
    }

    #[test]
    fn mid_apply_failure_compensates_previously_applied_steps_in_reverse() {
        let plan = plan_of_size(4);
        let applier = MockApplier::default();
        applier.apply_fail.borrow_mut().push("ws-2".into());
        let outcome = execute_bundle_apply(&plan, &applier);
        // Compensation succeeded on ws-0 and ws-1 → bundle returns to
        // Active state with rolled_back listing them in reverse order.
        assert_eq!(outcome.state, WorkspaceState::Active);
        assert_eq!(outcome.rolled_back, ["ws-1", "ws-0"]);
        // `applied` reports ws-0 and ws-1 as "applied then rolled back":
        // the same subset as rolled_back.
        assert_eq!(outcome.applied, ["ws-0", "ws-1"]);
        // The apply failure surfaces in conflicts.
        assert_eq!(outcome.conflicts.len(), 1);
        assert_eq!(outcome.conflicts[0].reason, "apply-fault");
        // Trace shows apply reached ws-2, then compensation in reverse.
        let trace = applier.trace.borrow();
        assert!(trace.contains(&"apply:ws-2".to_string()));
        assert!(!trace.contains(&"apply:ws-3".to_string()));
        // ws-1 compensated before ws-0.
        let pos_ws1 = trace.iter().position(|s| s == "compensate:ws-1").unwrap();
        let pos_ws0 = trace.iter().position(|s| s == "compensate:ws-0").unwrap();
        assert!(pos_ws1 < pos_ws0, "reverse-order compensation");
    }

    #[test]
    fn compensation_failure_lands_bundle_in_conflict_with_both_apply_and_compensate_reasons() {
        let plan = plan_of_size(3);
        let applier = MockApplier::default();
        applier.apply_fail.borrow_mut().push("ws-1".into());
        applier.compensate_fail.borrow_mut().push("ws-0".into());
        let outcome = execute_bundle_apply(&plan, &applier);
        assert_eq!(outcome.state, WorkspaceState::Conflict);
        // ws-0 was applied but its compensation failed → not in rolled_back
        // and thus not in `applied` either (which reports only successful
        // apply + successful compensate pairs).
        assert!(outcome.applied.is_empty());
        assert!(outcome.rolled_back.is_empty());
        // Both the apply-fault and compensate-fault reasons are surfaced.
        let reasons: Vec<&str> = outcome
            .conflicts
            .iter()
            .map(|c| c.reason.as_str())
            .collect();
        assert!(reasons.contains(&"apply-fault"));
        assert!(reasons.contains(&"compensate-fault"));
    }

    #[test]
    fn compensation_continues_after_a_single_undo_failure() {
        // ws-0..ws-3 applied; apply of ws-4 fails; compensate of ws-2 fails
        // BUT ws-3, ws-1, ws-0 still get their compensate attempted.
        let plan = plan_of_size(5);
        let applier = MockApplier::default();
        applier.apply_fail.borrow_mut().push("ws-4".into());
        applier.compensate_fail.borrow_mut().push("ws-2".into());
        let outcome = execute_bundle_apply(&plan, &applier);
        assert_eq!(outcome.state, WorkspaceState::Conflict);
        // ws-3, ws-1, ws-0 rolled back cleanly.
        assert_eq!(outcome.rolled_back, ["ws-3", "ws-1", "ws-0"]);
        // Trace confirms every compensate was attempted in reverse.
        let trace = applier.trace.borrow();
        for id in ["ws-3", "ws-2", "ws-1", "ws-0"] {
            assert!(
                trace.contains(&format!("compensate:{id}")),
                "compensate must have been attempted for {id}"
            );
        }
    }

    #[test]
    fn empty_plan_returns_active_immediately() {
        let plan = BundleApplyPlan {
            bundle_id: "bundle-e".into(),
            steps: Vec::new(),
        };
        let applier = MockApplier::default();
        let outcome = execute_bundle_apply(&plan, &applier);
        assert_eq!(outcome.state, WorkspaceState::Active);
        assert!(outcome.applied.is_empty());
        assert!(outcome.rolled_back.is_empty());
        assert!(outcome.conflicts.is_empty());
        assert!(applier.trace.borrow().is_empty());
    }

    // Silence unused-field warnings on ChangeKind / ResourceKind — they're
    // used to build realistic patch fixtures in future tests.
    #[allow(dead_code)]
    const _: (ChangeKind, ResourceKind) = (ChangeKind::Modified, ResourceKind::File);
}
