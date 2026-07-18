use crate::{
    snapshot::detect_binary, store::WorkspaceStore, AppliedFile, ApplyOutcome, ChangeKind,
    PatchConflict, PatchFile, PatchHunk, PatchSelection, PatchSet, PatchState, ResourceChange,
    ResourceKind,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};
use uuid::Uuid;

#[derive(Clone)]
struct EntryPayload {
    bytes: Vec<u8>,
    kind: ResourceKind,
    mode: Option<u32>,
}

struct PlannedWrite {
    path: String,
    before: Option<EntryPayload>,
    after: Option<EntryPayload>,
}

struct PreflightContext<'a> {
    workspace_root: &'a Path,
    scratch_root: &'a Path,
    store: &'a mut WorkspaceStore,
    now: i64,
}

pub struct ApplyOptions {
    pub revision: u64,
    pub now: i64,
    pub allow_irreversible: bool,
}

pub fn build_patch_set(
    task_id: &str,
    run_id: &str,
    base_revision: u64,
    changes: &[ResourceChange],
    store: &mut WorkspaceStore,
    scratch_root: &Path,
    now: i64,
) -> Result<PatchSet, String> {
    let mut files = Vec::with_capacity(changes.len());
    for change in changes {
        let hunks = if change.kind == ChangeKind::Modified
            && !change.binary
            && change.resource_kind == ResourceKind::File
        {
            build_hunks(change, store, scratch_root, now)?
        } else {
            Vec::new()
        };
        files.push(PatchFile {
            path: change.path.clone(),
            old_path: change.old_path.clone(),
            kind: change.kind,
            resource_kind: change.resource_kind,
            before_hash: change.before_hash.clone(),
            after_hash: change.hash.clone(),
            before_mode: change.before_mode,
            after_mode: change.after_mode,
            binary: change.binary,
            hunks,
        });
    }
    Ok(PatchSet {
        patch_id: format!("patch:{run_id}"),
        task_id: task_id.to_string(),
        run_id: run_id.to_string(),
        state: PatchState::Ready,
        base_revision,
        applied_revision: None,
        files,
        applied_files: Vec::new(),
        reversible: true,
        created_at: now,
    })
}

pub fn apply(
    workspace_root: &Path,
    scratch_root: &Path,
    store: &mut WorkspaceStore,
    patch: &mut PatchSet,
    selection: &[PatchSelection],
    options: ApplyOptions,
) -> Result<ApplyOutcome, String> {
    if patch.state != PatchState::Ready && patch.state != PatchState::Conflict {
        return Err(format!("patch set is not ready: {:?}", patch.state));
    }
    let selected_paths = selected_paths(selection)?;
    let files = patch
        .files
        .iter()
        .filter(|file| {
            selected_paths
                .as_ref()
                .is_none_or(|paths| paths.contains(&file.path))
        })
        .collect::<Vec<_>>();
    if files.is_empty() && !patch.files.is_empty() {
        return Err("patch selection did not match any resource".into());
    }

    let mut plans = Vec::new();
    let mut conflicts = Vec::new();
    let mut context = PreflightContext {
        workspace_root,
        scratch_root,
        store,
        now: options.now,
    };
    for file in files {
        let hunk_ids = selection
            .iter()
            .find(|item| item.path == file.path)
            .map(|item| item.hunk_ids.as_slice())
            .unwrap_or_default();
        preflight_patch_file(&mut context, file, hunk_ids, &mut plans, &mut conflicts)?;
    }
    if !conflicts.is_empty() {
        patch.state = PatchState::Conflict;
        return Ok(ApplyOutcome {
            state: PatchState::Conflict,
            revision: options.revision,
            conflicts,
        });
    }

    patch.reversible = persist_plan_blobs(
        context.store,
        &plans,
        options.now,
        options.allow_irreversible,
    )?;
    commit_plans(workspace_root, &plans)?;
    patch.applied_files = plans
        .iter()
        .map(|plan| AppliedFile {
            path: plan.path.clone(),
            before_apply_hash: plan.before.as_ref().map(|entry| hash(&entry.bytes)),
            after_apply_hash: plan.after.as_ref().map(|entry| hash(&entry.bytes)),
            before_kind: plan.before.as_ref().map(|entry| entry.kind),
            after_kind: plan.after.as_ref().map(|entry| entry.kind),
            before_mode: plan.before.as_ref().and_then(|entry| entry.mode),
            after_mode: plan.after.as_ref().and_then(|entry| entry.mode),
            binary: plan
                .after
                .as_ref()
                .or(plan.before.as_ref())
                .is_some_and(|entry| detect_binary(&entry.bytes)),
        })
        .collect();
    patch.state = PatchState::Applied;
    patch.applied_revision = Some(options.revision);
    Ok(ApplyOutcome {
        state: PatchState::Applied,
        revision: options.revision,
        conflicts: Vec::new(),
    })
}

pub fn undo(
    workspace_root: &Path,
    scratch_root: &Path,
    store: &mut WorkspaceStore,
    patch: &mut PatchSet,
    revision: u64,
    now: i64,
) -> Result<ApplyOutcome, String> {
    if patch.state != PatchState::Applied && patch.state != PatchState::Conflict {
        return Err(format!("patch set is not applied: {:?}", patch.state));
    }
    if !patch.reversible {
        return Err(
            "patch set was applied irreversibly because inverse data was not retained".into(),
        );
    }
    let mut plans = Vec::new();
    let mut conflicts = Vec::new();
    for file in &patch.applied_files {
        let current = read_entry(workspace_root, &file.path)?;
        let base = payload_from_store(
            store,
            file.after_apply_hash.as_deref(),
            file.after_kind,
            file.after_mode,
            now,
        )?;
        let desired = payload_from_store(
            store,
            file.before_apply_hash.as_deref(),
            file.before_kind,
            file.before_mode,
            now,
        )?;
        match merge_entry(
            scratch_root,
            &file.path,
            current.clone(),
            base,
            desired,
            file.binary,
        )? {
            MergeResult::Ready(after) => plans.push(PlannedWrite {
                path: file.path.clone(),
                before: current,
                after,
            }),
            MergeResult::Conflict(reason) => conflicts.push(PatchConflict {
                path: file.path.clone(),
                reason,
            }),
        }
    }
    if !conflicts.is_empty() {
        patch.state = PatchState::Conflict;
        return Ok(ApplyOutcome {
            state: PatchState::Conflict,
            revision,
            conflicts,
        });
    }
    commit_plans(workspace_root, &plans)?;
    patch.state = PatchState::Reverted;
    Ok(ApplyOutcome {
        state: PatchState::Reverted,
        revision,
        conflicts: Vec::new(),
    })
}

pub fn force_apply(
    workspace_root: &Path,
    scratch_root: &Path,
    store: &mut WorkspaceStore,
    patch: &mut PatchSet,
    selection: &[PatchSelection],
    options: ApplyOptions,
) -> Result<ApplyOutcome, String> {
    if patch.state != PatchState::Conflict {
        return Err(format!("patch set is not conflicted: {:?}", patch.state));
    }
    let selected_paths = selected_paths(selection)?;
    let files = patch
        .files
        .iter()
        .filter(|file| {
            selected_paths
                .as_ref()
                .is_none_or(|paths| paths.contains(&file.path))
        })
        .collect::<Vec<_>>();
    if files.is_empty() && !patch.files.is_empty() {
        return Err("patch selection did not match any resource".into());
    }
    let mut plans = Vec::new();
    for file in files {
        let hunk_ids = selection
            .iter()
            .find(|item| item.path == file.path)
            .map(|item| item.hunk_ids.as_slice())
            .unwrap_or_default();
        let mut desired = payload_from_store(
            store,
            file.after_hash.as_deref(),
            Some(file.resource_kind),
            file.after_mode,
            options.now,
        )?;
        if !hunk_ids.is_empty() {
            let base = payload_from_store(
                store,
                file.before_hash.as_deref(),
                Some(file.resource_kind),
                file.before_mode,
                options.now,
            )?
            .ok_or_else(|| format!("hunk selection missing baseline: {}", file.path))?;
            desired = Some(EntryPayload {
                bytes: apply_selected_hunks(
                    scratch_root,
                    file,
                    hunk_ids,
                    &base.bytes,
                    store,
                    options.now,
                )?,
                kind: ResourceKind::File,
                mode: file.after_mode,
            });
        }
        if file.kind == ChangeKind::Renamed {
            let old_path = file
                .old_path
                .as_deref()
                .ok_or_else(|| format!("rename missing old path: {}", file.path))?;
            plans.push(PlannedWrite {
                path: old_path.to_string(),
                before: read_entry(workspace_root, old_path)?,
                after: None,
            });
        }
        plans.push(PlannedWrite {
            path: file.path.clone(),
            before: read_entry(workspace_root, &file.path)?,
            after: desired,
        });
    }
    patch.reversible = persist_plan_blobs(store, &plans, options.now, options.allow_irreversible)?;
    commit_plans(workspace_root, &plans)?;
    patch.applied_files = plans
        .iter()
        .map(|plan| AppliedFile {
            path: plan.path.clone(),
            before_apply_hash: plan.before.as_ref().map(|entry| hash(&entry.bytes)),
            after_apply_hash: plan.after.as_ref().map(|entry| hash(&entry.bytes)),
            before_kind: plan.before.as_ref().map(|entry| entry.kind),
            after_kind: plan.after.as_ref().map(|entry| entry.kind),
            before_mode: plan.before.as_ref().and_then(|entry| entry.mode),
            after_mode: plan.after.as_ref().and_then(|entry| entry.mode),
            binary: plan
                .after
                .as_ref()
                .or(plan.before.as_ref())
                .is_some_and(|entry| detect_binary(&entry.bytes)),
        })
        .collect();
    patch.state = PatchState::Applied;
    patch.applied_revision = Some(options.revision);
    Ok(ApplyOutcome {
        state: PatchState::Applied,
        revision: options.revision,
        conflicts: Vec::new(),
    })
}

fn persist_plan_blobs(
    store: &mut WorkspaceStore,
    plans: &[PlannedWrite],
    now: i64,
    allow_irreversible: bool,
) -> Result<bool, String> {
    let mut reversible = true;
    for entry in plans
        .iter()
        .flat_map(|plan| [plan.before.as_ref(), plan.after.as_ref()])
        .flatten()
    {
        if let Err(error) = store.put_blob(&hash(&entry.bytes), &entry.bytes, now) {
            if allow_irreversible && error.starts_with("task workspace ledger capacity exceeded:") {
                reversible = false;
            } else {
                return Err(error);
            }
        }
    }
    Ok(reversible)
}

pub fn keep_current(patch: &mut PatchSet, revision: u64) -> Result<ApplyOutcome, String> {
    if patch.state != PatchState::Conflict {
        return Err(format!("patch set is not conflicted: {:?}", patch.state));
    }
    patch.state = PatchState::Reverted;
    patch.applied_files.clear();
    Ok(ApplyOutcome {
        state: PatchState::Reverted,
        revision,
        conflicts: Vec::new(),
    })
}

fn selected_paths(selection: &[PatchSelection]) -> Result<Option<HashSet<String>>, String> {
    if selection.is_empty() {
        return Ok(None);
    }
    let mut paths = HashSet::new();
    for item in selection {
        if item.path.is_empty() || !paths.insert(item.path.clone()) {
            return Err(format!(
                "invalid or duplicate patch selection: {}",
                item.path
            ));
        }
    }
    Ok(Some(paths))
}

fn preflight_patch_file(
    context: &mut PreflightContext<'_>,
    file: &PatchFile,
    hunk_ids: &[String],
    plans: &mut Vec<PlannedWrite>,
    conflicts: &mut Vec<PatchConflict>,
) -> Result<(), String> {
    if file.kind == ChangeKind::Renamed {
        let old_path = file
            .old_path
            .as_deref()
            .ok_or_else(|| format!("rename missing old path: {}", file.path))?;
        let old_current = read_entry(context.workspace_root, old_path)?;
        let old_base = payload_from_store(
            context.store,
            file.before_hash.as_deref(),
            Some(file.resource_kind),
            file.before_mode,
            context.now,
        )?;
        if !same_entry(old_current.as_ref(), old_base.as_ref()) {
            conflicts.push(PatchConflict {
                path: old_path.to_string(),
                reason: "rename source changed after the task started".into(),
            });
            return Ok(());
        }
        if read_entry(context.workspace_root, &file.path)?.is_some() {
            conflicts.push(PatchConflict {
                path: file.path.clone(),
                reason: "rename destination already exists".into(),
            });
            return Ok(());
        }
        let desired = payload_from_store(
            context.store,
            file.after_hash.as_deref(),
            Some(file.resource_kind),
            file.after_mode,
            context.now,
        )?;
        plans.push(PlannedWrite {
            path: old_path.to_string(),
            before: old_current,
            after: None,
        });
        plans.push(PlannedWrite {
            path: file.path.clone(),
            before: None,
            after: desired,
        });
        return Ok(());
    }

    let current = read_entry(context.workspace_root, &file.path)?;
    let base = payload_from_store(
        context.store,
        file.before_hash.as_deref(),
        Some(file.resource_kind),
        file.before_mode,
        context.now,
    )?;
    let mut desired = payload_from_store(
        context.store,
        file.after_hash.as_deref(),
        Some(file.resource_kind),
        file.after_mode,
        context.now,
    )?;
    if !hunk_ids.is_empty() {
        if file.kind != ChangeKind::Modified
            || file.binary
            || file.resource_kind != ResourceKind::File
        {
            return Err(format!(
                "resource does not support hunk selection: {}",
                file.path
            ));
        }
        let base_payload = base
            .as_ref()
            .ok_or_else(|| format!("hunk selection missing baseline: {}", file.path))?;
        let bytes = apply_selected_hunks(
            context.scratch_root,
            file,
            hunk_ids,
            &base_payload.bytes,
            context.store,
            context.now,
        )?;
        desired = Some(EntryPayload {
            bytes,
            kind: ResourceKind::File,
            mode: file.after_mode,
        });
    }
    match merge_entry(
        context.scratch_root,
        &file.path,
        current.clone(),
        base,
        desired,
        file.binary || file.resource_kind == ResourceKind::Symlink,
    )? {
        MergeResult::Ready(after) => plans.push(PlannedWrite {
            path: file.path.clone(),
            before: current,
            after,
        }),
        MergeResult::Conflict(reason) => conflicts.push(PatchConflict {
            path: file.path.clone(),
            reason,
        }),
    }
    Ok(())
}

fn build_hunks(
    change: &ResourceChange,
    store: &mut WorkspaceStore,
    scratch_root: &Path,
    now: i64,
) -> Result<Vec<PatchHunk>, String> {
    let before_hash = change
        .before_hash
        .as_deref()
        .ok_or_else(|| format!("modified resource missing before hash: {}", change.path))?;
    let after_hash = change
        .hash
        .as_deref()
        .ok_or_else(|| format!("modified resource missing after hash: {}", change.path))?;
    let before = store.get_blob(before_hash, now)?;
    let after = store.get_blob(after_hash, now)?;
    let forward = unified_diff(scratch_root, &change.path, &before, &after)?;
    let inverse = unified_diff(scratch_root, &change.path, &after, &before)?;
    let forward = split_patch_hunks(&forward)?;
    let inverse = split_patch_hunks(&inverse)?;
    if forward.len() != inverse.len() {
        return Err(format!("forward/inverse hunk mismatch for {}", change.path));
    }
    let mut hunks = Vec::with_capacity(forward.len());
    for (index, ((header, forward), (_, inverse))) in
        forward.into_iter().zip(inverse.into_iter()).enumerate()
    {
        let forward_hash = hash(forward.as_bytes());
        let inverse_hash = hash(inverse.as_bytes());
        store.put_blob(&forward_hash, forward.as_bytes(), now)?;
        store.put_blob(&inverse_hash, inverse.as_bytes(), now)?;
        hunks.push(PatchHunk {
            id: format!("hunk:{}:{}", index + 1, &forward_hash[..12]),
            header,
            forward_patch_hash: forward_hash,
            inverse_patch_hash: inverse_hash,
        });
    }
    Ok(hunks)
}

fn unified_diff(
    scratch_root: &Path,
    rel_path: &str,
    before: &[u8],
    after: &[u8],
) -> Result<String, String> {
    let scratch = scratch_root.join(format!("diff-{}", Uuid::now_v7()));
    let old_path = scratch.join("old").join(rel_path);
    let new_path = scratch.join("new").join(rel_path);
    if let Some(parent) = old_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create diff old: {error}"))?;
    }
    if let Some(parent) = new_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create diff new: {error}"))?;
    }
    fs::write(&old_path, before).map_err(|error| format!("write diff old: {error}"))?;
    fs::write(&new_path, after).map_err(|error| format!("write diff new: {error}"))?;
    let old_arg = Path::new("old").join(rel_path);
    let new_arg = Path::new("new").join(rel_path);
    let output = Command::new("git")
        .current_dir(&scratch)
        .args(["diff", "--no-index", "--binary", "--unified=3", "--"])
        .arg(&old_arg)
        .arg(&new_arg)
        .output()
        .map_err(|error| format!("start git diff for {rel_path}: {error}"));
    let _ = fs::remove_dir_all(&scratch);
    let output = output?;
    if !matches!(output.status.code(), Some(0 | 1)) {
        return Err(format!(
            "git diff failed for {rel_path}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let patch = String::from_utf8(output.stdout)
        .map_err(|_| format!("git diff returned non-UTF-8 patch for {rel_path}"))?;
    Ok(patch.replace("a/old/", "a/").replace("b/new/", "b/"))
}

fn split_patch_hunks(patch: &str) -> Result<Vec<(String, String)>, String> {
    let lines = patch.split_inclusive('\n').collect::<Vec<_>>();
    let first_hunk = lines
        .iter()
        .position(|line| line.starts_with("@@ "))
        .ok_or_else(|| "text diff did not contain a hunk".to_string())?;
    let prefix = lines[..first_hunk].concat();
    let mut out = Vec::new();
    let mut index = first_hunk;
    while index < lines.len() {
        let start = index;
        index += 1;
        while index < lines.len() && !lines[index].starts_with("@@ ") {
            index += 1;
        }
        let header = lines[start].trim_end().to_string();
        out.push((
            header,
            format!("{}{}", prefix, lines[start..index].concat()),
        ));
    }
    Ok(out)
}

fn apply_selected_hunks(
    scratch_root: &Path,
    file: &PatchFile,
    hunk_ids: &[String],
    baseline: &[u8],
    store: &mut WorkspaceStore,
    now: i64,
) -> Result<Vec<u8>, String> {
    let mut selected = Vec::new();
    let mut seen = HashSet::new();
    for hunk_id in hunk_ids {
        if !seen.insert(hunk_id) {
            return Err(format!("duplicate hunk selection: {hunk_id}"));
        }
        let hunk = file
            .hunks
            .iter()
            .find(|hunk| &hunk.id == hunk_id)
            .ok_or_else(|| format!("unknown hunk {hunk_id} for {}", file.path))?;
        let patch = store.get_blob(&hunk.forward_patch_hash, now)?;
        selected
            .push(String::from_utf8(patch).map_err(|_| "stored patch is not UTF-8".to_string())?);
    }
    let combined = combine_hunk_patches(&selected)?;
    let scratch = scratch_root.join(format!("apply-hunks-{}", Uuid::now_v7()));
    let target = scratch.join(&file.path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create hunk scratch: {error}"))?;
    }
    fs::write(&target, baseline).map_err(|error| format!("write hunk baseline: {error}"))?;
    let patch_path = scratch.join("selected.patch");
    fs::write(&patch_path, combined).map_err(|error| format!("write selected patch: {error}"))?;
    let output = Command::new("git")
        .current_dir(&scratch)
        .args(["apply", "--recount", "--unsafe-paths"])
        .arg(&patch_path)
        .output()
        .map_err(|error| format!("start git apply for {}: {error}", file.path));
    let result = match output {
        Ok(output) if output.status.success() => {
            fs::read(&target).map_err(|error| format!("read selected hunk result: {error}"))
        }
        Ok(output) => Err(format!(
            "selected hunks do not apply to {}: {}",
            file.path,
            String::from_utf8_lossy(&output.stderr).trim()
        )),
        Err(error) => Err(error),
    };
    let _ = fs::remove_dir_all(&scratch);
    result
}

fn combine_hunk_patches(patches: &[String]) -> Result<String, String> {
    let first = patches
        .first()
        .ok_or_else(|| "no hunks selected".to_string())?;
    let first_hunk = first
        .find("@@ ")
        .ok_or_else(|| "stored patch missing hunk".to_string())?;
    let mut combined = first[..first_hunk].to_string();
    for patch in patches {
        let hunk = patch
            .find("@@ ")
            .ok_or_else(|| "stored patch missing hunk".to_string())?;
        combined.push_str(&patch[hunk..]);
    }
    Ok(combined)
}

enum MergeResult {
    Ready(Option<EntryPayload>),
    Conflict(String),
}

fn merge_entry(
    scratch_root: &Path,
    rel_path: &str,
    current: Option<EntryPayload>,
    base: Option<EntryPayload>,
    desired: Option<EntryPayload>,
    binary: bool,
) -> Result<MergeResult, String> {
    match (current, base, desired) {
        (None, None, desired) => Ok(MergeResult::Ready(desired)),
        (Some(current), None, Some(desired)) if same_payload(&current, &desired) => {
            Ok(MergeResult::Ready(Some(current)))
        }
        (Some(_), None, Some(_)) => Ok(MergeResult::Conflict(
            "resource was created independently in the main workspace".into(),
        )),
        (None, Some(_), None) => Ok(MergeResult::Ready(None)),
        (Some(current), Some(base), None) if same_payload(&current, &base) => {
            Ok(MergeResult::Ready(None))
        }
        (Some(_), Some(_), None) => Ok(MergeResult::Conflict(
            "resource changed before task deletion could be applied".into(),
        )),
        (None, Some(_), Some(_)) => Ok(MergeResult::Conflict(
            "resource was deleted after the task started".into(),
        )),
        (Some(current), Some(base), Some(desired)) if same_payload(&current, &base) => {
            Ok(MergeResult::Ready(Some(desired)))
        }
        (Some(current), Some(base), Some(desired)) if same_payload(&current, &desired) => {
            Ok(MergeResult::Ready(Some(current)))
        }
        (Some(current), Some(base), Some(desired)) if binary => Ok(MergeResult::Conflict(
            "binary or symbolic-link resource changed on both sides".into(),
        )),
        (Some(current), Some(base), Some(desired)) if current.bytes.starts_with(&base.bytes) => {
            let mut bytes = desired.bytes.clone();
            bytes.extend_from_slice(&current.bytes[base.bytes.len()..]);
            Ok(MergeResult::Ready(Some(EntryPayload {
                bytes,
                kind: desired.kind,
                mode: desired.mode,
            })))
        }
        (Some(current), Some(base), Some(desired)) if current.bytes.ends_with(&base.bytes) => {
            let mut bytes = current.bytes[..current.bytes.len() - base.bytes.len()].to_vec();
            bytes.extend_from_slice(&desired.bytes);
            Ok(MergeResult::Ready(Some(EntryPayload {
                bytes,
                kind: desired.kind,
                mode: desired.mode,
            })))
        }
        (Some(current), Some(base), Some(desired)) => {
            let merged = merge_text(
                scratch_root,
                rel_path,
                &current.bytes,
                &base.bytes,
                &desired.bytes,
            )?;
            match merged {
                Some(bytes) => Ok(MergeResult::Ready(Some(EntryPayload {
                    bytes,
                    kind: desired.kind,
                    mode: desired.mode,
                }))),
                None => Ok(MergeResult::Conflict(
                    "text changed in overlapping hunks".into(),
                )),
            }
        }
        (Some(_), None, None) => Ok(MergeResult::Conflict(
            "resource exists but neither task baseline nor result contains it".into(),
        )),
    }
}

fn merge_text(
    scratch_root: &Path,
    rel_path: &str,
    current: &[u8],
    base: &[u8],
    desired: &[u8],
) -> Result<Option<Vec<u8>>, String> {
    let scratch = scratch_root.join(format!("merge-{}", Uuid::now_v7()));
    fs::create_dir_all(&scratch)
        .map_err(|error| format!("create merge scratch {}: {error}", scratch.display()))?;
    let current_path = scratch.join("current");
    let base_path = scratch.join("base");
    let desired_path = scratch.join("desired");
    fs::write(&current_path, current).map_err(|error| format!("write merge current: {error}"))?;
    fs::write(&base_path, base).map_err(|error| format!("write merge base: {error}"))?;
    fs::write(&desired_path, desired).map_err(|error| format!("write merge desired: {error}"))?;
    let output = Command::new("git")
        .args(["merge-file", "-p"])
        .arg(&current_path)
        .arg(&base_path)
        .arg(&desired_path)
        .output()
        .map_err(|error| format!("start git merge-file for {rel_path}: {error}"));
    let _ = fs::remove_dir_all(&scratch);
    let output = output?;
    match output.status.code() {
        Some(0) => Ok(Some(output.stdout)),
        Some(1) => Ok(None),
        _ => Err(format!(
            "git merge-file failed for {rel_path}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
    }
}

fn payload_from_store(
    store: &mut WorkspaceStore,
    hash: Option<&str>,
    kind: Option<ResourceKind>,
    mode: Option<u32>,
    now: i64,
) -> Result<Option<EntryPayload>, String> {
    let Some(hash) = hash else {
        return Ok(None);
    };
    Ok(Some(EntryPayload {
        bytes: store.get_blob(hash, now)?,
        kind: kind.unwrap_or(ResourceKind::File),
        mode,
    }))
}

fn read_entry(root: &Path, rel_path: &str) -> Result<Option<EntryPayload>, String> {
    let target = confined_target(root, rel_path)?;
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("stat {}: {error}", target.display())),
    };
    if metadata.file_type().is_symlink() {
        let link = fs::read_link(&target)
            .map_err(|error| format!("read link {}: {error}", target.display()))?;
        return Ok(Some(EntryPayload {
            bytes: link.to_string_lossy().as_bytes().to_vec(),
            kind: ResourceKind::Symlink,
            mode: file_mode(&target),
        }));
    }
    if !metadata.is_file() {
        return Err(format!("task patch target is not a file: {rel_path}"));
    }
    Ok(Some(EntryPayload {
        bytes: fs::read(&target).map_err(|error| format!("read {}: {error}", target.display()))?,
        kind: ResourceKind::File,
        mode: file_mode(&target),
    }))
}

fn commit_plans(root: &Path, plans: &[PlannedWrite]) -> Result<(), String> {
    let mut completed = Vec::new();
    for plan in plans {
        if let Err(error) = write_entry(root, &plan.path, plan.after.as_ref()) {
            for index in completed.into_iter().rev() {
                let rollback: &PlannedWrite = &plans[index];
                let _ = write_entry(root, &rollback.path, rollback.before.as_ref());
            }
            return Err(format!(
                "atomic task patch failed at {}: {error}",
                plan.path
            ));
        }
        completed.push(completed.len());
    }
    Ok(())
}

fn write_entry(root: &Path, rel_path: &str, entry: Option<&EntryPayload>) -> Result<(), String> {
    let target = confined_target(root, rel_path)?;
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            return Err(format!("refusing to replace directory: {rel_path}"));
        }
        fs::remove_file(&target)
            .map_err(|error| format!("remove {}: {error}", target.display()))?;
    }
    let Some(entry) = entry else {
        return Ok(());
    };
    let parent = target
        .parent()
        .ok_or_else(|| format!("invalid target path: {rel_path}"))?;
    fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize root {}: {error}", root.display()))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("canonicalize parent {}: {error}", parent.display()))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(format!("path escapes workspace: {rel_path}"));
    }
    match entry.kind {
        ResourceKind::File => {
            let temp = parent.join(format!(".cognia-write-{}", Uuid::now_v7()));
            fs::write(&temp, &entry.bytes)
                .map_err(|error| format!("write temp {}: {error}", temp.display()))?;
            apply_mode(&temp, entry.mode)?;
            fs::rename(&temp, &target)
                .map_err(|error| format!("publish {}: {error}", target.display()))?;
        }
        ResourceKind::Symlink => create_symlink(&target, &entry.bytes)?,
    }
    Ok(())
}

fn confined_target(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(rel_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("path escapes workspace: {rel_path}"));
    }
    Ok(root.join(relative))
}

fn same_entry(left: Option<&EntryPayload>, right: Option<&EntryPayload>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => same_payload(left, right),
        _ => false,
    }
}

fn same_payload(left: &EntryPayload, right: &EntryPayload) -> bool {
    left.kind == right.kind && left.bytes == right.bytes && left.mode == right.mode
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(unix)]
fn file_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    path.symlink_metadata()
        .ok()
        .map(|meta| meta.permissions().mode())
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Option<u32> {
    None
}

#[cfg(unix)]
fn apply_mode(path: &Path, mode: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|error| format!("chmod {}: {error}", path.display()))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn apply_mode(_path: &Path, _mode: Option<u32>) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn create_symlink(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::symlink;
    let target =
        String::from_utf8(bytes.to_vec()).map_err(|_| "invalid symlink target".to_string())?;
    symlink(target, path).map_err(|error| format!("symlink {}: {error}", path.display()))
}

#[cfg(windows)]
fn create_symlink(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::windows::fs::symlink_file;
    let target =
        String::from_utf8(bytes.to_vec()).map_err(|_| "invalid symlink target".to_string())?;
    symlink_file(target, path).map_err(|error| format!("symlink {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn capacity_failure_requires_an_explicit_irreversible_override() {
        let data = TempDir::new().unwrap();
        let plans = vec![PlannedWrite {
            path: "result.bin".into(),
            before: Some(EntryPayload {
                bytes: vec![1, 2],
                kind: ResourceKind::File,
                mode: None,
            }),
            after: None,
        }];
        let mut blocked_store = WorkspaceStore::open(data.path(), 0).unwrap();
        let error = persist_plan_blobs(&mut blocked_store, &plans, 1, false).unwrap_err();
        assert!(error.starts_with("task workspace ledger capacity exceeded:"));

        let override_data = TempDir::new().unwrap();
        let mut override_store = WorkspaceStore::open(override_data.path(), 0).unwrap();
        assert!(!persist_plan_blobs(&mut override_store, &plans, 1, true).unwrap());
    }
}
