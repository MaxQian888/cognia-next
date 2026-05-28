// Install a skill onto disk. The frontend serializes the SKILL.md
// (frontmatter + body) and resource list, and we materialise the on-disk
// layout — `scripts/`, `references/`, `assets/` subdirs based on each
// resource's kind.
//
// Two surfaces:
//
//   1. `skills_install_native` — legacy single-target writer for
//      `~/.claude/skills/<dir_name>/`. Kept as a thin wrapper so existing
//      callers (marketplace install, the per-skill push button) keep
//      working without a sweep.
//   2. `skills_install_mirrored` — the bundle-loader pipeline. Writes the
//      same SKILL.md + resources to one or more `SkillsTarget`s
//      (cognia-owned canonical, Claude CLI mirror, Codex CLI mirror) in
//      one shot, with an optional trash-before-clean step for the
//      cognia target.
//
// The actual file writing lives in `write_skill_into_dir`, called from
// both entry points so the existing validation + base64 logic doesn't
// drift between the two paths.

use serde::{Deserialize, Serialize};
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
    let written = write_skill_into_dir(
        &dir,
        &request.content,
        &request.resources,
        request.clean,
    )?;
    Ok(InstallSkillResponse {
        directory: dir.to_string_lossy().to_string(),
        written_files: written,
    })
}

/// Skill bundle mirror target. The cognia-owned canonical is always
/// writeable regardless of user settings; the other two are toggleable per
/// `AppSettings.skillBundleMirrors`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillsTarget {
    Cognia,
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillMirroredRequest {
    pub dir_name: String,
    pub content: String,
    pub resources: Vec<NativeSkillResource>,
    pub clean: bool,
    /// Targets to write. When empty, defaults to all three so a caller
    /// that forgets to populate the field still gets the documented
    /// behaviour.
    #[serde(default)]
    pub targets: Vec<SkillsTarget>,
    /// When true and the cognia target's existing dir is present, the
    /// prior copy is moved to `<appData>/cognia/skills/.trash/<dir>-<ts>/`
    /// before being cleared. Set by the bundle upsert step when the
    /// fingerprint changed.
    #[serde(default)]
    pub trash_before_clean: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillMirroredResponse {
    pub targets: Vec<MirrorTargetOutcome>,
    /// Path of the cognia copy moved to `.trash/` when applicable.
    pub trashed_from: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorTargetOutcome {
    pub target: SkillsTarget,
    pub directory: String,
    pub written_files: Vec<String>,
    /// Set when a target was requested but skipped silently (e.g. no
    /// home dir). The frontend surfaces this as an info toast.
    pub note: Option<String>,
}

fn resolve_target_root(
    target: SkillsTarget,
    app: &tauri::AppHandle,
) -> Result<Option<PathBuf>, String> {
    use tauri::Manager;
    match target {
        SkillsTarget::Cognia => {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir: {}", e))?;
            Ok(Some(app_data.join("cognia").join("skills")))
        }
        SkillsTarget::Claude => {
            let Some(home) = dirs::home_dir() else {
                return Ok(None);
            };
            Ok(Some(home.join(".claude").join("skills")))
        }
        SkillsTarget::Codex => {
            let Some(home) = dirs::home_dir() else {
                return Ok(None);
            };
            Ok(Some(home.join(".agents").join("skills")))
        }
    }
}

fn timestamp_iso_ish() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

/// Multi-target install. Writes the supplied SKILL.md + resources into
/// every requested target, optionally moving the prior cognia copy to
/// `.trash/` first. Per-target failures other than "no home directory"
/// bubble as `Err` so the frontend can show the user what went wrong
/// rather than silently dropping a mirror.
#[tauri::command]
pub fn skills_install_mirrored(
    app: tauri::AppHandle,
    request: InstallSkillMirroredRequest,
) -> Result<InstallSkillMirroredResponse, String> {
    validate_dir_name(&request.dir_name)?;
    let targets = if request.targets.is_empty() {
        vec![SkillsTarget::Cognia, SkillsTarget::Claude, SkillsTarget::Codex]
    } else {
        request.targets.clone()
    };

    let mut outcomes: Vec<MirrorTargetOutcome> = Vec::with_capacity(targets.len());
    let mut trashed_from: Option<String> = None;
    let mut cognia_dir: Option<PathBuf> = None;

    for target in targets {
        let root_opt = resolve_target_root(target, &app)?;
        let Some(root) = root_opt else {
            outcomes.push(MirrorTargetOutcome {
                target,
                directory: String::new(),
                written_files: Vec::new(),
                note: Some("home directory unavailable; mirror skipped".into()),
            });
            continue;
        };
        let dir = root.join(&request.dir_name);

        // Cognia target carries the canonical trash flow. Other mirrors
        // overwrite directly because they are throwaway projections of the
        // cognia state.
        if matches!(target, SkillsTarget::Cognia)
            && request.trash_before_clean
            && dir.exists()
        {
            let trash_root = root.join(".trash");
            std::fs::create_dir_all(&trash_root)
                .map_err(|e| format!("mkdir {}: {}", trash_root.display(), e))?;
            let stamped = format!("{}-{}", &request.dir_name, timestamp_iso_ish());
            let trash_path = trash_root.join(&stamped);
            std::fs::rename(&dir, &trash_path).map_err(|e| {
                format!(
                    "trash mv {} -> {}: {}",
                    dir.display(),
                    trash_path.display(),
                    e
                )
            })?;
            trashed_from = Some(trash_path.to_string_lossy().to_string());
        }

        // Cognia is the canonical home; everything is written there
        // verbatim. Claude / Codex are projections — symlink them at the
        // cognia copy on Unix to keep one source of truth, copy on
        // Windows to stay admin-free.
        let written = if matches!(target, SkillsTarget::Cognia) {
            let w = write_skill_into_dir(
                &dir,
                &request.content,
                &request.resources,
                request.clean,
            )?;
            cognia_dir = Some(dir.clone());
            w
        } else if let Some(source) = cognia_dir.as_ref() {
            link_or_copy_mirror(source, &dir)?
        } else {
            // Cognia wasn't requested — fall back to a fresh copy so the
            // mirror still lands somewhere usable.
            write_skill_into_dir(
                &dir,
                &request.content,
                &request.resources,
                request.clean,
            )?
        };

        outcomes.push(MirrorTargetOutcome {
            target,
            directory: dir.to_string_lossy().to_string(),
            written_files: written,
            note: None,
        });
    }

    Ok(InstallSkillMirroredResponse {
        targets: outcomes,
        trashed_from,
    })
}

/// Mirror the cognia canonical at a sibling root by either symlinking the
/// whole directory (Unix) or copying the tree (Windows / symlink failure).
/// Symlinks keep Claude Code / Codex CLI seeing exactly what cognia owns,
/// at the cost of edits from those CLIs writing back into the cognia copy
/// — which is the documented design.
fn link_or_copy_mirror(source: &Path, dest: &Path) -> Result<Vec<String>, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    if dest.exists() || dest.symlink_metadata().is_ok() {
        // Pre-existing target — could be a copy (regular dir) or a stale
        // symlink. Either way the safe move is to clear it before the
        // re-link / re-copy so the mirror reflects current cognia state.
        if dest.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            std::fs::remove_file(dest)
                .map_err(|e| format!("unlink {}: {}", dest.display(), e))?;
        } else if dest.is_dir() {
            std::fs::remove_dir_all(dest)
                .map_err(|e| format!("rmdir {}: {}", dest.display(), e))?;
        }
    }

    #[cfg(unix)]
    {
        match std::os::unix::fs::symlink(source, dest) {
            Ok(()) => return Ok(vec![dest.to_string_lossy().to_string()]),
            Err(e) => {
                // Fall through to copy below if the symlink call fails
                // (e.g. cross-filesystem on some exotic mount).
                eprintln!(
                    "[skills] symlink {} -> {} failed ({}); falling back to copy",
                    dest.display(),
                    source.display(),
                    e
                );
            }
        }
    }

    let mut written: Vec<String> = Vec::new();
    copy_tree(source, dest, &mut written)?;
    Ok(written)
}

fn copy_tree(source: &Path, dest: &Path, written: &mut Vec<String>) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir {}: {}", dest.display(), e))?;
    let entries = std::fs::read_dir(source)
        .map_err(|e| format!("read_dir {}: {}", source.display(), e))?;
    for entry in entries.flatten() {
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dest.join(&file_name);
        let ft = entry
            .file_type()
            .map_err(|e| format!("file_type {}: {}", src_path.display(), e))?;
        if ft.is_dir() {
            copy_tree(&src_path, &dest_path, written)?;
        } else {
            std::fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("copy {}: {}", src_path.display(), e))?;
            written.push(dest_path.to_string_lossy().to_string());
        }
    }
    Ok(())
}

/// Remove every skill copy under `<appData>/cognia/skills/.trash/`. Used
/// by the Settings → Skills → Empty Trash button. Returns the number of
/// directories removed.
#[tauri::command]
pub fn skills_empty_trash(app: tauri::AppHandle) -> Result<usize, String> {
    use tauri::Manager;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?;
    let trash = app_data.join("cognia").join("skills").join(".trash");
    if !trash.is_dir() {
        return Ok(0);
    }
    let entries = std::fs::read_dir(&trash)
        .map_err(|e| format!("read_dir {}: {}", trash.display(), e))?;
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Err(e) = std::fs::remove_dir_all(&path) {
                return Err(format!("rmdir {}: {}", path.display(), e));
            }
            removed += 1;
        }
    }
    Ok(removed)
}

/// List every trashed skill copy under
/// `<appData>/cognia/skills/.trash/`. Returns the `<name>-<ts>` basenames
/// so the UI can render a count + offer the empty-trash button.
#[tauri::command]
pub fn skills_list_trash(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?;
    let trash = app_data.join("cognia").join("skills").join(".trash");
    if !trash.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<String> = std::fs::read_dir(&trash)
        .map_err(|e| format!("read_dir {}: {}", trash.display(), e))?
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .collect();
    entries.sort();
    Ok(entries)
}

/// Write a serialized skill (SKILL.md + resources) into a specific
/// directory. Shared by `skills_install_native` and the multi-target
/// `skills_install_mirrored` so the validation + write logic stays in
/// one place.
fn write_skill_into_dir(
    dir: &Path,
    content: &str,
    resources: &[NativeSkillResource],
    clean: bool,
) -> Result<Vec<String>, String> {
    if clean && dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| format!("rmdir {}: {}", dir.display(), e))?;
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;

    let skill_md = dir.join("SKILL.md");
    std::fs::write(&skill_md, content)
        .map_err(|e| format!("write {}: {}", skill_md.display(), e))?;
    let mut written: Vec<String> = vec![skill_md.to_string_lossy().to_string()];

    for r in resources {
        validate_resource_path(&r.path)?;
        let target = resolve_resource_path(dir, r);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
        write_resource(&target, r)?;
        // Best-effort chmod on Unix so scripts/ are executable when Bash
        // picks them up. Windows ignores file modes; no-op there.
        #[cfg(unix)]
        if r.kind == "script" {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&target) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&target, perms);
            }
        }
        written.push(target.to_string_lossy().to_string());
    }

    Ok(written)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_dir_name_accepts_kebab_case() {
        assert!(validate_dir_name("my-skill").is_ok());
        assert!(validate_dir_name("Skill_v2").is_ok());
        assert!(validate_dir_name("a").is_ok());
    }

    #[test]
    fn validate_dir_name_rejects_empty() {
        assert!(validate_dir_name("").is_err());
    }

    #[test]
    fn validate_dir_name_rejects_too_long() {
        let long = "a".repeat(65);
        assert!(validate_dir_name(&long).is_err());
    }

    #[test]
    fn validate_dir_name_rejects_leading_or_trailing_dash() {
        assert!(validate_dir_name("-skill").is_err());
        assert!(validate_dir_name("skill-").is_err());
    }

    #[test]
    fn validate_dir_name_rejects_invalid_chars() {
        assert!(validate_dir_name("../etc").is_err());
        assert!(validate_dir_name("with space").is_err());
        assert!(validate_dir_name("with/slash").is_err());
        assert!(validate_dir_name("with\\bs").is_err());
        assert!(validate_dir_name("with.dot").is_err());
    }

    #[test]
    fn validate_resource_path_rejects_traversal() {
        assert!(validate_resource_path("..").is_err());
        assert!(validate_resource_path("foo/../bar").is_err());
        assert!(validate_resource_path("../etc/passwd").is_err());
    }

    #[test]
    fn validate_resource_path_rejects_empty_components() {
        assert!(validate_resource_path("").is_err());
        assert!(validate_resource_path("foo//bar").is_err());
        assert!(validate_resource_path("foo/./bar").is_err());
    }

    #[test]
    fn validate_resource_path_accepts_normal_paths() {
        assert!(validate_resource_path("scripts/foo.sh").is_ok());
        assert!(validate_resource_path("references/notes.md").is_ok());
        assert!(validate_resource_path("assets/logo.png").is_ok());
        assert!(validate_resource_path("nested/deep/path.txt").is_ok());
    }

    #[test]
    fn resolve_resource_path_prepends_kind_subdir() {
        let dir = PathBuf::from("/skills/x");
        let r = NativeSkillResource {
            kind: "script".to_string(),
            path: "foo.sh".to_string(),
            name: "foo".to_string(),
            content: String::new(),
            encoding: "utf-8".to_string(),
            mime_type: None,
            size: 0,
        };
        assert_eq!(
            resolve_resource_path(&dir, &r),
            PathBuf::from("/skills/x/scripts/foo.sh")
        );
    }

    #[test]
    fn resolve_resource_path_preserves_explicit_prefix() {
        let dir = PathBuf::from("/skills/x");
        let r = NativeSkillResource {
            kind: "reference".to_string(),
            path: "scripts/already.sh".to_string(),
            name: "already".to_string(),
            content: String::new(),
            encoding: "utf-8".to_string(),
            mime_type: None,
            size: 0,
        };
        assert_eq!(
            resolve_resource_path(&dir, &r),
            PathBuf::from("/skills/x/scripts/already.sh")
        );
    }

    #[test]
    fn resolve_resource_path_falls_back_for_unknown_kind() {
        let dir = PathBuf::from("/skills/x");
        let r = NativeSkillResource {
            kind: "weird".to_string(),
            path: "blob".to_string(),
            name: "b".to_string(),
            content: String::new(),
            encoding: "utf-8".to_string(),
            mime_type: None,
            size: 0,
        };
        assert_eq!(
            resolve_resource_path(&dir, &r),
            PathBuf::from("/skills/x/files/blob")
        );
    }

    #[test]
    fn base64_decode_round_trip_ascii() {
        // "Hello" -> SGVsbG8=
        assert_eq!(base64_decode("SGVsbG8=").unwrap(), b"Hello");
    }

    #[test]
    fn base64_decode_handles_whitespace() {
        assert_eq!(base64_decode("SGVs\nbG8=").unwrap(), b"Hello");
    }

    #[test]
    fn base64_decode_rejects_invalid_chars() {
        assert!(base64_decode("@@@@").is_err());
    }

    #[test]
    fn base64_decode_empty_string() {
        assert_eq!(base64_decode("").unwrap(), Vec::<u8>::new());
    }

    fn make_resource(kind: &str, path: &str, body: &str) -> NativeSkillResource {
        NativeSkillResource {
            kind: kind.to_string(),
            path: path.to_string(),
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            content: body.to_string(),
            encoding: "utf-8".to_string(),
            mime_type: None,
            size: body.len() as u64,
        }
    }

    #[test]
    fn write_skill_into_dir_creates_skill_md_and_resources() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("my-skill");
        let resources = vec![
            make_resource("script", "scripts/check.sh", "#!/bin/bash\necho ok\n"),
            make_resource("reference", "references/notes.md", "# notes\n"),
        ];
        let written = write_skill_into_dir(&dir, "MARKDOWN BODY", &resources, true).unwrap();
        assert_eq!(written.len(), 3);
        let skill_md = dir.join("SKILL.md");
        assert!(skill_md.is_file());
        assert_eq!(std::fs::read_to_string(&skill_md).unwrap(), "MARKDOWN BODY");
        assert!(dir.join("scripts").join("check.sh").is_file());
        assert!(dir.join("references").join("notes.md").is_file());
    }

    #[test]
    fn write_skill_into_dir_clears_existing_when_clean_true() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("clean-skill");
        std::fs::create_dir_all(&dir).unwrap();
        let leftover = dir.join("old.txt");
        std::fs::write(&leftover, "stale").unwrap();
        write_skill_into_dir(&dir, "X", &[], true).unwrap();
        assert!(!leftover.exists());
        assert!(dir.join("SKILL.md").is_file());
    }

    #[test]
    fn write_skill_into_dir_keeps_unrelated_when_clean_false() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("keep-skill");
        std::fs::create_dir_all(&dir).unwrap();
        let keep = dir.join("keep.txt");
        std::fs::write(&keep, "kept").unwrap();
        write_skill_into_dir(&dir, "X", &[], false).unwrap();
        assert!(keep.exists());
        assert!(dir.join("SKILL.md").is_file());
    }

    #[test]
    fn write_skill_into_dir_rejects_path_traversal_resource() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("evil-skill");
        let resources = vec![make_resource("asset", "../escape.txt", "x")];
        let err = write_skill_into_dir(&dir, "X", &resources, true).unwrap_err();
        assert!(err.contains("invalid resource path"));
    }

    #[test]
    fn skills_target_round_trips_lowercase_to_match_ts_payload() {
        let json = serde_json::to_string(&SkillsTarget::Cognia).unwrap();
        assert_eq!(json, "\"cognia\"");
        let parsed: SkillsTarget = serde_json::from_str("\"codex\"").unwrap();
        assert_eq!(parsed, SkillsTarget::Codex);
    }

    #[test]
    fn install_mirrored_request_defaults_omit_targets_and_trash_flag() {
        let raw = r#"{"dirName":"x","content":"MD","resources":[],"clean":true}"#;
        let req: InstallSkillMirroredRequest = serde_json::from_str(raw).expect("deserialize");
        assert!(req.targets.is_empty());
        assert!(!req.trash_before_clean);
        assert!(req.clean);
    }

    #[test]
    fn install_mirrored_request_round_trips_full_payload() {
        let req = InstallSkillMirroredRequest {
            dir_name: "x".into(),
            content: "MD".into(),
            resources: vec![],
            clean: false,
            targets: vec![SkillsTarget::Cognia, SkillsTarget::Codex],
            trash_before_clean: true,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"dirName\":\"x\""));
        assert!(json.contains("\"trashBeforeClean\":true"));
        let back: InstallSkillMirroredRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(back.targets.len(), 2);
        assert_eq!(back.targets[1], SkillsTarget::Codex);
    }
}
