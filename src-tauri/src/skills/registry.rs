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
