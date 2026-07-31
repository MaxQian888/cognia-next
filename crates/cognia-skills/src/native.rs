// Read ~/.claude/skills/<dir>/ — SKILL.md plus resources nested under
// scripts/, references/, or assets/. Mirrors what `~/.claude/skills/` looks
// like on disk for Claude Code, so a skill written by Claude Code is
// discoverable verbatim, and a skill we push out is discoverable by Claude
// Code without further conversion.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::{NativeSkill, NativeSkillResource};

const MAX_RESOURCE_BYTES: u64 = 2 * 1024 * 1024; // 2 MB per file
const MAX_RESOURCES_PER_SKILL: usize = 50;

/// Convert a `SystemTime` to milliseconds since UNIX epoch. Returns 0 for
/// pre-epoch / unreadable values so the frontend can treat that as
/// "unknown — pull conservatively".
fn system_time_to_millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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
    let mtime_ms = std::fs::metadata(&skill_md)
        .and_then(|m| m.modified())
        .map(system_time_to_millis)
        .unwrap_or(0);
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
        mtime_ms,
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
        // Reject symlinks unconditionally — a `scripts/inner → /etc` link
        // would otherwise leak files from outside the skill directory into
        // the resource bundle. `symlink_metadata` reports the link itself
        // (not the target) so we can check `file_type().is_symlink()`.
        let symlink_meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if symlink_meta.file_type().is_symlink() {
            continue;
        }
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

/// Resolve `~/.agents/skills/` (the Codex CLI default) and scan it. Empty
/// Vec when the directory doesn't exist — Codex CLI may simply not be
/// installed.
#[tauri::command]
pub fn skills_scan_codex() -> Result<Vec<NativeSkill>, String> {
    let Some(home) = dirs::home_dir() else {
        return Err("could not resolve home directory".into());
    };
    let dir = home.join(".agents").join("skills");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    skills_scan_dir(dir.to_string_lossy().to_string())
}

/// Move a cognia-owned skill directory at
/// `<appData>/cognia/skills/<dir_name>/` into the trash subdirectory at
/// `<appData>/cognia/skills/.trash/<dir_name>-<ts>/`. Returns the new path.
///
/// Used by the bundle-import flow when a re-import would overwrite an
/// existing copy: the prior copy goes to trash so the user can manually
/// recover via the Settings → Skills → Empty Trash button. No background
/// retention sweep is run; the trash grows until the user clears it.
#[tauri::command]
pub fn skills_move_to_trash(app: tauri::AppHandle, dir_name: String) -> Result<String, String> {
    if dir_name.contains('/') || dir_name.contains('\\') || dir_name.contains("..") {
        return Err(format!("invalid dir_name: {}", dir_name));
    }
    use tauri::Manager;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?;
    let cognia_root = app_data.join("cognia").join("skills");
    let target = cognia_root.join(&dir_name);
    if !target.is_dir() {
        return Err(format!("skill dir not found: {}", target.display()));
    }
    let trash_root = cognia_root.join(".trash");
    std::fs::create_dir_all(&trash_root)
        .map_err(|e| format!("mkdir {}: {}", trash_root.display(), e))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = trash_root.join(format!("{}-{}", dir_name, stamp));
    std::fs::rename(&target, &dest)
        .map_err(|e| format!("trash mv {} -> {}: {}", target.display(), dest.display(), e))?;
    Ok(dest.to_string_lossy().to_string())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(prefix: &str) -> PathBuf {
        // Each test gets its own subdirectory under the OS temp so concurrent
        // runs don't trample each other. Uses (pid + nanoseconds since epoch)
        // for uniqueness — keep it simple, no extra deps.
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!(
            "cognia-skills-{}-{}-{}",
            prefix,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&p).expect("create temp dir");
        p
    }

    #[test]
    fn system_time_to_millis_zero_for_unix_epoch() {
        assert_eq!(system_time_to_millis(UNIX_EPOCH), 0);
    }

    #[test]
    fn system_time_to_millis_positive_for_now() {
        let now = SystemTime::now();
        let ms = system_time_to_millis(now);
        // After Jan 1 2000.
        assert!(ms > 946_684_800_000);
    }

    #[test]
    fn is_text_recognises_common_extensions() {
        assert!(is_text(Path::new("a.md")));
        assert!(is_text(Path::new("a.txt")));
        assert!(is_text(Path::new("a.JSON"))); // case-insensitive
        assert!(is_text(Path::new("a.ts")));
        assert!(is_text(Path::new("a.tsx")));
        assert!(is_text(Path::new("a.py")));
        assert!(is_text(Path::new("a.rs")));
        assert!(is_text(Path::new("a.sh")));
    }

    #[test]
    fn is_text_rejects_binary_and_unknown() {
        assert!(!is_text(Path::new("a.png")));
        assert!(!is_text(Path::new("a.bin")));
        assert!(!is_text(Path::new("a.exe")));
        assert!(!is_text(Path::new("no-ext")));
    }

    #[test]
    fn guess_mime_returns_known_types() {
        assert_eq!(
            guess_mime(Path::new("a.md")).as_deref(),
            Some("text/markdown")
        );
        assert_eq!(
            guess_mime(Path::new("a.json")).as_deref(),
            Some("application/json")
        );
        assert_eq!(
            guess_mime(Path::new("a.YAML")).as_deref(),
            Some("text/yaml")
        );
        assert_eq!(guess_mime(Path::new("a.png")).as_deref(), Some("image/png"));
        assert!(guess_mime(Path::new("a.unknown")).is_none());
    }

    #[test]
    fn base64_encode_round_trip_three_bytes() {
        assert_eq!(base64_encode(b"Man"), "TWFu");
    }

    #[test]
    fn base64_encode_pads_one_byte() {
        // "M" -> "TQ=="
        assert_eq!(base64_encode(b"M"), "TQ==");
    }

    #[test]
    fn base64_encode_pads_two_bytes() {
        // "Ma" -> "TWE="
        assert_eq!(base64_encode(b"Ma"), "TWE=");
    }

    #[test]
    fn base64_encode_empty() {
        assert_eq!(base64_encode(b""), "");
    }

    #[test]
    fn read_skill_dir_returns_none_for_missing_skill_md() {
        let dir = temp_dir("no-skill-md");
        assert!(read_skill_dir(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_skill_dir_reads_minimal_skill() {
        let dir = temp_dir("minimal");
        let skill = dir.join("alpha");
        fs::create_dir_all(&skill).expect("create");
        fs::write(skill.join("SKILL.md"), "---\nname: Alpha\n---\nbody").expect("write");
        let result = read_skill_dir(&skill).expect("Some");
        assert_eq!(result.dir_name, "alpha");
        assert!(result.content.contains("name: Alpha"));
        assert_eq!(result.resources.len(), 0);
        // mtime is populated from filesystem metadata.
        assert!(result.mtime_ms > 0, "mtime should be populated");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_skill_dir_collects_resources_by_kind() {
        let dir = temp_dir("resources");
        let skill = dir.join("beta");
        fs::create_dir_all(skill.join("scripts")).expect("create");
        fs::create_dir_all(skill.join("references")).expect("create");
        fs::write(skill.join("SKILL.md"), "---\nname: Beta\n---\nbody").expect("write");
        fs::write(skill.join("scripts").join("run.sh"), "echo hi").expect("write");
        fs::write(skill.join("references").join("notes.md"), "# notes").expect("write");
        let result = read_skill_dir(&skill).expect("Some");
        assert_eq!(result.resources.len(), 2);
        let kinds: Vec<&str> = result.resources.iter().map(|r| r.kind.as_str()).collect();
        assert!(kinds.contains(&"script"));
        assert!(kinds.contains(&"reference"));
        // Every resource has a non-empty path beginning with its subdir.
        for r in &result.resources {
            assert!(r.path.starts_with("scripts/") || r.path.starts_with("references/"));
            assert!(!r.path.contains('\\'), "paths must use forward slashes");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_skill_dir_caps_at_max_resources() {
        let dir = temp_dir("caps");
        let skill = dir.join("gamma");
        fs::create_dir_all(skill.join("scripts")).expect("create");
        fs::write(skill.join("SKILL.md"), "---\nname: Gamma\n---\nbody").expect("write");
        // Write more than the cap; walker should stop early.
        for i in 0..(MAX_RESOURCES_PER_SKILL + 5) {
            fs::write(skill.join("scripts").join(format!("f{}.sh", i)), "x").expect("write");
        }
        let result = read_skill_dir(&skill).expect("Some");
        assert!(result.resources.len() <= MAX_RESOURCES_PER_SKILL);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_skill_dir_handles_large_binary_resource() {
        let dir = temp_dir("large");
        let skill = dir.join("delta");
        fs::create_dir_all(skill.join("assets")).expect("create");
        fs::write(skill.join("SKILL.md"), "---\nname: Delta\n---\nbody").expect("write");
        // Write a file larger than MAX_RESOURCE_BYTES; walker should record it
        // but with empty content (the cap-skip path at `:84-85`).
        let large = vec![0u8; (MAX_RESOURCE_BYTES + 1) as usize];
        fs::write(skill.join("assets").join("big.bin"), &large).expect("write");
        let result = read_skill_dir(&skill).expect("Some");
        let asset = result
            .resources
            .iter()
            .find(|r| r.name == "big.bin")
            .expect("asset row");
        assert_eq!(asset.content, "");
        assert!(asset.size > MAX_RESOURCE_BYTES);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_skill_dir_base64_encodes_binary() {
        let dir = temp_dir("binary");
        let skill = dir.join("eps");
        fs::create_dir_all(skill.join("assets")).expect("create");
        fs::write(skill.join("SKILL.md"), "---\nname: Eps\n---\nbody").expect("write");
        fs::write(skill.join("assets").join("logo.png"), b"\x89PNG\r\n").expect("write");
        let result = read_skill_dir(&skill).expect("Some");
        let asset = result
            .resources
            .iter()
            .find(|r| r.name == "logo.png")
            .unwrap();
        assert_eq!(asset.encoding, "base64");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn read_skill_dir_rejects_symlinks_in_resource_walker() {
        use std::os::unix::fs::symlink;
        let dir = temp_dir("symlink");
        let skill = dir.join("zeta");
        fs::create_dir_all(skill.join("scripts")).expect("create");
        fs::write(skill.join("SKILL.md"), "---\nname: Zeta\n---\nbody").expect("write");
        // Write a real script + a symlink. The walker must include the real
        // file and skip the symlink (security: a symlink could point outside
        // the skill dir).
        fs::write(skill.join("scripts").join("real.sh"), "echo real").expect("write");
        let outside = temp_dir("symlink-target");
        let target = outside.join("evil.sh");
        fs::write(&target, "echo evil").expect("write");
        symlink(&target, skill.join("scripts").join("link.sh")).expect("symlink");
        let result = read_skill_dir(&skill).expect("Some");
        let names: Vec<&str> = result.resources.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"real.sh"));
        assert!(!names.contains(&"link.sh"), "symlink must be skipped");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn skills_scan_dir_returns_empty_for_missing_path() {
        let p = std::env::temp_dir().join(format!("cognia-skills-missing-{}", std::process::id()));
        let result = skills_scan_dir(p.to_string_lossy().to_string()).expect("ok");
        assert!(result.is_empty());
    }

    #[test]
    fn skills_scan_dir_sorts_by_dir_name() {
        let root = temp_dir("scan-dir");
        for name in ["c-skill", "a-skill", "b-skill"] {
            let s = root.join(name);
            fs::create_dir_all(&s).expect("create");
            fs::write(
                s.join("SKILL.md"),
                format!("---\nname: {}\n---\nbody", name),
            )
            .expect("write");
        }
        let result = skills_scan_dir(root.to_string_lossy().to_string()).expect("ok");
        let names: Vec<&str> = result.iter().map(|r| r.dir_name.as_str()).collect();
        assert_eq!(names, vec!["a-skill", "b-skill", "c-skill"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skills_uninstall_native_rejects_path_traversal() {
        assert!(skills_uninstall_native("../etc".to_string()).is_err());
        assert!(skills_uninstall_native("a/b".to_string()).is_err());
        assert!(skills_uninstall_native("a\\b".to_string()).is_err());
    }

    #[test]
    fn skills_uninstall_native_no_op_when_dir_absent() {
        let nonexistent = format!("cognia-skills-uninstall-test-{}", std::process::id());
        let result = skills_uninstall_native(nonexistent).expect("ok");
        assert!(!result.removed);
    }
}
