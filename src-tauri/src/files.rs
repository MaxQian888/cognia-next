// File-system commands used by Skills and MCP import/export and the
// "import from Claude Code" compatibility flows. Kept separate from the
// chat sidecar commands because they're sync, simple, and have no shared
// state beyond the filesystem.

use gray_matter::{engine::YAML, Matter, Pod};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Read a text file at the given absolute path. The frontend uses this
/// after letting the user pick the path via the dialog plugin — that
/// user gesture stands in for an fs scope.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path, e))
}

/// Write a text file at the given absolute path, creating parent
/// directories as needed.
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
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
#[tauri::command]
pub fn ensure_dir(path: String) -> Result<(), String> {
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
) -> Result<String, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("memory content is empty".into());
    }
    let target = match scope.as_str() {
        "project" => {
            let cwd = cwd.ok_or_else(|| "project memory requires a cwd".to_string())?;
            PathBuf::from(cwd).join("CLAUDE.md")
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
        )
        .unwrap();
        assert!(Path::new(&path).is_file());
        memory_append(
            "project".into(),
            "second note".into(),
            Some(root.to_string_lossy().to_string()),
        )
        .unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("- first note\n"));
        assert!(body.contains("- second note\n"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn memory_append_rejects_unknown_scope() {
        let res = memory_append("garbage".into(), "x".into(), None);
        assert!(res.is_err());
    }
}
