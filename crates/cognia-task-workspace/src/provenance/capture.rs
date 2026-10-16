//! The single durable prepare/verify/commit boundary for user-visible mutations.
//! Filesystem writes remain owned by the ledger/integration; recovery uses only
//! this manifest, pinned blobs, and copied sources, never prunable run rows.

use super::*;
use crate::{PatchSet, PatchState, TaskWorkspaceState};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct CapturePath {
    pub path: String,
    pub old_path: Option<String>,
    pub before: Option<Vec<u8>>,
    pub after: Option<Vec<u8>>,
    pub segments: Option<Vec<Segment>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Verification {
    Disk { root: String },
    GitRef { repo: String, reference: String, expected_sha: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CapturedPath {
    path: String,
    old_path: Option<String>,
    resource_id: String,
    create: bool,
    before_hash: Option<String>,
    after_hash: Option<String>,
    before_blob: Option<String>,
    before_segments: Vec<Segment>,
    version: VersionInput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    format: u32,
    paths: Vec<CapturedPath>,
    adoptions: Vec<AdoptionInput>,
    verification: Verification,
    patch: Option<PatchSet>,
    task: Option<crate::TaskWorkspace>,
}

pub fn working_root(store: &mut WorkspaceStore, root: &Path) -> std::result::Result<ProvenanceRoot, String> {
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    store.provenance().register_root("local", "local", &canonical.to_string_lossy(), "working-tree", None)
        .map_err(|e| e.to_string())
}

pub fn unknown_source(store: &mut WorkspaceStore, root: &ProvenanceRoot) -> std::result::Result<String, String> {
    let source_id = format!("unknown:{}", root.root_id);
    store.provenance().upsert_source(&ProvenanceSource {
        provenance_id: source_id.clone(), root_id: root.root_id.clone(), origin: ProvenanceOrigin::Unknown,
        session_id: None, turn_id: None, task_id: None, run_id: None, agent_id: None,
        execution_run_id: None, trace_id: None, assistant_message_id: None, tool_call_id: None,
        event_id: None, evidence: OriginEvidence::Inferred, created_at: 0, details: serde_json::json!({}),
    }).map_err(|e| e.to_string())?;
    Ok(source_id)
}

fn uniform(bytes: &[u8], source: &str, evidence: MappingEvidence) -> std::result::Result<Vec<Segment>, String> {
    let (count, _) = line_map::inspect_content(bytes).map_err(|e| e.to_string())?;
    Ok(if count == 0 { vec![] } else { vec![Segment { start_line: 1, end_line: count + 1, provenance_id: source.into(), mapping_evidence: evidence }] })
}

pub fn map_before(store: &mut WorkspaceStore, root: &ProvenanceRoot, path: &str, bytes: &[u8], now: i64) -> std::result::Result<Vec<Segment>, String> {
    let unknown = unknown_source(store, root)?;
    let Some(version) = store.provenance().current_version(&root.root_id, path).map_err(|e| e.to_string())? else {
        return uniform(bytes, &unknown, MappingEvidence::Unknown);
    };
    let Some(blob) = &version.blob_ref else { return uniform(bytes, &unknown, MappingEvidence::Unknown); };
    let old = store.get_blob(blob, now)?;
    let mut segments = Vec::new();
    let mut cursor = None;
    loop {
        let page = store.provenance().segments(&root.root_id, &version.version_id, 1..version.line_count + 1, cursor.as_ref(), MAX_SEGMENTS_PER_QUERY).map_err(|e| e.to_string())?;
        segments.extend(page.items);
        cursor = page.next_cursor;
        if cursor.is_none() { break; }
    }
    line_map::carry_forward(&segments, &line_map::diff_lines(&old, bytes).map_err(|e| e.to_string())?, |_| (unknown.clone(), MappingEvidence::Unknown)).map_err(|e| e.to_string())
}

/// Build a fully replayable intent and pin every before/after body before writing.
pub fn prepare(store: &mut WorkspaceStore, root: &ProvenanceRoot, operation_key: &str, kind: &str,
    paths: &[CapturePath], adoptions: &[AdoptionInput], verification: Verification,
    patch: Option<&PatchSet>, now: i64) -> std::result::Result<String, String> {
    if let Some(intent) = store.provenance().mutation_intent(operation_key).map_err(|e| e.to_string())? {
        if intent.root_id != root.root_id || intent.kind != kind { return Err("capture retry scope differs".into()); }
        let saved: Manifest = serde_json::from_value(intent.manifest).map_err(|e| e.to_string())?;
        if saved.paths.len() != paths.len() || saved.paths.iter().zip(paths).any(|(saved, supplied)|
            saved.path != supplied.path || saved.old_path != supplied.old_path
                || saved.before_hash != supplied.before.as_ref().map(|b| content_hash(b))
                || saved.after_hash != supplied.after.as_ref().map(|b| content_hash(b))
                || supplied.segments.as_ref().is_some_and(|segments| *segments != saved.version.segments))
            || saved.adoptions != adoptions || saved.patch.as_ref() != patch || saved.verification != verification {
            return Err("capture retry payload differs".into());
        }
        return Ok(operation_key.into());
    }
    let unknown = unknown_source(store, root)?;
    let mut captured = Vec::new();
    let mut pins = Vec::new();
    for input in paths {
        super::path(&input.path).map_err(|e| e.to_string())?;
        let origin_path = input.old_path.as_deref().unwrap_or(&input.path);
        super::path(origin_path).map_err(|e| e.to_string())?;
        let existing = store.provenance().resolve_path(&root.root_id, origin_path).map_err(|e| e.to_string())?;
        if existing.as_ref().is_some_and(|p| p.state != IdentityState::Active) { return Err("ambiguous capture identity".into()); }
        let current = store.provenance().current_version(&root.root_id, origin_path).map_err(|e| e.to_string())?;
        let resource_id = existing.and_then(|p| p.resource_id).unwrap_or_else(id);
        let before = input.before.as_deref().unwrap_or_default();
        let after = input.after.as_deref().unwrap_or_default();
        let before_segments = map_before(store, root, origin_path, before, now)?;
        let segments = match &input.segments {
            Some(segments) => segments.clone(),
            None => line_map::carry_forward(&before_segments, &line_map::diff_lines(before, after).map_err(|e| e.to_string())?, |_| (unknown.clone(), MappingEvidence::Unknown)).map_err(|e| e.to_string())?,
        };
        let mut blob = |bytes: Option<&Vec<u8>>| -> std::result::Result<Option<String>, String> {
            bytes.map(|bytes| {
                let hash = content_hash(bytes)[7..].to_string();
                store.put_blob(&hash, bytes, now)?;
                pins.push(hash.clone());
                Ok(hash)
            }).transpose()
        };
        let before_blob = blob(input.before.as_ref())?;
        let after_blob = blob(input.after.as_ref())?;
        let (line_count, binary) = line_map::inspect_content(after).map_err(|e| e.to_string())?;
        captured.push(CapturedPath {
            path: input.path.clone(), old_path: input.old_path.clone(), resource_id: resource_id.clone(),
            create: current.is_none() && store.provenance().resolve_path(&root.root_id, origin_path).map_err(|e| e.to_string())?.is_none(),
            before_hash: input.before.as_ref().map(|v| content_hash(v)), after_hash: input.after.as_ref().map(|v| content_hash(v)),
            before_blob, before_segments,
            version: VersionInput { version_id: id(), resource_id, parent_version_id: current.map(|v| v.version_id),
                content_hash: content_hash(after), blob_ref: after_blob, line_count, binary, segments,
                completeness: if input.after.is_some() { Completeness::Complete } else { Completeness::Partial }, observed_at: now },
        });
    }
    let mut task = patch.map(|p| store.get_task(&p.task_id)).transpose()?.flatten();
    if let (Some(task), Some(patch)) = (&mut task, patch) {
        if let Some(revision) = patch.applied_revision { task.revision = task.revision.max(revision); }
        if matches!(kind, "undo" | "discard") { task.revision = task.revision.saturating_add(1); }
        task.state = if patch.state == PatchState::Applied { TaskWorkspaceState::Applied } else { TaskWorkspaceState::Ready };
    }
    let manifest = Manifest { format: 1, paths: captured, adoptions: adoptions.to_vec(), verification, patch: patch.cloned(), task };
    store.provenance().prepare_mutation(&MutationIntent {
        root_id: root.root_id.clone(), operation_key: operation_key.into(), kind: kind.into(),
        manifest: serde_json::to_value(manifest).map_err(|e| e.to_string())?,
        selection: patch.map(|p| serde_json::to_value(&p.applied_selection)).transpose().map_err(|e| e.to_string())?.unwrap_or(serde_json::Value::Null),
        blob_refs: pins, created_at: now,
    }).map_err(|e| e.to_string())?;
    Ok(operation_key.into())
}

fn disk_bytes(root: &Path, relative: &str) -> std::result::Result<Option<Vec<u8>>, String> {
    super::path(relative).map_err(|e| e.to_string())?;
    let target = root.join(relative);
    // Check every existing ancestor, including symlinks, before reading.
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut parent = target.parent();
    while let Some(p) = parent {
        if p.exists() {
            if !p.canonicalize().map_err(|e| e.to_string())?.starts_with(&canonical_root) { return Err("capture path escapes root".into()); }
            break;
        }
        parent = p.parent();
    }
    match std::fs::symlink_metadata(&target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
        Ok(meta) if meta.file_type().is_symlink() => Ok(Some(std::fs::read_link(target).map_err(|e| e.to_string())?.as_os_str().as_encoded_bytes().to_vec())),
        Ok(_) => std::fs::read(target).map(Some).map_err(|e| e.to_string()),
    }
}

fn verify(manifest: &Manifest) -> std::result::Result<(), String> {
    let repository = match &manifest.verification {
        Verification::GitRef { repo, reference, expected_sha } => {
            let repo = git2::Repository::open(repo).map_err(|e| e.to_string())?;
            let commit = repo.revparse_single(reference).and_then(|o| o.peel_to_commit()).map_err(|e| e.to_string())?;
            if commit.id().to_string() != *expected_sha { return Err("capture target ref changed".into()); }
            drop(commit);
            Some(repo)
        }
        _ => None,
    };
    for p in &manifest.paths {
        let read = |path: &str| -> std::result::Result<Option<Vec<u8>>, String> {
            match &manifest.verification {
                Verification::Disk { root } => disk_bytes(Path::new(root), path),
                Verification::GitRef { expected_sha, .. } => {
                    let repo = repository.as_ref().ok_or("missing verification repository")?;
                    let tree = repo.find_commit(git2::Oid::from_str(expected_sha).map_err(|e| e.to_string())?).and_then(|c| c.tree()).map_err(|e| e.to_string())?;
                    match tree.get_path(Path::new(path)) {
                        Ok(entry) => repo.find_blob(entry.id()).map(|b| Some(b.content().to_vec())).map_err(|e| e.to_string()),
                        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
                        Err(e) => Err(e.to_string()),
                    }
                }
            }
        };
        if read(&p.path)?.as_ref().map(|b| content_hash(b)) != p.after_hash { return Err("capture post-write hash mismatch".into()); }
        if let Some(old) = &p.old_path {
            if read(old)?.is_some() { return Err("capture rename source still exists".into()); }
        }
    }
    Ok(())
}

/// Verify actual bytes and atomically publish identity, maps, adoption and patch/task state.
pub fn record_applied_patch(store: &mut WorkspaceStore, operation_key: &str) -> std::result::Result<(), String> {
    let intent = store.provenance().mutation_intent(operation_key).map_err(|e| e.to_string())?.ok_or("missing capture intent")?;
    let manifest: Manifest = serde_json::from_value(intent.manifest).map_err(|e| e.to_string())?;
    if store.provenance().mutation(operation_key).map_err(|e| e.to_string())?.is_some_and(|m| m.state == MutationCommitState::Committed) { return Ok(()); }
    verify(&manifest)?;
    let versions: Vec<_> = manifest.paths.iter().map(|p| p.version.clone()).collect();
    store.provenance().commit_mutation_with_changes(operation_key, &versions, &manifest.adoptions, |tx| {
        for p in &manifest.paths {
            if let Some(blob) = &p.before_blob { super::pin(tx, "version", &p.version.version_id, blob)?; }
            let origin = p.old_path.as_deref().unwrap_or(&p.path);
            if p.create { ProvenanceStore::create_resource_with_id_in_transaction(tx, &intent.root_id, origin, &p.resource_id, intent.created_at)?; }
            if let Some(old) = &p.old_path {
                ProvenanceStore::record_rename_in_transaction(tx, &format!("{operation_key}:rename:{}", p.path), &RenameClaim {
                    root_id: intent.root_id.clone(), old_path: old.clone(), new_path: p.path.clone(),
                    expected_version_id: p.version.parent_version_id.clone(), evidence: OriginEvidence::Inferred, candidates: vec![p.resource_id.clone()],
                })?;
            }
        }
        if let Some(patch) = &manifest.patch {
            // Recovery owns the application result, not the immutable patch
            // definition or metadata subsequently attached by another writer.
            let applied = serde_json::json!({
                "state": patch.state,
                "appliedRevision": patch.applied_revision,
                "appliedFiles": patch.applied_files,
                "appliedSelection": patch.applied_selection,
                "appliedSelectionKnown": patch.applied_selection_known,
                "reversible": patch.reversible,
            });
            tx.execute("INSERT INTO task_patch_sets(run_id,task_id,payload) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM task_runs WHERE run_id=?1) AND NOT EXISTS(SELECT 1 FROM task_workspaces WHERE task_id=?2 AND json_extract(payload,'$.revision')>?4) ON CONFLICT(run_id) DO UPDATE SET payload=json_patch(task_patch_sets.payload,?5)", params![patch.run_id, patch.task_id, json(patch)?, manifest.task.as_ref().map(|t| t.revision).unwrap_or(0), json(&applied)?])?;
        }
        if let Some(task) = &manifest.task {
            // Pins, expiry and future metadata are independent of applying a
            // patch. Merge only owned fields even when the revision is equal.
            tx.execute("UPDATE task_workspaces SET payload=json_set(payload,'$.state',json_extract(?2,'$.state'),'$.revision',?3) WHERE task_id=?1 AND json_extract(payload,'$.revision')<=?3", params![task.task_id, json(task)?, task.revision])?;
        }
        Ok(())
    }, |tx| {
        for p in &manifest.paths {
            if p.after_hash.is_none() { ProvenanceStore::delete_resource_in_transaction(tx, &intent.root_id, &p.path, OriginEvidence::Inferred)?; }
        }
        Ok(())
    }).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn before_segments(store: &mut WorkspaceStore, operation_key: &str, path: &str) -> std::result::Result<Option<Vec<Segment>>, String> {
    let Some(intent) = store.provenance().mutation_intent(operation_key).map_err(|e| e.to_string())? else { return Ok(None); };
    let manifest: Manifest = serde_json::from_value(intent.manifest).map_err(|e| e.to_string())?;
    Ok(manifest.paths.into_iter().find(|p| p.path == path).map(|p| p.before_segments))
}

/// A failed capture is observable even when the mutation itself could not prepare.
pub fn warn_gap(store: &mut WorkspaceStore, operation_key: &str, error: &str) {
    eprintln!("task workspace provenance capture gap: {error}");
    let result = store.connection.execute_batch("CREATE TABLE IF NOT EXISTS provenance_capture_gaps(operation_key TEXT PRIMARY KEY, completeness TEXT NOT NULL CHECK(completeness='gap'), reason TEXT NOT NULL)")
        .and_then(|_| store.connection.execute("INSERT INTO provenance_capture_gaps VALUES(?1,'gap',?2) ON CONFLICT(operation_key) DO UPDATE SET reason=excluded.reason", params![operation_key, error]));
    if let Err(error) = result { eprintln!("task workspace provenance gap persistence failed: {error}"); }
    let _ = store.provenance().abort_mutation(operation_key, true);
}

pub fn reconcile(store: &mut WorkspaceStore) -> std::result::Result<(), String> {
    let mut cursor = None;
    loop {
        let pending = store.provenance().pending_mutations_after(cursor.as_deref(), MAX_HISTORY_PER_QUERY).map_err(|e| e.to_string())?;
        if pending.is_empty() { break; }
        for (mutation, intent) in pending {
            cursor = Some(mutation.operation_id);
            if intent.manifest.get("format").and_then(|v| v.as_u64()) != Some(1) { continue; }
            if let Err(error) = record_applied_patch(store, &mutation.operation_key) { warn_gap(store, &mutation.operation_key, &error); }
        }
    }
    Ok(())
}

/// Copy source metadata at observation time. Tool linkage is supported only by a
/// unique trusted receipt for the run-local baseline-to-output transition.
pub fn run_source(store: &mut WorkspaceStore, root: &ProvenanceRoot, patch: &PatchSet,
    receipt: Option<&str>) -> std::result::Result<String, String> {
    let (run, _) = store.get_run::<serde_json::Value>(&patch.run_id)?.ok_or("missing provenance run")?;
    let task = store.get_task(&run.task_id)?.ok_or("missing provenance task")?;
    let source_key = serde_json::to_vec(&(&root.root_id, &run.run_id, receipt)).map_err(|e| e.to_string())?;
    let source_id = format!("run:{}", content_hash(&source_key));
    store.provenance().upsert_source(&ProvenanceSource {
        provenance_id: source_id.clone(), root_id: root.root_id.clone(), origin: ProvenanceOrigin::Agent,
        session_id: Some(task.session_id), turn_id: run.turn_id, task_id: Some(run.task_id), run_id: Some(run.run_id),
        agent_id: Some(run.agent_id), execution_run_id: run.execution_run_id, trace_id: run.trace_id,
        assistant_message_id: None, tool_call_id: receipt.map(str::to_string), event_id: None,
        evidence: if receipt.is_some() { OriginEvidence::ConfirmedReceipt } else { OriginEvidence::Inferred },
        created_at: run.created_at, details: serde_json::json!({"agentKind":run.agent_kind,"attemptId":run.attempt_id}),
    }).map_err(|e| e.to_string())?;
    Ok(source_id)
}

pub fn adoption_units(patch: &PatchSet, source: &str, selection: &[crate::PatchSelection], state: AdoptionState) -> Vec<AdoptionInput> {
    let mut units = Vec::new();
    for file in &patch.files {
        let selected = selection.iter().find(|s| s.path == file.path);
        let included = selection.is_empty() || selected.is_some();
        let hunk_ids = selected.map(|s| s.hunk_ids.as_slice()).unwrap_or_default();
        let partial = included && !hunk_ids.is_empty() && hunk_ids.len() < file.hunks.len();
        let selected_state = |chosen: bool| if state == AdoptionState::Applied && !chosen { AdoptionState::Discarded } else { state };
        units.push(AdoptionInput { provenance_id: source.into(), unit_key: format!("file:{}", file.path),
            state: if state == AdoptionState::Applied && partial { AdoptionState::Partial } else { selected_state(included) }, details: serde_json::json!({}) });
        for hunk in &file.hunks {
            units.push(AdoptionInput { provenance_id: source.into(), unit_key: format!("hunk:{}:{}", file.path, hunk.id),
                state: selected_state(included && (hunk_ids.is_empty() || hunk_ids.contains(&hunk.id))), details: serde_json::json!({}) });
        }
    }
    units
}

pub fn record_pending(store: &mut WorkspaceStore, patch: &PatchSet, root: &Path, now: i64) -> std::result::Result<(), String> {
    record_adoption_only(store, patch, root, patch.base_revision, now, AdoptionState::Pending, "pending")
}

pub fn discard(store: &mut WorkspaceStore, patch: &PatchSet, root: &Path, revision: u64, now: i64) -> std::result::Result<(), String> {
    record_adoption_only(store, patch, root, revision, now, AdoptionState::Discarded, "discard")
}

fn record_adoption_only(store: &mut WorkspaceStore, patch: &PatchSet, root: &Path, revision: u64, now: i64,
    state: AdoptionState, kind: &str) -> std::result::Result<(), String> {
    let root = working_root(store, root)?;
    let source = run_source(store, &root, patch, None)?;
    let key = format!("{kind}:{}:{}:{}:{revision}", root.root_id, patch.run_id, patch.created_at);
    let adoptions = adoption_units(patch, &source, &[], state);
    prepare(store, &root, &key, kind, &[], &adoptions, Verification::Disk { root: root.canonical_root.clone() },
        (state != AdoptionState::Pending).then_some(patch), now)?;
    record_applied_patch(store, &key)
}

pub(crate) fn applied_intent(store: &mut WorkspaceStore, patch: &PatchSet, root_id: &str) -> std::result::Result<Option<MutationIntent>, String> {
    let key: Option<String> = store.connection.query_row(
        "SELECT operation_key FROM provenance_mutations WHERE root_id=?1 AND kind IN ('apply','force') AND commit_state='committed' AND json_extract(manifest_json,'$.patch.runId')=?2 AND json_extract(manifest_json,'$.patch.appliedRevision')=?3 ORDER BY seq DESC LIMIT 1",
        params![root_id, patch.run_id, patch.applied_revision], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    key.map(|key| store.provenance().mutation_intent(&key).map_err(|e| e.to_string())).transpose().map(Option::flatten)
}

/// Carry the current map across undo; only restored lines consult the saved
/// before-map. Independent later changes retain their already observed origins.
pub(crate) fn undo_map(store: &mut WorkspaceStore, intent: &MutationIntent, path: &str,
    current: &[u8], current_segments: &[Segment], actual: &[u8], unknown: &str, now: i64,
) -> std::result::Result<Vec<Segment>, String> {
    let manifest: Manifest = serde_json::from_value(intent.manifest.clone()).map_err(|e| e.to_string())?;
    let saved = manifest.paths.iter().find(|p| p.path == path || p.old_path.as_deref() == Some(path)).ok_or("missing inverse provenance path")?;
    let bytes = saved.before_blob.as_ref().map(|b| store.get_blob(b, now)).transpose()?.unwrap_or_default();
    restore_map(&bytes, &saved.before_segments, current, current_segments, actual, unknown)
}

fn restore_map(saved: &[u8], saved_segments: &[Segment], current: &[u8], current_segments: &[Segment],
    actual: &[u8], unknown: &str,
) -> std::result::Result<Vec<Segment>, String> {
    let current_ops = line_map::diff_lines(current, actual).map_err(|e| e.to_string())?;
    let carried = line_map::carry_forward(current_segments, &current_ops,
        |_| (unknown.into(), MappingEvidence::Unknown)).map_err(|e| e.to_string())?;
    let restored = line_map::carry_forward(saved_segments,
        &line_map::diff_lines(saved, actual).map_err(|e| e.to_string())?,
        |_| (unknown.into(), MappingEvidence::Unknown)).map_err(|e| e.to_string())?;
    let count = carried.last().map_or(0, |segment| segment.end_line - 1);
    let mut inserted = vec![false; count];
    for operation in &current_ops {
        if let line_map::LineOp::Insert { new_range } = operation {
            inserted[new_range.start - 1..new_range.end - 1].fill(true);
        }
    }
    let mut result: Vec<Segment> = Vec::new();
    let mut restored_index = 0;
    for segment in carried {
        for line in segment.start_line..segment.end_line {
            while restored.get(restored_index).is_some_and(|candidate| candidate.end_line <= line) {
                restored_index += 1;
            }
            let origin = if inserted[line - 1] {
                restored.get(restored_index).filter(|candidate| candidate.start_line <= line).unwrap_or(&segment)
            } else { &segment };
            if let Some(previous) = result.last_mut().filter(|previous| previous.end_line == line
                && previous.provenance_id == origin.provenance_id && previous.mapping_evidence == origin.mapping_evidence) {
                previous.end_line = line + 1;
            } else {
                result.push(Segment { start_line: line, end_line: line + 1,
                    provenance_id: origin.provenance_id.clone(), mapping_evidence: origin.mapping_evidence });
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn provenance_undo_preserves_later_agent_and_unobserved_human_lines() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(data.path(), 1024 * 1024).unwrap();
        let root = working_root(&mut store, workspace.path()).unwrap();
        let unknown = unknown_source(&mut store, &root).unwrap();
        for id in ["earlier-origin", "run-a", "run-b", "human"] {
            let mut source = store.provenance().source(&root.root_id, &unknown).unwrap().unwrap();
            source.provenance_id = id.into();
            source.origin = if id == "human" { ProvenanceOrigin::Human } else { ProvenanceOrigin::Agent };
            source.run_id = (id != "human").then(|| id.into());
            source.session_id = Some("undo-regression-session".into());
            store.provenance().upsert_source(&source).unwrap();
        }
        let lines: Vec<_> = (1..=20).map(|line| format!("line-{line}\n")).collect();
        let baseline = lines.concat().into_bytes();
        let mut a_lines = lines.clone();
        a_lines[1] = "agent-a\n".into();
        let a = a_lines.concat().into_bytes();
        let mut b_lines = a_lines;
        b_lines[17] = "agent-b\n".into();
        let b = b_lines.concat().into_bytes();
        let initial = vec![Segment { start_line: 1, end_line: 21, provenance_id: "earlier-origin".into(), mapping_evidence: MappingEvidence::Exact }];
        let a_map = line_map::carry_forward(&initial, &line_map::diff_lines(&baseline, &a).unwrap(),
            |_| ("run-a".into(), MappingEvidence::Exact)).unwrap();
        let b_map = line_map::carry_forward(&a_map, &line_map::diff_lines(&a, &b).unwrap(),
            |_| ("run-b".into(), MappingEvidence::Exact)).unwrap();
        let persist = |store: &mut WorkspaceStore, key: &str, before: Option<Vec<u8>>, after: &[u8], segments: Vec<Segment>| {
            prepare(store, &root, key, "test", &[CapturePath { path: "file".into(), old_path: None,
                before, after: Some(after.to_vec()), segments: Some(segments) }], &[],
                Verification::Disk { root: root.canonical_root.clone() }, None, 1).unwrap();
            std::fs::write(workspace.path().join("file"), after).unwrap();
            record_applied_patch(store, key).unwrap();
        };
        persist(&mut store, "seed", None, &baseline, initial);
        persist(&mut store, "apply-a", Some(baseline.clone()), &a, a_map);
        persist(&mut store, "apply-b", Some(a), &b, b_map.clone());
        b_lines[9] = "recorded human edit\n".into();
        let human = b_lines.concat().into_bytes();
        let human_map = line_map::carry_forward(&b_map, &line_map::diff_lines(&b, &human).unwrap(),
            |_| ("human".into(), MappingEvidence::Exact)).unwrap();
        persist(&mut store, "human-save", Some(b), &human, human_map);
        drop(store);
        let mut store = WorkspaceStore::open(data.path(), 1024 * 1024).unwrap();
        b_lines[19] = "independent human edit\n".into();
        let current = b_lines.concat().into_bytes();
        std::fs::write(workspace.path().join("file"), &current).unwrap();
        let current_map = map_before(&mut store, &root, "file", &current, 2).unwrap();
        b_lines[1] = lines[1].clone();
        let reverted = b_lines.concat().into_bytes();
        let intent = store.provenance().mutation_intent("apply-a").unwrap().unwrap();
        let restored = undo_map(&mut store, &intent, "file", &current, &current_map, &reverted, &unknown, 2).unwrap();
        let source_at = |line| restored.iter().find(|segment| segment.start_line <= line && segment.end_line > line).unwrap().provenance_id.as_str();
        assert_eq!(source_at(2), "earlier-origin");
        assert_eq!(source_at(18), "run-b");
        assert_eq!(source_at(10), "human");
        assert_eq!(source_at(20), unknown);
        persist(&mut store, "undo-a", Some(current), &reverted, restored);
        let version = store.provenance().current_version(&root.root_id, "file").unwrap().unwrap();
        let segments = store.provenance().segments(&root.root_id, &version.version_id, 18..19, None, 10).unwrap();
        assert_eq!(segments.items[0].provenance_id, "run-b");
        assert_eq!(segments.items[0].mapping_evidence, MappingEvidence::Carried);
    }

    #[test]
    fn provenance_capture_retry_rejects_changed_payload_and_reconciles_only_verified_bytes() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        std::fs::write(workspace.path().join("a"), b"before\n").unwrap();
        let mut store = WorkspaceStore::open(data.path(), 1024 * 1024).unwrap();
        let root = working_root(&mut store, workspace.path()).unwrap();
        let input = CapturePath { path: "a".into(), old_path: None, before: Some(b"before\n".to_vec()), after: Some(b"after\n".to_vec()), segments: None };
        let verification = Verification::Disk { root: root.canonical_root.clone() };
        prepare(&mut store, &root, "retry", "test", &[input.clone()], &[], verification.clone(), None, 1).unwrap();
        let mut changed = input.clone();
        changed.after = Some(b"other\n".to_vec());
        assert!(prepare(&mut store, &root, "retry", "test", &[changed], &[], verification.clone(), None, 2).unwrap_err().contains("payload differs"));
        let mut remapped = input.clone();
        remapped.segments = Some(vec![Segment { start_line: 1, end_line: 2,
            provenance_id: unknown_source(&mut store, &root).unwrap(), mapping_evidence: MappingEvidence::Exact }]);
        assert!(prepare(&mut store, &root, "retry", "test", &[remapped], &[], verification.clone(), None, 2).unwrap_err().contains("payload differs"));
        let wrong_target = Verification::Disk { root: workspace.path().join("other").to_string_lossy().into_owned() };
        assert!(prepare(&mut store, &root, "retry", "test", &[input], &[], wrong_target, None, 2).unwrap_err().contains("payload differs"));
        reconcile(&mut store).unwrap();
        assert_eq!(store.provenance().mutation("retry").unwrap().unwrap().state, MutationCommitState::ReconcileRequired);
        assert!(store.provenance().current_version(&root.root_id, "a").unwrap().is_none());
        std::fs::write(workspace.path().join("a"), b"after\n").unwrap();
        drop(store);
        let mut store = WorkspaceStore::open(data.path(), 1024 * 1024).unwrap();
        reconcile(&mut store).unwrap();
        assert_eq!(store.provenance().mutation("retry").unwrap().unwrap().state, MutationCommitState::Committed);
        record_applied_patch(&mut store, "retry").unwrap();
        let count: i64 = store.connection.query_row("SELECT COUNT(*) FROM resource_versions", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
        store.prune_unreferenced_blobs().unwrap();
        assert_eq!(store.get_blob(&content_hash(b"before\n")[7..], 3).unwrap(), b"before\n");
    }

    #[test]
    fn provenance_capture_does_not_follow_an_escaping_parent_symlink() {
        #[cfg(unix)] {
            let root = TempDir::new().unwrap();
            let outside = TempDir::new().unwrap();
            std::fs::write(outside.path().join("a"), b"secret").unwrap();
            std::os::unix::fs::symlink(outside.path(), root.path().join("outside")).unwrap();
            assert!(disk_bytes(root.path(), "outside/a").unwrap_err().contains("escapes root"));
        }
    }
}
