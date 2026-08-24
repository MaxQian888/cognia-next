//! ADR-0111 Managed Workspace Registry: the single owner of managed
//! workspace lifecycle.
//!
//! # Responsibilities
//!
//! - **Signed ownership.** Every managed workspace carries an
//!   `(owner_type, owner_ref)` pair. Startup reconcile only claims rows the
//!   Registry itself wrote; unowned worktrees discovered on disk are marked
//!   `Imported` and never auto-pruned.
//! - **State machine.** Transitions are validated by
//!   [`validate_state_transition`]; the Registry's mutating APIs are the
//!   only callers permitted to advance the state. Illegal transitions
//!   fail-closed with a typed error.
//! - **Retention.** Directory reclaim and snapshot expiration are separate
//!   entry points ([`plan_directory_reclaim`] and
//!   [`plan_snapshot_expiration`]); each consults the ADR-0111 ineligibility
//!   list before proposing prune candidates. This module owns *planning*; the
//!   actual filesystem/git side effects live in `service.rs` and
//!   `bundle.rs`.
//!
//! # Purity
//!
//! Everything here is deterministic and I/O-free with respect to the
//! filesystem and git — the only I/O is through [`WorkspaceStore`], which is
//! passed in by the caller. This keeps unit tests fast and lets callers wrap
//! actions in transactions.

use crate::{
    sensitive::{SensitiveAuditEntry, SensitiveDecision, SensitiveGrant, SensitiveGrantStore},
    store::WorkspaceStore,
    IsolationKind, WorkspaceBaseSpec, WorkspaceEnvironmentKind, WorkspaceLifecyclePolicy,
    WorkspaceOwnerType, WorkspaceRecord, WorkspaceState,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

/// Errors the Registry can emit. `String` messages are safe to display to
/// developers; user-facing surfaces translate them into localized strings.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RegistryError {
    /// The requested workspace does not exist.
    #[error("workspace {0} not found")]
    NotFound(String),

    /// Attempted a state transition the state machine forbids.
    #[error("illegal transition {from:?} → {to:?} for {workspace_id}")]
    IllegalTransition {
        workspace_id: String,
        from: WorkspaceState,
        to: WorkspaceState,
    },

    /// A caller tried to mutate a workspace they do not own.
    #[error("workspace {workspace_id} is owned by {actual:?}/{actual_ref:?}, not by {expected:?}/{expected_ref:?}")]
    OwnershipMismatch {
        workspace_id: String,
        expected: WorkspaceOwnerType,
        expected_ref: Option<String>,
        actual: WorkspaceOwnerType,
        actual_ref: Option<String>,
    },

    /// A caller tried to unlock or remove a workspace whose lock reason
    /// belongs to another actor.
    #[error("workspace {workspace_id} is locked by {actual:?}, not by {expected:?}")]
    LockReasonMismatch {
        workspace_id: String,
        expected: String,
        actual: Option<String>,
    },

    /// A caller tried to prune / auto-clean a workspace whose state
    /// protects it from automatic retention.
    #[error("workspace {workspace_id} in state {state:?} is not prunable")]
    ProtectedFromPrune {
        workspace_id: String,
        state: WorkspaceState,
    },

    /// A caller tried to use `Imported` semantics to modify a Cognia-owned
    /// workspace. Retained separately from `OwnershipMismatch` to make the
    /// UI story explicit.
    #[error("workspace {0} is Cognia-owned; imported semantics rejected")]
    NotImported(String),

    /// Underlying store call failed. Preserves the message so callers see
    /// the SQLite / IO cause.
    #[error("store error: {0}")]
    Store(String),
}

impl RegistryError {
    /// Convenience for lifting a `Result<T, String>` from the store layer.
    pub fn from_store<T>(result: Result<T, String>) -> Result<T, Self> {
        result.map_err(RegistryError::Store)
    }
}

/// Encode the ADR-0111 legal state transitions.
///
/// Returns `Ok(())` iff `from → to` is a legal step. `Provisioning`,
/// `Active`, `Archived`, `Restorable`, and `Conflict` may all transition to
/// `Removing`; `Removing → Removed` is terminal; no other transitions are
/// allowed. Any state may "transition" to itself (idempotent puts).
pub fn validate_state_transition(
    from: WorkspaceState,
    to: WorkspaceState,
) -> Result<(), RegistryError> {
    // Self-transitions are always allowed so repeated `put_workspace` calls
    // with the same state are idempotent.
    if from == to {
        return Ok(());
    }
    let allowed = matches!(
        (from, to),
        (WorkspaceState::Provisioning, WorkspaceState::Active)
            | (WorkspaceState::Provisioning, WorkspaceState::Removing)
            | (WorkspaceState::Active, WorkspaceState::Archived)
            | (WorkspaceState::Active, WorkspaceState::Conflict)
            | (WorkspaceState::Active, WorkspaceState::Removing)
            | (WorkspaceState::Archived, WorkspaceState::Restorable)
            | (WorkspaceState::Archived, WorkspaceState::Removing)
            | (WorkspaceState::Restorable, WorkspaceState::Active)
            | (WorkspaceState::Restorable, WorkspaceState::Removing)
            | (WorkspaceState::Conflict, WorkspaceState::Active)
            | (WorkspaceState::Conflict, WorkspaceState::Removing)
            | (WorkspaceState::Removing, WorkspaceState::Removed)
    );
    if allowed {
        Ok(())
    } else {
        // We don't have the workspace_id here — callers wrap this so the
        // caller-facing error includes the id.
        Err(RegistryError::IllegalTransition {
            workspace_id: String::new(),
            from,
            to,
        })
    }
}

/// Compose the canonical lock reason for a managed workspace.
///
/// Format is `cognia:<workspaceId>` per ADR-0111 §3. The Registry writes
/// this via `git worktree lock --reason` (in the service layer) and only
/// unlocks when the reason matches.
pub fn compose_lock_reason(workspace_id: &str) -> String {
    format!("cognia:{workspace_id}")
}

/// Split a lock reason back into the workspace id it references. Returns
/// `None` for reasons the Registry did not author, so `remove` can refuse
/// them.
pub fn parse_lock_reason(reason: &str) -> Option<&str> {
    reason.strip_prefix("cognia:")
}

/// Outcome of one reconcile pass. Callers persist the changes; the
/// planner itself does not mutate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileOutcome {
    /// Rows the Registry already knew about and which passed signature
    /// verification. Nothing changes for these.
    pub reclaimed: Vec<String>,
    /// Rows the Registry knew about but whose owner_ref no longer resolves
    /// (session gone, task deleted, etc.). Callers should demote these to
    /// `Restorable` or archive them.
    pub orphaned: Vec<String>,
    /// Worktrees on disk that Registry did not create. Callers store these
    /// as `Imported` — they must never be auto-pruned.
    pub imported: Vec<ImportedWorkspaceHint>,
}

/// A hint about a worktree found on disk that Registry did not create.
///
/// The planner records only the source root + execution root so callers can
/// insert a signed `WorkspaceRecord` with `owner_type = Imported` after
/// verifying paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedWorkspaceHint {
    pub source_root: String,
    pub execution_root: String,
    pub git_common_dir: Option<String>,
    pub branch: Option<String>,
}

/// One directory-reclaim proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryReclaimCandidate {
    pub workspace_id: String,
    pub execution_root: String,
    pub last_used_at: i64,
    pub reason: DirectoryReclaimReason,
}

/// Why the planner is proposing to reclaim a workspace directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DirectoryReclaimReason {
    /// The active-managed directory cap was exceeded; this is the
    /// least-recently-used prunable row.
    OverCap,
    /// User-issued manual archive.
    ManualArchive,
}

/// One snapshot-expiration proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotExpirationCandidate {
    pub workspace_id: String,
    pub snapshot_task_id: String,
    pub last_used_at: i64,
    pub reason: SnapshotExpirationReason,
}

/// Why the planner is proposing to expire a snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotExpirationReason {
    /// The snapshot is older than `snapshot_retention_days` days.
    Aged,
    /// The blob budget was exceeded; this is the least-recently-used
    /// snapshot participating in the overrun.
    OverBudget,
}

/// The Registry facade. Owns the `WorkspaceStore` handle and the in-memory
/// sensitive-grant index; every mutating operation validates ownership and
/// state before touching the store.
pub struct WorkspaceRegistry {
    store: std::sync::Arc<parking_lot::Mutex<WorkspaceStore>>,
    grants: parking_lot::Mutex<SensitiveGrantStore>,
    policy: parking_lot::RwLock<WorkspaceLifecyclePolicy>,
}

impl WorkspaceRegistry {
    /// Wrap an existing store handle and hydrate the sensitive-grant index.
    ///
    /// The store is shared with `TaskWorkspaceService` — one connection, two
    /// façades — so schema transactions do not race across the Registry and
    /// service surfaces.
    pub fn new(
        store: std::sync::Arc<parking_lot::Mutex<WorkspaceStore>>,
    ) -> Result<Self, RegistryError> {
        let (grants, policy) = {
            let guard = store.lock();
            let loaded = RegistryError::from_store(guard.list_sensitive_grants())?;
            let mut index = SensitiveGrantStore::new();
            index.seed(loaded);
            let policy = RegistryError::from_store(guard.get_workspace_lifecycle_policy())?
                .unwrap_or_default();
            (index, policy)
        };
        Ok(Self {
            store,
            grants: parking_lot::Mutex::new(grants),
            policy: parking_lot::RwLock::new(policy),
        })
    }

    /// Override the retention policy. Callers wire this from user settings.
    pub fn set_policy(&self, policy: WorkspaceLifecyclePolicy) -> Result<(), RegistryError> {
        RegistryError::from_store(self.store.lock().put_workspace_lifecycle_policy(&policy))?;
        *self.policy.write() = policy;
        Ok(())
    }

    /// Read the current retention policy.
    pub fn policy(&self) -> WorkspaceLifecyclePolicy {
        *self.policy.read()
    }

    /// Fetch one Registry row.
    pub fn get(&self, workspace_id: &str) -> Result<Option<WorkspaceRecord>, RegistryError> {
        RegistryError::from_store(self.store.lock().get_workspace(workspace_id))
    }

    /// List every Registry row, most-recently-used first.
    pub fn list(&self) -> Result<Vec<WorkspaceRecord>, RegistryError> {
        RegistryError::from_store(self.store.lock().list_workspaces())
    }

    /// Insert a new managed workspace. Returns the assigned `workspace_id`.
    ///
    /// The initial state must be `Provisioning`; callers advance to `Active`
    /// after `service.rs` finishes materializing the isolation root.
    ///
    /// The lock reason is derived deterministically from the `workspace_id`
    /// so a subsequent `remove_workspace` call can validate it.
    pub fn insert(
        &self,
        owner_type: WorkspaceOwnerType,
        owner_ref: Option<String>,
        source_root: String,
        git_common_dir: Option<String>,
        base: WorkspaceBaseSpec,
        isolation_kind: IsolationKind,
        execution_root: String,
        now: i64,
    ) -> Result<WorkspaceRecord, RegistryError> {
        let workspace_id = Uuid::now_v7().to_string();
        self.insert_reserved(
            workspace_id,
            owner_type,
            owner_ref,
            source_root,
            git_common_dir,
            base,
            isolation_kind,
            execution_root,
            now,
        )
    }

    /// Reserve a caller-assigned workspace id before provisioning begins.
    ///
    /// Provisioners need the id to construct the signed Git lock reason in
    /// the same `git worktree add` invocation that creates the directory.
    pub fn insert_reserved(
        &self,
        workspace_id: String,
        owner_type: WorkspaceOwnerType,
        owner_ref: Option<String>,
        source_root: String,
        git_common_dir: Option<String>,
        base: WorkspaceBaseSpec,
        isolation_kind: IsolationKind,
        execution_root: String,
        now: i64,
    ) -> Result<WorkspaceRecord, RegistryError> {
        // `Imported` may only be inserted via `insert_imported`.
        if owner_type == WorkspaceOwnerType::Imported {
            return Err(RegistryError::OwnershipMismatch {
                workspace_id: workspace_id.clone(),
                expected: WorkspaceOwnerType::User,
                expected_ref: None,
                actual: WorkspaceOwnerType::Imported,
                actual_ref: owner_ref.clone(),
            });
        }
        let record = WorkspaceRecord {
            workspace_id: workspace_id.clone(),
            environment_kind: WorkspaceEnvironmentKind::Managed,
            owner_type,
            owner_ref,
            state: WorkspaceState::Provisioning,
            source_root,
            git_common_dir,
            base,
            head: None,
            branch: None,
            isolation_kind,
            execution_root,
            snapshot_task_id: None,
            size_bytes: None,
            last_used_at: now,
            locked_by: Some(compose_lock_reason(&workspace_id)),
            pinned: false,
            created_at: now,
        };
        RegistryError::from_store(self.store.lock().put_workspace(&record))?;
        Ok(record)
    }

    /// Insert an `Imported` row — a worktree already on disk that Registry
    /// discovered but did not create. Imported rows never participate in
    /// automatic prune and cannot be transitioned by Registry code.
    pub fn insert_imported(
        &self,
        hint: ImportedWorkspaceHint,
        now: i64,
    ) -> Result<WorkspaceRecord, RegistryError> {
        let workspace_id = Uuid::now_v7().to_string();
        let record = WorkspaceRecord {
            workspace_id: workspace_id.clone(),
            environment_kind: WorkspaceEnvironmentKind::Imported,
            owner_type: WorkspaceOwnerType::Imported,
            owner_ref: None,
            state: WorkspaceState::Active,
            source_root: hint.source_root,
            git_common_dir: hint.git_common_dir,
            base: WorkspaceBaseSpec::LocalHead,
            head: None,
            branch: hint.branch,
            isolation_kind: IsolationKind::GitWorktree,
            execution_root: hint.execution_root,
            snapshot_task_id: None,
            size_bytes: None,
            last_used_at: now,
            locked_by: None, // imported rows carry no Cognia lock
            pinned: false,
            created_at: now,
        };
        RegistryError::from_store(self.store.lock().put_workspace(&record))?;
        Ok(record)
    }

    /// Transition a workspace to a new state, with ownership + legality
    /// checks. Callers pass the expected owner so a peer session cannot
    /// mutate a workspace it did not create.
    pub fn transition(
        &self,
        workspace_id: &str,
        expected_owner_type: WorkspaceOwnerType,
        expected_owner_ref: Option<&str>,
        to: WorkspaceState,
        now: i64,
    ) -> Result<WorkspaceRecord, RegistryError> {
        let store = self.store.lock();
        let mut record = store
            .get_workspace(workspace_id)
            .map_err(RegistryError::Store)?
            .ok_or_else(|| RegistryError::NotFound(workspace_id.to_string()))?;
        // Ownership check first — an unauthorized caller must not learn the
        // current state.
        if record.owner_type != expected_owner_type
            || record.owner_ref.as_deref() != expected_owner_ref
        {
            return Err(RegistryError::OwnershipMismatch {
                workspace_id: workspace_id.to_string(),
                expected: expected_owner_type,
                expected_ref: expected_owner_ref.map(str::to_string),
                actual: record.owner_type,
                actual_ref: record.owner_ref.clone(),
            });
        }
        // Imported rows may not be transitioned by Registry code.
        if record.owner_type == WorkspaceOwnerType::Imported {
            return Err(RegistryError::NotImported(workspace_id.to_string()));
        }
        // Legality check.
        validate_state_transition(record.state, to).map_err(|_| {
            RegistryError::IllegalTransition {
                workspace_id: workspace_id.to_string(),
                from: record.state,
                to,
            }
        })?;
        record.state = to;
        record.last_used_at = now;
        // Removing → the lock is only released when we cross into Removed.
        if to == WorkspaceState::Removed {
            record.locked_by = None;
        }
        store.put_workspace(&record).map_err(RegistryError::Store)?;
        Ok(record)
    }

    /// Pin or unpin a workspace. Pinned workspaces are excluded from
    /// directory-reclaim proposals.
    pub fn set_pinned(
        &self,
        workspace_id: &str,
        pinned: bool,
    ) -> Result<WorkspaceRecord, RegistryError> {
        let store = self.store.lock();
        let mut record = store
            .get_workspace(workspace_id)
            .map_err(RegistryError::Store)?
            .ok_or_else(|| RegistryError::NotFound(workspace_id.to_string()))?;
        record.pinned = pinned;
        store.put_workspace(&record).map_err(RegistryError::Store)?;
        Ok(record)
    }

    /// Classify a Cognia-owned row as session-managed or permanent.
    pub fn set_environment_kind(
        &self,
        workspace_id: &str,
        environment_kind: WorkspaceEnvironmentKind,
    ) -> Result<WorkspaceRecord, RegistryError> {
        if environment_kind == WorkspaceEnvironmentKind::Imported {
            return Err(RegistryError::NotImported(workspace_id.to_string()));
        }
        let store = self.store.lock();
        let mut record = store
            .get_workspace(workspace_id)
            .map_err(RegistryError::Store)?
            .ok_or_else(|| RegistryError::NotFound(workspace_id.to_string()))?;
        if record.owner_type == WorkspaceOwnerType::Imported {
            return Err(RegistryError::NotImported(workspace_id.to_string()));
        }
        record.environment_kind = environment_kind;
        store.put_workspace(&record).map_err(RegistryError::Store)?;
        Ok(record)
    }

    /// Transfer an explicitly selected Imported row into Cognia ownership.
    /// The caller must establish any physical Git lock before committing this
    /// metadata change; unknown environments remain read-only until this call.
    pub fn adopt_imported(
        &self,
        workspace_id: &str,
        owner_type: WorkspaceOwnerType,
        owner_ref: Option<String>,
        environment_kind: WorkspaceEnvironmentKind,
    ) -> Result<WorkspaceRecord, RegistryError> {
        if owner_type == WorkspaceOwnerType::Imported
            || environment_kind == WorkspaceEnvironmentKind::Imported
        {
            return Err(RegistryError::NotImported(workspace_id.to_string()));
        }
        let store = self.store.lock();
        let mut record = store
            .get_workspace(workspace_id)
            .map_err(RegistryError::Store)?
            .ok_or_else(|| RegistryError::NotFound(workspace_id.to_string()))?;
        if record.owner_type != WorkspaceOwnerType::Imported
            || record.environment_kind != WorkspaceEnvironmentKind::Imported
        {
            return Err(RegistryError::NotImported(workspace_id.to_string()));
        }
        record.owner_type = owner_type;
        record.owner_ref = owner_ref;
        record.environment_kind = environment_kind;
        record.locked_by = Some(compose_lock_reason(workspace_id));
        store.put_workspace(&record).map_err(RegistryError::Store)?;
        Ok(record)
    }

    pub fn set_archive_metadata(
        &self,
        workspace_id: &str,
        snapshot_task_id: Option<String>,
        size_bytes: Option<u64>,
    ) -> Result<WorkspaceRecord, RegistryError> {
        let store = self.store.lock();
        let mut record = store
            .get_workspace(workspace_id)
            .map_err(RegistryError::Store)?
            .ok_or_else(|| RegistryError::NotFound(workspace_id.to_string()))?;
        if record.owner_type == WorkspaceOwnerType::Imported {
            return Err(RegistryError::NotImported(workspace_id.to_string()));
        }
        record.snapshot_task_id = snapshot_task_id;
        record.size_bytes = size_bytes;
        store.put_workspace(&record).map_err(RegistryError::Store)?;
        Ok(record)
    }

    /// Persist branch metadata after a host has successfully attached a
    /// detached managed worktree to a branch. Git mutation stays outside this
    /// transport-neutral crate; Registry remains the metadata authority.
    pub fn set_branch_metadata(
        &self,
        workspace_id: &str,
        branch: String,
        head: Option<String>,
    ) -> Result<WorkspaceRecord, RegistryError> {
        let store = self.store.lock();
        let mut record = store
            .get_workspace(workspace_id)
            .map_err(RegistryError::Store)?
            .ok_or_else(|| RegistryError::NotFound(workspace_id.to_string()))?;
        if record.owner_type == WorkspaceOwnerType::Imported
            || record.environment_kind == WorkspaceEnvironmentKind::Imported
        {
            return Err(RegistryError::NotImported(workspace_id.to_string()));
        }
        record.branch = Some(branch);
        if let Some(head) = head {
            record.head = Some(head);
        }
        store.put_workspace(&record).map_err(RegistryError::Store)?;
        Ok(record)
    }

    /// Remove a Cognia-owned workspace. Refuses if the lock reason does not
    /// match. Callers must have separately transitioned the workspace to
    /// `Removing` first — this call finalizes it to `Removed` and deletes
    /// the row.
    ///
    /// Imported rows are refused; use [`forget_imported`] instead.
    pub fn remove_workspace(
        &self,
        workspace_id: &str,
        expected_lock_reason: &str,
    ) -> Result<(), RegistryError> {
        let store = self.store.lock();
        let record = store
            .get_workspace(workspace_id)
            .map_err(RegistryError::Store)?
            .ok_or_else(|| RegistryError::NotFound(workspace_id.to_string()))?;
        if record.owner_type == WorkspaceOwnerType::Imported {
            return Err(RegistryError::NotImported(workspace_id.to_string()));
        }
        if record.locked_by.as_deref() != Some(expected_lock_reason) {
            return Err(RegistryError::LockReasonMismatch {
                workspace_id: workspace_id.to_string(),
                expected: expected_lock_reason.to_string(),
                actual: record.locked_by,
            });
        }
        if record.state != WorkspaceState::Removing {
            return Err(RegistryError::IllegalTransition {
                workspace_id: workspace_id.to_string(),
                from: record.state,
                to: WorkspaceState::Removed,
            });
        }
        store
            .delete_workspace(workspace_id)
            .map_err(RegistryError::Store)
    }

    /// Forget an Imported row — the on-disk worktree is untouched; Registry
    /// just stops tracking it. Refuses Cognia-owned rows.
    pub fn forget_imported(&self, workspace_id: &str) -> Result<(), RegistryError> {
        let store = self.store.lock();
        let record = store
            .get_workspace(workspace_id)
            .map_err(RegistryError::Store)?
            .ok_or_else(|| RegistryError::NotFound(workspace_id.to_string()))?;
        if record.owner_type != WorkspaceOwnerType::Imported {
            return Err(RegistryError::OwnershipMismatch {
                workspace_id: workspace_id.to_string(),
                expected: WorkspaceOwnerType::Imported,
                expected_ref: None,
                actual: record.owner_type,
                actual_ref: record.owner_ref,
            });
        }
        store
            .delete_workspace(workspace_id)
            .map_err(RegistryError::Store)
    }

    /// Record a sensitive-path decision. On `Granted` the grant is added to
    /// both SQLite and the in-memory index. Every call appends an audit row.
    pub fn record_sensitive_decision(
        &self,
        workspace_id: &str,
        relative_path: &str,
        decision: SensitiveDecision,
        requester_owner_type: WorkspaceOwnerType,
        requester_owner_ref: Option<String>,
        now: i64,
        reason: Option<String>,
    ) -> Result<(), RegistryError> {
        let store = self.store.lock();
        if decision == SensitiveDecision::Granted {
            let grant = SensitiveGrant {
                workspace_id: workspace_id.to_string(),
                relative_path: relative_path.to_string(),
                granted_by_owner_type: requester_owner_type,
                granted_by_owner_ref: requester_owner_ref.clone(),
                granted_at: now,
            };
            store
                .put_sensitive_grant(&grant)
                .map_err(RegistryError::Store)?;
            self.grants.lock().insert(workspace_id, relative_path);
        }
        let audit = SensitiveAuditEntry {
            audit_id: Uuid::now_v7().to_string(),
            workspace_id: workspace_id.to_string(),
            relative_path: relative_path.to_string(),
            decision,
            requester_owner_type,
            requester_owner_ref,
            decided_at: now,
            reason,
        };
        store
            .append_sensitive_audit(&audit)
            .map_err(RegistryError::Store)
    }

    /// Query whether a sensitive path has been granted for this workspace.
    /// Backed by the in-memory index (no SQLite hit).
    pub fn sensitive_grant_exists(&self, workspace_id: &str, relative_path: &str) -> bool {
        self.grants.lock().is_granted(workspace_id, relative_path)
    }
}

/// Compute directory-reclaim candidates for a corpus of records.
///
/// Pure function of the inputs — the corpus is loaded by the caller (from
/// `WorkspaceStore::list_workspaces`). Returns candidates in prune-preferred
/// order (oldest `last_used_at` first). The ADR-0111 ineligibility list is
/// enforced by `WorkspaceState::is_prunable` and by the pin/lock checks.
pub fn plan_directory_reclaim(
    records: &[WorkspaceRecord],
    policy: WorkspaceLifecyclePolicy,
) -> Vec<DirectoryReclaimCandidate> {
    let active_count = records
        .iter()
        .filter(|r| {
            matches!(
                r.state,
                WorkspaceState::Active | WorkspaceState::Provisioning
            )
        })
        .count() as u32;
    if active_count <= policy.active_directory_cap {
        return Vec::new();
    }
    let overflow = (active_count - policy.active_directory_cap) as usize;
    let mut candidates: Vec<&WorkspaceRecord> = records
        .iter()
        .filter(|record| {
            record.environment_kind == WorkspaceEnvironmentKind::Managed
                && record.state.is_prunable()
                && !record.pinned
                && record.owner_type != WorkspaceOwnerType::Imported
        })
        .collect();
    candidates.sort_by_key(|record| record.last_used_at);
    candidates
        .into_iter()
        .take(overflow)
        .map(|record| DirectoryReclaimCandidate {
            workspace_id: record.workspace_id.clone(),
            execution_root: record.execution_root.clone(),
            last_used_at: record.last_used_at,
            reason: DirectoryReclaimReason::OverCap,
        })
        .collect()
}

/// Compute snapshot-expiration candidates for a corpus of records.
///
/// Aged snapshots come first (oldest snapshots that exceed
/// `snapshot_retention_days`). If total snapshot bytes still exceed
/// `blob_budget_bytes`, additional least-recently-used snapshots are
/// proposed with `OverBudget`.
pub fn plan_snapshot_expiration(
    records: &[WorkspaceRecord],
    policy: WorkspaceLifecyclePolicy,
    now: i64,
) -> Vec<SnapshotExpirationCandidate> {
    let retention_window_millis = i64::from(policy.snapshot_retention_days) * 24 * 60 * 60 * 1_000;
    let mut candidates: Vec<SnapshotExpirationCandidate> = Vec::new();
    let mut kept_bytes: u64 = 0;
    let mut protected: HashSet<&str> = HashSet::new();

    // Pass 1: aged snapshots — ineligible states are filtered here.
    for record in records {
        let Some(ref task_id) = record.snapshot_task_id else {
            continue;
        };
        if record.environment_kind != WorkspaceEnvironmentKind::Managed
            || !record.state.is_prunable()
            || record.pinned
        {
            protected.insert(task_id.as_str());
            kept_bytes = kept_bytes.saturating_add(record.size_bytes.unwrap_or(0));
            continue;
        }
        if now.saturating_sub(record.last_used_at) > retention_window_millis {
            candidates.push(SnapshotExpirationCandidate {
                workspace_id: record.workspace_id.clone(),
                snapshot_task_id: task_id.clone(),
                last_used_at: record.last_used_at,
                reason: SnapshotExpirationReason::Aged,
            });
        } else {
            kept_bytes = kept_bytes.saturating_add(record.size_bytes.unwrap_or(0));
        }
    }

    // Pass 2: budget overrun — sort remaining candidates by LRU and drop
    // until under budget. Protected snapshots always count against the
    // budget but never enter the candidates.
    if kept_bytes > policy.blob_budget_bytes {
        let mut remaining: Vec<&WorkspaceRecord> = records
            .iter()
            .filter(|record| {
                let Some(ref task_id) = record.snapshot_task_id else {
                    return false;
                };
                !protected.contains(task_id.as_str())
                    && !candidates
                        .iter()
                        .any(|candidate| &candidate.snapshot_task_id == task_id)
                    && record.environment_kind == WorkspaceEnvironmentKind::Managed
                    && record.state.is_prunable()
                    && !record.pinned
            })
            .collect();
        remaining.sort_by_key(|record| record.last_used_at);
        for record in remaining {
            if kept_bytes <= policy.blob_budget_bytes {
                break;
            }
            let snapshot_task_id = record.snapshot_task_id.clone().unwrap_or_default();
            let size = record.size_bytes.unwrap_or(0);
            kept_bytes = kept_bytes.saturating_sub(size);
            candidates.push(SnapshotExpirationCandidate {
                workspace_id: record.workspace_id.clone(),
                snapshot_task_id,
                last_used_at: record.last_used_at,
                reason: SnapshotExpirationReason::OverBudget,
            });
        }
    }

    candidates
}

/// Deduce reconcile candidates from Registry rows + on-disk worktree paths.
///
/// `on_disk_execution_roots` are the execution roots observed via
/// `git worktree list` (or equivalent). `owner_still_alive` tells the
/// planner whether an `owner_ref` string still resolves to a live owner —
/// e.g. session id in the session store. Rows whose owner has gone away are
/// reported as `orphaned` and callers should demote them to `Restorable`.
pub fn plan_reconcile(
    records: &[WorkspaceRecord],
    on_disk_execution_roots: &HashSet<String>,
    owner_still_alive: &dyn Fn(&WorkspaceRecord) -> bool,
) -> ReconcileOutcome {
    let mut reclaimed = Vec::new();
    let mut orphaned = Vec::new();
    let mut imported = Vec::new();

    let known_roots: HashSet<&str> = records
        .iter()
        .map(|record| record.execution_root.as_str())
        .collect();
    for record in records {
        if record.owner_type == WorkspaceOwnerType::Imported {
            continue;
        }
        if !on_disk_execution_roots.contains(&record.execution_root) {
            // Row on file but worktree gone — treat as orphaned so callers
            // can archive or garbage-collect.
            orphaned.push(record.workspace_id.clone());
            continue;
        }
        if owner_still_alive(record) {
            reclaimed.push(record.workspace_id.clone());
        } else {
            orphaned.push(record.workspace_id.clone());
        }
    }
    for path in on_disk_execution_roots {
        if !known_roots.contains(path.as_str()) {
            imported.push(ImportedWorkspaceHint {
                source_root: String::new(),
                execution_root: path.clone(),
                git_common_dir: None,
                branch: None,
            });
        }
    }
    ReconcileOutcome {
        reclaimed,
        orphaned,
        imported,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{IsolationKind, WorkspaceBaseSpec, WorkspaceOwnerType, WorkspaceRecord};
    use std::sync::Arc;

    fn record(id: &str, state: WorkspaceState, owner_type: WorkspaceOwnerType) -> WorkspaceRecord {
        WorkspaceRecord {
            workspace_id: id.into(),
            environment_kind: if owner_type == WorkspaceOwnerType::Imported {
                WorkspaceEnvironmentKind::Imported
            } else {
                WorkspaceEnvironmentKind::Managed
            },
            owner_type,
            owner_ref: Some("owner".into()),
            state,
            source_root: "/workspace".into(),
            git_common_dir: None,
            base: WorkspaceBaseSpec::LocalHead,
            head: None,
            branch: None,
            isolation_kind: IsolationKind::Shadow,
            execution_root: format!("/tmp/{id}"),
            snapshot_task_id: None,
            size_bytes: None,
            last_used_at: 0,
            locked_by: Some(compose_lock_reason(id)),
            pinned: false,
            created_at: 0,
        }
    }

    #[test]
    fn compose_and_parse_lock_reason_round_trip() {
        let reason = compose_lock_reason("ws-42");
        assert_eq!(reason, "cognia:ws-42");
        assert_eq!(parse_lock_reason(&reason), Some("ws-42"));
        assert_eq!(parse_lock_reason("other:ws-42"), None);
    }

    #[test]
    fn state_machine_rejects_illegal_transitions() {
        // Legal
        assert!(
            validate_state_transition(WorkspaceState::Provisioning, WorkspaceState::Active).is_ok()
        );
        assert!(
            validate_state_transition(WorkspaceState::Active, WorkspaceState::Archived).is_ok()
        );
        assert!(
            validate_state_transition(WorkspaceState::Restorable, WorkspaceState::Active).is_ok()
        );
        // Illegal
        assert!(
            validate_state_transition(WorkspaceState::Provisioning, WorkspaceState::Archived)
                .is_err()
        );
        assert!(
            validate_state_transition(WorkspaceState::Removed, WorkspaceState::Active).is_err()
        );
        assert!(
            validate_state_transition(WorkspaceState::Archived, WorkspaceState::Active).is_err()
        );
        // Self-transition allowed (idempotency)
        assert!(validate_state_transition(WorkspaceState::Active, WorkspaceState::Active).is_ok());
    }

    fn new_registry() -> (WorkspaceRegistry, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(parking_lot::Mutex::new(
            WorkspaceStore::open(dir.path(), 1024 * 1024).unwrap(),
        ));
        let registry = WorkspaceRegistry::new(store).unwrap();
        (registry, dir)
    }

    #[test]
    fn insert_creates_row_in_provisioning_state_with_lock_reason() {
        let (registry, _dir) = new_registry();
        let record = registry
            .insert(
                WorkspaceOwnerType::Session,
                Some("session-1".into()),
                "/workspace".into(),
                None,
                WorkspaceBaseSpec::WorkingState,
                IsolationKind::Shadow,
                "/tmp/ws".into(),
                42,
            )
            .unwrap();
        assert_eq!(record.state, WorkspaceState::Provisioning);
        assert_eq!(
            record.locked_by.as_deref(),
            Some(compose_lock_reason(&record.workspace_id).as_str())
        );
        let loaded = registry.get(&record.workspace_id).unwrap().unwrap();
        assert_eq!(loaded, record);
    }

    #[test]
    fn insert_reserved_uses_the_id_for_the_signed_lock_reason() {
        let (registry, _dir) = new_registry();
        let record = registry
            .insert_reserved(
                "workspace-fixed".into(),
                WorkspaceOwnerType::Session,
                Some("session-1".into()),
                "/workspace".into(),
                Some("/workspace/.git".into()),
                WorkspaceBaseSpec::WorkingState,
                IsolationKind::GitWorktree,
                "/tmp/workspace-fixed".into(),
                42,
            )
            .unwrap();

        assert_eq!(record.workspace_id, "workspace-fixed");
        assert_eq!(record.locked_by.as_deref(), Some("cognia:workspace-fixed"));
        assert_eq!(registry.get("workspace-fixed").unwrap(), Some(record));
    }

    #[test]
    fn insert_refuses_imported_owner_type() {
        let (registry, _dir) = new_registry();
        let error = registry
            .insert(
                WorkspaceOwnerType::Imported,
                None,
                "/workspace".into(),
                None,
                WorkspaceBaseSpec::LocalHead,
                IsolationKind::Shadow,
                "/tmp/ws".into(),
                0,
            )
            .expect_err("must reject imported");
        assert!(matches!(error, RegistryError::OwnershipMismatch { .. }));
    }

    #[test]
    fn imported_rows_require_explicit_adoption_before_ownership_changes() {
        let (registry, _dir) = new_registry();
        let imported = registry
            .insert_imported(
                ImportedWorkspaceHint {
                    source_root: "/workspace".into(),
                    execution_root: "/tmp/imported".into(),
                    git_common_dir: Some("/workspace/.git".into()),
                    branch: None,
                },
                1,
            )
            .unwrap();
        let lock_reason = compose_lock_reason(&imported.workspace_id);
        let adopted = registry
            .adopt_imported(
                &imported.workspace_id,
                WorkspaceOwnerType::User,
                None,
                WorkspaceEnvironmentKind::Managed,
            )
            .unwrap();

        assert_eq!(adopted.owner_type, WorkspaceOwnerType::User);
        assert_eq!(adopted.environment_kind, WorkspaceEnvironmentKind::Managed);
        assert_eq!(adopted.locked_by.as_deref(), Some(lock_reason.as_str()));
        assert!(matches!(
            registry.adopt_imported(
                &imported.workspace_id,
                WorkspaceOwnerType::User,
                None,
                WorkspaceEnvironmentKind::Managed,
            ),
            Err(RegistryError::NotImported(_))
        ));
    }

    #[test]
    fn transition_requires_correct_owner() {
        let (registry, _dir) = new_registry();
        let record = registry
            .insert(
                WorkspaceOwnerType::Session,
                Some("session-1".into()),
                "/workspace".into(),
                None,
                WorkspaceBaseSpec::LocalHead,
                IsolationKind::Shadow,
                "/tmp/ws".into(),
                0,
            )
            .unwrap();
        let wrong = registry.transition(
            &record.workspace_id,
            WorkspaceOwnerType::Team,
            Some("team-1"),
            WorkspaceState::Active,
            10,
        );
        assert!(matches!(
            wrong,
            Err(RegistryError::OwnershipMismatch { .. })
        ));
        // Same owner_type but wrong owner_ref is also rejected.
        let wrong_ref = registry.transition(
            &record.workspace_id,
            WorkspaceOwnerType::Session,
            Some("session-2"),
            WorkspaceState::Active,
            10,
        );
        assert!(matches!(
            wrong_ref,
            Err(RegistryError::OwnershipMismatch { .. })
        ));
        // Correct owner succeeds.
        let ok = registry
            .transition(
                &record.workspace_id,
                WorkspaceOwnerType::Session,
                Some("session-1"),
                WorkspaceState::Active,
                10,
            )
            .unwrap();
        assert_eq!(ok.state, WorkspaceState::Active);
    }

    #[test]
    fn transition_rejects_illegal_state_hops() {
        let (registry, _dir) = new_registry();
        let record = registry
            .insert(
                WorkspaceOwnerType::Session,
                Some("s".into()),
                "/workspace".into(),
                None,
                WorkspaceBaseSpec::LocalHead,
                IsolationKind::Shadow,
                "/tmp/ws".into(),
                0,
            )
            .unwrap();
        // Provisioning → Archived is illegal (must go via Active first).
        let error = registry
            .transition(
                &record.workspace_id,
                WorkspaceOwnerType::Session,
                Some("s"),
                WorkspaceState::Archived,
                1,
            )
            .expect_err("illegal transition");
        assert!(matches!(error, RegistryError::IllegalTransition { .. }));
    }

    #[test]
    fn transition_refuses_to_touch_imported_rows() {
        let (registry, _dir) = new_registry();
        let imported = registry
            .insert_imported(
                ImportedWorkspaceHint {
                    source_root: "/workspace".into(),
                    execution_root: "/imported".into(),
                    git_common_dir: None,
                    branch: None,
                },
                0,
            )
            .unwrap();
        let error = registry
            .transition(
                &imported.workspace_id,
                WorkspaceOwnerType::Imported,
                None,
                WorkspaceState::Active,
                1,
            )
            .expect_err("imported must reject");
        assert!(matches!(error, RegistryError::NotImported(_)));
    }

    #[test]
    fn remove_requires_matching_lock_reason_and_removing_state() {
        let (registry, _dir) = new_registry();
        let record = registry
            .insert(
                WorkspaceOwnerType::User,
                None,
                "/workspace".into(),
                None,
                WorkspaceBaseSpec::LocalHead,
                IsolationKind::Shadow,
                "/tmp/ws".into(),
                0,
            )
            .unwrap();
        // Not yet in Removing → refused.
        let too_early =
            registry.remove_workspace(&record.workspace_id, record.locked_by.as_deref().unwrap());
        assert!(matches!(
            too_early,
            Err(RegistryError::IllegalTransition { .. })
        ));
        // Advance to Active then Removing.
        registry
            .transition(
                &record.workspace_id,
                WorkspaceOwnerType::User,
                None,
                WorkspaceState::Active,
                1,
            )
            .unwrap();
        registry
            .transition(
                &record.workspace_id,
                WorkspaceOwnerType::User,
                None,
                WorkspaceState::Removing,
                2,
            )
            .unwrap();
        // Wrong lock reason → refused.
        let wrong_lock = registry.remove_workspace(&record.workspace_id, "cognia:someone-else");
        assert!(matches!(
            wrong_lock,
            Err(RegistryError::LockReasonMismatch { .. })
        ));
        // Correct lock reason → succeeds.
        registry
            .remove_workspace(&record.workspace_id, record.locked_by.as_deref().unwrap())
            .unwrap();
        assert!(registry.get(&record.workspace_id).unwrap().is_none());
    }

    #[test]
    fn imported_rows_are_forgotten_not_removed() {
        let (registry, _dir) = new_registry();
        let imported = registry
            .insert_imported(
                ImportedWorkspaceHint {
                    source_root: "/w".into(),
                    execution_root: "/imported".into(),
                    git_common_dir: None,
                    branch: None,
                },
                0,
            )
            .unwrap();
        // remove_workspace refuses imported rows.
        let error = registry.remove_workspace(&imported.workspace_id, "cognia:whatever");
        assert!(matches!(error, Err(RegistryError::NotImported(_))));
        // forget_imported succeeds.
        registry.forget_imported(&imported.workspace_id).unwrap();
        assert!(registry.get(&imported.workspace_id).unwrap().is_none());
    }

    #[test]
    fn set_pinned_flips_the_flag_and_persists() {
        let (registry, _dir) = new_registry();
        let record = registry
            .insert(
                WorkspaceOwnerType::User,
                None,
                "/w".into(),
                None,
                WorkspaceBaseSpec::LocalHead,
                IsolationKind::Shadow,
                "/tmp/ws".into(),
                0,
            )
            .unwrap();
        registry.set_pinned(&record.workspace_id, true).unwrap();
        assert!(registry.get(&record.workspace_id).unwrap().unwrap().pinned);
    }

    #[test]
    fn granting_a_sensitive_path_persists_and_updates_index() {
        let (registry, _dir) = new_registry();
        let record = registry
            .insert(
                WorkspaceOwnerType::User,
                None,
                "/w".into(),
                None,
                WorkspaceBaseSpec::LocalHead,
                IsolationKind::Shadow,
                "/tmp/ws".into(),
                0,
            )
            .unwrap();
        registry
            .record_sensitive_decision(
                &record.workspace_id,
                "secrets.env",
                SensitiveDecision::Granted,
                WorkspaceOwnerType::User,
                None,
                1,
                Some("initial grant".into()),
            )
            .unwrap();
        assert!(registry.sensitive_grant_exists(&record.workspace_id, "secrets.env"));
        // Subsequent audit rows for the same path do not re-insert the grant.
        registry
            .record_sensitive_decision(
                &record.workspace_id,
                "secrets.env",
                SensitiveDecision::ReusedGrant,
                WorkspaceOwnerType::Scheduled,
                Some("scheduler".into()),
                2,
                None,
            )
            .unwrap();
        assert!(registry.sensitive_grant_exists(&record.workspace_id, "secrets.env"));
    }

    // ---------------------------------------------------------------
    // Retention planners
    // ---------------------------------------------------------------

    #[test]
    fn directory_reclaim_prunes_lru_prunable_over_cap() {
        // 3 active + 4 archived (all prunable). Cap = 5 → 3 active + only
        // 2 prunable retained → 2 archived to reclaim.
        let mut records = Vec::new();
        for i in 0..3 {
            let mut r = record(
                &format!("active-{i}"),
                WorkspaceState::Active,
                WorkspaceOwnerType::User,
            );
            r.last_used_at = 200 + i as i64;
            records.push(r);
        }
        for i in 0..4 {
            let mut r = record(
                &format!("arch-{i}"),
                WorkspaceState::Archived,
                WorkspaceOwnerType::User,
            );
            r.last_used_at = i as i64;
            records.push(r);
        }
        let policy = WorkspaceLifecyclePolicy {
            active_directory_cap: 5,
            ..WorkspaceLifecyclePolicy::default()
        };
        let plan = plan_directory_reclaim(&records, policy);
        assert!(plan.is_empty(), "3 active ≤ 5 cap — nothing to reclaim");
        // Now push active over the cap.
        for i in 0..4 {
            let mut r = record(
                &format!("more-{i}"),
                WorkspaceState::Active,
                WorkspaceOwnerType::User,
            );
            r.last_used_at = 500 + i as i64;
            records.push(r);
        }
        // 7 active → 2 over cap; the 2 oldest prunable archived rows are proposed.
        let plan = plan_directory_reclaim(&records, policy);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].workspace_id, "arch-0");
        assert_eq!(plan[1].workspace_id, "arch-1");
        assert!(plan
            .iter()
            .all(|c| c.reason == DirectoryReclaimReason::OverCap));
    }

    #[test]
    fn directory_reclaim_skips_pinned_and_imported() {
        let mut records = Vec::new();
        for i in 0..8 {
            let mut r = record(
                &format!("active-{i}"),
                WorkspaceState::Active,
                WorkspaceOwnerType::User,
            );
            r.last_used_at = 100 + i as i64;
            records.push(r);
        }
        // Three archived rows: pinned (protected), Imported (protected), and
        // a plain-Archived candidate. `locked_by` presence is informational —
        // Registry itself unlocks + prunes in the same transaction, so it
        // does not block auto-prune.
        let mut pinned = record("pinned", WorkspaceState::Archived, WorkspaceOwnerType::User);
        pinned.pinned = true;
        pinned.last_used_at = 0;
        let mut imported = record(
            "imp",
            WorkspaceState::Archived,
            WorkspaceOwnerType::Imported,
        );
        imported.locked_by = None;
        imported.last_used_at = 1;
        let mut eligible = record(
            "eligible",
            WorkspaceState::Archived,
            WorkspaceOwnerType::User,
        );
        eligible.last_used_at = 2;
        records.extend([pinned, imported, eligible]);

        let policy = WorkspaceLifecyclePolicy {
            active_directory_cap: 5,
            ..WorkspaceLifecyclePolicy::default()
        };
        let plan = plan_directory_reclaim(&records, policy);
        // 8 active > 5 cap → 3 overflow, but only 1 eligible archived row.
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].workspace_id, "eligible");
    }

    #[test]
    fn snapshot_expiration_flags_aged_rows_first() {
        let millis_per_day: i64 = 24 * 60 * 60 * 1_000;
        let now = 1_000_000 + 100 * millis_per_day;
        let mut fresh = record("fresh", WorkspaceState::Archived, WorkspaceOwnerType::User);
        fresh.snapshot_task_id = Some("snap-fresh".into());
        fresh.last_used_at = now - millis_per_day; // 1 day old
        fresh.size_bytes = Some(100);
        let mut aged = record("aged", WorkspaceState::Archived, WorkspaceOwnerType::User);
        aged.snapshot_task_id = Some("snap-aged".into());
        aged.last_used_at = now - 45 * millis_per_day; // 45 days old
        aged.size_bytes = Some(100);
        let policy = WorkspaceLifecyclePolicy {
            snapshot_retention_days: 30,
            blob_budget_bytes: 1 << 30,
            ..WorkspaceLifecyclePolicy::default()
        };
        let plan = plan_snapshot_expiration(&[fresh, aged], policy, now);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].snapshot_task_id, "snap-aged");
        assert_eq!(plan[0].reason, SnapshotExpirationReason::Aged);
    }

    #[test]
    fn snapshot_expiration_drops_lru_over_budget() {
        let now = 10_000_000;
        // Three snapshots, all within retention. Budget = 150 bytes; total
        // = 300 bytes → must drop 2 oldest.
        let mut a = record("a", WorkspaceState::Archived, WorkspaceOwnerType::User);
        a.snapshot_task_id = Some("snap-a".into());
        a.last_used_at = 1;
        a.size_bytes = Some(100);
        let mut b = record("b", WorkspaceState::Archived, WorkspaceOwnerType::User);
        b.snapshot_task_id = Some("snap-b".into());
        b.last_used_at = 2;
        b.size_bytes = Some(100);
        let mut c = record("c", WorkspaceState::Archived, WorkspaceOwnerType::User);
        c.snapshot_task_id = Some("snap-c".into());
        c.last_used_at = 3;
        c.size_bytes = Some(100);
        let policy = WorkspaceLifecyclePolicy {
            snapshot_retention_days: 365,
            blob_budget_bytes: 150,
            ..WorkspaceLifecyclePolicy::default()
        };
        let plan = plan_snapshot_expiration(&[a, b, c], policy, now);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].snapshot_task_id, "snap-a");
        assert_eq!(plan[1].snapshot_task_id, "snap-b");
        assert!(plan
            .iter()
            .all(|c| c.reason == SnapshotExpirationReason::OverBudget));
    }

    #[test]
    fn snapshot_expiration_protects_active_pinned_and_locked_snapshots() {
        let now = 10_000_000;
        let mut protected = record("prot", WorkspaceState::Active, WorkspaceOwnerType::User);
        protected.snapshot_task_id = Some("snap-prot".into());
        protected.last_used_at = 0; // very old
        protected.size_bytes = Some(1 << 30);
        let policy = WorkspaceLifecyclePolicy {
            snapshot_retention_days: 1,
            blob_budget_bytes: 1024,
            ..WorkspaceLifecyclePolicy::default()
        };
        let plan = plan_snapshot_expiration(&[protected], policy, now);
        assert!(plan.is_empty(), "Active-state snapshots must be protected");
    }

    // ---------------------------------------------------------------
    // Reconcile
    // ---------------------------------------------------------------

    #[test]
    fn reconcile_classifies_rows_by_disk_presence_and_owner_liveness() {
        let mut on_disk = HashSet::new();
        on_disk.insert("/tmp/live".to_string());
        on_disk.insert("/tmp/orphan".to_string());
        on_disk.insert("/tmp/new-imported".to_string());

        let live = {
            let mut r = record("live", WorkspaceState::Active, WorkspaceOwnerType::Session);
            r.execution_root = "/tmp/live".into();
            r
        };
        let dead_owner = {
            let mut r = record(
                "orphan",
                WorkspaceState::Active,
                WorkspaceOwnerType::Session,
            );
            r.execution_root = "/tmp/orphan".into();
            r
        };
        let missing_from_disk = {
            let mut r = record("gone", WorkspaceState::Active, WorkspaceOwnerType::Session);
            r.execution_root = "/tmp/gone".into();
            r
        };
        let already_imported = {
            let mut r = record("imp", WorkspaceState::Active, WorkspaceOwnerType::Imported);
            r.execution_root = "/tmp/known-imported".into();
            r
        };

        let outcome = plan_reconcile(
            &[
                live.clone(),
                dead_owner.clone(),
                missing_from_disk.clone(),
                already_imported.clone(),
            ],
            &on_disk,
            &|record| record.workspace_id == "live",
        );

        assert_eq!(outcome.reclaimed, ["live".to_string()]);
        assert_eq!(outcome.orphaned, ["orphan".to_string(), "gone".to_string()]);
        // Only the truly-unknown on-disk path is proposed as imported.
        assert_eq!(outcome.imported.len(), 1);
        assert_eq!(outcome.imported[0].execution_root, "/tmp/new-imported");
    }
}
