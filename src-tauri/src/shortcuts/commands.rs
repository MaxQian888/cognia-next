//! IPC commands for the renderer-driven shortcut registry. Mirror the
//! shape of `tray::commands` so the renderer can use one IPC convention
//! across both subsystems.
//!
//! Mobile builds stub every command — global hot-keys are desktop-only by
//! design, but the command list stays platform-uniform so
//! `tauri::generate_handler!` doesn't need cfg gates.

use std::sync::Arc;

use tauri::{AppHandle, Runtime, State};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::registry::{normalize_chord, ShortcutBindingDto};

use super::ShortcutRegistry;

#[cfg(any(target_os = "android", target_os = "ios"))]
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ShortcutBindingDto {
    pub id: String,
    pub chord: String,
}

#[tauri::command]
pub async fn shortcut_bind<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<ShortcutRegistry>>,
    id: String,
    chord: String,
) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        state
            .bind(&app, &id, &chord)
            .map_err(|e| format!("shortcut_bind: {e}"))
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, state, id, chord);
        Err("global shortcuts not available on this platform".into())
    }
}

#[tauri::command]
pub async fn shortcut_unbind<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<ShortcutRegistry>>,
    id: String,
) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        state
            .unbind(&app, &id)
            .map_err(|e| format!("shortcut_unbind: {e}"))
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, state, id);
        Err("global shortcuts not available on this platform".into())
    }
}

#[tauri::command]
pub async fn shortcut_list(
    state: State<'_, Arc<ShortcutRegistry>>,
) -> Result<Vec<ShortcutBindingDto>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Ok(state.list())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = state;
        Ok(Vec::new())
    }
}

/// Used by the renderer's record-binding UI to warn before clobbering a
/// chord owned by another id. `ignoring_id` is the id the renderer is
/// rebinding — without it, rebinding the *same* id with the *same* chord
/// would report a phantom self-conflict.
#[tauri::command]
pub async fn shortcut_check_conflict(
    state: State<'_, Arc<ShortcutRegistry>>,
    chord: String,
    ignoring_id: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let normalized = normalize_chord(&chord);
        let ignore = ignoring_id.unwrap_or_default();
        Ok(state.conflict_for(&normalized, &ignore))
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (state, chord, ignoring_id);
        Ok(None)
    }
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::*;

    // OS-level bind/unbind requires a real `tauri_plugin_global_shortcut`
    // runtime that `tauri::test::mock_app` cannot provide here (the project
    // doesn't enable Tauri's `test` feature — see `window_utils.rs:46`).
    // The pure paths — chord normalization, conflict detection, list
    // serialization — are covered by `registry.rs`'s own test block. The
    // commands module's only command-specific surface is the DTO shape.

    #[test]
    fn dto_round_trips_through_serde() {
        let dto = ShortcutBindingDto {
            id: "tray.show".into(),
            chord: "ctrl+shift+space".into(),
        };
        let json = serde_json::to_string(&dto).unwrap();
        let back: ShortcutBindingDto = serde_json::from_str(&json).unwrap();
        assert_eq!(dto, back);
    }

    #[test]
    fn dto_serde_tolerates_extra_keys_for_forward_compat() {
        // Renderer may send forward-compatible fields the Rust side hasn't
        // learned yet. serde's default rejects unknown fields, but our DTO
        // doesn't `deny_unknown_fields`, so this should round-trip cleanly.
        let json = r#"{"id":"tray.show","chord":"ctrl+space","scope":"global"}"#;
        let dto: ShortcutBindingDto = serde_json::from_str(json).unwrap();
        assert_eq!(dto.id, "tray.show");
        assert_eq!(dto.chord, "ctrl+space");
    }
}
