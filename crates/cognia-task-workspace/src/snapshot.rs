use crate::{
    resource::{is_sensitive_resource, media_type_for},
    ResourceKind, ResourceTrackingPolicy,
};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub path: String,
    pub kind: EntryKind,
    pub hash: String,
    pub size: u64,
    pub mode: Option<u32>,
    pub binary: bool,
    pub media_type: String,
    pub sensitive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedSnapshotEntry {
    pub path: String,
    pub kind: ResourceKind,
    pub size: u64,
    pub mode: Option<u32>,
    pub modified_at: Option<i64>,
    pub media_type: String,
    pub sensitive: bool,
}

/// Where an entry's bytes can be found.
///
/// A snapshot of a Git worktree does not copy content Git already stores. The
/// entry list stays complete either way — `reconcile` compares whole file sets,
/// so a thinned list would make a deletion invisible — but for a `GitCommit`
/// base the bytes of unmodified tracked files are left in the object database
/// and the entry hash *is* their blob id, so a blob lookup that misses the
/// store must fall back to the repository.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SnapshotBase {
    /// Every entry's bytes are in the blob store. The shape of every snapshot
    /// written before Git-backed capture existed, hence the `Default`.
    #[default]
    Blobs,
    /// Bytes missing from the blob store live in the workspace repository at
    /// this commit, which is pinned by a ref so a user-run `git gc` cannot
    /// collect them out from under a pending rollback.
    GitCommit { commit: String },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    pub entries: BTreeMap<String, SnapshotEntry>,
    #[serde(default)]
    pub generated_entries: BTreeMap<String, GeneratedSnapshotEntry>,
    /// Defaulted so snapshots persisted before this field existed keep
    /// deserializing as fully blob-backed.
    #[serde(default)]
    pub base: SnapshotBase,
}

#[cfg(test)]
pub fn capture(root: &Path) -> Result<(WorkspaceSnapshot, HashMap<String, Vec<u8>>), String> {
    capture_with_policy(
        root,
        &ResourceTrackingPolicy {
            generated_output_roots: Vec::new(),
            auto_detect: false,
        },
    )
}

pub fn capture_with_policy(
    root: &Path,
    policy: &ResourceTrackingPolicy,
) -> Result<(WorkspaceSnapshot, HashMap<String, Vec<u8>>), String> {
    // Every acquisition pays this walk, and it reads each file whole into
    // memory before hashing it, so the span is the one number that says
    // whether provisioning cost is dominated by the snapshot or by git.
    let _perf = cognia_instrument::guard("workspace.snapshot_capture");
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize root {}: {error}", root.display()))?;
    // Git already holds every byte of an unmodified tracked file, and asking it
    // for the tree costs one subprocess instead of reading the whole checkout.
    // Falls through to the walk below whenever the root is not a usable Git
    // worktree — no repository, an unborn branch, a broken `git`.
    if let Some(captured) = capture_git_backed(&canonical_root, policy)? {
        return Ok(captured);
    }
    let mut entries = BTreeMap::new();
    let mut blobs = HashMap::new();
    let mut builder = WalkBuilder::new(&canonical_root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .ignore(true)
        .parents(true)
        .require_git(false)
        .follow_links(false);

    for item in builder.build() {
        let entry = item.map_err(|error| format!("walk {}: {error}", canonical_root.display()))?;
        let path = entry.path();
        if path == canonical_root || excluded(path, &canonical_root, &policy.generated_output_roots)
        {
            continue;
        }
        let file_type = entry
            .file_type()
            .ok_or_else(|| format!("missing file type: {}", path.display()))?;
        if file_type.is_dir() {
            continue;
        }
        let rel = path
            .strip_prefix(&canonical_root)
            .map_err(|_| format!("path escapes workspace: {}", path.display()))?;
        let rel_path = rel.to_string_lossy().replace('\\', "/");
        let (kind, bytes) = if file_type.is_symlink() {
            let target = fs::read_link(path)
                .map_err(|error| format!("read link {}: {error}", path.display()))?;
            validate_symlink_target(rel, &target)?;
            (
                EntryKind::Symlink,
                target.to_string_lossy().as_bytes().to_vec(),
            )
        } else if file_type.is_file() {
            (
                EntryKind::File,
                fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?,
            )
        } else {
            continue;
        };
        let hash = hex::encode(Sha256::digest(&bytes));
        let binary = kind == EntryKind::File && detect_binary(&bytes);
        let mode = file_mode(path);
        entries.insert(
            rel_path.clone(),
            SnapshotEntry {
                path: rel_path,
                kind,
                hash: hash.clone(),
                size: bytes.len() as u64,
                mode,
                binary,
                media_type: media_type_for(rel.to_string_lossy().as_ref(), binary).to_string(),
                sensitive: is_sensitive_resource(rel.to_string_lossy().as_ref()),
            },
        );
        blobs.entry(hash).or_insert(bytes);
    }
    capture_worktree_includes(&canonical_root, &mut entries, &mut blobs)?;
    let generated_entries = capture_generated(&canonical_root, &policy.generated_output_roots)?;
    Ok((
        WorkspaceSnapshot {
            entries,
            generated_entries,
            base: SnapshotBase::Blobs,
        },
        blobs,
    ))
}

// ---------------------------------------------------------------------------
// Git-backed capture
//
// Reading a whole checkout to hash it is pure duplication when the checkout is
// a Git worktree: Git has already hashed every tracked file and can hand over
// the list, with blob ids and sizes, in a single subprocess. Measured on this
// repository (280 MB, 25,138 tracked files): `ls-tree` 0.07 s + `status` 0.19 s
// against 5.5 s to read and hash the tree, and that 5.5 s is only the floor —
// the walk also held every byte in memory to zstd it into SQLite afterwards.
//
// The entry list this produces is deliberately *identical in shape* to the
// walk's: complete, one entry per file present on disk. Only the provenance of
// the bytes changes.
// ---------------------------------------------------------------------------

/// Run `git` inside `root`, returning stdout only on a clean exit.
///
/// Every failure is `None` rather than an error: the sole caller treats "git
/// could not answer" as "this is not a Git worktree, take the walk".
fn git_stdout(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

/// One row of `git ls-tree -r --long -z`.
struct GitTreeRow {
    oid: String,
    size: u64,
    path: String,
}

/// Parse `git ls-tree -r --long -z` output.
///
/// Record layout is `<mode> SP <type> SP <oid> SP+ <size> TAB <path>`, records
/// NUL-separated. `-z` is load-bearing: without it Git quotes and escapes paths
/// containing non-ASCII or control characters, and the unescaping is not
/// round-trippable by hand.
fn parse_ls_tree(stdout: &[u8]) -> Vec<GitTreeRow> {
    let mut rows = Vec::new();
    for record in stdout.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        // Split on the TAB first: a path may contain spaces, the metadata may not.
        let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
            continue;
        };
        let (meta, path) = record.split_at(tab);
        let Ok(path) = std::str::from_utf8(&path[1..]) else {
            continue;
        };
        let Ok(meta) = std::str::from_utf8(meta) else {
            continue;
        };
        let mut fields = meta.split_whitespace();
        // `<mode> <type> <oid> <size>`; the mode is skipped because the entry
        // records the lstat mode, exactly as the filesystem walk did.
        let (Some(_mode), Some(kind), Some(oid), Some(size)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        // Submodules ("commit") and nested trees carry no blob to restore.
        if kind != "blob" {
            continue;
        }
        let Ok(size) = size.parse::<u64>() else {
            continue;
        };
        rows.push(GitTreeRow {
            oid: oid.to_string(),
            size,
            path: path.to_string(),
        });
    }
    rows
}

/// Paths reported by `git status --porcelain=v1 -z`, i.e. everything the
/// working tree holds that `HEAD` does not agree with.
///
/// Run with `--no-renames` so a rename arrives as a delete plus an add. That
/// keeps the record layout a flat `XY SP <path>` — the rename form appends a
/// second NUL-terminated path and is easy to mis-parse — and costs nothing,
/// because `reconcile` pairs deletes with adds by hash on its own.
fn parse_status_paths(stdout: &[u8]) -> Vec<String> {
    stdout
        .split(|byte| *byte == 0)
        .filter(|record| record.len() > 3)
        .filter_map(|record| std::str::from_utf8(&record[3..]).ok())
        .map(str::to_string)
        .collect()
}

/// Git's own blob hash for `bytes`, so hashes are comparable no matter whether
/// an entry came from `ls-tree` or from disk.
///
/// This matters for more than tidiness: `reconcile` pairs a deletion with a
/// creation by hash equality to report a rename. Hash a moved file with a
/// different algorithm than the one Git used for its old path and the rename
/// silently degrades into an unrelated delete-plus-create.
fn git_blob_hash(bytes: &[u8], format: git2::ObjectFormat) -> Result<String, String> {
    git2::Oid::hash_object_ext(git2::ObjectType::Blob, bytes, format)
        .map(|oid| oid.to_string())
        .map_err(|error| format!("hash blob: {error}"))
}

/// Whether a path looks binary, judged by extension alone.
///
/// Used only for entries taken from `ls-tree`, whose bytes are deliberately not
/// read. `binary` never participates in change detection — `reconcile` compares
/// hash, mode and kind — it only decides whether line counts are meaningful, so
/// an extension-based answer costs at most a missing line count on an
/// oddly-named file. Mirrors the same inversion `service.rs` already applies
/// when it derives `binary` from a media type.
fn binary_hint_from_path(rel_path: &str) -> bool {
    let media = media_type_for(rel_path, false);
    !(media.starts_with("text/") || media == "application/json" || media == "image/svg+xml")
}

/// Capture `root` using Git as the content store.
///
/// `Ok(None)` means "not a Git worktree we can read" and asks the caller to
/// fall back to the filesystem walk.
fn capture_git_backed(
    canonical_root: &Path,
    policy: &ResourceTrackingPolicy,
) -> Result<Option<(WorkspaceSnapshot, HashMap<String, Vec<u8>>)>, String> {
    let Some(head) = git_stdout(canonical_root, &["rev-parse", "HEAD"]) else {
        return Ok(None);
    };
    let commit = String::from_utf8_lossy(&head).trim().to_string();
    if commit.is_empty() {
        return Ok(None);
    }
    // A SHA-256 repository would need SHA-256 blob hashes for the dirty
    // overlay, and this build of git2 only offers that behind its
    // `unstable-sha256` feature. Hashing the overlay with SHA-1 while the tree
    // rows carry SHA-256 ids would put two incomparable hash spaces in one
    // entry map, so such a repository takes the walk instead. They are rare;
    // a wrong answer here would not be.
    match git_stdout(canonical_root, &["rev-parse", "--show-object-format"]) {
        Some(raw) if String::from_utf8_lossy(&raw).trim() != "sha1" => return Ok(None),
        None => return Ok(None),
        _ => {}
    }
    let format = git2::ObjectFormat::Sha1;
    let Some(tree) = git_stdout(canonical_root, &["ls-tree", "-r", "--long", "-z", &commit]) else {
        return Ok(None);
    };
    let Some(status) = git_stdout(
        canonical_root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
    ) else {
        return Ok(None);
    };

    let mut entries = BTreeMap::new();
    let mut blobs: HashMap<String, Vec<u8>> = HashMap::new();

    for row in parse_ls_tree(&tree) {
        let absolute = canonical_root.join(&row.path);
        if excluded(&absolute, canonical_root, &policy.generated_output_roots) {
            continue;
        }
        // One lstat per tracked file. It buys two things at once: the mode,
        // recorded exactly as the walk records it so a Git-backed baseline and
        // a walk-backed capture never disagree about permissions; and proof the
        // file is actually materialised. The second matters under
        // sparse-checkout, where `ls-tree` lists paths that were deliberately
        // not written — reporting those as present would make every settle read
        // them back as deletions.
        let Ok(meta) = absolute.symlink_metadata() else {
            continue;
        };
        let kind = if meta.file_type().is_symlink() {
            // A symlink's "content" is its target, and the escape check the
            // walk performs is a security floor, not a formality.
            let target = fs::read_link(&absolute)
                .map_err(|error| format!("read link {}: {error}", absolute.display()))?;
            validate_symlink_target(Path::new(&row.path), &target)?;
            EntryKind::Symlink
        } else if meta.file_type().is_file() {
            EntryKind::File
        } else {
            continue;
        };
        let binary = binary_hint_from_path(&row.path);
        entries.insert(
            row.path.clone(),
            SnapshotEntry {
                path: row.path.clone(),
                kind,
                hash: row.oid,
                size: row.size,
                mode: file_mode(&absolute),
                binary,
                media_type: media_type_for(&row.path, binary).to_string(),
                sensitive: is_sensitive_resource(&row.path),
            },
        );
    }

    // Overlay everything the working tree disagrees with HEAD about. This is
    // the only set whose bytes are read, and on a healthy checkout it is tiny.
    for path in parse_status_paths(&status) {
        let absolute = canonical_root.join(&path);
        if excluded(&absolute, canonical_root, &policy.generated_output_roots) {
            continue;
        }
        let Ok(meta) = absolute.symlink_metadata() else {
            // Deleted in the working tree: drop the entry Git's tree listed.
            entries.remove(&path);
            continue;
        };
        let (kind, bytes) = if meta.file_type().is_symlink() {
            let target = fs::read_link(&absolute)
                .map_err(|error| format!("read link {}: {error}", absolute.display()))?;
            validate_symlink_target(Path::new(&path), &target)?;
            (
                EntryKind::Symlink,
                target.to_string_lossy().as_bytes().to_vec(),
            )
        } else if meta.file_type().is_file() {
            (
                EntryKind::File,
                fs::read(&absolute)
                    .map_err(|error| format!("read {}: {error}", absolute.display()))?,
            )
        } else {
            continue;
        };
        let hash = git_blob_hash(&bytes, format)?;
        let binary = kind == EntryKind::File && detect_binary(&bytes);
        entries.insert(
            path.clone(),
            SnapshotEntry {
                path: path.clone(),
                kind,
                hash: hash.clone(),
                size: bytes.len() as u64,
                mode: file_mode(&absolute),
                binary,
                media_type: media_type_for(&path, binary).to_string(),
                sensitive: is_sensitive_resource(&path),
            },
        );
        blobs.entry(hash).or_insert(bytes);
    }

    capture_worktree_includes(canonical_root, &mut entries, &mut blobs)?;
    let generated_entries = capture_generated(canonical_root, &policy.generated_output_roots)?;
    Ok(Some((
        WorkspaceSnapshot {
            entries,
            generated_entries,
            base: SnapshotBase::GitCommit { commit },
        },
        blobs,
    )))
}

/// Read blobs straight out of a repository's object database.
///
/// The counterpart to Git-backed capture: those snapshots deliberately leave
/// unmodified tracked content in Git, so anything that later wants the bytes —
/// restoring a workspace, diffing a change — resolves them here.
///
/// Uses one `cat-file --batch` process for the whole request rather than a
/// `cat-file blob` per object. Restoring a workspace asks for every entry it
/// has, so the per-process version would mean tens of thousands of spawns and
/// would be far slower than the whole-tree read this design exists to avoid.
///
/// Objects Git does not have are simply absent from the result; the caller
/// decides whether that is fatal.
pub fn git_read_blobs(
    root: &Path,
    hashes: &[String],
) -> Result<HashMap<String, Vec<u8>>, String> {
    use std::io::{BufRead, BufReader, Read, Write};

    let mut resolved = HashMap::new();
    if hashes.is_empty() {
        return Ok(resolved);
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["cat-file", "--batch"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("start git cat-file: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "git cat-file stdin unavailable".to_string())?;
    let requested: Vec<String> = hashes.to_vec();
    // Feed the whole request from a worker: `cat-file --batch` interleaves its
    // answers with our queries, so writing and reading from one thread
    // deadlocks as soon as either pipe buffer fills.
    let writer = std::thread::spawn(move || {
        for hash in &requested {
            if writeln!(stdin, "{hash}").is_err() {
                return;
            }
        }
        let _ = stdin.flush();
    });

    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| "git cat-file stdout unavailable".to_string())?,
    );
    let mut header = String::new();
    loop {
        header.clear();
        let read = stdout
            .read_line(&mut header)
            .map_err(|error| format!("read git cat-file: {error}"))?;
        if read == 0 {
            break;
        }
        let line = header.trim_end();
        let mut fields = line.split(' ');
        let (Some(oid), Some(kind), Some(size)) = (fields.next(), fields.next(), fields.next())
        else {
            // "<oid> missing" — two fields, nothing to consume after it.
            continue;
        };
        let size: usize = size
            .parse()
            .map_err(|_| format!("git cat-file returned an unreadable size: {line}"))?;
        let mut bytes = vec![0u8; size];
        stdout
            .read_exact(&mut bytes)
            .map_err(|error| format!("read git object {oid}: {error}"))?;
        // Each record is terminated by a newline outside the payload.
        let mut terminator = [0u8; 1];
        let _ = stdout.read_exact(&mut terminator);
        if kind == "blob" {
            resolved.insert(oid.to_string(), bytes);
        }
    }
    let _ = writer.join();
    let _ = child.wait();
    Ok(resolved)
}

/// `.worktreeinclude` is an explicit escape hatch for ignored local files that
/// are required to initialize an isolated worktree. Each non-comment line is a
/// relative file or directory; globbing is deliberately unsupported so the
/// copied boundary remains reviewable. Known credential paths fail closed.
fn capture_worktree_includes(
    root: &Path,
    entries: &mut BTreeMap<String, SnapshotEntry>,
    blobs: &mut HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    let allowlist = root.join(".worktreeinclude");
    let Ok(text) = fs::read_to_string(&allowlist) else {
        return Ok(());
    };
    for (line_index, raw) in text.lines().enumerate() {
        let value = raw.trim().replace('\\', "/");
        if value.is_empty() || value.starts_with('#') {
            continue;
        }
        let relative = Path::new(&value);
        if relative.is_absolute()
            || value.contains(['*', '?', '[', ']'])
            || relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                ) || matches!(
                    component.as_os_str().to_str(),
                    Some(".git" | "node_modules")
                )
            })
        {
            return Err(format!(
                "invalid .worktreeinclude entry on line {}: {value}",
                line_index + 1
            ));
        }
        let candidate = root.join(relative);
        let canonical = candidate.canonicalize().map_err(|error| {
            format!(
                "resolve .worktreeinclude entry on line {} ({value}): {error}",
                line_index + 1
            )
        })?;
        if !canonical.starts_with(root) {
            return Err(format!(".worktreeinclude entry escapes workspace: {value}"));
        }
        if candidate.is_dir() {
            let mut builder = WalkBuilder::new(&candidate);
            builder
                .hidden(false)
                .git_ignore(false)
                .git_exclude(false)
                .git_global(false)
                .ignore(false)
                .parents(false)
                .follow_links(false);
            for item in builder.build() {
                let item = item.map_err(|error| format!("walk included path {value}: {error}"))?;
                if item.path() == candidate || item.file_type().is_some_and(|kind| kind.is_dir()) {
                    continue;
                }
                capture_included_entry(root, item.path(), entries, blobs)?;
            }
        } else {
            capture_included_entry(root, &candidate, entries, blobs)?;
        }
    }
    Ok(())
}

fn capture_included_entry(
    root: &Path,
    path: &Path,
    entries: &mut BTreeMap<String, SnapshotEntry>,
    blobs: &mut HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    let rel = path
        .strip_prefix(root)
        .map_err(|_| format!("included path escapes workspace: {}", path.display()))?;
    let rel_path = rel.to_string_lossy().replace('\\', "/");
    if is_sensitive_resource(&rel_path) {
        return Err(format!(
            "sensitive path is not allowed in .worktreeinclude: {rel_path}"
        ));
    }
    if rel.components().any(|component| {
        matches!(
            component.as_os_str().to_str(),
            Some(".git" | "node_modules")
        )
    }) {
        return Err(format!(
            "protected path is not allowed in .worktreeinclude: {rel_path}"
        ));
    }
    let metadata = path
        .symlink_metadata()
        .map_err(|error| format!("stat included path {rel_path}: {error}"))?;
    let (kind, bytes) = if metadata.file_type().is_symlink() {
        let target = fs::read_link(path)
            .map_err(|error| format!("read link {}: {error}", path.display()))?;
        validate_symlink_target(rel, &target)?;
        (
            EntryKind::Symlink,
            target.to_string_lossy().as_bytes().to_vec(),
        )
    } else if metadata.is_file() {
        (
            EntryKind::File,
            fs::read(path).map_err(|error| format!("read included path {rel_path}: {error}"))?,
        )
    } else {
        return Ok(());
    };
    let hash = hex::encode(Sha256::digest(&bytes));
    let binary = kind == EntryKind::File && detect_binary(&bytes);
    entries.insert(
        rel_path.clone(),
        SnapshotEntry {
            path: rel_path.clone(),
            kind,
            hash: hash.clone(),
            size: bytes.len() as u64,
            mode: file_mode(path),
            binary,
            media_type: media_type_for(&rel_path, binary).to_string(),
            sensitive: false,
        },
    );
    blobs.entry(hash).or_insert(bytes);
    Ok(())
}

fn capture_generated(
    root: &Path,
    generated_roots: &[String],
) -> Result<BTreeMap<String, GeneratedSnapshotEntry>, String> {
    let mut entries = BTreeMap::new();
    for generated_root in generated_roots {
        let scan_root = root.join(generated_root);
        if !scan_root.exists() {
            continue;
        }
        let canonical = scan_root.canonicalize().map_err(|error| {
            format!(
                "canonicalize generated root {}: {error}",
                scan_root.display()
            )
        })?;
        if !canonical.starts_with(root) {
            return Err(format!(
                "generated output root escapes workspace: {generated_root}"
            ));
        }
        let mut builder = WalkBuilder::new(&scan_root);
        builder
            .hidden(false)
            .git_ignore(false)
            .git_exclude(false)
            .git_global(false)
            .ignore(false)
            .parents(false)
            .follow_links(false);
        for item in builder.build() {
            let entry = item.map_err(|error| format!("walk {}: {error}", scan_root.display()))?;
            let path = entry.path();
            if path == scan_root
                || path
                    .components()
                    .any(|component| component.as_os_str() == "node_modules")
            {
                continue;
            }
            let file_type = entry
                .file_type()
                .ok_or_else(|| format!("missing file type: {}", path.display()))?;
            if file_type.is_dir() {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .map_err(|_| format!("generated path escapes workspace: {}", path.display()))?;
            let rel_path = rel.to_string_lossy().replace('\\', "/");
            let metadata = path
                .symlink_metadata()
                .map_err(|error| format!("stat {}: {error}", path.display()))?;
            let (kind, size) = if file_type.is_symlink() {
                let target = fs::read_link(path)
                    .map_err(|error| format!("read link {}: {error}", path.display()))?;
                validate_symlink_target(rel, &target)?;
                (ResourceKind::Symlink, target.as_os_str().len() as u64)
            } else if file_type.is_file() {
                (ResourceKind::File, metadata.len())
            } else {
                continue;
            };
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as i64);
            entries.insert(
                rel_path.clone(),
                GeneratedSnapshotEntry {
                    path: rel_path.clone(),
                    kind,
                    size,
                    mode: file_mode(path),
                    modified_at,
                    media_type: media_type_for(&rel_path, false).to_string(),
                    sensitive: is_sensitive_resource(&rel_path),
                },
            );
        }
    }
    Ok(entries)
}

fn validate_symlink_target(link_path: &Path, target: &Path) -> Result<(), String> {
    use std::path::Component;
    if target.is_absolute() {
        return Err(format!(
            "symlink escapes workspace: {} -> {}",
            link_path.display(),
            target.display()
        ));
    }
    let mut depth = link_path
        .parent()
        .map_or(0, |parent| parent.components().count());
    for component in target.components() {
        match component {
            Component::ParentDir if depth == 0 => {
                return Err(format!(
                    "symlink escapes workspace: {} -> {}",
                    link_path.display(),
                    target.display()
                ));
            }
            Component::ParentDir => depth -= 1,
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => {
                return Err("absolute symlink target is not allowed".into());
            }
        }
    }
    Ok(())
}

fn excluded(path: &Path, root: &Path, generated_roots: &[String]) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    generated_roots
        .iter()
        .any(|generated| rel.starts_with(generated))
        || rel.components().any(|component| {
            matches!(
                component.as_os_str().to_str(),
                Some(".git" | "node_modules")
            )
        })
}

/// Ref that keeps a Git-backed baseline's commit reachable.
///
/// Named from the execution root so pinning and unpinning can be done from
/// either end without threading a run id through the teardown paths, and so two
/// workspaces cut from the same commit hold independent pins.
fn base_pin_ref(execution_root: &Path) -> String {
    let digest = Sha256::digest(execution_root.to_string_lossy().as_bytes());
    format!("refs/cognia/workspace-base/{}", hex::encode(digest))
}

/// Keep the commit a Git-backed snapshot references alive.
///
/// The snapshot deliberately stores no blobs for unmodified tracked files, so
/// its restore path depends on those objects still being in the repository.
/// Nothing else keeps them there: rewriting history — a rebase, an amend, a
/// branch delete — can leave the captured commit unreachable, and the next
/// `git gc` is then free to collect it, silently breaking a rollback that has
/// already been promised. `git gc` will not touch anything under `refs/`, so a
/// ref is the whole fix.
///
/// Best-effort: a repository that refuses the ref is not a reason to fail an
/// acquisition, and a blob-backed snapshot needs no pin at all.
pub fn pin_snapshot_base(workspace_root: &Path, execution_root: &Path, snapshot: &WorkspaceSnapshot) {
    let SnapshotBase::GitCommit { commit } = &snapshot.base else {
        return;
    };
    let _ = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(["update-ref", &base_pin_ref(execution_root), commit])
        .status();
}

/// Drop the pin created by [`pin_snapshot_base`]. Safe to call for a workspace
/// that never had one.
pub fn unpin_snapshot_base(workspace_root: &Path, execution_root: &Path) {
    let _ = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(["update-ref", "-d", &base_pin_ref(execution_root)])
        .status();
}

/// Bring a worktree that Git has just checked out at the snapshot's commit into
/// the exact state the snapshot describes.
///
/// The counterpart to `materialize` for a `SnapshotBase::GitCommit` snapshot.
/// `materialize` writes every entry from a blob, which for a Git-backed
/// snapshot would mean pulling the whole tree back out of Git only to overwrite
/// files Git had already written correctly. The checkout is the baseline; all
/// that is left is the difference between it and the working state that was
/// captured:
///
///   * entries whose bytes came with the snapshot — the files that were dirty
///     or untracked at capture — are written over the checkout;
///   * paths the commit contains but the snapshot does not are deleted, because
///     they had been removed from the working tree before capture.
///
/// Returns `Ok(false)` when `snapshot` has no Git base, leaving the caller to
/// fall back to `materialize`.
pub fn apply_git_overlay(
    root: &Path,
    snapshot: &WorkspaceSnapshot,
    blobs: &HashMap<String, Vec<u8>>,
    policy: &ResourceTrackingPolicy,
) -> Result<bool, String> {
    let SnapshotBase::GitCommit { commit } = &snapshot.base else {
        return Ok(false);
    };
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize root {}: {error}", root.display()))?;
    let Some(listing) = git_stdout(
        &canonical_root,
        &["ls-tree", "-r", "--name-only", "-z", commit],
    ) else {
        return Ok(false);
    };

    // Delete what the checkout has but the captured working state did not.
    // `excluded` has to be consulted here for the same reason capture consults
    // it: a tracked file living under a generated-output root never enters the
    // entry map, and deleting it because it is "not in the snapshot" would
    // destroy real content.
    for path in listing.split(|byte| *byte == 0) {
        if path.is_empty() {
            continue;
        }
        let Ok(path) = std::str::from_utf8(path) else {
            continue;
        };
        if snapshot.entries.contains_key(path) {
            continue;
        }
        let absolute = canonical_root.join(path);
        if excluded(&absolute, &canonical_root, &policy.generated_output_roots) {
            continue;
        }
        if absolute.symlink_metadata().is_ok() {
            fs::remove_file(&absolute)
                .map_err(|error| format!("remove {}: {error}", absolute.display()))?;
        }
    }

    // Write back the entries that were not identical to the commit.
    for entry in snapshot.entries.values() {
        let Some(bytes) = blobs.get(&entry.hash) else {
            continue;
        };
        let target = canonical_root.join(PathBuf::from(&entry.path));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        match entry.kind {
            EntryKind::File => {
                fs::write(&target, bytes)
                    .map_err(|error| format!("write {}: {error}", target.display()))?;
                apply_mode(&target, entry.mode)?;
            }
            EntryKind::Symlink => {
                // The checkout may already hold a symlink here; `symlink(2)`
                // refuses to replace an existing path.
                let _ = fs::remove_file(&target);
                create_symlink(&target, bytes)?;
            }
        }
    }
    Ok(true)
}

pub fn materialize(
    root: &Path,
    snapshot: &WorkspaceSnapshot,
    blobs: &HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    let _perf = cognia_instrument::guard("workspace.snapshot_materialize");
    fs::create_dir_all(root).map_err(|error| format!("create {}: {error}", root.display()))?;
    for entry in snapshot.entries.values() {
        let target = root.join(PathBuf::from(&entry.path));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        let bytes = blobs
            .get(&entry.hash)
            .ok_or_else(|| format!("missing blob {}", entry.hash))?;
        match entry.kind {
            EntryKind::File => {
                fs::write(&target, bytes)
                    .map_err(|error| format!("write {}: {error}", target.display()))?;
                apply_mode(&target, entry.mode)?;
            }
            EntryKind::Symlink => create_symlink(&target, bytes)?,
        }
    }
    Ok(())
}

pub fn detect_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    sample.contains(&0) || std::str::from_utf8(sample).is_err()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Count of observations recorded for `name`, or 0 if the span is unknown.
    ///
    /// Deliberately reads a delta rather than calling `REGISTRY.reset()`: the
    /// registry is a process-global shared by every test in this crate, and
    /// resetting it would race with whatever else is mid-flight.
    fn span_count(name: &str) -> u64 {
        cognia_instrument::registry::REGISTRY
            .snapshot()
            .iter()
            .find(|row| row.name == name)
            .map(|row| row.count)
            .unwrap_or(0)
    }

    /// A repository with one committed file and whatever `extra` adds.
    fn git_fixture(extra: impl FnOnce(&Path)) -> TempDir {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let run = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        run(&["init", "--quiet", "--initial-branch=main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test User"]);
        run(&["config", "commit.gpgsign", "false"]);
        fs::write(root.join("tracked.txt"), "committed\n").unwrap();
        fs::write(root.join("also.txt"), "second\n").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "--quiet", "-m", "initial"]);
        extra(root);
        dir
    }

    /// Resolved target of a ref, or empty when it does not exist.
    ///
    /// `rev-parse` alone is no good here: given a ref that is absent it echoes
    /// the argument back and exits non-zero, so a naive stdout read reports the
    /// ref name as though it were an object id.
    fn git_ref_target(root: &Path, name: &str) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["rev-parse", "--verify", "--quiet", name])
            .output()
            .unwrap();
        if !out.status.success() {
            return String::new();
        }
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn git_oid_of(root: &Path, rev: &str) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["rev-parse", rev])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// The point of the whole exercise: a clean checkout costs no blobs. If
    /// this regresses, the capture has silently gone back to reading the tree.
    #[test]
    fn git_capture_stores_no_blobs_for_unmodified_tracked_files() {
        let dir = git_fixture(|_| {});
        let (snapshot, blobs) = capture(dir.path()).unwrap();

        assert!(matches!(snapshot.base, SnapshotBase::GitCommit { .. }));
        assert!(snapshot.entries.contains_key("tracked.txt"));
        assert!(snapshot.entries.contains_key("also.txt"));
        assert!(
            blobs.is_empty(),
            "a clean worktree must not copy content Git already holds, got {:?}",
            blobs.keys().collect::<Vec<_>>()
        );
    }

    /// Entry hashes must be Git blob ids, not a private digest — `reconcile`
    /// pairs a delete with an add by hash equality to report a rename, so a
    /// clean file and a modified one have to live in the same hash space.
    #[test]
    fn git_capture_hashes_match_git_blob_ids_on_both_sides() {
        let dir = git_fixture(|root| {
            fs::write(root.join("tracked.txt"), "changed\n").unwrap();
        });
        let (snapshot, blobs) = capture(dir.path()).unwrap();

        // Clean file: the id straight out of the tree.
        assert_eq!(
            snapshot.entries["also.txt"].hash,
            git_oid_of(dir.path(), "HEAD:also.txt")
        );
        // Dirty file: hashed by us, and it is the id Git would have given it.
        let dirty = &snapshot.entries["tracked.txt"];
        assert_eq!(
            dirty.hash,
            git_blob_hash(b"changed\n", git2::ObjectFormat::Sha1).unwrap()
        );
        assert_ne!(
            dirty.hash,
            git_oid_of(dir.path(), "HEAD:tracked.txt"),
            "the committed id must not be reused for modified content"
        );
        assert_eq!(
            blobs.get(&dirty.hash).map(Vec::as_slice),
            Some(&b"changed\n"[..])
        );
    }

    /// A file removed from the working tree must leave the entry list, or a
    /// later settle reads the absence back as a fresh deletion.
    #[test]
    fn git_capture_drops_files_deleted_in_the_working_tree() {
        let dir = git_fixture(|root| {
            fs::remove_file(root.join("also.txt")).unwrap();
        });
        let (snapshot, _) = capture(dir.path()).unwrap();

        assert!(snapshot.entries.contains_key("tracked.txt"));
        assert!(!snapshot.entries.contains_key("also.txt"));
    }

    #[test]
    fn git_capture_includes_untracked_files_with_their_bytes() {
        let dir = git_fixture(|root| {
            fs::write(root.join("new.txt"), "fresh\n").unwrap();
        });
        let (snapshot, blobs) = capture(dir.path()).unwrap();

        let entry = &snapshot.entries["new.txt"];
        assert_eq!(blobs.get(&entry.hash).map(Vec::as_slice), Some(&b"fresh\n"[..]));
    }

    /// A directory that is not a repository keeps the original behaviour.
    /// A tracked file that `.gitignore` also matches is part of the repository
    /// whether or not the ignore rules mention it, and Git-backed capture
    /// reports it. The filesystem walk this replaced skipped such files,
    /// because it judged them by the ignore rules alone and never knew what was
    /// tracked — so a task editing one produced no change record at all.
    ///
    /// Intentional and pinned here: the entry list is a baseline for restoring
    /// a workspace and attributing edits, and committed content belongs in it.
    #[test]
    fn git_capture_includes_tracked_files_that_gitignore_also_matches() {
        let dir = git_fixture(|root| {
            fs::write(root.join(".gitignore"), "generated.log\n").unwrap();
            fs::write(root.join("generated.log"), "kept\n").unwrap();
            for args in [
                &["add", "-A", "-f"][..],
                &["commit", "--quiet", "-m", "track an ignored path"][..],
            ] {
                std::process::Command::new("git")
                    .arg("-C")
                    .arg(root)
                    .args(args)
                    .output()
                    .unwrap();
            }
        });
        let (snapshot, _) = capture(dir.path()).unwrap();
        assert!(
            snapshot.entries.contains_key("generated.log"),
            "a tracked path must appear even when the ignore rules match it"
        );
    }

    /// The pin is what stands between a promised rollback and a user's
    /// `git gc`: a Git-backed baseline keeps no copy of unmodified content, so
    /// its commit must stay reachable on its own.
    #[test]
    fn pinning_keeps_the_baseline_commit_reachable_and_unpinning_releases_it() {
        let dir = git_fixture(|_| {});
        let (snapshot, _) = capture(dir.path()).unwrap();
        let SnapshotBase::GitCommit { commit } = &snapshot.base else {
            panic!("expected a git base");
        };
        let execution_root = dir.path().join(".cognia/worktrees/run-1");
        let pin = base_pin_ref(&execution_root);

        pin_snapshot_base(dir.path(), &execution_root, &snapshot);
        assert_eq!(&git_ref_target(dir.path(), &pin), commit);

        unpin_snapshot_base(dir.path(), &execution_root);
        assert!(
            git_ref_target(dir.path(), &pin).is_empty(),
            "the pin must be gone once the workspace is torn down"
        );
    }

    /// A blob-backed snapshot carries its own content and needs no pin — and
    /// must not leave a dangling ref behind.
    #[test]
    fn pinning_is_a_no_op_for_a_blob_backed_snapshot() {
        let dir = git_fixture(|_| {});
        let blob_backed = WorkspaceSnapshot::default();
        let execution_root = dir.path().join(".cognia/worktrees/run-2");

        pin_snapshot_base(dir.path(), &execution_root, &blob_backed);
        assert!(git_ref_target(dir.path(), &base_pin_ref(&execution_root)).is_empty());
    }

    #[test]
    fn non_git_capture_stays_blob_backed() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        let (snapshot, blobs) = capture(dir.path()).unwrap();

        assert_eq!(snapshot.base, SnapshotBase::Blobs);
        assert_eq!(blobs.len(), 1);
    }

    /// Git is the second tier of the blob store for these snapshots, so the
    /// bytes of a file nobody copied must still be reachable.
    #[test]
    fn git_read_blobs_resolves_unmodified_content() {
        let dir = git_fixture(|_| {});
        let (snapshot, _) = capture(dir.path()).unwrap();
        let hash = snapshot.entries["tracked.txt"].hash.clone();

        let resolved = git_read_blobs(dir.path(), &[hash.clone()]).unwrap();
        assert_eq!(resolved.get(&hash).map(Vec::as_slice), Some(&b"committed\n"[..]));
    }

    #[test]
    fn git_read_blobs_omits_objects_the_repository_does_not_have() {
        let dir = git_fixture(|_| {});
        let absent = "0".repeat(40);
        let resolved = git_read_blobs(dir.path(), &[absent.clone()]).unwrap();
        assert!(resolved.is_empty());
    }

    /// The overlay is what replaces "empty the tree and rewrite every file".
    #[test]
    fn git_overlay_restores_modifications_and_deletions_onto_a_checkout() {
        let source = git_fixture(|root| {
            fs::write(root.join("tracked.txt"), "changed\n").unwrap();
            fs::remove_file(root.join("also.txt")).unwrap();
            fs::write(root.join("new.txt"), "fresh\n").unwrap();
        });
        let (snapshot, blobs) = capture(source.path()).unwrap();

        // Stand in for the worktree Git checks out at the snapshot's commit.
        let checkout = TempDir::new().unwrap();
        let SnapshotBase::GitCommit { commit } = &snapshot.base else {
            panic!("expected a git base");
        };
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(source.path())
            .arg("worktree")
            .arg("add")
            .arg("--detach")
            .arg(checkout.path().join("wt"))
            .arg(commit)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "worktree add failed");
        let wt = checkout.path().join("wt");

        // Straight from the commit, before the overlay.
        assert_eq!(fs::read_to_string(wt.join("tracked.txt")).unwrap(), "committed\n");
        assert!(wt.join("also.txt").exists());

        let applied = apply_git_overlay(
            &wt,
            &snapshot,
            &blobs,
            &ResourceTrackingPolicy {
                generated_output_roots: Vec::new(),
                auto_detect: false,
            },
        )
        .unwrap();

        assert!(applied);
        assert_eq!(fs::read_to_string(wt.join("tracked.txt")).unwrap(), "changed\n");
        assert_eq!(fs::read_to_string(wt.join("new.txt")).unwrap(), "fresh\n");
        assert!(!wt.join("also.txt").exists(), "deletion must be replayed");
    }

    #[test]
    fn git_overlay_declines_a_blob_backed_snapshot() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        let (snapshot, blobs) = capture(dir.path()).unwrap();

        let applied = apply_git_overlay(
            dir.path(),
            &snapshot,
            &blobs,
            &ResourceTrackingPolicy {
                generated_output_roots: Vec::new(),
                auto_detect: false,
            },
        )
        .unwrap();
        assert!(!applied, "a blob-backed snapshot must fall back to materialize");
    }

    /// Batch 2 rewrites `capture_with_policy` to stop reading the whole tree.
    /// This pins the span across that rewrite: without it the optimisation
    /// could land together with the loss of the only number proving it worked.
    #[test]
    fn capture_records_a_span() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("a.txt"), "a\n").unwrap();

        let before = span_count("workspace.snapshot_capture");
        capture(root.path()).unwrap();
        assert!(
            span_count("workspace.snapshot_capture") > before,
            "capture_with_policy must record workspace.snapshot_capture"
        );
    }

    #[test]
    fn materialize_records_a_span() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("a.txt"), "a\n").unwrap();
        let (snapshot, blobs) = capture(root.path()).unwrap();

        let restored = TempDir::new().unwrap();
        let before = span_count("workspace.snapshot_materialize");
        materialize(restored.path(), &snapshot, &blobs).unwrap();
        assert!(
            span_count("workspace.snapshot_materialize") > before,
            "materialize must record workspace.snapshot_materialize"
        );
    }

    #[test]
    fn captures_conventionally_named_directories_when_policy_does_not_classify_them() {
        let root = TempDir::new().unwrap();
        fs::create_dir(root.path().join("dist")).unwrap();
        fs::write(
            root.path().join("dist/source.ts"),
            "export const source = true;\n",
        )
        .unwrap();

        let (snapshot, _) = capture(root.path()).unwrap();
        assert!(snapshot.entries.contains_key("dist/source.ts"));
        assert!(snapshot.generated_entries.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn capture_rejects_symlinks_that_escape_the_workspace() {
        use std::os::unix::fs::symlink;
        let root = TempDir::new().unwrap();
        symlink("../../outside", root.path().join("escape")).unwrap();
        assert!(capture(root.path())
            .unwrap_err()
            .contains("escapes workspace"));
    }

    #[test]
    fn worktree_include_copies_ignored_files_but_rejects_credentials() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join(".gitignore"), "local/\n.env.local\n").unwrap();
        fs::create_dir(root.path().join("local")).unwrap();
        fs::write(root.path().join("local/toolchain.json"), "{}\n").unwrap();
        fs::write(
            root.path().join(".worktreeinclude"),
            "local/toolchain.json\n",
        )
        .unwrap();

        let (snapshot, _) = capture(root.path()).unwrap();
        assert!(snapshot.entries.contains_key("local/toolchain.json"));

        fs::write(root.path().join(".env.local"), "TOKEN=secret\n").unwrap();
        fs::write(root.path().join(".worktreeinclude"), ".env.local\n").unwrap();
        assert!(capture(root.path())
            .unwrap_err()
            .contains("sensitive path is not allowed"));
    }
}

#[cfg(windows)]
fn create_symlink(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::windows::fs::symlink_file;
    let target =
        String::from_utf8(bytes.to_vec()).map_err(|_| "invalid symlink target".to_string())?;
    symlink_file(target, path).map_err(|error| format!("symlink {}: {error}", path.display()))
}

