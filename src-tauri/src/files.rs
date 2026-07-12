// File-system commands used by Skills and MCP import/export and the
// "import from Claude Code" compatibility flows. Kept separate from the
// chat sidecar commands because they're sync, simple, and have no shared
// state beyond the filesystem.

use gray_matter::{engine::YAML, Matter, Pod};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

// ---------------------------------------------------------------------------
// Allowed-roots registry (ADR-0028 follow-up) + shadow-mode containment.
//
// The raw `read_text_file` / `write_text_file` / `ensure_dir` commands accept an
// arbitrary absolute path and are reachable from BOTH the renderer and a paired
// remote device (companion RPC re-dispatches them — see companion_api/rpc.rs).
// Neither caller is authoritative, so the path must be gated in Rust.
//
// This process-global set (modelled on `hooks::trust`) holds the directories the
// app legitimately touches: appdata, the home config trees, the user's
// documents dir (seeded at startup), the active workspace roots (pushed by the
// renderer), and dialog-chosen directories (registered on the user gesture).
//
// SHADOW MODE: every raw fs op evaluates containment and LOGS a denial for any
// path outside the registered roots, but STILL proceeds. This surfaces the
// real-world out-of-root accesses before a later release flips the log into a
// hard `Err`, so legitimate flows that touch an unseeded directory are observed
// (and their root registered) rather than silently broken.
// ---------------------------------------------------------------------------

fn allowed_roots_registry() -> &'static RwLock<HashSet<String>> {
    static REG: OnceLock<RwLock<HashSet<String>>> = OnceLock::new();
    REG.get_or_init(|| RwLock::new(HashSet::new()))
}

/// Normalize a root to a stable key: trim, unify separators to `/`, drop a
/// trailing slash (mirrors `hooks::trust::normalize`).
fn normalize_root(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

/// Add one directory to the allowed-roots set (idempotent). Additive: seeds and
/// previously-registered roots are never removed (shadow mode never enforces, so
/// over-permissiveness only means fewer log lines, never a broken flow).
pub fn add_allowed_root(path: String) {
    let key = normalize_root(&path);
    if key.is_empty() {
        return;
    }
    if let Ok(mut guard) = allowed_roots_registry().write() {
        guard.insert(key);
    }
}

/// Add the active workspace roots the renderer pushes. Additive (see above).
pub fn set_allowed_roots(paths: Vec<String>) {
    for p in paths {
        add_allowed_root(p);
    }
}

/// Seed the structurally-trusted directories at startup: appdata, the home
/// config trees Claude Code / Codex / Gemini read & write, and the documents dir
/// (the default export target). Called once from `lib.rs` `.setup`.
pub fn seed_default_allowed_roots() {
    if let Some(data) = dirs::data_dir() {
        add_allowed_root(data.join("cognia").to_string_lossy().to_string());
    }
    if let Some(home) = dirs::home_dir() {
        for sub in [".claude", ".codex", ".gemini"] {
            add_allowed_root(home.join(sub).to_string_lossy().to_string());
        }
    }
    if let Some(docs) = dirs::document_dir() {
        add_allowed_root(docs.to_string_lossy().to_string());
    }
}

/// Snapshot the registered roots for a containment check.
fn allowed_roots_snapshot() -> Vec<String> {
    allowed_roots_registry()
        .read()
        .map(|g| g.iter().cloned().collect())
        .unwrap_or_default()
}

/// Read-only containment check against the live registry.
fn is_path_allowed(path: &str) -> bool {
    is_path_within_roots(path, &allowed_roots_snapshot())
}

/// Pure containment check: does `path` resolve inside one of `roots`? Never
/// creates directories. Resolves the deepest EXISTING ancestor and canonicalizes
/// it (so symlinks in the ancestry are followed — the real guard a lexical check
/// can't provide). Empty `roots` returns `true` so shadow mode never floods logs
/// before startup seeding runs.
fn is_path_within_roots(path: &str, roots: &[String]) -> bool {
    let canonical_roots = canonicalize_roots(roots);
    if canonical_roots.is_empty() {
        return true;
    }
    let target = PathBuf::from(path);
    let mut probe: &Path = target.as_path();
    let canonical = loop {
        if let Ok(c) = probe.canonicalize() {
            break c;
        }
        match probe.parent() {
            Some(p) if !p.as_os_str().is_empty() => probe = p,
            _ => return false,
        }
    };
    starts_with_any_canonical_root(&canonical, &canonical_roots)
}

/// Origin of a raw fs command. `Local` = the renderer (a trusted user gesture —
/// typically a file dialog — stands in for the fs scope). `Remote` = a paired
/// device over the companion API, which has no such gesture and is the real
/// exfil / backdoor-write surface.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FsOrigin {
    Local,
    Remote,
}

/// Containment gate for the raw fs commands. Remote WRITES that escape the
/// registered roots are ENFORCED (hard `Err`) — closing the documented hole
/// where a paired device could read/write anywhere the desktop can. Local calls
/// (backed by a user gesture) and all READS stay in shadow mode: logged, never
/// blocked, so existing local flows are unaffected. An empty registry allows
/// everything (never blocks before startup seeding runs).
fn enforce_check_path(path: &str, op: &str, origin: FsOrigin) -> Result<(), String> {
    if is_path_allowed(path) {
        return Ok(());
    }
    let is_write = matches!(op, "write_text_file" | "ensure_dir");
    if origin == FsOrigin::Remote && is_write {
        log::warn!("fs_enforce_denial op={op} path={path} origin=remote — outside registered roots (blocked)");
        return Err(format!(
            "{op}: path is outside the workspace roots this device may write to: {path}"
        ));
    }
    log::warn!(
        "fs_shadow_denial op={op} path={path} origin={origin:?} — outside registered roots (allowed in shadow mode)"
    );
    Ok(())
}

/// Register a dialog-chosen path so a subsequent confined/raw write to it is
/// inside an allowed root. For a directory the dir itself is registered; for a
/// file (or a not-yet-created save target) its containing directory is.
#[tauri::command]
pub fn fs_allow_dialog_path(path: String) {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        add_allowed_root(path);
    } else if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            add_allowed_root(parent.to_string_lossy().to_string());
        }
    }
}

/// Replace/extend the registered workspace roots from the renderer's active
/// project. Called whenever `Project.roots` change.
#[tauri::command]
pub fn fs_set_allowed_roots(paths: Vec<String>) {
    set_allowed_roots(paths);
}

/// Read a text file at the given absolute path. The frontend uses this
/// after letting the user pick the path via the dialog plugin — that
/// user gesture stands in for an fs scope. Shadow-mode containment logs (but
/// does not yet block) reads outside the registered roots.
///
/// `async` + `spawn_blocking`: Tauri dispatches sync commands on the main
/// (UI) thread, so a large or slow-FS read would freeze the webview. The
/// blocking work runs on the blocking pool; `read_text_file_impl` holds the
/// actual sync logic so tests and the companion RPC path can call it directly.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || read_text_file_impl(path, FsOrigin::Local))
        .await
        .map_err(|e| format!("read_text_file task failed: {e}"))?
}

pub(crate) fn read_text_file_impl(path: String, origin: FsOrigin) -> Result<String, String> {
    enforce_check_path(&path, "read_text_file", origin)?;
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path, e))
}

/// Write a text file at the given absolute path, creating parent
/// directories as needed. Shadow-mode containment logs out-of-root writes.
/// Runs off the UI thread (see [`read_text_file`]).
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || write_text_file_impl(path, content, FsOrigin::Local))
        .await
        .map_err(|e| format!("write_text_file task failed: {e}"))?
}

pub(crate) fn write_text_file_impl(
    path: String,
    content: String,
    origin: FsOrigin,
) -> Result<(), String> {
    enforce_check_path(&path, "write_text_file", origin)?;
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
    }
    std::fs::write(&p, content).map_err(|e| format!("write {}: {}", path, e))
}

/// Ensure a directory exists, creating it (and parents) if needed.
/// Shadow-mode containment logs out-of-root directory creation. Runs off the
/// UI thread (see [`read_text_file`]).
#[tauri::command]
pub async fn ensure_dir(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || ensure_dir_impl(path, FsOrigin::Local))
        .await
        .map_err(|e| format!("ensure_dir task failed: {e}"))?
}

pub(crate) fn ensure_dir_impl(path: String, origin: FsOrigin) -> Result<(), String> {
    enforce_check_path(&path, "ensure_dir", origin)?;
    std::fs::create_dir_all(&path).map_err(|e| format!("mkdir {}: {}", path, e))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiscoveredSkill {
    /// Skill directory name (one level under `~/.claude/skills/`).
    pub dir_name: String,
    /// Absolute path to the SKILL.md file.
    pub file_path: String,
    /// Raw file contents — the frontend parses frontmatter itself.
    pub content: String,
}

/// Walk `~/.claude/skills/*/SKILL.md` and return the discoverable skill
/// files. Returns an empty list when the directory doesn't exist. Runs off the
/// UI thread — the directory walk + per-skill reads can be slow (see
/// [`read_text_file`]); `scan_claude_skills_impl` holds the sync logic.
#[tauri::command]
pub async fn scan_claude_skills() -> Result<Vec<DiscoveredSkill>, String> {
    tokio::task::spawn_blocking(scan_claude_skills_impl)
        .await
        .map_err(|e| format!("scan_claude_skills task failed: {e}"))?
}

pub(crate) fn scan_claude_skills_impl() -> Result<Vec<DiscoveredSkill>, String> {
    let Some(home) = dirs::home_dir() else {
        return Err("could not resolve home directory".into());
    };
    let skills_root = home.join(".claude").join("skills");
    if !skills_root.is_dir() {
        return Ok(vec![]);
    }
    let mut out: Vec<DiscoveredSkill> = vec![];
    let entries = std::fs::read_dir(&skills_root)
        .map_err(|e| format!("read_dir {}: {}", skills_root.display(), e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let dir_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let content = match std::fs::read_to_string(&skill_md) {
            Ok(c) => c,
            Err(_) => continue,
        };
        out.push(DiscoveredSkill {
            dir_name,
            file_path: skill_md.to_string_lossy().to_string(),
            content,
        });
    }
    out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    Ok(out)
}

/// Read the user-level Claude Code config at `~/.claude.json`. Used to
/// import its `mcpServers` block. Returns an empty object when the file
/// doesn't exist so the UI can show "no servers found" cleanly.
#[tauri::command]
pub async fn read_claude_user_config() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(read_claude_user_config_impl)
        .await
        .map_err(|e| format!("read_claude_user_config task failed: {e}"))?
}

pub(crate) fn read_claude_user_config_impl() -> Result<serde_json::Value, String> {
    let Some(home) = dirs::home_dir() else {
        return Err("could not resolve home directory".into());
    };
    let candidate = home.join(".claude.json");
    if !candidate.is_file() {
        return Ok(serde_json::json!({}));
    }
    let raw = std::fs::read_to_string(&candidate)
        .map_err(|e| format!("read {}: {}", candidate.display(), e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {}", candidate.display(), e))
}

/// Convenience used by Sync export/import — resolve a sensible default
/// directory for save dialogs (the user's documents folder).
#[tauri::command]
pub fn default_export_dir() -> Result<String, String> {
    let dir = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "could not resolve documents/home directory".to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Composer features: workspace search, slash command discovery, memory append.
// Used by the @file/folder picker, /command popover, and # memory shortcut in
// the chat composer. All paths are resolved relative to a caller-supplied root
// (typically the active session.cwd).
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceEntry {
    /// Path relative to the search root, using forward slashes regardless of
    /// the host OS so it can be embedded directly in a prompt as `@<rel>`.
    pub rel_path: String,
    pub absolute_path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Last-modified time in milliseconds since the Unix epoch. `None` when the
    /// platform/filesystem can't report it. Powers the file-tree browser.
    pub mtime_ms: Option<u64>,
}

/// Single-path metadata for the workspace file-tree browser. Mirrors the fields
/// a client needs to render a node without a full directory listing.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceStat {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: Option<u64>,
}

/// Milliseconds-since-epoch of a file's mtime, or `None` when unavailable.
fn mtime_ms_of(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// Sort workspace entries for a file-tree listing: directories first, then by
/// case-insensitive basename.
fn sort_dir_listing(entries: &mut [WorkspaceEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| {
            let an = a
                .rel_path
                .rsplit('/')
                .next()
                .unwrap_or(&a.rel_path)
                .to_lowercase();
            let bn = b
                .rel_path
                .rsplit('/')
                .next()
                .unwrap_or(&b.rel_path)
                .to_lowercase();
            an.cmp(&bn)
        })
    });
}

/// Resolve `root`/`rel_path` for a workspace-sandboxed op and verify containment.
/// `must_exist=true` canonicalizes the target itself (following a symlinked final
/// component so the *real* location is range-checked); `false` canonicalizes the
/// deepest existing ancestor (the target may not exist yet — mkdir / rename +
/// copy destinations). Returns `(canonical_root, joined_target)`; callers operate
/// on `joined_target`.
fn resolve_workspace_target(
    root: &str,
    rel_path: &str,
    must_exist: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let root_path = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("canonicalize root {}: {}", root, e))?;
    let target = root_path.join(rel_path);
    let check = if must_exist {
        target
            .canonicalize()
            .map_err(|e| format!("canonicalize {}: {}", target.display(), e))?
    } else {
        canonicalize_deepest_existing_ancestor(&target)?
    };
    if !check.starts_with(&root_path) {
        return Err(format!(
            "path escapes workspace: {} (root {})",
            check.display(),
            root_path.display()
        ));
    }
    Ok((root_path, target))
}

const SEARCH_HARD_LIMIT: usize = 200;
const SEARCH_MAX_DEPTH: usize = 12;

/// Walk `root` (respecting `.gitignore` + the standard ignore set) and return
/// up to `limit` entries whose path contains `query`. Empty `query` returns the
/// first `limit` entries found in walk order. Sorting puts directories before
/// files and prefix matches before substring matches.
#[tauri::command]
pub fn fs_search_workspace(
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("root is not a directory: {}", root));
    }
    let cap = limit.unwrap_or(50).min(SEARCH_HARD_LIMIT);
    let needle = query.to_lowercase();
    let mut out: Vec<WorkspaceEntry> = Vec::new();

    let walker = WalkBuilder::new(&root_path)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .require_git(false)
        .max_depth(Some(SEARCH_MAX_DEPTH))
        .build();

    for dent in walker.flatten() {
        if dent.depth() == 0 {
            continue;
        }
        let path = dent.path();
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if !needle.is_empty() && !rel_str.to_lowercase().contains(&needle) {
            continue;
        }
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let meta = dent.metadata().ok();
        let size = if is_dir {
            0
        } else {
            meta.as_ref().map(|m| m.len()).unwrap_or(0)
        };
        let mtime_ms = meta.as_ref().and_then(mtime_ms_of);
        out.push(WorkspaceEntry {
            rel_path: rel_str,
            absolute_path: path.to_string_lossy().to_string(),
            is_dir,
            size,
            mtime_ms,
        });
        if out.len() >= cap * 4 {
            // gather extra so we can rank, but stop walking eventually
            break;
        }
    }

    rank_search_results(&mut out, &needle);
    out.truncate(cap);
    Ok(out)
}

/// Sort `entries` so the most relevant rows come first.
/// Order: prefix-match-name > prefix-match-path > directories > shorter path.
fn rank_search_results(entries: &mut [WorkspaceEntry], needle_lower: &str) {
    entries.sort_by(|a, b| {
        let score = |e: &WorkspaceEntry| -> u32 {
            let mut s = 0u32;
            if !needle_lower.is_empty() {
                let lower = e.rel_path.to_lowercase();
                let basename = lower.rsplit('/').next().unwrap_or(&lower).to_string();
                if basename.starts_with(needle_lower) {
                    s += 100;
                }
                if lower.starts_with(needle_lower) {
                    s += 50;
                }
            }
            if e.is_dir {
                s += 10;
            }
            // Penalty for deeper paths so shallow files float up.
            s = s.saturating_sub(e.rel_path.matches('/').count() as u32);
            s
        };
        score(b)
            .cmp(&score(a))
            .then_with(|| a.rel_path.len().cmp(&b.rel_path.len()))
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
}

/// A single content-search hit inside a workspace file.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceContentMatch {
    /// Path relative to the search root, forward-slashed.
    pub rel_path: String,
    pub absolute_path: String,
    /// 1-based line number of the match.
    pub line: u32,
    /// 1-based column (char offset) where the match starts on that line.
    pub column: u32,
    /// The matching line, trimmed to `CONTENT_PREVIEW_MAX` chars.
    pub preview: String,
}

const CONTENT_SEARCH_MAX_MATCHES: usize = 500;
/// Skip files larger than this (bytes) — they are almost always generated or
/// binary and would dominate the walk.
const CONTENT_SEARCH_MAX_FILE_BYTES: u64 = 2_000_000;
const CONTENT_PREVIEW_MAX: usize = 400;

/// Project-wide content search. Walks `root` (respecting `.gitignore` + the
/// standard ignore set, like `fs_search_workspace`), reads each UTF-8 text
/// file, and returns up to `max_results` line matches for `query`.
///
/// `is_regex` interprets `query` as a Rust regex (invalid patterns error out);
/// otherwise it is matched literally. `case_sensitive` defaults to false.
///
/// The `root` is validated as a directory; individual files are range-safe by
/// construction (we only read paths yielded by the walker under `root`). Binary
/// / non-UTF-8 / oversized files are skipped silently.
#[tauri::command]
pub fn fs_search_content_workspace(
    root: String,
    query: String,
    is_regex: Option<bool>,
    case_sensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<Vec<WorkspaceContentMatch>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("root is not a directory: {}", root));
    }
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let cap = max_results
        .unwrap_or(CONTENT_SEARCH_MAX_MATCHES)
        .min(CONTENT_SEARCH_MAX_MATCHES);
    let case_sensitive = case_sensitive.unwrap_or(false);

    let pattern = if is_regex.unwrap_or(false) {
        query.clone()
    } else {
        regex::escape(&query)
    };
    let matcher = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("invalid search pattern: {}", e))?;

    let walker = WalkBuilder::new(&root_path)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .require_git(false)
        .max_depth(Some(SEARCH_MAX_DEPTH))
        .build();

    let mut out: Vec<WorkspaceContentMatch> = Vec::new();
    'walk: for dent in walker.flatten() {
        if dent.depth() == 0 {
            continue;
        }
        let file_type = dent.file_type();
        // Skip directories AND symlinks: `read_to_string` would follow a
        // symlink and read a target that may resolve OUTSIDE `root`, escaping
        // the sandbox (the size guard sees the link's own size, not the
        // target's). Real files only.
        if file_type
            .map(|t| t.is_dir() || t.is_symlink())
            .unwrap_or(true)
        {
            continue;
        }
        let path = dent.path();
        if dent.metadata().ok().map(|m| m.len()).unwrap_or(0) > CONTENT_SEARCH_MAX_FILE_BYTES {
            continue;
        }
        let contents = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue, // binary / non-UTF-8 / unreadable → skip
        };
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let abs = path.to_string_lossy().to_string();
        for (idx, raw_line) in contents.lines().enumerate() {
            if let Some(m) = matcher.find(raw_line) {
                // 1-based char column of the match start.
                let column = raw_line[..m.start()].chars().count() as u32 + 1;
                let preview: String = raw_line.chars().take(CONTENT_PREVIEW_MAX).collect();
                out.push(WorkspaceContentMatch {
                    rel_path: rel.clone(),
                    absolute_path: abs.clone(),
                    line: idx as u32 + 1,
                    column,
                    preview,
                });
                if out.len() >= cap {
                    break 'walk;
                }
            }
        }
    }

    Ok(out)
}

/// Read a text file inside a workspace, with a sandboxed path-traversal check.
/// `rel_path` is joined to `root` and must canonicalize back inside `root`.
#[tauri::command]
pub fn fs_read_workspace_file(
    root: String,
    rel_path: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let root_path = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("canonicalize root {}: {}", root, e))?;
    let target = root_path.join(&rel_path);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", target.display(), e))?;
    if !canonical.starts_with(&root_path) {
        return Err(format!(
            "path escapes workspace: {} (root {})",
            canonical.display(),
            root_path.display()
        ));
    }
    let limit = max_bytes.unwrap_or(256 * 1024);
    let mut content =
        std::fs::read_to_string(&canonical).map_err(|e| format!("read {}: {}", rel_path, e))?;
    if content.len() > limit {
        content.truncate(limit);
        content.push_str("\n... (truncated)");
    }
    Ok(content)
}

/// Write a text file inside a workspace, with the same sandboxed path-traversal
/// check as [`fs_read_workspace_file`]. `rel_path` is joined to `root`; parent
/// directories are created as needed, and the resolved parent must canonicalize
/// back inside `root` so a `../` escape cannot write outside the workspace.
#[tauri::command]
pub fn fs_write_workspace_file(
    root: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("canonicalize root {}: {}", root, e))?;
    let target = root_path.join(&rel_path);
    // The target file may not exist yet, so canonicalize its *parent* (which
    // may not exist yet) by walking up to the deepest existing ancestor before
    // creating anything. A denied traversal must not leave directories behind.
    let parent = target
        .parent()
        .ok_or_else(|| format!("invalid target path: {}", target.display()))?;
    let canonical_existing = canonicalize_deepest_existing_ancestor(parent)?;
    if !canonical_existing.starts_with(&root_path) {
        log::warn!(
            "fs_workspace_write_denied path={} root={} resolved_ancestor={}",
            target.display(),
            root_path.display(),
            canonical_existing.display()
        );
        return Err(format!(
            "path escapes workspace: {} (root {})",
            canonical_existing.display(),
            root_path.display()
        ));
    }
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", parent.display(), e))?;
    if !canonical_parent.starts_with(&root_path) {
        log::warn!(
            "fs_workspace_write_denied path={} root={} resolved_parent={}",
            target.display(),
            root_path.display(),
            canonical_parent.display()
        );
        return Err(format!(
            "path escapes workspace: {} (root {})",
            canonical_parent.display(),
            root_path.display()
        ));
    }
    let file_name = target
        .file_name()
        .ok_or_else(|| format!("invalid target path: {}", target.display()))?;
    let final_path = canonical_parent.join(file_name);
    reject_symlinked_final(&final_path)?;
    std::fs::write(&final_path, content).map_err(|e| format!("write {}: {}", rel_path, e))
}

/// List the immediate children of `root`/`rel_path` (empty/None `rel_path` =
/// the root itself) for the file-tree browser. Non-recursive. Respects the
/// standard ignore set (`.gitignore` etc.) by default; pass `include_ignored =
/// Some(true)` to show everything. Directories are listed before files, each
/// sorted case-insensitively by name. `rel_path` is sandbox-checked against
/// `root` like the read/write variants.
#[tauri::command]
pub fn fs_list_workspace_dir(
    root: String,
    rel_path: Option<String>,
    include_ignored: Option<bool>,
) -> Result<Vec<WorkspaceEntry>, String> {
    let rel = rel_path.unwrap_or_default();
    let (root_path, dir) = resolve_workspace_target(&root, &rel, true)?;
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", dir.display()));
    }
    let respect_ignore = !include_ignored.unwrap_or(false);
    let walker = WalkBuilder::new(&dir)
        .hidden(false)
        .git_ignore(respect_ignore)
        .git_exclude(respect_ignore)
        .git_global(respect_ignore)
        .ignore(respect_ignore)
        .parents(respect_ignore)
        .require_git(false)
        .max_depth(Some(1))
        .build();

    let mut out: Vec<WorkspaceEntry> = Vec::new();
    for dent in walker.flatten() {
        if dent.depth() == 0 {
            // The starting directory itself.
            continue;
        }
        let path = dent.path();
        let rel_to_root = match path.strip_prefix(&root_path) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let meta = dent.metadata().ok();
        let size = if is_dir {
            0
        } else {
            meta.as_ref().map(|m| m.len()).unwrap_or(0)
        };
        let mtime_ms = meta.as_ref().and_then(mtime_ms_of);
        out.push(WorkspaceEntry {
            rel_path: rel_to_root,
            absolute_path: path.to_string_lossy().to_string(),
            is_dir,
            size,
            mtime_ms,
        });
    }
    sort_dir_listing(&mut out);
    Ok(out)
}

/// Metadata for a single workspace path (`root`/`rel_path`). Returns
/// `exists: false` (never an error) when the path is absent, so a client can
/// probe before a create/rename. Sandbox-checked against `root`; a `rel_path`
/// that escapes the workspace is rejected even when it doesn't exist.
#[tauri::command]
pub fn fs_stat_workspace_file(root: String, rel_path: String) -> Result<WorkspaceStat, String> {
    let root_path = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("canonicalize root {}: {}", root, e))?;
    let target = root_path.join(&rel_path);
    // Range-check the deepest existing ancestor so a not-yet-existing path is
    // still confined to the workspace.
    let check = canonicalize_deepest_existing_ancestor(&target)?;
    if !check.starts_with(&root_path) {
        return Err(format!(
            "path escapes workspace: {} (root {})",
            check.display(),
            root_path.display()
        ));
    }
    match std::fs::metadata(&target) {
        Ok(meta) => Ok(WorkspaceStat {
            exists: true,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime_ms: mtime_ms_of(&meta),
        }),
        Err(_) => Ok(WorkspaceStat {
            exists: false,
            is_dir: false,
            size: 0,
            mtime_ms: None,
        }),
    }
}

/// Create a directory (and any missing parents) at `root`/`rel_path`, confined
/// to the workspace. The `root` + `rel_path` counterpart to `ensure_dir_confined`
/// (which takes an absolute path + allowed roots). Re-verifies the created path
/// stays inside `root` to guard a symlinked ancestor.
#[tauri::command]
pub fn fs_create_workspace_dir(root: String, rel_path: String) -> Result<(), String> {
    if rel_path.trim().is_empty() {
        return Err("rel_path is empty".into());
    }
    let (root_path, target) = resolve_workspace_target(&root, &rel_path, false)?;
    std::fs::create_dir_all(&target).map_err(|e| format!("mkdir {}: {}", target.display(), e))?;
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", target.display(), e))?;
    if !canonical.starts_with(&root_path) {
        return Err(format!(
            "path escapes workspace: {} (root {})",
            canonical.display(),
            root_path.display()
        ));
    }
    Ok(())
}

/// Delete a file or directory at `root`/`rel_path`, confined to the workspace.
/// A directory is removed only when `recursive = Some(true)` (otherwise it must
/// be empty). A symlinked final component is unlinked (never followed), so a
/// symlinked directory can't let removal traverse outside the workspace.
/// Deleting the root itself (empty `rel_path`) is refused.
#[tauri::command]
pub fn fs_delete_workspace_entry(
    root: String,
    rel_path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    if rel_path.trim().is_empty() {
        return Err("refusing to delete the workspace root".into());
    }
    let (_root_path, target) = resolve_workspace_target(&root, &rel_path, true)?;
    let meta =
        std::fs::symlink_metadata(&target).map_err(|e| format!("stat {}: {}", rel_path, e))?;
    if meta.file_type().is_symlink() {
        return std::fs::remove_file(&target)
            .map_err(|e| format!("remove symlink {}: {}", rel_path, e));
    }
    if meta.is_dir() {
        if recursive.unwrap_or(false) {
            std::fs::remove_dir_all(&target).map_err(|e| format!("remove dir {}: {}", rel_path, e))
        } else {
            std::fs::remove_dir(&target).map_err(|e| format!("remove dir {}: {}", rel_path, e))
        }
    } else {
        std::fs::remove_file(&target).map_err(|e| format!("remove {}: {}", rel_path, e))
    }
}

/// Rename/move `from_rel_path` → `to_rel_path` within the workspace. Both
/// endpoints are sandbox-checked against `root`; the destination parent is
/// created as needed. Refuses to clobber an existing destination or to write
/// through a symlinked destination.
#[tauri::command]
pub fn fs_rename_workspace_entry(
    root: String,
    from_rel_path: String,
    to_rel_path: String,
) -> Result<(), String> {
    if from_rel_path.trim().is_empty() || to_rel_path.trim().is_empty() {
        return Err("rename requires a non-empty source and destination".into());
    }
    let (root_path, from) = resolve_workspace_target(&root, &from_rel_path, true)?;
    let (_, to) = resolve_workspace_target(&root, &to_rel_path, false)?;
    if to.exists() {
        return Err(format!("destination already exists: {}", to_rel_path));
    }
    reject_symlinked_final(&to)?;
    prepare_dest_parent(&root_path, &to)?;
    std::fs::rename(&from, &to)
        .map_err(|e| format!("rename {} -> {}: {}", from_rel_path, to_rel_path, e))
}

/// Copy `from_rel_path` → `to_rel_path` within the workspace. A directory is
/// copied only when `recursive = Some(true)`. Both endpoints are sandbox-checked;
/// the destination parent is created as needed; refuses to clobber an existing
/// destination or to write through a symlinked destination. Symlinks inside a
/// recursively-copied tree are skipped (never followed out of the workspace).
#[tauri::command]
pub fn fs_copy_workspace_entry(
    root: String,
    from_rel_path: String,
    to_rel_path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    if from_rel_path.trim().is_empty() || to_rel_path.trim().is_empty() {
        return Err("copy requires a non-empty source and destination".into());
    }
    let (root_path, from) = resolve_workspace_target(&root, &from_rel_path, true)?;
    let (_, to) = resolve_workspace_target(&root, &to_rel_path, false)?;
    if to.exists() {
        return Err(format!("destination already exists: {}", to_rel_path));
    }
    reject_symlinked_final(&to)?;
    prepare_dest_parent(&root_path, &to)?;
    let meta =
        std::fs::symlink_metadata(&from).map_err(|e| format!("stat {}: {}", from_rel_path, e))?;
    if meta.is_dir() {
        if !recursive.unwrap_or(false) {
            return Err(format!(
                "{} is a directory (pass recursive = true to copy it)",
                from_rel_path
            ));
        }
        copy_dir_recursive(&from, &to)
    } else {
        std::fs::copy(&from, &to)
            .map(|_| ())
            .map_err(|e| format!("copy {} -> {}: {}", from_rel_path, to_rel_path, e))
    }
}

/// Create the destination parent for a rename/copy and re-verify it stays inside
/// `root_path` (guards a symlinked ancestor introduced between the range-check
/// and the mkdir).
fn prepare_dest_parent(root_path: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| format!("canonicalize {}: {}", parent.display(), e))?;
            if !canonical_parent.starts_with(root_path) {
                return Err(format!(
                    "path escapes workspace: {} (root {})",
                    canonical_parent.display(),
                    root_path.display()
                ));
            }
        }
    }
    Ok(())
}

/// Recursively copy `from` → `to`, skipping symlinks so a link inside the tree
/// can't redirect the copy outside the workspace.
fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("mkdir {}: {}", to.display(), e))?;
    for entry in
        std::fs::read_dir(from).map_err(|e| format!("read_dir {}: {}", from.display(), e))?
    {
        let entry = entry.map_err(|e| format!("read_dir entry: {}", e))?;
        let file_type = entry.file_type().map_err(|e| format!("file_type: {}", e))?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if file_type.is_symlink() {
            continue;
        } else if file_type.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| format!("copy {}: {}", src.display(), e))?;
        }
    }
    Ok(())
}

/// Canonicalize each allowed root, dropping any that fail to resolve (a root
/// that doesn't exist on disk can never contain a target).
fn canonicalize_roots(allowed_roots: &[String]) -> Vec<PathBuf> {
    allowed_roots
        .iter()
        .filter_map(|r| PathBuf::from(r).canonicalize().ok())
        .collect()
}

/// True when `candidate` is one of, or a descendant of, any canonical root.
fn starts_with_any_canonical_root(candidate: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|r| candidate.starts_with(r))
}

fn canonicalize_deepest_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path;
    while !existing.exists() {
        match existing.parent() {
            Some(p) if !p.as_os_str().is_empty() => existing = p,
            _ => break,
        }
    }
    existing
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", existing.display(), e))
}

/// Reject writing through a symlinked final component. The TS lexical
/// pre-flight cannot see symlinks; this on-disk check is the authoritative
/// guard against a symlink inside an allowed root pointing outside it.
fn reject_symlinked_final(final_path: &Path) -> Result<(), String> {
    if let Ok(meta) = std::fs::symlink_metadata(final_path) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "refusing to write through symlink: {}",
                final_path.display()
            ));
        }
    }
    Ok(())
}

/// Resolve an absolute `path` for a confined write: create the parent,
/// canonicalize it (resolving any symlinks in the ancestry), verify it sits
/// inside one of `allowed_roots`, and reject a symlinked final component.
/// Returns the absolute path to write to. Empty `allowed_roots` => `Err` (no
/// implicit any-path).
fn resolve_confined_target(path: &str, allowed_roots: &[String]) -> Result<PathBuf, String> {
    let roots = canonicalize_roots(allowed_roots);
    if roots.is_empty() {
        return Err("no allowed roots configured".into());
    }
    let target = PathBuf::from(path);
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("invalid target path: {}", target.display()))?;
    let canonical_existing = canonicalize_deepest_existing_ancestor(parent)?;
    if !starts_with_any_canonical_root(&canonical_existing, &roots) {
        log::warn!(
            "fs_confined_write_denied path={} resolved_ancestor={}",
            target.display(),
            canonical_existing.display()
        );
        return Err(format!(
            "path escapes the allowed roots: {}",
            canonical_existing.display()
        ));
    }
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", parent.display(), e))?;
    if !starts_with_any_canonical_root(&canonical_parent, &roots) {
        log::warn!(
            "fs_confined_write_denied path={} resolved_parent={}",
            target.display(),
            canonical_parent.display()
        );
        return Err(format!(
            "path escapes the allowed roots: {}",
            canonical_parent.display()
        ));
    }
    let file_name = target
        .file_name()
        .ok_or_else(|| format!("invalid target path: {}", target.display()))?;
    let final_path = canonical_parent.join(file_name);
    reject_symlinked_final(&final_path)?;
    Ok(final_path)
}

/// Write a text file confined to `allowed_roots` (the active workspace roots
/// supplied by the renderer). The authoritative counterpart to the unconfined
/// [`write_text_file`]; the secure-fs write path calls this so a write that
/// escapes the workspace — including via a symlink the lexical TS check can't
/// see — is rejected on-disk.
#[tauri::command]
pub fn write_text_file_confined(
    path: String,
    content: String,
    allowed_roots: Vec<String>,
) -> Result<(), String> {
    let final_path = resolve_confined_target(&path, &allowed_roots)?;
    std::fs::write(&final_path, content).map_err(|e| format!("write {}: {}", path, e))
}

/// Ensure a directory exists, confined to `allowed_roots`. Verifies the
/// deepest existing ancestor canonicalizes inside a root *before* creating any
/// new directories, so a denied call never creates a directory outside the
/// workspace.
#[tauri::command]
pub fn ensure_dir_confined(path: String, allowed_roots: Vec<String>) -> Result<(), String> {
    let roots = canonicalize_roots(&allowed_roots);
    if roots.is_empty() {
        return Err("no allowed roots configured".into());
    }
    let target = PathBuf::from(&path);
    let canonical_existing = canonicalize_deepest_existing_ancestor(target.as_path())?;
    if !starts_with_any_canonical_root(&canonical_existing, &roots) {
        return Err(format!(
            "path escapes the allowed roots: {}",
            canonical_existing.display()
        ));
    }
    std::fs::create_dir_all(&target).map_err(|e| format!("mkdir {}: {}", path, e))?;
    // Re-verify the created path stays inside a root (guards a symlinked ancestor).
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", path, e))?;
    if !starts_with_any_canonical_root(&canonical, &roots) {
        return Err(format!(
            "path escapes the allowed roots: {}",
            canonical.display()
        ));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandFile {
    /// File-derived command name (e.g. `review`, `frontend/refactor`). Forward
    /// slashes in nested directories so the UI can render hierarchy.
    pub name: String,
    pub scope: String, // "project" | "user"
    pub path: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    /// Per-command model override; takes precedence over session/character/app default.
    pub model: Option<String>,
    /// Absolute paths to add to `additionalDirectories` whenever this command runs.
    pub paths: Option<Vec<String>>,
    /// When `true`, hide from the slash-command picker. The command can still be
    /// invoked programmatically (e.g. by another skill or by typing the full
    /// name explicitly). Defaults to `false` if missing.
    pub disable_model_invocation: Option<bool>,
    /// When `false`, hide from the user-facing picker. Defaults to `true`.
    pub user_invocable: Option<bool>,
    pub body: String,
}

/// Discover Claude Code custom commands at `<cwd>/.claude/commands/**/*.md`
/// and `~/.claude/commands/**/*.md`. Returns an empty list rather than erroring
/// when neither directory exists; missing/unreadable entries are skipped.
#[tauri::command]
pub fn slash_commands_scan(cwd: Option<String>) -> Result<Vec<SlashCommandFile>, String> {
    let mut out: Vec<SlashCommandFile> = Vec::new();
    if let Some(cwd) = cwd.as_ref() {
        let project_root = PathBuf::from(cwd).join(".claude").join("commands");
        collect_command_files(&project_root, "project", &mut out);
    }
    if let Some(home) = dirs::home_dir() {
        let user_root = home.join(".claude").join("commands");
        collect_command_files(&user_root, "user", &mut out);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn collect_command_files(root: &Path, scope: &str, out: &mut Vec<SlashCommandFile>) {
    if !root.is_dir() {
        return;
    }
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(false)
        .max_depth(Some(8))
        .build();
    let matter: Matter<YAML> = Matter::new();
    for dent in walker.flatten() {
        let path = dent.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.with_extension(""),
            Err(_) => continue,
        };
        let name = rel.to_string_lossy().replace('\\', "/");
        // gray_matter 0.3 made `parse` generic + fallible; `Pod` keeps the
        // dynamic front-matter access this loop relies on. Skip files whose
        // front matter fails to parse (a malformed command file is unusable).
        let parsed = match matter.parse::<Pod>(&raw) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let body = parsed.content.trim_start().to_string();
        let mut description: Option<String> = None;
        let mut argument_hint: Option<String> = None;
        let mut allowed_tools: Option<Vec<String>> = None;
        let mut model: Option<String> = None;
        let mut paths: Option<Vec<String>> = None;
        let mut disable_model_invocation: Option<bool> = None;
        let mut user_invocable: Option<bool> = None;
        if let Some(data) = parsed.data {
            if let Ok(map) = data.as_hashmap() {
                if let Some(d) = map.get("description").and_then(|v| v.as_string().ok()) {
                    description = Some(d);
                }
                if let Some(h) = map.get("argument-hint").and_then(|v| v.as_string().ok()) {
                    argument_hint = Some(h);
                }
                if let Some(at) = map.get("allowed-tools").and_then(|v| v.as_vec().ok()) {
                    let list: Vec<String> =
                        at.into_iter().filter_map(|v| v.as_string().ok()).collect();
                    if !list.is_empty() {
                        allowed_tools = Some(list);
                    }
                }
                if let Some(m) = map.get("model").and_then(|v| v.as_string().ok()) {
                    model = Some(m);
                }
                if let Some(p) = map.get("paths").and_then(|v| v.as_vec().ok()) {
                    let list: Vec<String> =
                        p.into_iter().filter_map(|v| v.as_string().ok()).collect();
                    if !list.is_empty() {
                        paths = Some(list);
                    }
                }
                if let Some(b) = map
                    .get("disable-model-invocation")
                    .and_then(|v| v.as_bool().ok())
                {
                    disable_model_invocation = Some(b);
                }
                if let Some(b) = map.get("user-invocable").and_then(|v| v.as_bool().ok()) {
                    user_invocable = Some(b);
                }
            }
        }
        out.push(SlashCommandFile {
            name,
            scope: scope.to_string(),
            path: path.to_string_lossy().to_string(),
            description,
            argument_hint,
            allowed_tools,
            model,
            paths,
            disable_model_invocation,
            user_invocable,
            body,
        });
    }
}

/// Append a memory line to either the project CLAUDE.md (when scope ==
/// "project") or the user-global ~/.claude/CLAUDE.md (scope == "user"). The
/// content is prefixed with `\n- ` to match Claude Code's bullet style; the
/// caller passes the bare text. Creates the file if missing.
#[tauri::command]
pub fn memory_append(
    scope: String,
    content: String,
    cwd: Option<String>,
    allowed_roots: Option<Vec<String>>,
) -> Result<String, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("memory content is empty".into());
    }
    let target = match scope.as_str() {
        "project" => {
            let cwd = cwd.ok_or_else(|| "project memory requires a cwd".to_string())?;
            let claude_md = PathBuf::from(&cwd).join("CLAUDE.md");
            // When the caller supplies the active workspace roots, confine the
            // project CLAUDE.md to them so a stray cwd can't write outside.
            if let Some(roots) = allowed_roots.as_ref() {
                resolve_confined_target(&claude_md.to_string_lossy(), roots)?
            } else {
                claude_md
            }
        }
        "user" => {
            let home =
                dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
            home.join(".claude").join("CLAUDE.md")
        }
        other => return Err(format!("unknown memory scope: {}", other)),
    };
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
    }
    let mut existing: String = std::fs::read_to_string(&target).unwrap_or_default();
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    existing.push_str("- ");
    existing.push_str(trimmed);
    existing.push('\n');
    std::fs::write(&target, existing).map_err(|e| format!("write {}: {}", target.display(), e))?;
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_and_read_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("cognia-test-{}.txt", std::process::id()));
        let path = tmp.to_string_lossy().to_string();
        write_text_file_impl(path.clone(), "hello".into(), FsOrigin::Local).unwrap();
        assert_eq!(
            read_text_file_impl(path.clone(), FsOrigin::Local).unwrap(),
            "hello"
        );
        let _ = std::fs::remove_file(&tmp);
    }

    // Exercises the async command wrappers (spawn_blocking path), not just the
    // sync `_impl`, so the off-UI-thread dispatch is covered end-to-end.
    #[tokio::test]
    async fn async_write_and_read_roundtrip() {
        let tmp =
            std::env::temp_dir().join(format!("cognia-test-async-{}.txt", std::process::id()));
        let path = tmp.to_string_lossy().to_string();
        write_text_file(path.clone(), "world".into()).await.unwrap();
        assert_eq!(read_text_file(path.clone()).await.unwrap(), "world");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn write_creates_parent_dirs() {
        let tmp = std::env::temp_dir()
            .join(format!("cognia-test-nested-{}", std::process::id()))
            .join("a")
            .join("b")
            .join("file.txt");
        let path = tmp.to_string_lossy().to_string();
        write_text_file_impl(path.clone(), "x".into(), FsOrigin::Local).unwrap();
        assert!(std::path::Path::new(&path).is_file());
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn scan_returns_empty_when_no_dir() {
        // Can't really test the real ~/.claude/skills; just ensure it returns
        // a Vec without panicking. The function's branch for missing dir is
        // already covered by the empty case if the user has no dir.
        let _ = scan_claude_skills_impl();
    }

    fn make_sandbox(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("cognia-files-test").join(format!(
            "{}-{}",
            prefix,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn search_finds_matches_and_ranks_basenames_first() {
        let root = make_sandbox("search");
        std::fs::create_dir_all(root.join("src/components")).unwrap();
        std::fs::write(root.join("README.md"), "x").unwrap();
        std::fs::write(root.join("src/components/Button.tsx"), "x").unwrap();
        std::fs::write(root.join("src/components/Other.tsx"), "x").unwrap();
        let results = fs_search_workspace(
            root.to_string_lossy().to_string(),
            "button".into(),
            Some(10),
        )
        .unwrap();
        assert!(!results.is_empty(), "should find Button.tsx");
        assert!(results[0].rel_path.to_lowercase().contains("button"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_respects_gitignore() {
        let root = make_sandbox("ignore");
        std::fs::write(root.join(".gitignore"), "secret.txt\n").unwrap();
        std::fs::write(root.join("secret.txt"), "x").unwrap();
        std::fs::write(root.join("public.txt"), "x").unwrap();
        let results =
            fs_search_workspace(root.to_string_lossy().to_string(), "txt".into(), Some(10))
                .unwrap();
        let names: Vec<_> = results.iter().map(|e| e.rel_path.clone()).collect();
        assert!(names.iter().any(|n| n == "public.txt"));
        assert!(
            !names.iter().any(|n| n == "secret.txt"),
            "gitignored file should not appear: {:?}",
            names
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_rejects_invalid_root() {
        let bogus = std::env::temp_dir().join("definitely-not-here-xyz-cognia");
        let _ = std::fs::remove_dir_all(&bogus);
        let res = fs_search_workspace(bogus.to_string_lossy().to_string(), "".into(), None);
        assert!(res.is_err());
    }

    #[test]
    fn read_workspace_file_blocks_traversal() {
        let root = make_sandbox("read-sandbox");
        std::fs::write(root.join("ok.txt"), "hello").unwrap();
        let ok = fs_read_workspace_file(root.to_string_lossy().to_string(), "ok.txt".into(), None)
            .unwrap();
        assert_eq!(ok, "hello");

        // Try to escape upwards — must fail (whether due to canonicalize or our
        // explicit prefix check).
        let escape = fs_read_workspace_file(
            root.to_string_lossy().to_string(),
            "../../etc/hosts".into(),
            None,
        );
        assert!(escape.is_err(), "traversal must be rejected");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_workspace_file_writes_and_blocks_traversal() {
        let root = make_sandbox("write-sandbox");
        // Writes to a nested rel path, creating parent dirs.
        fs_write_workspace_file(
            root.to_string_lossy().to_string(),
            "nested/dir/out.txt".into(),
            "payload".into(),
        )
        .unwrap();
        let written =
            std::fs::read_to_string(root.join("nested").join("dir").join("out.txt")).unwrap();
        assert_eq!(written, "payload");

        // Escaping the root must be rejected.
        let escape = fs_write_workspace_file(
            root.to_string_lossy().to_string(),
            "../escape.txt".into(),
            "x".into(),
        );
        assert!(escape.is_err(), "traversal write must be rejected");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_workspace_file_rejects_escape_without_creating_parent() {
        let root = make_sandbox("write-sandbox-no-mutation");
        let outside_dir = root
            .parent()
            .unwrap()
            .join(format!("write-escape-created-{}", std::process::id()));
        let outside_name = outside_dir.file_name().unwrap().to_string_lossy();
        let _ = std::fs::remove_dir_all(&outside_dir);

        let escape = fs_write_workspace_file(
            root.to_string_lossy().to_string(),
            format!("../{outside_name}/evil.txt"),
            "x".into(),
        );

        assert!(escape.is_err(), "traversal write must be rejected");
        assert!(
            !outside_dir.exists(),
            "rejected traversal must not create an out-of-root parent"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn slash_commands_scan_reads_project_dir() {
        let root = make_sandbox("slash");
        let cmds = root.join(".claude").join("commands");
        std::fs::create_dir_all(&cmds).unwrap();
        std::fs::write(
            cmds.join("review.md"),
            "---\ndescription: Review code\nargument-hint: <file>\n---\nReview $1\n",
        )
        .unwrap();
        let list = slash_commands_scan(Some(root.to_string_lossy().to_string())).unwrap();
        let review = list
            .iter()
            .find(|c| c.name == "review")
            .expect("review cmd");
        assert_eq!(review.scope, "project");
        assert_eq!(review.description.as_deref(), Some("Review code"));
        assert_eq!(review.argument_hint.as_deref(), Some("<file>"));
        assert!(review.body.starts_with("Review $1"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn memory_append_creates_and_appends() {
        let root = make_sandbox("memory");
        let path = memory_append(
            "project".into(),
            "first note".into(),
            Some(root.to_string_lossy().to_string()),
            None,
        )
        .unwrap();
        assert!(Path::new(&path).is_file());
        memory_append(
            "project".into(),
            "second note".into(),
            Some(root.to_string_lossy().to_string()),
            None,
        )
        .unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("- first note\n"));
        assert!(body.contains("- second note\n"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn memory_append_rejects_unknown_scope() {
        let res = memory_append("garbage".into(), "x".into(), None, None);
        assert!(res.is_err());
    }

    #[test]
    fn memory_append_project_confined_to_roots() {
        let root = make_sandbox("memory-confined");
        let roots = vec![root.to_string_lossy().to_string()];
        // cwd inside the root → allowed.
        memory_append(
            "project".into(),
            "ok".into(),
            Some(root.to_string_lossy().to_string()),
            Some(roots.clone()),
        )
        .unwrap();
        // cwd outside the root → denied.
        let outside = std::env::temp_dir().join(format!("cognia-mem-out-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&outside);
        let res = memory_append(
            "project".into(),
            "nope".into(),
            Some(outside.to_string_lossy().to_string()),
            Some(roots),
        );
        assert!(res.is_err(), "cwd outside roots must be denied");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn confined_write_inside_root_creates_nested() {
        let root = make_sandbox("confined-write");
        let roots = vec![root.to_string_lossy().to_string()];
        let target = root.join("a").join("b").join("file.txt");
        write_text_file_confined(target.to_string_lossy().to_string(), "hi".into(), roots).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hi");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn confined_write_outside_root_denied() {
        let root = make_sandbox("confined-deny");
        let roots = vec![root.to_string_lossy().to_string()];
        let outside = std::env::temp_dir().join(format!("cognia-out-{}.txt", std::process::id()));
        let res =
            write_text_file_confined(outside.to_string_lossy().to_string(), "x".into(), roots);
        assert!(res.is_err(), "write outside roots must be denied");
        assert!(!outside.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn confined_write_rejects_escape_without_creating_parent() {
        let root = make_sandbox("confined-no-mutation");
        let roots = vec![root.to_string_lossy().to_string()];
        let outside_dir = root
            .parent()
            .unwrap()
            .join(format!("confined-escape-created-{}", std::process::id()));
        let target = outside_dir.join("evil.txt");
        let _ = std::fs::remove_dir_all(&outside_dir);

        let res = write_text_file_confined(target.to_string_lossy().to_string(), "x".into(), roots);

        assert!(res.is_err(), "write outside roots must be denied");
        assert!(
            !outside_dir.exists(),
            "rejected confined write must not create an out-of-root parent"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn confined_write_empty_roots_denied() {
        let root = make_sandbox("confined-empty");
        let target = root.join("f.txt");
        let res =
            write_text_file_confined(target.to_string_lossy().to_string(), "x".into(), vec![]);
        assert!(res.is_err(), "empty roots must deny (no implicit any-path)");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn confined_write_rejects_symlinked_final_component() {
        use std::os::unix::fs::symlink;
        let root = make_sandbox("confined-symlink");
        let outside = std::env::temp_dir().join(format!("cognia-sym-out-{}", std::process::id()));
        let _ = std::fs::remove_file(&outside);
        std::fs::write(&outside, "victim").unwrap();
        // A symlink INSIDE the root pointing OUTSIDE it.
        let link = root.join("link.txt");
        symlink(&outside, &link).unwrap();
        let roots = vec![root.to_string_lossy().to_string()];
        let res =
            write_text_file_confined(link.to_string_lossy().to_string(), "evil".into(), roots);
        assert!(
            res.is_err(),
            "must refuse to write through a symlinked final component"
        );
        // The out-of-root victim must be untouched.
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "victim");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn path_within_roots_empty_is_allowed() {
        // Unseeded registry (no roots) must not flag anything — shadow safety.
        assert!(is_path_within_roots("/anywhere/at/all", &[]));
    }

    #[test]
    fn path_within_roots_allows_inside_denies_outside() {
        let root = make_sandbox("within-roots");
        std::fs::write(root.join("ok.txt"), "x").unwrap();
        let roots = vec![root.to_string_lossy().to_string()];

        // Existing file inside the root.
        assert!(is_path_within_roots(
            &root.join("ok.txt").to_string_lossy(),
            &roots
        ));
        // Not-yet-created file inside the root (deepest existing ancestor = root).
        assert!(is_path_within_roots(
            &root.join("new/sub/file.txt").to_string_lossy(),
            &roots
        ));
        // A path outside every root.
        let outside = std::env::temp_dir().join(format!("cognia-wr-out-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&outside);
        std::fs::write(outside.join("secret"), "x").unwrap();
        assert!(!is_path_within_roots(
            &outside.join("secret").to_string_lossy(),
            &roots
        ));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn path_within_roots_follows_symlink_ancestor_outside() {
        use std::os::unix::fs::symlink;
        let root = make_sandbox("within-symlink");
        let outside = std::env::temp_dir().join(format!("cognia-wr-sym-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        // A symlink inside the root pointing to an out-of-root directory.
        let link = root.join("escape");
        symlink(&outside, &link).unwrap();
        let roots = vec![root.to_string_lossy().to_string()];
        // The target sits under the symlink but canonicalizes outside the root.
        assert!(!is_path_within_roots(
            &link.join("file.txt").to_string_lossy(),
            &roots
        ));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn allowed_roots_registry_add_and_dialog_register() {
        // Process-global registry: keep all mutations in one sequential test so
        // cargo's parallel runner can't interleave (mirrors hooks::trust).
        let root = make_sandbox("registry");
        std::fs::write(root.join("f.txt"), "x").unwrap();
        add_allowed_root(root.to_string_lossy().to_string());
        assert!(is_path_allowed(&root.join("f.txt").to_string_lossy()));

        // Separator + trailing-slash normalization key.
        assert_eq!(normalize_root("C:\\a\\b\\"), "C:/a/b");

        // Dialog gesture: a file registers its parent dir.
        let dir = make_sandbox("registry-dialog");
        let file = dir.join("export.json");
        fs_allow_dialog_path(file.to_string_lossy().to_string());
        std::fs::write(&file, "x").unwrap();
        assert!(is_path_allowed(&file.to_string_lossy()));

        // Dialog gesture: a directory registers itself.
        let folder = make_sandbox("registry-folder");
        fs_allow_dialog_path(folder.to_string_lossy().to_string());
        std::fs::write(folder.join("inside.txt"), "x").unwrap();
        assert!(is_path_allowed(
            &folder.join("inside.txt").to_string_lossy()
        ));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn remote_writes_enforce_root_containment_local_stays_shadow() {
        // Seed a root so the registry is non-empty (an empty registry is
        // shadow-permissive by design and would not exercise enforcement).
        let root = make_sandbox("remote-enforce");
        add_allowed_root(root.to_string_lossy().to_string());

        // Remote write INSIDE the root → allowed.
        let inside = root.join("ok.txt").to_string_lossy().to_string();
        write_text_file_impl(inside.clone(), "x".into(), FsOrigin::Remote).unwrap();
        assert!(std::path::Path::new(&inside).is_file());

        // Remote write OUTSIDE every root → hard error, and the file is NOT created.
        let out_dir =
            std::env::temp_dir().join(format!("cognia-remote-out-{}", std::process::id()));
        let outside = out_dir.join("escape.txt");
        let outside_s = outside.to_string_lossy().to_string();
        let err =
            write_text_file_impl(outside_s.clone(), "x".into(), FsOrigin::Remote).unwrap_err();
        assert!(err.contains("outside the workspace roots"), "got: {err}");
        assert!(
            !outside.exists(),
            "a blocked remote write must not create the file"
        );

        // Remote ensure_dir outside every root → also blocked.
        assert!(ensure_dir_impl(out_dir.to_string_lossy().to_string(), FsOrigin::Remote).is_err());

        // A LOCAL write to the same outside path stays in shadow mode (allowed) —
        // the enforcement flip is remote-only so existing renderer flows survive.
        write_text_file_impl(outside_s.clone(), "x".into(), FsOrigin::Local).unwrap();
        assert!(outside.exists());

        // A remote READ is never containment-blocked (only writes are enforced);
        // it succeeds now that the local write created the file.
        assert_eq!(
            read_text_file_impl(outside_s.clone(), FsOrigin::Remote).unwrap(),
            "x"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&out_dir);
    }

    #[test]
    fn ensure_dir_confined_allows_inside_denies_outside() {
        let root = make_sandbox("ensure-confined");
        let roots = vec![root.to_string_lossy().to_string()];
        ensure_dir_confined(
            root.join("x").join("y").to_string_lossy().to_string(),
            roots.clone(),
        )
        .unwrap();
        assert!(root.join("x").join("y").is_dir());
        let outside = std::env::temp_dir().join(format!("cognia-ed-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        let res = ensure_dir_confined(outside.to_string_lossy().to_string(), roots);
        assert!(res.is_err(), "dir outside roots must be denied");
        assert!(!outside.exists(), "denied dir must not be created");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── file-tree browser commands ──────────────────────────────────────────

    #[test]
    fn list_workspace_dir_lists_immediate_children_dirs_first_nonrecursive() {
        let root = make_sandbox("list");
        std::fs::create_dir_all(root.join("zdir")).unwrap();
        std::fs::write(root.join("zdir").join("child.txt"), "nested").unwrap();
        std::fs::write(root.join("afile.txt"), "hello").unwrap();

        let entries =
            fs_list_workspace_dir(root.to_string_lossy().to_string(), None, None).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.rel_path.clone()).collect();
        // Immediate children only — never the nested file.
        assert!(names.iter().any(|n| n == "zdir"));
        assert!(names.iter().any(|n| n == "afile.txt"));
        assert!(
            !names.iter().any(|n| n.contains("child")),
            "listing must be non-recursive: {:?}",
            names
        );
        // Directories sort before files.
        assert!(entries[0].is_dir, "dir should come first: {:?}", names);
        // Files carry a size + mtime.
        let file = entries.iter().find(|e| e.rel_path == "afile.txt").unwrap();
        assert_eq!(file.size, 5);
        assert!(file.mtime_ms.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_workspace_dir_respects_gitignore_unless_included() {
        let root = make_sandbox("list-ignore");
        std::fs::write(root.join(".gitignore"), "secret.txt\n").unwrap();
        std::fs::write(root.join("secret.txt"), "x").unwrap();
        std::fs::write(root.join("public.txt"), "x").unwrap();

        let default =
            fs_list_workspace_dir(root.to_string_lossy().to_string(), None, None).unwrap();
        let default_names: Vec<_> = default.iter().map(|e| e.rel_path.clone()).collect();
        assert!(default_names.iter().any(|n| n == "public.txt"));
        assert!(
            !default_names.iter().any(|n| n == "secret.txt"),
            "gitignored file hidden by default: {:?}",
            default_names
        );

        let all =
            fs_list_workspace_dir(root.to_string_lossy().to_string(), None, Some(true)).unwrap();
        let all_names: Vec<_> = all.iter().map(|e| e.rel_path.clone()).collect();
        assert!(
            all_names.iter().any(|n| n == "secret.txt"),
            "include_ignored shows everything: {:?}",
            all_names
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_content_finds_line_matches_with_position() {
        let root = make_sandbox("grep");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src").join("a.ts"),
            "const x = 1\nconst needle = 2\nplain\n",
        )
        .unwrap();
        std::fs::write(root.join("b.ts"), "no match here\n").unwrap();

        let hits = fs_search_content_workspace(
            root.to_string_lossy().to_string(),
            "needle".into(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(hits.len(), 1, "one line matches: {:?}", hits);
        let hit = &hits[0];
        assert_eq!(hit.rel_path, "src/a.ts");
        assert_eq!(hit.line, 2);
        assert_eq!(hit.column, 7); // "const " = 6 chars, match starts at col 7
        assert!(hit.preview.contains("needle"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_content_is_case_insensitive_by_default_and_literal() {
        let root = make_sandbox("grep-case");
        // `.` would be a regex wildcard if not escaped — literal mode escapes it.
        std::fs::write(root.join("f.txt"), "Foo.Bar\nfxoxo\n").unwrap();

        let ci = fs_search_content_workspace(
            root.to_string_lossy().to_string(),
            "foo.bar".into(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(ci.len(), 1, "case-insensitive literal match: {:?}", ci);

        let sensitive = fs_search_content_workspace(
            root.to_string_lossy().to_string(),
            "foo.bar".into(),
            None,
            Some(true),
            None,
        )
        .unwrap();
        assert!(
            sensitive.is_empty(),
            "case-sensitive misses: {:?}",
            sensitive
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_content_regex_mode_and_gitignore_and_empty_query() {
        let root = make_sandbox("grep-regex");
        std::fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(root.join("ignored.txt"), "TODO: skip me\n").unwrap();
        std::fs::write(root.join("keep.txt"), "TODO: fix\nTODONT\n").unwrap();

        let regex_hits = fs_search_content_workspace(
            root.to_string_lossy().to_string(),
            r"TODO:\s".into(),
            Some(true),
            None,
            None,
        )
        .unwrap();
        // gitignored file excluded; only keep.txt line 1 matches `TODO: `.
        assert_eq!(regex_hits.len(), 1, "regex + gitignore: {:?}", regex_hits);
        assert_eq!(regex_hits[0].rel_path, "keep.txt");
        assert_eq!(regex_hits[0].line, 1);

        // Empty query yields nothing (guards against a full-file dump).
        let empty = fs_search_content_workspace(
            root.to_string_lossy().to_string(),
            "".into(),
            None,
            None,
            None,
        )
        .unwrap();
        assert!(empty.is_empty());

        // Invalid regex errors out rather than matching everything.
        let bad = fs_search_content_workspace(
            root.to_string_lossy().to_string(),
            "(".into(),
            Some(true),
            None,
            None,
        );
        assert!(bad.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn search_content_does_not_follow_symlinks_out_of_root() {
        let root = make_sandbox("grep-symlink");
        // A secret file OUTSIDE the workspace root.
        let outside =
            std::env::temp_dir().join(format!("cognia-secret-{}.txt", std::process::id()));
        std::fs::write(&outside, "SUPER_SECRET_TOKEN\n").unwrap();
        // A symlink inside the workspace pointing at it.
        std::os::unix::fs::symlink(&outside, root.join("link.txt")).unwrap();
        std::fs::write(root.join("real.txt"), "SUPER_SECRET_TOKEN in-repo\n").unwrap();

        let hits = fs_search_content_workspace(
            root.to_string_lossy().to_string(),
            "SUPER_SECRET_TOKEN".into(),
            None,
            None,
            None,
        )
        .unwrap();
        // Only the real in-repo file matches; the symlink's target is never read.
        assert_eq!(hits.len(), 1, "symlink target must not be read: {:?}", hits);
        assert_eq!(hits[0].rel_path, "real.txt");
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_workspace_dir_subdir_and_rejects_traversal() {
        let root = make_sandbox("list-sub");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("main.rs"), "x").unwrap();
        let sub =
            fs_list_workspace_dir(root.to_string_lossy().to_string(), Some("src".into()), None)
                .unwrap();
        assert!(sub.iter().any(|e| e.rel_path == "src/main.rs"));

        let escape =
            fs_list_workspace_dir(root.to_string_lossy().to_string(), Some("../".into()), None);
        assert!(escape.is_err(), "traversal must be rejected");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stat_workspace_file_reports_existence_and_kind() {
        let root = make_sandbox("stat");
        std::fs::write(root.join("f.txt"), "hello").unwrap();
        std::fs::create_dir_all(root.join("d")).unwrap();

        let file =
            fs_stat_workspace_file(root.to_string_lossy().to_string(), "f.txt".into()).unwrap();
        assert!(file.exists && !file.is_dir);
        assert_eq!(file.size, 5);
        assert!(file.mtime_ms.is_some());

        let dir = fs_stat_workspace_file(root.to_string_lossy().to_string(), "d".into()).unwrap();
        assert!(dir.exists && dir.is_dir);

        let missing =
            fs_stat_workspace_file(root.to_string_lossy().to_string(), "nope.txt".into()).unwrap();
        assert!(!missing.exists);

        let escape =
            fs_stat_workspace_file(root.to_string_lossy().to_string(), "../../etc/hosts".into());
        assert!(escape.is_err(), "traversal must be rejected");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_workspace_dir_creates_nested_and_blocks_traversal() {
        let root = make_sandbox("mkdir");
        fs_create_workspace_dir(root.to_string_lossy().to_string(), "a/b/c".into()).unwrap();
        assert!(root.join("a").join("b").join("c").is_dir());

        let outside = root
            .parent()
            .unwrap()
            .join(format!("mkdir-escape-{}", std::process::id()));
        let outside_name = outside.file_name().unwrap().to_string_lossy();
        let _ = std::fs::remove_dir_all(&outside);
        let escape = fs_create_workspace_dir(
            root.to_string_lossy().to_string(),
            format!("../{outside_name}"),
        );
        assert!(escape.is_err(), "traversal mkdir must be rejected");
        assert!(
            !outside.exists(),
            "rejected mkdir must not create outside root"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_workspace_entry_file_dir_and_guards() {
        let root = make_sandbox("delete");
        std::fs::write(root.join("f.txt"), "x").unwrap();
        fs_delete_workspace_entry(root.to_string_lossy().to_string(), "f.txt".into(), None)
            .unwrap();
        assert!(!root.join("f.txt").exists());

        // Non-empty dir: needs recursive.
        std::fs::create_dir_all(root.join("d")).unwrap();
        std::fs::write(root.join("d").join("inner.txt"), "x").unwrap();
        let non_recursive =
            fs_delete_workspace_entry(root.to_string_lossy().to_string(), "d".into(), None);
        assert!(non_recursive.is_err(), "non-empty dir needs recursive");
        fs_delete_workspace_entry(root.to_string_lossy().to_string(), "d".into(), Some(true))
            .unwrap();
        assert!(!root.join("d").exists());

        // Refuse the root itself.
        assert!(fs_delete_workspace_entry(
            root.to_string_lossy().to_string(),
            "".into(),
            Some(true)
        )
        .is_err());

        // Traversal onto an out-of-root file must be rejected and leave it intact.
        let victim = root
            .parent()
            .unwrap()
            .join(format!("delete-victim-{}.txt", std::process::id()));
        std::fs::write(&victim, "keep").unwrap();
        let victim_name = victim.file_name().unwrap().to_string_lossy();
        let escape = fs_delete_workspace_entry(
            root.to_string_lossy().to_string(),
            format!("../{victim_name}"),
            None,
        );
        assert!(escape.is_err(), "traversal delete must be rejected");
        assert!(victim.exists(), "out-of-root victim must be untouched");
        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn delete_workspace_entry_unlinks_symlink_without_following() {
        use std::os::unix::fs::symlink;
        let root = make_sandbox("delete-symlink");
        std::fs::write(root.join("real.txt"), "keep").unwrap();
        symlink(root.join("real.txt"), root.join("link.txt")).unwrap();
        fs_delete_workspace_entry(root.to_string_lossy().to_string(), "link.txt".into(), None)
            .unwrap();
        assert!(!root.join("link.txt").exists(), "link removed");
        assert_eq!(
            std::fs::read_to_string(root.join("real.txt")).unwrap(),
            "keep",
            "symlink target must be untouched"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_workspace_entry_moves_and_guards() {
        let root = make_sandbox("rename");
        std::fs::write(root.join("a.txt"), "payload").unwrap();
        fs_rename_workspace_entry(
            root.to_string_lossy().to_string(),
            "a.txt".into(),
            "sub/b.txt".into(),
        )
        .unwrap();
        assert!(!root.join("a.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("sub").join("b.txt")).unwrap(),
            "payload"
        );

        // No clobber.
        std::fs::write(root.join("c.txt"), "x").unwrap();
        let clobber = fs_rename_workspace_entry(
            root.to_string_lossy().to_string(),
            "c.txt".into(),
            "sub/b.txt".into(),
        );
        assert!(clobber.is_err(), "rename must not clobber existing dest");

        // Traversal source.
        let escape = fs_rename_workspace_entry(
            root.to_string_lossy().to_string(),
            "../nope".into(),
            "x.txt".into(),
        );
        assert!(escape.is_err(), "traversal rename must be rejected");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_workspace_entry_file_dir_and_guards() {
        let root = make_sandbox("copy");
        std::fs::write(root.join("a.txt"), "x").unwrap();
        fs_copy_workspace_entry(
            root.to_string_lossy().to_string(),
            "a.txt".into(),
            "b.txt".into(),
            None,
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "x");
        assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "x");

        // Directory needs recursive.
        std::fs::create_dir_all(root.join("d")).unwrap();
        std::fs::write(root.join("d").join("inner.txt"), "y").unwrap();
        let non_recursive = fs_copy_workspace_entry(
            root.to_string_lossy().to_string(),
            "d".into(),
            "d-copy".into(),
            None,
        );
        assert!(non_recursive.is_err(), "dir copy needs recursive");
        fs_copy_workspace_entry(
            root.to_string_lossy().to_string(),
            "d".into(),
            "d-copy".into(),
            Some(true),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("d-copy").join("inner.txt")).unwrap(),
            "y"
        );

        // No clobber.
        let clobber = fs_copy_workspace_entry(
            root.to_string_lossy().to_string(),
            "a.txt".into(),
            "b.txt".into(),
            None,
        );
        assert!(clobber.is_err(), "copy must not clobber existing dest");

        // Traversal source.
        let escape = fs_copy_workspace_entry(
            root.to_string_lossy().to_string(),
            "../nope".into(),
            "x.txt".into(),
            None,
        );
        assert!(escape.is_err(), "traversal copy must be rejected");
        let _ = std::fs::remove_dir_all(&root);
    }
}
