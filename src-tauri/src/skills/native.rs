// Read ~/.claude/skills/<dir>/ — SKILL.md plus resources nested under
// scripts/, references/, or assets/. Mirrors what `~/.claude/skills/` looks
// like on disk for Claude Code, so a skill written by Claude Code is
// discoverable verbatim, and a skill we push out is discoverable by Claude
// Code without further conversion.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::types::{NativeSkill, NativeSkillResource};

const MAX_RESOURCE_BYTES: u64 = 2 * 1024 * 1024; // 2 MB per file
const MAX_RESOURCES_PER_SKILL: usize = 50;

/// Walk a single skill directory. Returns `None` if there's no SKILL.md.
pub fn read_skill_dir(dir: &Path) -> Option<NativeSkill> {
    let skill_md = dir.join("SKILL.md");
    if !skill_md.is_file() {
        return None;
    }
    let dir_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    if dir_name.is_empty() {
        return None;
    }
    let content = std::fs::read_to_string(&skill_md).ok()?;
    let mut resources: Vec<NativeSkillResource> = Vec::new();
    let kinds: [(&str, &str); 3] = [
        ("scripts", "script"),
        ("references", "reference"),
        ("assets", "asset"),
    ];
    for (subdir, kind) in kinds {
        let sub = dir.join(subdir);
        if !sub.is_dir() {
            continue;
        }
        walk_resources(&sub, &sub, kind, &mut resources);
        if resources.len() >= MAX_RESOURCES_PER_SKILL {
            break;
        }
    }
    Some(NativeSkill {
        dir_name,
        file_path: skill_md.to_string_lossy().to_string(),
        content,
        resources,
    })
}

fn walk_resources(start: &Path, root: &Path, kind: &str, out: &mut Vec<NativeSkillResource>) {
    let entries = match std::fs::read_dir(start) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_RESOURCES_PER_SKILL {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_resources(&path, root, kind, out);
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = meta.len();
        let rel = match path.strip_prefix(root.parent().unwrap_or(root)) {
            Ok(r) => r.to_path_buf(),
            Err(_) => continue,
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let mime_type = guess_mime(&path);
        let (content, encoding) = if size > MAX_RESOURCE_BYTES {
            (String::new(), "utf-8".to_string())
        } else if is_text(&path) {
            match std::fs::read_to_string(&path) {
                Ok(s) => (s, "utf-8".to_string()),
                Err(_) => continue,
            }
        } else {
            match std::fs::read(&path) {
                Ok(bytes) => (base64_encode(&bytes), "base64".to_string()),
                Err(_) => continue,
            }
        };
        out.push(NativeSkillResource {
            kind: kind.to_string(),
            path: rel_str,
            name,
            content,
            encoding,
            mime_type,
            size,
        });
    }
}

fn is_text(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "md" | "txt"
            | "json"
            | "yaml"
            | "yml"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "py"
            | "rs"
            | "go"
            | "java"
            | "rb"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "html"
            | "htm"
            | "css"
            | "scss"
            | "toml"
            | "ini"
            | "csv"
    )
}

fn guess_mime(path: &Path) -> Option<String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "md" => "text/markdown",
        "json" => "application/json",
        "yaml" | "yml" => "text/yaml",
        "py" => "text/x-python",
        "ts" | "tsx" => "text/typescript",
        "js" | "jsx" => "text/javascript",
        "sh" | "bash" => "application/x-shellscript",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => return None,
    };
    Some(mime.to_string())
}

/// Light base64 encoder — avoids pulling in a dep just for this. The
/// frontend only ever decodes resources we wrote, so consistency matters
/// more than RFC compliance.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
        out.push(TABLE[(n & 0x3F) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
        out.push('=');
    }
    out
}

/// Walk a directory of skill subdirectories — typically `~/.claude/skills/`
/// or a user-supplied folder via the discovery flow. Returns the parsed
/// skills with their resources.
#[tauri::command]
pub fn skills_scan_dir(path: String) -> Result<Vec<NativeSkill>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let entries =
        std::fs::read_dir(&root).map_err(|e| format!("read_dir {}: {}", root.display(), e))?;
    let mut out: Vec<NativeSkill> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(skill) = read_skill_dir(&path) {
            out.push(skill);
        }
    }
    out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    Ok(out)
}

/// Resolve `~/.claude/skills/` and scan it. Empty Vec when the directory
/// doesn't exist (e.g., user has never used Claude Code).
#[tauri::command]
pub fn skills_scan_native() -> Result<Vec<NativeSkill>, String> {
    let Some(home) = dirs::home_dir() else {
        return Err("could not resolve home directory".into());
    };
    let dir = home.join(".claude").join("skills");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    skills_scan_dir(dir.to_string_lossy().to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UninstallResult {
    pub removed: bool,
    pub directory: String,
}

/// Remove `~/.claude/skills/<dir_name>/` recursively. The frontend should
/// confirm with the user first; this command does no extra prompting.
#[tauri::command]
pub fn skills_uninstall_native(dir_name: String) -> Result<UninstallResult, String> {
    if dir_name.contains('/') || dir_name.contains('\\') || dir_name.contains("..") {
        return Err(format!("invalid dir_name: {}", dir_name));
    }
    let Some(home) = dirs::home_dir() else {
        return Err("could not resolve home directory".into());
    };
    let dir = home.join(".claude").join("skills").join(&dir_name);
    if !dir.is_dir() {
        return Ok(UninstallResult {
            removed: false,
            directory: dir.to_string_lossy().to_string(),
        });
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("rmdir {}: {}", dir.display(), e))?;
    Ok(UninstallResult {
        removed: true,
        directory: dir.to_string_lossy().to_string(),
    })
}
