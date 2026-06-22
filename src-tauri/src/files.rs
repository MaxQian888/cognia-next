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

/// Shadow-mode gate: log (but do not block) a raw fs op that escapes the
/// registered roots. The `op`/`path` marker lets the diagnostics log surface
/// real out-of-root accesses ahead of a future enforce-mode flip.
fn shadow_check_path(path: &str, op: &str) {
    if !is_path_allowed(path) {
        log::warn!(
            "fs_shadow_denial op={op} path={path} — outside registered roots (allowed in shadow mode)"
        );
    }
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
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    shadow_check_path(&path, "read_text_file");
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path, e))
}

/// Write a text file at the given absolute path, creating parent
/// directories as needed. Shadow-mode containment logs out-of-root writes.
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    shadow_check_path(&path, "write_text_file");
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
/// Shadow-mode containment logs out-of-root directory creation.
#[tauri::command]
pub fn ensure_dir(path: String) -> Result<(), String> {
    shadow_check_path(&path, "ensure_dir");
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
/// files. Returns an empty list when the directory doesn't exist.
#[tauri::command]
pub fn scan_claude_skills() -> Result<Vec<DiscoveredSkill>, String> {
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
pub fn read_claude_user_config() -> Result<serde_json::Value, String> {
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
        let size = if is_dir {
            0
        } else {
            dent.metadata().map(|m| m.len()).unwrap_or(0)
        };
        out.push(WorkspaceEntry {
            rel_path: rel_str,
            absolute_path: path.to_string_lossy().to_string(),
            is_dir,
            size,
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
        write_text_file(path.clone(), "hello".into()).unwrap();
        assert_eq!(read_text_file(path.clone()).unwrap(), "hello");
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
        write_text_file(path.clone(), "x".into()).unwrap();
        assert!(std::path::Path::new(&path).is_file());
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn scan_returns_empty_when_no_dir() {
        // Can't really test the real ~/.claude/skills; just ensure it returns
        // a Vec without panicking. The function's branch for missing dir is
        // already covered by the empty case if the user has no dir.
        let _ = scan_claude_skills();
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
}
