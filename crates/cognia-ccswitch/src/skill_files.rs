// Installed skill bundle IO. Never reads outside the selected skill root.

use cognia_skills::types::NativeSkill;
use std::path::{Component, Path};

pub(crate) struct SkillFiles {
    pub native: NativeSkill,
    pub openai_yaml: Option<String>,
}

pub(crate) fn read_installed_skill(root: &Path, directory: &str) -> Option<SkillFiles> {
    if !Path::new(directory)
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let root = root.canonicalize().ok()?;
    let dir = root.join(directory).canonicalize().ok()?;
    if dir == root || !dir.starts_with(&root) {
        return None;
    }
    if ["SKILL.md", "scripts", "references", "assets", "agents"]
        .iter()
        .any(|name| {
            std::fs::symlink_metadata(dir.join(name)).is_ok_and(|m| m.file_type().is_symlink())
        })
    {
        return None;
    }
    if !safe_skill_bundle(&dir) {
        return None;
    }
    let native = cognia_skills::native::read_skill_dir(&dir)?;
    let openai_yaml = std::fs::read_to_string(dir.join("agents/openai.yaml")).ok();
    Some(SkillFiles {
        native,
        openai_yaml,
    })
}

/// Validate file kinds and bounds before the shared native reader opens them.
/// Special files (notably FIFOs) must never block a synchronous IPC command.
fn safe_skill_bundle(dir: &Path) -> bool {
    let regular = |path: &Path| {
        std::fs::symlink_metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.len() <= 2 * 1024 * 1024)
    };
    if !regular(&dir.join("SKILL.md")) {
        return false;
    }
    let yaml = dir.join("agents/openai.yaml");
    if std::fs::symlink_metadata(&yaml).is_ok() && !regular(&yaml) {
        return false;
    }
    let mut stack = Vec::new();
    for name in ["scripts", "references", "assets"] {
        let path = dir.join(name);
        if std::fs::symlink_metadata(&path).is_ok() {
            stack.push((path, 0));
        }
    }
    let mut files = 0;
    let mut directories = 0;
    while let Some((path, depth)) = stack.pop() {
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            return false;
        };
        if meta.is_dir() && depth <= 32 {
            directories += 1;
            if directories > 500 {
                return false;
            }
            let Ok(entries) = std::fs::read_dir(path) else {
                return false;
            };
            for entry in entries {
                let Ok(entry) = entry else {
                    return false;
                };
                stack.push((entry.path(), depth + 1));
            }
        } else {
            files += 1;
            if files > 50 || !meta.is_file() || meta.len() > 2 * 1024 * 1024 {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_skills_preserve_manifest_resources_and_codex_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("example");
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::create_dir_all(dir.join("agents")).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: example\ndescription: Test skill\n---\n# Workflow",
        )
        .unwrap();
        std::fs::write(dir.join("scripts/run.py"), "print('fixture')").unwrap();
        std::fs::write(
            dir.join("agents/openai.yaml"),
            "policy:\n  allow_implicit_invocation: false",
        )
        .unwrap();
        let files = read_installed_skill(tmp.path(), "example").unwrap();
        assert!(files.native.content.contains("# Workflow"));
        assert_eq!(files.native.resources[0].path, "scripts/run.py");
        assert!(files
            .openai_yaml
            .as_ref()
            .unwrap()
            .contains("allow_implicit_invocation"));
    }

    #[test]
    fn skills_reject_traversal_missing_directories_and_symlink_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("SKILL.md"), "secret").unwrap();
        for directory in ["../outside", "/absolute", "missing", ".", ""] {
            assert!(read_installed_skill(tmp.path(), directory).is_none());
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), tmp.path().join("escape")).unwrap();
            assert!(read_installed_skill(tmp.path(), "escape").is_none());
        }
    }

    #[test]
    #[cfg(unix)]
    fn special_skill_files_are_rejected_before_open() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("agents")).unwrap();
        std::fs::write(tmp.path().join("SKILL.md"), "body").unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(tmp.path().join("agents/openai.yaml"))
            .status()
            .unwrap()
            .success());
        assert!(!safe_skill_bundle(tmp.path()));
        std::fs::remove_file(tmp.path().join("agents/openai.yaml")).unwrap();
        std::fs::create_dir(tmp.path().join("scripts")).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(tmp.path().join("scripts/run.py"))
            .status()
            .unwrap()
            .success());
        assert!(!safe_skill_bundle(tmp.path()));
    }
}
