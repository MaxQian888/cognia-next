//! IPC commands the renderer uses to push tray state into the Rust process.
//! The renderer is the source of truth (i18n, persistence, `when`-filtering)
//! — these commands rebuild the OS-level menu / icon to reflect what the
//! renderer just decided.
//!
//! Mobile (Android / iOS) builds stub every command with a clear error
//! string; the tray UI is desktop-only by design but the command list must
//! stay platform-uniform to keep `tauri::generate_handler!` simple.

use std::sync::Arc;

use tauri::{AppHandle, Runtime, State};

use super::dto::{TrayIconState, TrayMenuItem};
use super::TrayMenuStateStore;

#[cfg(desktop)]
use super::icon_state::{self, TrayIconStateStore};
#[cfg(desktop)]
use super::menu_builder::build_menu;
#[cfg(desktop)]
use super::TRAY_ICON_ID;
#[cfg(desktop)]
use tauri::Manager;

/// Replace the tray menu in one shot. Empty input wipes the menu down to
/// just whatever predefined items the OS forces (typically nothing).
#[tauri::command]
pub async fn tray_set_menu<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TrayMenuStateStore>>,
    items: Vec<TrayMenuItem>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let _ = &state;
        // Main-thread dispatch: building an NSMenu and swapping it on the
        // NSStatusItem (which also drops the OLD menu) are AppKit ops that
        // trap off-main — and async commands run on tokio workers. The layout
        // store write moves inside the closure too, so the persisted layout
        // and the applied menu can't diverge when a build fails.
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let built = match build_menu(&handle, &items) {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("tray: build_menu failed: {e}");
                    return;
                }
            };
            if let Some(store) = handle.try_state::<Arc<TrayMenuStateStore>>() {
                store.set_layout(items, built.index);
            }
            match handle.tray_by_id(TRAY_ICON_ID) {
                Some(tray) => {
                    if let Err(e) = tray.set_menu(Some(built.menu)) {
                        log::warn!("tray: set_menu failed: {e}");
                    }
                }
                None => log::warn!("tray: {TRAY_ICON_ID} not registered"),
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state, items);
        Err("tray not available on this platform".into())
    }
}

#[tauri::command]
pub async fn tray_set_icon_state<R: Runtime>(
    app: AppHandle<R>,
    state: String,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let parsed = TrayIconState::from_str(&state)
            .ok_or_else(|| format!("unknown icon state: {state}"))?;
        // Main-thread dispatch — applying inline from this async command (a
        // tokio worker) trapped in AppKit's NSStatusItem teardown.
        icon_state::apply_on_main(&app, parsed)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state);
        Err("tray not available on this platform".into())
    }
}

/// Cache PNG bytes for `state` so subsequent `tray_set_icon_state` calls
/// can swap the rendered image without crossing IPC for every flip. The
/// renderer pushes one buffer per state at boot (see
/// `lib/tray/icon-builder.ts`). Bytes must be a complete PNG payload —
/// `tauri::image::Image::from_bytes` decodes them on first apply.
#[tauri::command]
pub async fn tray_register_icon<R: Runtime>(
    app: AppHandle<R>,
    state: String,
    png_bytes: Vec<u8>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let parsed = TrayIconState::from_str(&state)
            .ok_or_else(|| format!("unknown icon state: {state}"))?;
        if png_bytes.is_empty() {
            return Err("png_bytes is empty".into());
        }
        // Quick sanity check: the bytes must look like a PNG (or ICO). We
        // surface a clean error here rather than after `Image::from_bytes`
        // fails three layers deep.
        let looks_like_png = png_bytes.len() >= 8 && png_bytes[..8] == PNG_MAGIC;
        let looks_like_ico = png_bytes.len() >= 4 && png_bytes[..4] == ICO_MAGIC;
        if !looks_like_png && !looks_like_ico {
            return Err("png_bytes is neither PNG nor ICO".into());
        }
        let store = app
            .try_state::<Arc<TrayIconStateStore>>()
            .ok_or_else(|| "tray icon-state store not managed".to_string())?;
        store.register_raster(parsed, png_bytes);
        // If the renderer just registered the icon for the currently-shown
        // state, re-apply immediately so the new raster takes effect
        // without waiting for the next `tray_set_icon_state` call.
        if store.current() == parsed {
            let _ = icon_state::apply_on_main(&app, parsed);
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state, png_bytes);
        Err("tray not available on this platform".into())
    }
}

#[cfg(desktop)]
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
#[cfg(desktop)]
const ICO_MAGIC: [u8; 4] = [0x00, 0x00, 0x01, 0x00];

#[tauri::command]
pub async fn tray_set_tooltip<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TrayMenuStateStore>>,
    text: String,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        state.set_tooltip(Some(text.clone()));
        // Main-thread dispatch — same AppKit off-main trap as `tray_set_menu`.
        let handle = app.clone();
        app.run_on_main_thread(move || match handle.tray_by_id(TRAY_ICON_ID) {
            Some(tray) => {
                if let Err(e) = tray.set_tooltip(Some(text.as_str())) {
                    log::warn!("tray: set_tooltip failed: {e}");
                }
            }
            None => log::warn!("tray: {TRAY_ICON_ID} not registered"),
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state, text);
        Err("tray not available on this platform".into())
    }
}

/// Snapshot the current items as the Rust side sees them — used by the
/// renderer's hydration path to verify the bootstrap layout matches what it
/// has persisted. Also useful for diagnostics.
#[tauri::command]
pub async fn tray_get_current_menu(
    state: State<'_, Arc<TrayMenuStateStore>>,
) -> Result<Vec<TrayMenuItem>, String> {
    Ok(state.snapshot_items())
}

#[tauri::command]
pub async fn tray_get_icon_state<R: Runtime>(_app: AppHandle<R>) -> Result<TrayIconState, String> {
    #[cfg(desktop)]
    {
        if let Some(store) = _app.try_state::<Arc<TrayIconStateStore>>() {
            return Ok(store.current());
        }
        Ok(TrayIconState::Idle)
    }
    #[cfg(not(desktop))]
    {
        Ok(TrayIconState::Idle)
    }
}

/// Snapshot the tooltip Rust currently holds. The renderer hydration path
/// in `lib/tray/tray-controller.ts` uses this on cold boot to avoid pushing
/// a tooltip identical to the one set during the previous session — set the
/// tooltip via `tray_set_tooltip` once on boot, then poll via this getter
/// to keep the unified-event dashboard in sync.
#[tauri::command]
pub async fn tray_get_tooltip(
    state: State<'_, Arc<TrayMenuStateStore>>,
) -> Result<Option<String>, String> {
    Ok(state.tooltip())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tray::dto::TrayActionPayload;

    #[test]
    fn icon_state_parser_rejects_unknown_strings() {
        assert!(TrayIconState::from_str("strobe").is_none());
        assert!(TrayIconState::from_str("idle").is_some());
        assert!(TrayIconState::from_str("BUSY").is_none()); // case-sensitive
    }

    #[cfg(desktop)]
    #[test]
    fn menu_state_store_set_layout_writes_index() {
        let store = TrayMenuStateStore::default();
        let items = vec![TrayMenuItem::Action {
            id: "a".into(),
            label: "A".into(),
            accelerator: None,
            payload: TrayActionPayload::Slash {
                command: "clear".into(),
            },
            disabled: None,
            checked: None,
        }];
        let mut idx = std::collections::HashMap::new();
        idx.insert(
            "a".to_string(),
            TrayActionPayload::Slash {
                command: "clear".into(),
            },
        );
        store.set_layout(items, idx);
        assert!(matches!(
            store.lookup_payload("a"),
            Some(TrayActionPayload::Slash { ref command }) if command == "clear"
        ));
    }

    /// Direct read of `TrayMenuStateStore::tooltip()` — the command body
    /// is a one-line wrapper around this getter, so testing the getter
    /// covers the command's only behaviour. Avoids spinning up a tauri
    /// mock app (the project doesn't enable Tauri's `test` feature; see
    /// `window_utils.rs:46`).
    #[test]
    fn tooltip_getter_round_trips_through_store() {
        let store = TrayMenuStateStore::default();
        assert!(store.tooltip().is_none());
        store.set_tooltip(Some("Cognia (busy)".into()));
        assert_eq!(store.tooltip().as_deref(), Some("Cognia (busy)"));
        store.set_tooltip(None);
        assert!(store.tooltip().is_none());
    }
}
