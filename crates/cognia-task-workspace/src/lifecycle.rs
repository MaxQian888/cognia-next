//! Managed-worktree lifecycle events (ADR-0111 decision 9).
//!
//! The Registry state machine is the only place a managed worktree is created
//! or removed, so it is the producer for the `WorktreeCreate` /
//! `WorktreeRemove` agent hook events. This crate cannot depend on the app
//! (`src-tauri`) — the hook runner lives there — so, exactly like the resource
//! watcher's `TaskWorkspaceEventSink`, the service takes an injected sink and
//! the app decides what to do with the event (run the hooks, publish to the
//! companion bus, …). Without a sink installed the events are simply dropped.
//!
//! Only `IsolationKind::GitWorktree` executions emit: a materialized shadow of a
//! non-Git root is not a worktree, and a plugin subscribed to `WorktreeCreate`
//! must be able to `git` inside the path it is handed.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::types::{IsolationKind, WorkspaceBaseSpec, WorkspaceOwnerType, WorkspaceRecord};

/// Which lifecycle edge fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeLifecycleKind {
    Created,
    Removed,
}

/// The payload handed to hook subscribers. Field names are the wire names the
/// hook catalog documents (`worktree_path`, `owner_type`, …); everything the
/// registry knows that a hook could act on, nothing it would have to guess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WorktreeLifecycleEvent {
    pub kind: WorktreeLifecycleKind,
    /// Registry id of the managed workspace.
    pub workspace_id: String,
    /// The Git root the worktree was created from.
    pub workspace_root: String,
    /// The worktree directory itself (`execution_root`).
    pub worktree_path: String,
    pub owner_type: WorkspaceOwnerType,
    pub owner_ref: Option<String>,
    /// The chat session that owns the run, when the owner is a session.
    pub session_id: Option<String>,
    pub base: WorkspaceBaseSpec,
    pub branch: Option<String>,
    /// Why a worktree went away: `discard`, `prune`, `rollback`.
    pub reason: Option<String>,
}

pub trait WorktreeLifecycleSink: Send + Sync + 'static {
    fn emit(&self, event: WorktreeLifecycleEvent);
}

/// Holder the service owns. `None` until the host installs a sink.
#[derive(Default)]
pub struct WorktreeLifecycleEmitter {
    sink: Mutex<Option<Arc<dyn WorktreeLifecycleSink>>>,
}

impl WorktreeLifecycleEmitter {
    pub fn set_sink(&self, sink: Option<Arc<dyn WorktreeLifecycleSink>>) {
        *self.sink.lock() = sink;
    }

    pub fn has_sink(&self) -> bool {
        self.sink.lock().is_some()
    }

    /// Emit for a registry record. No-op without a sink or for non-worktree
    /// isolation. The sink is cloned out of the lock before the call so a
    /// slow subscriber never holds the emitter's mutex.
    pub fn emit(
        &self,
        kind: WorktreeLifecycleKind,
        record: &WorkspaceRecord,
        session_id: Option<&str>,
        reason: Option<&str>,
    ) {
        if record.isolation_kind != IsolationKind::GitWorktree {
            return;
        }
        let sink = self.sink.lock().clone();
        let Some(sink) = sink else {
            return;
        };
        sink.emit(WorktreeLifecycleEvent {
            kind,
            workspace_id: record.workspace_id.clone(),
            workspace_root: record.source_root.clone(),
            worktree_path: record.execution_root.clone(),
            owner_type: record.owner_type,
            owner_ref: record.owner_ref.clone(),
            session_id: session_id.map(str::to_string).or_else(|| {
                (record.owner_type == WorkspaceOwnerType::Session)
                    .then(|| record.owner_ref.clone())
                    .flatten()
            }),
            base: record.base.clone(),
            branch: record.branch.clone(),
            reason: reason.map(str::to_string),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::WorkspaceState;
    use std::sync::Mutex as StdMutex;

    struct Recorder(StdMutex<Vec<WorktreeLifecycleEvent>>);

    impl WorktreeLifecycleSink for Recorder {
        fn emit(&self, event: WorktreeLifecycleEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    fn record(isolation_kind: IsolationKind, owner_type: WorkspaceOwnerType) -> WorkspaceRecord {
        WorkspaceRecord {
            project_id: None,
            workspace_id: "ws-1".into(),
            environment_kind: if owner_type == WorkspaceOwnerType::Imported {
                crate::WorkspaceEnvironmentKind::Imported
            } else {
                crate::WorkspaceEnvironmentKind::Managed
            },
            owner_type,
            owner_ref: Some("owner-1".into()),
            state: WorkspaceState::Active,
            source_root: "/repo".into(),
            git_common_dir: Some("/repo/.git".into()),
            base: WorkspaceBaseSpec::WorkingState,
            head: None,
            branch: Some("cognia/ws-1".into()),
            isolation_kind,
            execution_root: "/repo/.cognia/ws-1".into(),
            snapshot_task_id: None,
            size_bytes: None,
            last_used_at: 0,
            locked_by: None,
            pinned: false,
            created_at: 0,
        }
    }

    #[test]
    fn drops_events_without_a_sink() {
        let emitter = WorktreeLifecycleEmitter::default();
        assert!(!emitter.has_sink());
        emitter.emit(
            WorktreeLifecycleKind::Created,
            &record(IsolationKind::GitWorktree, WorkspaceOwnerType::Session),
            None,
            None,
        );
    }

    #[test]
    fn emits_only_for_git_worktrees_with_the_documented_payload() {
        let emitter = WorktreeLifecycleEmitter::default();
        let recorder = Arc::new(Recorder(StdMutex::new(Vec::new())));
        emitter.set_sink(Some(recorder.clone()));
        assert!(emitter.has_sink());

        emitter.emit(
            WorktreeLifecycleKind::Created,
            &record(IsolationKind::Shadow, WorkspaceOwnerType::Session),
            None,
            None,
        );
        assert!(
            recorder.0.lock().unwrap().is_empty(),
            "shadow roots are not worktrees"
        );

        emitter.emit(
            WorktreeLifecycleKind::Created,
            &record(IsolationKind::GitWorktree, WorkspaceOwnerType::Session),
            None,
            None,
        );
        emitter.emit(
            WorktreeLifecycleKind::Removed,
            &record(IsolationKind::GitWorktree, WorkspaceOwnerType::Team),
            Some("sess-explicit"),
            Some("prune"),
        );
        let events = recorder.0.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, WorktreeLifecycleKind::Created);
        assert_eq!(events[0].worktree_path, "/repo/.cognia/ws-1");
        assert_eq!(events[0].workspace_root, "/repo");
        // A session-owned record's owner_ref doubles as the session id.
        assert_eq!(events[0].session_id.as_deref(), Some("owner-1"));
        assert_eq!(events[0].branch.as_deref(), Some("cognia/ws-1"));
        assert_eq!(events[1].kind, WorktreeLifecycleKind::Removed);
        assert_eq!(events[1].session_id.as_deref(), Some("sess-explicit"));
        assert_eq!(events[1].reason.as_deref(), Some("prune"));
        assert_eq!(events[1].owner_type, WorkspaceOwnerType::Team);
    }

    #[test]
    fn serializes_with_snake_case_wire_names() {
        let event = WorktreeLifecycleEvent {
            kind: WorktreeLifecycleKind::Created,
            workspace_id: "ws".into(),
            workspace_root: "/r".into(),
            worktree_path: "/r/w".into(),
            owner_type: WorkspaceOwnerType::User,
            owner_ref: None,
            session_id: None,
            base: WorkspaceBaseSpec::WorkingState,
            branch: None,
            reason: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["kind"], "created");
        assert_eq!(json["worktree_path"], "/r/w");
        assert_eq!(json["workspace_root"], "/r");
    }
}
