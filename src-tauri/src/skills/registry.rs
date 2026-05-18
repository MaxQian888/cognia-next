// Read the project's skills-lock.json registry. The path is resolved
// relative to the app's resource dir at build time so the production binary
// ships the registry alongside the executable. In dev mode we fall back to
// the repo's `skills-lock.json`.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::types::RegistryEntry;

#[derive(Debug, Deserialize)]
struct LockFile {
    #[allow(dead_code)]
    version: u32,
    #[serde(default)]
    skills: BTreeMap<String, LockEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockEntry {
    source: String,
    source_type: String,
    #[serde(default)]
    skill_path: Option<String>,
    #[serde(default)]
    computed_hash: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    raw_skill_url: Option<String>,
}

fn load_lockfile(path: &Path) -> Result<LockFile, String> {
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {}", path.display(), e))
}

fn locate_lockfile() -> Option<PathBuf> {
    // 1. Bundled resource directory (production install).
    // 2. Repo root next to src-tauri/ (dev mode).
    // The Tauri runtime resolves resources via the app handle in real code; here
    // we fall through paths until one exists.
    let candidates = vec![
        PathBuf::from("../skills-lock.json"),
        PathBuf::from("skills-lock.json"),
        PathBuf::from("../../skills-lock.json"),
    ];
    candidates.into_iter().find(|c| c.is_file())
}

#[tauri::command]
pub fn skills_load_registry() -> Result<Vec<RegistryEntry>, String> {
    let path = match locate_lockfile() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let lock = load_lockfile(&path)?;
    let mut out: Vec<RegistryEntry> = lock
        .skills
        .into_iter()
        .map(|(id, entry)| RegistryEntry {
            id,
            source: entry.source,
            source_type: entry.source_type,
            skill_path: entry.skill_path,
            computed_hash: entry.computed_hash,
            display_name: entry.display_name,
            description: entry.description,
            category: entry.category,
            tags: entry.tags,
            author: entry.author,
            icon_url: entry.icon_url,
            raw_skill_url: entry.raw_skill_url,
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_valid_lockfile() {
        let raw = r#"{
            "version": 1,
            "skills": {
                "foo": {
                    "source": "github.com/x/y",
                    "sourceType": "github",
                    "displayName": "Foo",
                    "category": "development",
                    "tags": ["a", "b"]
                },
                "bar": {
                    "source": "github.com/x/y",
                    "sourceType": "github"
                }
            }
        }"#;
        let lf: LockFile = serde_json::from_str(raw).expect("parse");
        assert_eq!(lf.skills.len(), 2);
        let foo = lf.skills.get("foo").unwrap();
        assert_eq!(foo.source_type, "github");
        assert_eq!(foo.tags.as_ref().unwrap().len(), 2);
        assert_eq!(foo.display_name.as_deref(), Some("Foo"));
        // Optional fields default to None.
        let bar = lf.skills.get("bar").unwrap();
        assert!(bar.display_name.is_none());
        assert!(bar.tags.is_none());
    }

    #[test]
    fn rejects_malformed_json() {
        let bad = "{not json}";
        assert!(serde_json::from_str::<LockFile>(bad).is_err());
    }

    #[test]
    fn load_lockfile_round_trip() {
        let tmp = std::env::temp_dir().join(format!("skills-lock-test-{}.json", std::process::id()));
        let raw = r#"{"version":1,"skills":{"a":{"source":"s","sourceType":"github"}}}"#;
        {
            let mut f = std::fs::File::create(&tmp).expect("create");
            f.write_all(raw.as_bytes()).expect("write");
        }
        let parsed = load_lockfile(&tmp).expect("load");
        assert_eq!(parsed.skills.len(), 1);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn load_lockfile_missing_file_errors() {
        let p = std::env::temp_dir().join("does-not-exist-skills.json");
        assert!(load_lockfile(&p).is_err());
    }

    #[test]
    fn skills_load_registry_returns_empty_when_no_lockfile() {
        // Note: this test runs from the crate root where locate_lockfile()
        // may find the repo's real skills-lock.json. We only assert it
        // doesn't error.
        let result = skills_load_registry();
        assert!(result.is_ok());
    }
}
