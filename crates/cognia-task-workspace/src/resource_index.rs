//! The files an agent left in each conversation's workspace (ADR-0223 §8).
//!
//! The ledger records one `ResourceChange` per run and path: the run's net
//! change against its own baseline. Replaying those changes in settle order
//! per conversation leaves, for every path still standing, the latest thing
//! that happened to it. That is what the Files page lists as a workspace
//! file. Nothing here reads or writes the disk: whether the file is still
//! there is checked by whoever opens it.
//!
//! A run works in its own root; its changes reach the workspace only when the
//! person applies its patch set. So each change is weighed by what became of
//! that patch: applied, still waiting, or thrown away (undone, or left out of
//! the selection that was applied). A thrown-away change is as if it never
//! happened, so whatever the path was before it stands.

use std::{collections::HashMap, sync::Arc};

use serde::{Deserialize, Serialize};

use crate::{
    ChangeKind, ContributionOrigin, PatchState, ResourceCaptureClass, ResourceChange, ResourceKind,
    TaskRun,
};

/// Whether a listed change is in the workspace yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ResourceAdoption {
    /// Applied to the workspace: the file is under `workspace_root`.
    Applied,
    /// Not applied yet: the file is only under the run's `execution_root`,
    /// for as long as that root is kept.
    Pending,
}

/// What became of one change, from its run's patch set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeAdoption {
    Applied,
    Pending,
    /// Undone, or left out of the selection that was applied.
    Discarded,
}

/// The part of a stored patch set the index reads. Unknown fields (the
/// files and their hunks) are skipped, not kept.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchOutcome {
    pub state: PatchState,
    #[serde(default)]
    pub applied_files: Vec<PatchPath>,
    #[serde(default)]
    pub applied_selection: Vec<PatchPath>,
    #[serde(default)]
    pub applied_selection_known: bool,
}

/// A path named by a patch set's applied files or selection.
#[derive(Debug, Clone, Deserialize)]
pub struct PatchPath {
    pub path: String,
}

impl PatchOutcome {
    /// What became of the change to `path`. A run with no patch set has not
    /// settled into one, so its changes wait like a ready patch's.
    pub fn adoption_of(outcome: Option<&Self>, path: &str) -> ChangeAdoption {
        let Some(outcome) = outcome else {
            return ChangeAdoption::Pending;
        };
        let applied = match outcome.state {
            PatchState::Reverted => return ChangeAdoption::Discarded,
            PatchState::Ready => return ChangeAdoption::Pending,
            // An apply that conflicted wrote nothing; an undo that conflicted
            // left what it was undoing in place.
            PatchState::Conflict if outcome.applied_files.is_empty() => {
                return ChangeAdoption::Pending
            }
            PatchState::Conflict | PatchState::Applied => outcome,
        };
        // The person's selection says what they took; an empty one is all of
        // it. Patch sets from before the selection was recorded fall back to
        // the files the apply wrote.
        let taken = if applied.applied_selection_known {
            applied.applied_selection.is_empty()
                || applied
                    .applied_selection
                    .iter()
                    .any(|item| item.path == path)
        } else {
            applied.applied_files.is_empty()
                || applied.applied_files.iter().any(|item| item.path == path)
        };
        if taken {
            ChangeAdoption::Applied
        } else {
            ChangeAdoption::Discarded
        }
    }
}

/// One file an agent created, modified or renamed in a conversation, as the
/// latest net change to that path across the conversation's runs.
///
/// `path` is relative to both roots. `adoption` says which one holds the
/// file: `workspace_root` once the run's patch was applied, the run's own
/// `execution_root` until then (and only while that root is kept).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct ResourceIndexEntry {
    pub session_id: String,
    pub task_id: String,
    /// The run that changed the path last.
    pub run_id: String,
    pub workspace_root: String,
    pub execution_root: String,
    pub path: String,
    /// Never `deleted`: a deleted path leaves the index. `created` sticks
    /// through later edits, so a file the agent wrote reads as its own.
    pub kind: ChangeKind,
    /// Where a renamed file was before its first rename in the index.
    pub old_path: Option<String>,
    pub media_type: String,
    pub size: u64,
    pub hash: Option<String>,
    pub binary: bool,
    /// When the run that first put the path in the index settled (epoch ms).
    pub first_changed_at: i64,
    /// When the run that changed it last settled (epoch ms).
    pub changed_at: i64,
    /// Whether that last change is in the workspace yet, which says where
    /// the file is: `workspace_root` once applied, `execution_root` before.
    pub adoption: ResourceAdoption,
}

/// Largest slice [`crate::TaskWorkspaceService::read_resource_capture`]
/// returns, as a workspace file's ranged read does: the bytes travel IPC and
/// companion frames as base64, so the cap bounds both.
pub const RESOURCE_CAPTURE_CHUNK_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// One slice of the bytes a run's change left at a path, read from the
/// ledger's capture rather than from disk: for a change not applied yet
/// whose run root is gone (archived or removed), the capture is the only
/// copy of what the agent wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct ResourceCaptureChunk {
    /// The bytes read, base64 (standard alphabet, padded).
    pub data_base64: String,
    /// Where the slice starts.
    pub offset: u64,
    /// How many bytes were read: fewer than asked only at the end.
    pub bytes_read: u64,
    /// The whole capture's size.
    pub size: u64,
    /// Whether this slice reaches the end.
    pub eof: bool,
}

/// One ledger row with the conversation and run it belongs to. The run is
/// shared by all of its rows.
#[derive(Debug, Clone)]
pub struct ResourceIndexRow {
    pub session_id: String,
    pub workspace_root: String,
    pub run: Arc<TaskRun>,
    pub change: ResourceChange,
    pub adoption: ChangeAdoption,
}

fn settled_at(run: &TaskRun) -> i64 {
    run.settled_at.unwrap_or(run.created_at)
}

/// Whether a change may stand in the index at all. A credential-shaped path,
/// a build output or a symlink never does, whoever made it.
fn listable(change: &ResourceChange) -> bool {
    !change.sensitive
        && change.capture_class == ResourceCaptureClass::Source
        && change.resource_kind == ResourceKind::File
}

type IndexKey = (String, String, String);

fn key(row: &ResourceIndexRow, path: &str) -> IndexKey {
    (
        row.session_id.clone(),
        row.workspace_root.clone(),
        path.to_string(),
    )
}

/// Replay the ledger into the index, newest change first.
///
/// Rows are replayed in settle order, so a later run's change to a path wins.
/// Only an agent's change puts a path in; any origin's delete or rename moves
/// it, and a change that makes it unlistable (renamed to `.env`, into a build
/// directory) takes it out.
pub fn fold_resource_index(mut rows: Vec<ResourceIndexRow>) -> Vec<ResourceIndexEntry> {
    rows.sort_by(|a, b| {
        settled_at(&a.run)
            .cmp(&settled_at(&b.run))
            .then_with(|| a.run.created_at.cmp(&b.run.created_at))
            .then_with(|| a.run.run_id.cmp(&b.run.run_id))
            .then_with(|| a.change.revision.cmp(&b.change.revision))
            .then_with(|| a.change.path.cmp(&b.change.path))
    });
    let mut index: HashMap<IndexKey, ResourceIndexEntry> = HashMap::new();
    for row in &rows {
        if row.adoption == ChangeAdoption::Discarded {
            continue;
        }
        let change = &row.change;
        let at = settled_at(&row.run);
        match change.kind {
            ChangeKind::Deleted => {
                index.remove(&key(row, &change.path));
            }
            ChangeKind::Renamed => {
                let moved = change
                    .old_path
                    .as_deref()
                    .and_then(|old| index.remove(&key(row, old)));
                // The new path replaces whatever stood there.
                index.remove(&key(row, &change.path));
                if !listable(change) {
                    continue;
                }
                let entry = match moved {
                    Some(previous) => ResourceIndexEntry {
                        kind: if previous.kind == ChangeKind::Created {
                            ChangeKind::Created
                        } else {
                            ChangeKind::Renamed
                        },
                        old_path: previous.old_path.or_else(|| change.old_path.clone()),
                        first_changed_at: previous.first_changed_at,
                        ..entry_for(row, at)
                    },
                    None if change.origin == ContributionOrigin::Agent => entry_for(row, at),
                    None => continue,
                };
                index.insert(key(row, &change.path), entry);
            }
            ChangeKind::Created | ChangeKind::Modified => {
                let slot = key(row, &change.path);
                if !listable(change) {
                    index.remove(&slot);
                    continue;
                }
                let next = match index.remove(&slot) {
                    Some(previous) => ResourceIndexEntry {
                        kind: if previous.kind == ChangeKind::Created {
                            ChangeKind::Created
                        } else {
                            change.kind
                        },
                        old_path: previous.old_path,
                        first_changed_at: previous.first_changed_at,
                        ..entry_for(row, at)
                    },
                    None if change.origin == ContributionOrigin::Agent => entry_for(row, at),
                    None => continue,
                };
                index.insert(slot, next);
            }
        }
    }
    let mut entries: Vec<ResourceIndexEntry> = index.into_values().collect();
    entries.sort_by(|a, b| {
        b.changed_at
            .cmp(&a.changed_at)
            .then_with(|| a.session_id.cmp(&b.session_id))
            .then_with(|| a.workspace_root.cmp(&b.workspace_root))
            .then_with(|| a.path.cmp(&b.path))
    });
    entries
}

fn entry_for(row: &ResourceIndexRow, at: i64) -> ResourceIndexEntry {
    let change = &row.change;
    ResourceIndexEntry {
        session_id: row.session_id.clone(),
        task_id: row.run.task_id.clone(),
        run_id: row.run.run_id.clone(),
        workspace_root: row.workspace_root.clone(),
        execution_root: row.run.execution_root.clone(),
        path: change.path.clone(),
        kind: change.kind,
        old_path: change.old_path.clone(),
        media_type: change.media_type.clone(),
        size: change.size,
        hash: change.hash.clone(),
        binary: change.binary,
        first_changed_at: at,
        changed_at: at,
        adoption: if row.adoption == ChangeAdoption::Applied {
            ResourceAdoption::Applied
        } else {
            ResourceAdoption::Pending
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{IsolationKind, ResourceTrackingPolicy, RunState, WorkspaceBaseSpec};

    fn run(run_id: &str, settled: i64) -> TaskRun {
        TaskRun {
            run_id: run_id.into(),
            task_id: "task-1".into(),
            parent_run_id: None,
            agent_id: "agent".into(),
            agent_kind: "test".into(),
            execution_root: format!("/exec/{run_id}"),
            isolation_kind: IsolationKind::Shadow,
            isolation_ref: None,
            workspace_id: None,
            base: WorkspaceBaseSpec::WorkingState,
            workspace_key: None,
            execution_run_id: None,
            trace_id: None,
            turn_id: None,
            attempt_id: None,
            provider_attempt_id: None,
            surface: None,
            tracking_policy: ResourceTrackingPolicy::default(),
            baseline_revision: 0,
            state: RunState::Ready,
            created_at: settled - 1,
            settled_at: Some(settled),
        }
    }

    fn change(run_id: &str, path: &str, kind: ChangeKind) -> ResourceChange {
        ResourceChange {
            run_id: run_id.into(),
            path: path.into(),
            old_path: None,
            kind,
            origin: ContributionOrigin::Agent,
            agent_id: Some("agent".into()),
            media_type: "text/markdown".into(),
            size: 10,
            hash: Some(format!("{run_id}:{path}")),
            before_hash: None,
            insertions: None,
            deletions: None,
            binary: false,
            resource_kind: ResourceKind::File,
            before_mode: None,
            after_mode: None,
            sensitive: false,
            revision: 1,
            capture_class: ResourceCaptureClass::Source,
            content_captured: true,
        }
    }

    fn row(session: &str, run: &TaskRun, change: ResourceChange) -> ResourceIndexRow {
        adopted(session, run, change, ChangeAdoption::Applied)
    }

    fn adopted(
        session: &str,
        run: &TaskRun,
        change: ResourceChange,
        adoption: ChangeAdoption,
    ) -> ResourceIndexRow {
        ResourceIndexRow {
            session_id: session.into(),
            workspace_root: "/repo".into(),
            run: Arc::new(run.clone()),
            change,
            adoption,
        }
    }

    fn outcome(state: PatchState, applied: &[&str], selection: Option<&[&str]>) -> PatchOutcome {
        let paths = |items: &[&str]| {
            items
                .iter()
                .map(|path| PatchPath {
                    path: (*path).into(),
                })
                .collect()
        };
        PatchOutcome {
            state,
            applied_files: paths(applied),
            applied_selection: paths(selection.unwrap_or(&[])),
            applied_selection_known: selection.is_some(),
        }
    }

    fn paths(entries: &[ResourceIndexEntry]) -> Vec<(&str, &str, ChangeKind)> {
        entries
            .iter()
            .map(|entry| (entry.session_id.as_str(), entry.path.as_str(), entry.kind))
            .collect()
    }

    #[test]
    fn a_later_edit_keeps_the_file_the_agents_own_and_moves_it_to_the_top() {
        let first = run("run-1", 10);
        let second = run("run-2", 20);
        let entries = fold_resource_index(vec![
            // Out of settle order on purpose: replay sorts.
            row(
                "s1",
                &second,
                change("run-2", "notes.md", ChangeKind::Modified),
            ),
            row(
                "s1",
                &first,
                change("run-1", "notes.md", ChangeKind::Created),
            ),
            row(
                "s1",
                &first,
                change("run-1", "plan.md", ChangeKind::Created),
            ),
        ]);
        assert_eq!(
            paths(&entries),
            [
                ("s1", "notes.md", ChangeKind::Created),
                ("s1", "plan.md", ChangeKind::Created),
            ]
        );
        let notes = &entries[0];
        assert_eq!(notes.run_id, "run-2");
        assert_eq!(notes.execution_root, "/exec/run-2");
        assert_eq!(notes.workspace_root, "/repo");
        assert_eq!(notes.first_changed_at, 10);
        assert_eq!(notes.changed_at, 20);
        assert_eq!(notes.hash.as_deref(), Some("run-2:notes.md"));
    }

    #[test]
    fn a_deleted_path_leaves_whoever_deleted_it() {
        let first = run("run-1", 10);
        let second = run("run-2", 20);
        let mut deleted = change("run-2", "a.md", ChangeKind::Deleted);
        deleted.origin = ContributionOrigin::User;
        let entries = fold_resource_index(vec![
            row("s1", &first, change("run-1", "a.md", ChangeKind::Created)),
            row("s1", &second, deleted),
        ]);
        assert!(entries.is_empty());
    }

    #[test]
    fn a_rename_moves_the_entry_and_remembers_where_it_came_from() {
        let first = run("run-1", 10);
        let second = run("run-2", 20);
        let third = run("run-3", 30);
        let mut renamed = change("run-2", "b.md", ChangeKind::Renamed);
        renamed.old_path = Some("a.md".into());
        renamed.origin = ContributionOrigin::User;
        let mut again = change("run-3", "c.md", ChangeKind::Renamed);
        again.old_path = Some("b.md".into());
        let entries = fold_resource_index(vec![
            row("s1", &first, change("run-1", "a.md", ChangeKind::Modified)),
            row("s1", &second, renamed),
            row("s1", &third, again),
        ]);
        assert_eq!(paths(&entries), [("s1", "c.md", ChangeKind::Renamed)]);
        assert_eq!(entries[0].old_path.as_deref(), Some("a.md"));
        assert_eq!(entries[0].first_changed_at, 10);
    }

    #[test]
    fn only_an_agent_puts_a_path_in() {
        let first = run("run-1", 10);
        let mut user = change("run-1", "mine.md", ChangeKind::Created);
        user.origin = ContributionOrigin::User;
        let mut unknown = change("run-1", "who.md", ChangeKind::Renamed);
        unknown.origin = ContributionOrigin::Unknown;
        unknown.old_path = Some("elsewhere.md".into());
        let entries =
            fold_resource_index(vec![row("s1", &first, user), row("s1", &first, unknown)]);
        assert!(entries.is_empty());
    }

    #[test]
    fn credentials_build_outputs_and_symlinks_never_stand() {
        let first = run("run-1", 10);
        let second = run("run-2", 20);
        let mut secret = change("run-1", ".env", ChangeKind::Created);
        secret.sensitive = true;
        let mut generated = change("run-1", "dist/app.js", ChangeKind::Created);
        generated.capture_class = ResourceCaptureClass::Generated;
        let mut link = change("run-1", "link", ChangeKind::Created);
        link.resource_kind = ResourceKind::Symlink;
        // A listed file renamed into a credential name leaves the index.
        let mut hidden = change("run-2", "key.pem", ChangeKind::Renamed);
        hidden.old_path = Some("a.md".into());
        hidden.sensitive = true;
        let entries = fold_resource_index(vec![
            row("s1", &first, secret),
            row("s1", &first, generated),
            row("s1", &first, link),
            row("s1", &first, change("run-1", "a.md", ChangeKind::Created)),
            row("s1", &second, hidden),
        ]);
        assert!(entries.is_empty());
    }

    #[test]
    fn the_same_path_in_two_conversations_is_two_files() {
        let first = run("run-1", 10);
        let entries = fold_resource_index(vec![
            row("s1", &first, change("run-1", "a.md", ChangeKind::Created)),
            row("s2", &first, change("run-1", "a.md", ChangeKind::Created)),
        ]);
        assert_eq!(
            paths(&entries),
            [
                ("s1", "a.md", ChangeKind::Created),
                ("s2", "a.md", ChangeKind::Created),
            ]
        );
    }

    #[test]
    fn a_patch_decides_whether_each_change_counts() {
        use ChangeAdoption::{Applied, Discarded, Pending};
        let of = |outcome: &PatchOutcome, path| PatchOutcome::adoption_of(Some(outcome), path);
        // No patch set yet, or one waiting: the change sits in the run's root.
        assert_eq!(PatchOutcome::adoption_of(None, "a.md"), Pending);
        assert_eq!(of(&outcome(PatchState::Ready, &[], None), "a.md"), Pending);
        // Undone, or kept out by a conflict resolved for the current files.
        assert_eq!(
            of(&outcome(PatchState::Reverted, &[], Some(&[])), "a.md"),
            Discarded
        );
        // An apply that conflicted wrote nothing; an undo that did left it applied.
        assert_eq!(
            of(&outcome(PatchState::Conflict, &[], None), "a.md"),
            Pending
        );
        assert_eq!(
            of(&outcome(PatchState::Conflict, &["a.md"], Some(&[])), "a.md"),
            Applied
        );
        // Applied: what the person selected, all of it when they selected nothing.
        let all = outcome(PatchState::Applied, &["a.md"], Some(&[]));
        assert_eq!(of(&all, "b.md"), Applied);
        let some = outcome(PatchState::Applied, &["a.md"], Some(&["a.md"]));
        assert_eq!(of(&some, "a.md"), Applied);
        assert_eq!(of(&some, "b.md"), Discarded);
        // Before selections were recorded: the files the apply wrote.
        let legacy = outcome(PatchState::Applied, &["a.md"], None);
        assert_eq!(of(&legacy, "a.md"), Applied);
        assert_eq!(of(&legacy, "b.md"), Discarded);
        assert_eq!(
            of(&outcome(PatchState::Applied, &[], None), "b.md"),
            Applied
        );
    }

    #[test]
    fn a_thrown_away_change_is_as_if_it_never_happened() {
        let first = run("run-1", 10);
        let second = run("run-2", 20);
        let third = run("run-3", 30);
        let entries = fold_resource_index(vec![
            row(
                "s1",
                &first,
                change("run-1", "kept.md", ChangeKind::Created),
            ),
            // Undone: the delete never reached the workspace, the edit neither.
            adopted(
                "s1",
                &second,
                change("run-2", "kept.md", ChangeKind::Deleted),
                ChangeAdoption::Discarded,
            ),
            adopted(
                "s1",
                &second,
                change("run-2", "gone.md", ChangeKind::Created),
                ChangeAdoption::Discarded,
            ),
            // Not applied yet: listed, and where it is says so.
            adopted(
                "s1",
                &third,
                change("run-3", "draft.md", ChangeKind::Created),
                ChangeAdoption::Pending,
            ),
        ]);
        assert_eq!(
            paths(&entries),
            [
                ("s1", "draft.md", ChangeKind::Created),
                ("s1", "kept.md", ChangeKind::Created),
            ]
        );
        assert_eq!(entries[0].adoption, ResourceAdoption::Pending);
        assert_eq!(entries[1].adoption, ResourceAdoption::Applied);
        assert_eq!(entries[1].run_id, "run-1");
    }

    #[test]
    fn a_stored_patch_set_reads_as_its_outcome() {
        let json = serde_json::json!({
            "patchId": "patch:run-1",
            "state": "applied",
            "files": [{ "path": "a.md", "hunks": [{ "id": "h1" }] }],
            "appliedFiles": [{ "path": "a.md", "binary": false }],
            "appliedSelection": [{ "path": "a.md", "hunkIds": [] }],
            "appliedSelectionKnown": true
        });
        let outcome: PatchOutcome = serde_json::from_value(json).unwrap();
        assert_eq!(outcome.state, PatchState::Applied);
        assert_eq!(
            PatchOutcome::adoption_of(Some(&outcome), "a.md"),
            ChangeAdoption::Applied
        );
        // A patch set written before the applied fields existed.
        let old: PatchOutcome =
            serde_json::from_value(serde_json::json!({ "state": "ready" })).unwrap();
        assert!(old.applied_files.is_empty() && !old.applied_selection_known);
    }
}
