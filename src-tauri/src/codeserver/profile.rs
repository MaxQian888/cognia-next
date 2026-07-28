//! Isolated code-server profiles.
//!
//! Managed extensions and native Open VSX extensions cannot safely share an
//! extension host: both execute with the host user's privileges. Keep their
//! user data and extension directories physically separate and never issue
//! broker credentials to the native profile.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The two mutually exclusive code-server trust domains.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdeProfile {
    /// Pinned Cognia broker and generated proxy extensions only.
    #[default]
    Managed,
    /// User-selected Open VSX extensions, without Cognia broker credentials.
    Native,
}

impl IdeProfile {
    pub const fn directory_name(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::Native => "native",
        }
    }

    pub const fn allows_broker(self) -> bool {
        matches!(self, Self::Managed)
    }
}

/// Profile-specific paths below the common signed artifact root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfilePaths {
    pub user_data_dir: PathBuf,
    pub extensions_dir: PathBuf,
}

impl ProfilePaths {
    pub fn new(code_server_root: &Path, profile: IdeProfile) -> Self {
        let root = code_server_root
            .join("profiles")
            .join(profile.directory_name());
        Self {
            user_data_dir: root.join("user-data"),
            extensions_dir: root.join("extensions"),
        }
    }
}

/// One-release migration from the former shared profile. The legacy tree is
/// retained for export/rollback; data is copied into the native trust domain,
/// while managed receives only validated portable preferences.
pub fn migrate_legacy_profile_state(code_server_root: &Path) -> Result<(), String> {
    let marker = code_server_root
        .join("profiles")
        .join(".legacy-migrated-v1");
    if marker.exists() {
        return Ok(());
    }
    let native = ProfilePaths::new(code_server_root, IdeProfile::Native);
    let managed = ProfilePaths::new(code_server_root, IdeProfile::Managed);
    copy_tree_missing(&code_server_root.join("extensions"), &native.extensions_dir)?;
    copy_tree_missing(&code_server_root.join("user-data"), &native.user_data_dir)?;
    synchronize_portable_preferences(&native.user_data_dir, &managed.user_data_dir)?;
    let parent = marker
        .parent()
        .ok_or_else(|| "invalid profile migration marker".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create {}: {error}", parent.display()))?;
    std::fs::write(&marker, b"1\n").map_err(|error| format!("write {}: {error}", marker.display()))
}

fn copy_tree_missing(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(destination)
        .map_err(|error| format!("create {}: {error}", destination.display()))?;
    for entry in
        std::fs::read_dir(source).map_err(|error| format!("read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("read {}: {error}", source.display()))?;
        let target = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect {}: {error}", entry.path().display()))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            copy_tree_missing(&entry.path(), &target)?;
        } else if file_type.is_file() && !target.exists() {
            std::fs::copy(entry.path(), &target)
                .map_err(|error| format!("copy {}: {error}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// Refresh the managed profile's portable preferences from the native trust
/// domain. This is intentionally one-way: native extension settings and
/// keybindings remain authoritative, while managed receives only the allowlist.
pub fn synchronize_portable_preferences(native: &Path, managed: &Path) -> Result<(), String> {
    let native_user = native.join("User");
    let managed_user = managed.join("User");
    std::fs::create_dir_all(&managed_user)
        .map_err(|error| format!("create {}: {error}", managed_user.display()))?;
    let settings_path = native_user.join("settings.json");
    if let Ok(raw) = std::fs::read_to_string(&settings_path) {
        if let Ok(value) = serde_json::from_str::<Value>(&crate::agents::io::strip_jsonc(&raw)) {
            let filtered = filter_synchronized_settings(&value);
            let bytes = serde_json::to_vec_pretty(&filtered)
                .map_err(|error| format!("encode synchronized settings: {error}"))?;
            std::fs::write(managed_user.join("settings.json"), bytes)
                .map_err(|error| format!("write managed settings: {error}"))?;
        }
    }
    let keybindings_path = native_user.join("keybindings.json");
    if let Ok(raw) = std::fs::read_to_string(&keybindings_path) {
        if let Ok(value) = serde_json::from_str::<Value>(&crate::agents::io::strip_jsonc(&raw)) {
            let filtered = filter_synchronized_keybindings(&value);
            let bytes = serde_json::to_vec_pretty(&filtered)
                .map_err(|error| format!("encode synchronized keybindings: {error}"))?;
            std::fs::write(managed_user.join("keybindings.json"), bytes)
                .map_err(|error| format!("write managed keybindings: {error}"))?;
        }
    }
    Ok(())
}

fn filter_synchronized_settings(value: &Value) -> Value {
    let allowed = [
        "workbench.colorTheme",
        "workbench.iconTheme",
        "workbench.productIconTheme",
        "window.zoomLevel",
        "editor.fontFamily",
        "editor.fontSize",
        "editor.fontLigatures",
        "editor.tabSize",
        "editor.insertSpaces",
        "editor.wordWrap",
        "files.autoSave",
    ];
    let filtered = value
        .as_object()
        .into_iter()
        .flat_map(|object| object.iter())
        .filter(|(key, value)| {
            allowed.contains(&key.as_str())
                && matches!(
                    value,
                    Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null
                )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Map<_, _>>();
    Value::Object(filtered)
}

fn filter_synchronized_keybindings(value: &Value) -> Value {
    const SAFE_PREFIXES: &[&str] = &["workbench.action.", "editor.action.", "cursor", "delete"];
    const SAFE_EXACT: &[&str] = &["type", "undo", "redo", "copy", "cut", "paste"];
    Value::Array(
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter(|entry| {
                entry
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| {
                        SAFE_PREFIXES
                            .iter()
                            .any(|prefix| command.starts_with(prefix))
                            || SAFE_EXACT.contains(&command)
                    })
            })
            .cloned()
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_use_disjoint_state_and_extension_directories() {
        let root = Path::new("/app-data/code-server");
        let managed = ProfilePaths::new(root, IdeProfile::Managed);
        let native = ProfilePaths::new(root, IdeProfile::Native);

        assert_ne!(managed.user_data_dir, native.user_data_dir);
        assert_ne!(managed.extensions_dir, native.extensions_dir);
        assert_eq!(
            managed.user_data_dir,
            Path::new("/app-data/code-server/profiles/managed/user-data")
        );
        assert_eq!(
            native.extensions_dir,
            Path::new("/app-data/code-server/profiles/native/extensions")
        );
    }

    #[test]
    fn only_managed_profile_may_receive_broker_credentials() {
        assert!(IdeProfile::Managed.allows_broker());
        assert!(!IdeProfile::Native.allows_broker());
    }

    #[test]
    fn profile_wire_names_are_stable() {
        assert_eq!(
            serde_json::to_string(&IdeProfile::Managed).unwrap(),
            "\"managed\""
        );
        assert_eq!(
            serde_json::from_str::<IdeProfile>("\"native\"").unwrap(),
            IdeProfile::Native
        );
    }

    #[test]
    fn legacy_profile_migrates_to_native_without_sharing_extension_state() {
        let root = tempfile::tempdir().unwrap();
        let legacy_extensions = root.path().join("extensions");
        let legacy_user = root.path().join("user-data/User");
        std::fs::create_dir_all(&legacy_extensions).unwrap();
        std::fs::create_dir_all(&legacy_user).unwrap();
        std::fs::write(legacy_extensions.join("third-party"), b"extension").unwrap();
        std::fs::write(
            legacy_user.join("settings.json"),
            br#"{
              "workbench.colorTheme": "Dark",
              "thirdParty.secretSetting": "do-not-copy"
            }"#,
        )
        .unwrap();

        migrate_legacy_profile_state(root.path()).unwrap();

        let native = ProfilePaths::new(root.path(), IdeProfile::Native);
        let managed = ProfilePaths::new(root.path(), IdeProfile::Managed);
        assert!(native.extensions_dir.join("third-party").exists());
        assert!(!managed.extensions_dir.join("third-party").exists());
        let managed_settings: Value = serde_json::from_slice(
            &std::fs::read(managed.user_data_dir.join("User/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(managed_settings["workbench.colorTheme"], "Dark");
        assert!(managed_settings.get("thirdParty.secretSetting").is_none());
        // Export/rollback source is retained for the one-release migration window.
        assert!(legacy_extensions.join("third-party").exists());
    }

    #[test]
    fn only_builtin_keybindings_cross_the_profile_boundary() {
        let filtered = filter_synchronized_keybindings(&serde_json::json!([
            { "key": "cmd+k", "command": "workbench.action.files.openFile" },
            { "key": "cmd+x", "command": "evil.extension.exfiltrate" }
        ]));
        assert_eq!(filtered.as_array().unwrap().len(), 1);
    }

    #[test]
    fn jsonc_preferences_are_filtered_before_profile_synchronization() {
        let root = tempfile::tempdir().unwrap();
        let native = ProfilePaths::new(root.path(), IdeProfile::Native);
        std::fs::create_dir_all(native.user_data_dir.join("User")).unwrap();
        std::fs::write(
            native.user_data_dir.join("User/settings.json"),
            br#"{
              // VS Code settings are JSONC, not strict JSON.
              "editor.fontSize": 15,
              "native.extension.secret": "blocked",
            }"#,
        )
        .unwrap();

        synchronize_portable_preferences(
            &native.user_data_dir,
            &ProfilePaths::new(root.path(), IdeProfile::Managed).user_data_dir,
        )
        .unwrap();

        let managed = std::fs::read_to_string(
            ProfilePaths::new(root.path(), IdeProfile::Managed)
                .user_data_dir
                .join("User/settings.json"),
        )
        .unwrap();
        let value: Value = serde_json::from_str(&managed).unwrap();
        assert_eq!(value["editor.fontSize"], 15);
        assert!(value.get("native.extension.secret").is_none());
    }

    #[test]
    fn synchronization_refreshes_preferences_after_the_one_shot_migration() {
        let root = tempfile::tempdir().unwrap();
        let native = ProfilePaths::new(root.path(), IdeProfile::Native);
        let managed = ProfilePaths::new(root.path(), IdeProfile::Managed);
        std::fs::create_dir_all(native.user_data_dir.join("User")).unwrap();
        std::fs::write(
            native.user_data_dir.join("User/settings.json"),
            br#"{ "editor.fontSize": 14 }"#,
        )
        .unwrap();
        migrate_legacy_profile_state(root.path()).unwrap();

        std::fs::write(
            native.user_data_dir.join("User/settings.json"),
            br#"{
              "editor.fontSize": 18,
              "native.extension.token": "blocked"
            }"#,
        )
        .unwrap();
        synchronize_portable_preferences(&native.user_data_dir, &managed.user_data_dir).unwrap();

        let value: Value = serde_json::from_slice(
            &std::fs::read(managed.user_data_dir.join("User/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(value["editor.fontSize"], 18);
        assert!(value.get("native.extension.token").is_none());
    }
}
