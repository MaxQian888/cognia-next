//! `plugin_scan_directory` — on-disk plugin discovery for the desktop shell.
//!
//! The TS `PluginManager.scanPlugins()` (lib/plugin/core/manager.ts) invokes
//! this at startup to re-discover plugins installed under
//! `<app_data>/cognia/plugins/`. Two manifest layouts exist on disk:
//! the GitHub installer ships the repo's `plugin.json`, while
//! `plugin_install` (lifecycle.rs) writes `manifest.json`. Both are accepted;
//! `plugin.json` wins when both are present.
//!
//! Manifest *validation* stays TS-side (`validatePluginManifest`) — this
//! command only finds and parses JSON. Unparseable entries are logged and
//! skipped so one broken plugin can't hide the rest. A nonexistent directory
//! is normal on first launch and yields an empty list, not an error.

use std::fs;
use std::path::Path;

use serde::Serialize;

use super::Result;

/// One discovered on-disk plugin. Field names cross the IPC boundary in
/// camelCase to match the TS destructuring in `manager.ts` (`installRootKind`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedPlugin {
    pub manifest: serde_json::Value,
    pub path: String,
    pub source: String,
    pub install_root_kind: String,
}

const MANIFEST_CANDIDATES: [&str; 2] = ["plugin.json", "manifest.json"];

#[tauri::command]
pub async fn plugin_scan_directory(directory: String) -> Result<Vec<ScannedPlugin>> {
    Ok(scan_directory_inner(Path::new(&directory)))
}

fn scan_directory_inner(dir: &Path) -> Vec<ScannedPlugin> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // First launch: the plugin directory hasn't been created yet.
        Err(_) => return Vec::new(),
    };

    let mut discovered = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(manifest_path) = MANIFEST_CANDIDATES
            .iter()
            .map(|name| path.join(name))
            .find(|candidate| candidate.is_file())
        else {
            continue;
        };
        match read_manifest(&manifest_path) {
            Ok(manifest) => discovered.push(ScannedPlugin {
                manifest,
                path: path.to_string_lossy().into_owned(),
                source: "local".into(),
                install_root_kind: "installed".into(),
            }),
            Err(err) => {
                log::warn!(
                    "plugin_scan_directory: skipping {}: {err}",
                    manifest_path.display()
                );
            }
        }
    }
    discovered
}

fn read_manifest(path: &Path) -> std::result::Result<serde_json::Value, String> {
    let bytes = fs::read(path).map_err(|e| format!("read: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse: {e}"))?;
    if !value.is_object() {
        return Err("manifest is not a JSON object".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_plugin(dir: &Path, sub: &str, file: &str, body: &str) {
        let plugin_dir = dir.join(sub);
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(plugin_dir.join(file), body).unwrap();
    }

    #[test]
    fn nonexistent_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("does-not-exist");
        assert!(scan_directory_inner(&missing).is_empty());
    }

    #[test]
    fn empty_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        assert!(scan_directory_inner(tmp.path()).is_empty());
    }

    #[test]
    fn reads_plugin_json_layout() {
        let tmp = TempDir::new().unwrap();
        write_plugin(tmp.path(), "demo", "plugin.json", r#"{"id":"demo","version":"1.0.0"}"#);

        let found = scan_directory_inner(tmp.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].manifest["id"], "demo");
        assert_eq!(found[0].source, "local");
        assert_eq!(found[0].install_root_kind, "installed");
        assert!(found[0].path.ends_with("demo"));
    }

    #[test]
    fn reads_manifest_json_layout() {
        let tmp = TempDir::new().unwrap();
        write_plugin(tmp.path(), "installed-one", "manifest.json", r#"{"id":"installed-one"}"#);

        let found = scan_directory_inner(tmp.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].manifest["id"], "installed-one");
    }

    #[test]
    fn plugin_json_wins_over_manifest_json() {
        let tmp = TempDir::new().unwrap();
        write_plugin(tmp.path(), "both", "plugin.json", r#"{"id":"from-plugin-json"}"#);
        write_plugin(tmp.path(), "both", "manifest.json", r#"{"id":"from-manifest-json"}"#);

        let found = scan_directory_inner(tmp.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].manifest["id"], "from-plugin-json");
    }

    #[test]
    fn skips_unparseable_and_continues() {
        let tmp = TempDir::new().unwrap();
        write_plugin(tmp.path(), "broken", "plugin.json", "{not json");
        write_plugin(tmp.path(), "not-object", "plugin.json", r#"["array"]"#);
        write_plugin(tmp.path(), "good", "plugin.json", r#"{"id":"good"}"#);

        let found = scan_directory_inner(tmp.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].manifest["id"], "good");
    }

    #[test]
    fn ignores_top_level_files_and_manifestless_dirs() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("stray.json"), r#"{"id":"stray"}"#).unwrap();
        fs::create_dir_all(tmp.path().join("no-manifest")).unwrap();

        assert!(scan_directory_inner(tmp.path()).is_empty());
    }

    #[test]
    fn serializes_install_root_kind_as_camel_case() {
        let entry = ScannedPlugin {
            manifest: serde_json::json!({"id":"x"}),
            path: "p".into(),
            source: "local".into(),
            install_root_kind: "installed".into(),
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["installRootKind"], "installed");
        assert!(json.get("install_root_kind").is_none());
    }
}
