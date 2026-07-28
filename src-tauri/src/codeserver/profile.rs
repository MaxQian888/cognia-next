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

/// Marker for the one-shot native → managed preference seed.
///
/// A sibling of `.legacy-migrated-v1` rather than part of it: the seed has to
/// run on the first **managed** launch, which can be long after the legacy tree
/// was migrated — a user may live in the native profile for weeks before ever
/// opening the managed one.
const PORTABLE_PREFERENCES_MARKER: &str = ".portable-preferences-v1";

/// Seed the managed profile's portable preferences from the native trust
/// domain, exactly once.
///
/// This used to run on every managed launch, and
/// [`synchronize_portable_preferences`] replaced whole files. Managed
/// `settings.json` is also written by `codeserver_write_user_settings` and by
/// the renderer's theme sync, and managed `keybindings.json` has no other
/// writer at all — so every launch deleted whatever the user had set from
/// inside VS Code, and handed the native profile the last word on the eight
/// keys the two allowlists share. Two authorities over one key is the defect;
/// seeding once is what the operations guide always described.
pub fn sync_portable_preferences_once(
    code_server_root: &Path,
    profile: IdeProfile,
) -> Result<(), String> {
    if profile != IdeProfile::Managed {
        return Ok(());
    }
    let marker = code_server_root
        .join("profiles")
        .join(PORTABLE_PREFERENCES_MARKER);
    if marker.exists() {
        return Ok(());
    }
    let native = ProfilePaths::new(code_server_root, IdeProfile::Native);
    let managed = ProfilePaths::new(code_server_root, IdeProfile::Managed);
    synchronize_portable_preferences(&native.user_data_dir, &managed.user_data_dir)?;
    let parent = marker
        .parent()
        .ok_or_else(|| "invalid preference marker".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create {}: {error}", parent.display()))?;
    // Written only after a successful seed, so a partial failure retries on the
    // next launch instead of being recorded as done.
    std::fs::write(&marker, b"1\n").map_err(|error| format!("write {}: {error}", marker.display()))
}

/// Copy the managed profile's portable preferences across from the native trust
/// domain. One-way and **additive**: only the allowlisted keys are written, so
/// anything else already in the managed profile — the renderer's theme
/// projection, and whatever the user set from inside VS Code — survives.
///
/// Callers should go through [`sync_portable_preferences_once`].
pub fn synchronize_portable_preferences(native: &Path, managed: &Path) -> Result<(), String> {
    let native_user = native.join("User");
    let managed_user = managed.join("User");
    std::fs::create_dir_all(&managed_user)
        .map_err(|error| format!("create {}: {error}", managed_user.display()))?;

    if let Some(native_settings) = read_jsonc(&native_user.join("settings.json")) {
        let projected = filter_synchronized_settings(&native_settings);
        let mut merged = read_jsonc(&managed_user.join("settings.json"))
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        for (key, value) in projected.as_object().into_iter().flatten() {
            merged.insert(key.clone(), value.clone());
        }
        write_json_pretty(&managed_user.join("settings.json"), &Value::Object(merged))?;
    }

    if let Some(native_keybindings) = read_jsonc(&native_user.join("keybindings.json")) {
        let projected = filter_synchronized_keybindings(&native_keybindings);
        let existing = read_jsonc(&managed_user.join("keybindings.json"));
        let merged = merge_keybindings(existing.as_ref(), &projected);
        write_json_pretty(&managed_user.join("keybindings.json"), &merged)?;
    }
    Ok(())
}

/// Read a JSON-with-comments document, tolerating an absent or malformed file
/// the same way the original implementation did.
fn read_jsonc(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&crate::agents::io::strip_jsonc(&raw)).ok()
}

fn write_json_pretty(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| format!("encode {}: {error}", path.display()))?;
    // Reuses the writer the settings command already goes through, so VS Code's
    // file watcher never observes a half-written document.
    super::commands::atomic_write_text(path, &text)
}

/// Union the seeded bindings with whatever the managed profile already had,
/// keyed on the `(key, when, command)` triple so a re-seed is idempotent and a
/// user's own binding for an unlisted command is never dropped.
fn merge_keybindings(existing: Option<&Value>, projected: &Value) -> Value {
    let identity = |entry: &Value| {
        (
            entry
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            entry
                .get("when")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            entry
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        )
    };
    let projected_entries: Vec<&Value> = projected.as_array().into_iter().flatten().collect();
    let seeded: std::collections::HashSet<_> =
        projected_entries.iter().map(|e| identity(e)).collect();
    let mut merged: Vec<Value> = projected_entries.into_iter().cloned().collect();
    for entry in existing.into_iter().filter_map(Value::as_array).flatten() {
        if !seeded.contains(&identity(entry)) {
            merged.push(entry.clone());
        }
    }
    Value::Array(merged)
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
    fn direct_synchronization_overlays_the_allowlist_without_clobbering() {
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

        // Stand in for the two writers that own this file after the seed: the
        // renderer's theme projection and the user typing inside VS Code.
        std::fs::write(
            managed.user_data_dir.join("User/settings.json"),
            // `br##"…"##` because the colour literal contains `"#`, which would
            // otherwise close a single-hash raw string.
            br##"{
              "editor.fontSize": 14,
              "workbench.colorCustomizations": { "editorCursor.foreground": "#ff0000" },
              "editor.stickyScroll.enabled": true
            }"##,
        )
        .unwrap();
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
        // The whole point of the change: keys the allowlist does not name are
        // no longer collateral damage.
        assert!(value.get("workbench.colorCustomizations").is_some());
        assert_eq!(value["editor.stickyScroll.enabled"], true);
    }

    #[test]
    fn synchronization_preserves_user_authored_keybindings() {
        let root = tempfile::tempdir().unwrap();
        let native = ProfilePaths::new(root.path(), IdeProfile::Native);
        let managed = ProfilePaths::new(root.path(), IdeProfile::Managed);
        std::fs::create_dir_all(native.user_data_dir.join("User")).unwrap();
        std::fs::create_dir_all(managed.user_data_dir.join("User")).unwrap();
        // This sync is the ONLY writer of managed keybindings, so a whole-file
        // replacement deleted anything the user bound inside the managed IDE.
        std::fs::write(
            managed.user_data_dir.join("User/keybindings.json"),
            br#"[{ "key": "ctrl+k m", "command": "mine.custom" }]"#,
        )
        .unwrap();
        std::fs::write(
            native.user_data_dir.join("User/keybindings.json"),
            br#"[
              { "key": "ctrl+p", "command": "workbench.action.quickOpen" },
              { "key": "ctrl+e", "command": "evil.extension.exfiltrate" }
            ]"#,
        )
        .unwrap();

        synchronize_portable_preferences(&native.user_data_dir, &managed.user_data_dir).unwrap();

        let value: Value = serde_json::from_slice(
            &std::fs::read(managed.user_data_dir.join("User/keybindings.json")).unwrap(),
        )
        .unwrap();
        let commands: Vec<&str> = value
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry.get("command").and_then(Value::as_str))
            .collect();
        assert!(commands.contains(&"workbench.action.quickOpen"));
        assert!(commands.contains(&"mine.custom"));
        assert!(!commands.contains(&"evil.extension.exfiltrate"));
    }

    #[test]
    fn portable_preferences_are_seeded_once_and_never_again() {
        let root = tempfile::tempdir().unwrap();
        let native = ProfilePaths::new(root.path(), IdeProfile::Native);
        let managed = ProfilePaths::new(root.path(), IdeProfile::Managed);
        std::fs::create_dir_all(native.user_data_dir.join("User")).unwrap();
        std::fs::write(
            native.user_data_dir.join("User/settings.json"),
            br#"{ "editor.fontSize": 14 }"#,
        )
        .unwrap();

        sync_portable_preferences_once(root.path(), IdeProfile::Managed).unwrap();
        assert!(root
            .path()
            .join("profiles")
            .join(PORTABLE_PREFERENCES_MARKER)
            .exists());

        // Both sides move the way they would in real use: the renderer rewrites
        // managed, the user changes native. A second launch must not touch
        // managed again — that was the data loss.
        std::fs::write(
            managed.user_data_dir.join("User/settings.json"),
            br#"{ "editor.fontSize": 22 }"#,
        )
        .unwrap();
        std::fs::write(
            native.user_data_dir.join("User/settings.json"),
            br#"{ "editor.fontSize": 9 }"#,
        )
        .unwrap();
        sync_portable_preferences_once(root.path(), IdeProfile::Managed).unwrap();

        let value: Value = serde_json::from_slice(
            &std::fs::read(managed.user_data_dir.join("User/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(value["editor.fontSize"], 22);
    }

    #[test]
    fn a_native_launch_never_touches_the_managed_profile() {
        let root = tempfile::tempdir().unwrap();
        let managed = ProfilePaths::new(root.path(), IdeProfile::Managed);

        sync_portable_preferences_once(root.path(), IdeProfile::Native).unwrap();

        assert!(!root
            .path()
            .join("profiles")
            .join(PORTABLE_PREFERENCES_MARKER)
            .exists());
        assert!(!managed.user_data_dir.join("User").exists());
    }

    #[test]
    fn a_failed_seed_leaves_no_marker_so_the_next_launch_retries() {
        let root = tempfile::tempdir().unwrap();
        let native = ProfilePaths::new(root.path(), IdeProfile::Native);
        let managed = ProfilePaths::new(root.path(), IdeProfile::Managed);
        std::fs::create_dir_all(native.user_data_dir.join("User")).unwrap();
        std::fs::write(
            native.user_data_dir.join("User/settings.json"),
            br#"{ "editor.fontSize": 14 }"#,
        )
        .unwrap();
        // Managed's `User` path is occupied by a regular file, so create_dir_all
        // fails and the seed cannot complete.
        std::fs::create_dir_all(&managed.user_data_dir).unwrap();
        std::fs::write(managed.user_data_dir.join("User"), b"not a directory").unwrap();

        assert!(sync_portable_preferences_once(root.path(), IdeProfile::Managed).is_err());
        assert!(!root
            .path()
            .join("profiles")
            .join(PORTABLE_PREFERENCES_MARKER)
            .exists());
    }
}
