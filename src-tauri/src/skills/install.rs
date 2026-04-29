// Install a skill into ~/.claude/skills/<dir_name>/. The frontend serializes
// the SKILL.md (frontmatter + body) and resource list, and we materialise
// the on-disk layout — `scripts/`, `references/`, `assets/` subdirs based
// on each resource's kind. Used by the "push to native" sync flow + the
// marketplace install action.

use std::path::{Path, PathBuf};

use super::types::{InstallSkillRequest, InstallSkillResponse, NativeSkillResource};

const ALLOWED_DIR_CHARS: &[char] = &['-', '_'];

fn validate_dir_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("dir_name is empty".into());
    }
    if name.len() > 64 {
        return Err("dir_name too long (max 64)".into());
    }
    for c in name.chars() {
        if !c.is_ascii_alphanumeric() && !ALLOWED_DIR_CHARS.contains(&c) {
            return Err(format!("invalid character in dir_name: {}", c));
        }
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err("dir_name cannot start or end with '-'".into());
    }
    Ok(())
}

fn validate_resource_path(rel: &str) -> Result<(), String> {
    if rel.is_empty() || rel.contains("..") {
        return Err(format!("invalid resource path: {}", rel));
    }
    for component in rel.split(['/', '\\']) {
        if component.is_empty() || component == "." {
            return Err(format!("invalid resource path: {}", rel));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn skills_install_native(request: InstallSkillRequest) -> Result<InstallSkillResponse, String> {
    validate_dir_name(&request.dir_name)?;
    let Some(home) = dirs::home_dir() else {
        return Err("could not resolve home directory".into());
    };
    let dir = home.join(".claude").join("skills").join(&request.dir_name);

    if request.clean && dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("rmdir {}: {}", dir.display(), e))?;
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;

    // Write SKILL.md.
    let skill_md = dir.join("SKILL.md");
    std::fs::write(&skill_md, &request.content)
        .map_err(|e| format!("write {}: {}", skill_md.display(), e))?;
    let mut written: Vec<String> = vec![skill_md.to_string_lossy().to_string()];

    // Write resources, putting unspecified-subdir paths under the kind's
    // default folder (scripts/ / references/ / assets/).
    for r in &request.resources {
        validate_resource_path(&r.path)?;
        let target = resolve_resource_path(&dir, r);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
        write_resource(&target, r)?;
        written.push(target.to_string_lossy().to_string());
    }

    Ok(InstallSkillResponse {
        directory: dir.to_string_lossy().to_string(),
        written_files: written,
    })
}

fn resolve_resource_path(skill_dir: &Path, r: &NativeSkillResource) -> PathBuf {
    // Accept paths that already include scripts/references/assets/, otherwise
    // prepend the matching subdir based on `kind`.
    let prefix = match r.kind.as_str() {
        "script" => "scripts",
        "reference" => "references",
        "asset" => "assets",
        _ => "files",
    };
    let p = r.path.as_str();
    if p.starts_with("scripts/") || p.starts_with("references/") || p.starts_with("assets/") {
        skill_dir.join(p)
    } else {
        skill_dir.join(prefix).join(p)
    }
}

fn write_resource(target: &Path, r: &NativeSkillResource) -> Result<(), String> {
    if r.encoding == "base64" {
        let bytes = base64_decode(&r.content)?;
        std::fs::write(target, &bytes).map_err(|e| format!("write {}: {}", target.display(), e))?;
    } else {
        std::fs::write(target, &r.content)
            .map_err(|e| format!("write {}: {}", target.display(), e))?;
    }
    Ok(())
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut buf = Vec::with_capacity(input.len() * 3 / 4);
    let mut accum: u32 = 0;
    let mut bits = 0;
    for c in input.chars() {
        if c == '=' {
            break;
        }
        if c.is_ascii_whitespace() {
            continue;
        }
        let v = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            _ => return Err(format!("invalid base64 character: {}", c)),
        };
        accum = (accum << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push(((accum >> bits) & 0xFF) as u8);
        }
    }
    Ok(buf)
}
