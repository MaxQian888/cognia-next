//! IPC commands the renderer uses to push tray state into the Rust process.
//! The renderer is the source of truth (i18n, persistence, `when`-filtering)
//! — these commands rebuild the OS-level menu / icon to reflect what the
//! renderer just decided.
//!
//! Mobile (Android / iOS) builds stub every command with a clear error
//! string; the tray UI is desktop-only by design but the command list must
//! stay platform-uniform to keep `tauri::generate_handler!` simple.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use super::dto::{TrayIconState, TrayMenuItem};
use super::TrayMenuStateStore;

#[cfg(desktop)]
use super::icon_state::{self, TrayIconStateStore};
#[cfg(desktop)]
use super::menu_builder::{build_menu_skipping_invalid, BuiltMenu, SanitizedBuild, SkippedItem};
#[cfg(desktop)]
use super::TRAY_ICON_ID;
#[cfg(desktop)]
use tauri::Manager;

/// What `tray_set_menu` applied. Returned only once the new menu is on the
/// tray; anything that leaves the previous menu up is an `Err` instead.
/// Mirrored by `TraySetMenuReport` in `lib/tray/sync.ts`.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TraySetMenuReport {
    /// Items dropped for breaking a builder invariant (unknown native
    /// action, duplicate id, nesting past the cap). Empty on a clean push.
    pub skipped: Vec<TraySkippedMenuItem>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TraySkippedMenuItem {
    pub id: String,
    /// The builder's reason, e.g. "tray menu references unknown native
    /// action 'x'".
    pub reason: String,
}

#[cfg(desktop)]
impl From<SkippedItem> for TraySkippedMenuItem {
    fn from(skipped: SkippedItem) -> Self {
        Self {
            id: skipped.id,
            reason: skipped.error.to_string(),
        }
    }
}

/// Replace the tray menu in one shot. Empty input wipes the menu down to
/// just whatever predefined items the OS forces (typically nothing).
///
/// Items that break a builder invariant are dropped and listed in the
/// report; the rest of the menu still applies. The command fails only when
/// the new menu never reached the tray, and then the previous menu (on cold
/// start, the English bootstrap one) is what the user still sees.
#[tauri::command]
pub async fn tray_set_menu<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TrayMenuStateStore>>,
    items: Vec<TrayMenuItem>,
) -> Result<TraySetMenuReport, String> {
    #[cfg(desktop)]
    {
        // Main-thread dispatch: building an NSMenu and swapping it on the
        // NSStatusItem (which also drops the OLD menu) are AppKit ops that
        // trap off-main — and async commands run on tokio workers. The
        // outcome comes back over a oneshot so a failed build or swap
        // reaches the renderer instead of the command reporting success.
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        let store = Arc::clone(state.inner());
        app.run_on_main_thread(move || {
            // A closed receiver means the IPC call was abandoned; there is
            // no one left to tell.
            let _ = tx.send(apply_menu(&handle, &store, &items));
        })
        .map_err(|e| e.to_string())?;
        rx.await
            .map_err(|_| "tray: the menu update was dropped before it ran".to_string())?
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state, items);
        Err("tray not available on this platform".into())
    }
}

/// Build `items` and swap the result onto the tray. Must run on the main
/// thread. The layout store is written only after the swap succeeds, and
/// with the items actually applied, so the persisted layout, the click
/// index, and the menu on screen can't diverge.
#[cfg(desktop)]
fn apply_menu<R: Runtime>(
    handle: &AppHandle<R>,
    store: &TrayMenuStateStore,
    items: &[TrayMenuItem],
) -> Result<TraySetMenuReport, String> {
    // Looked up first: with no tray (e.g. `install` failed on a Linux host
    // without an appindicator) every debounced push would otherwise build a
    // whole menu only to throw it away.
    let tray = handle
        .tray_by_id(TRAY_ICON_ID)
        .ok_or_else(|| format!("tray: {TRAY_ICON_ID} not registered"))?;
    let SanitizedBuild {
        built: BuiltMenu { menu, index },
        applied,
        skipped,
    } = build_menu_skipping_invalid(handle, items)
        .map_err(|e| format!("tray: build_menu failed: {e}"))?;
    tray.set_menu(Some(menu))
        .map_err(|e| format!("tray: set_menu failed: {e}"))?;
    store.set_layout(applied, index);
    // Debug, not warn: the renderer gets the list in the report and logs it
    // once per distinct set, where a warning here would repeat on every
    // debounced push for as long as the stale item stays persisted.
    for item in &skipped {
        log::debug!("tray: skipped menu item '{}': {}", item.id, item.error);
    }
    Ok(TraySetMenuReport {
        skipped: skipped.into_iter().map(Into::into).collect(),
    })
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

/// Set (or clear, with `None`) the text rendered next to the tray icon.
/// macOS shows it in the menu bar and Linux appindicators render it inline;
/// Windows has no equivalent surface and Tauri no-ops there — the renderer
/// offers the icon-badge mode instead (`lib/tray/icon-builder.ts`).
#[tauri::command]
pub async fn tray_set_title<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TrayMenuStateStore>>,
    text: Option<String>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        state.set_title(text.clone());
        // Main-thread dispatch — same AppKit off-main trap as `tray_set_menu`.
        let handle = app.clone();
        app.run_on_main_thread(move || match handle.tray_by_id(TRAY_ICON_ID) {
            Some(tray) => {
                if let Err(e) = tray.set_title(text.as_deref()) {
                    log::warn!("tray: set_title failed: {e}");
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

/// Snapshot the title Rust currently holds — diagnostics counterpart of
/// `tray_get_tooltip`.
#[tauri::command]
pub async fn tray_get_title(
    state: State<'_, Arc<TrayMenuStateStore>>,
) -> Result<Option<String>, String> {
    Ok(state.title())
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
    /// Same one-line-wrapper rationale as the tooltip getter below: the
    /// `tray_set_title` / `tray_get_title` command bodies reduce to these
    /// store calls plus a main-thread OS mutation we can't exercise without
    /// Tauri's `test` feature.
    #[test]
    fn title_getter_round_trips_through_store() {
        let store = TrayMenuStateStore::default();
        assert!(store.title().is_none());
        store.set_title(Some("42%".into()));
        assert_eq!(store.title().as_deref(), Some("42%"));
        store.set_title(None);
        assert!(store.title().is_none());
    }

    /// Pins the wire shape `lib/tray/sync.ts` reads (`TraySetMenuReport`).
    #[test]
    fn set_menu_report_serializes_to_the_renderer_shape() {
        let clean = serde_json::to_value(TraySetMenuReport::default()).unwrap();
        assert_eq!(clean, serde_json::json!({ "skipped": [] }));

        let report = TraySetMenuReport {
            skipped: vec![TraySkippedMenuItem {
                id: "tray.stale".into(),
                reason: "tray menu references unknown native action 'x'".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            serde_json::json!({
                "skipped": [{
                    "id": "tray.stale",
                    "reason": "tray menu references unknown native action 'x'",
                }],
            })
        );
    }

    /// `apply_menu` needs a live tray (the project doesn't enable Tauri's
    /// `test` feature), so this covers its pure half: the sanitizer's skips
    /// become the report entries the renderer logs.
    #[cfg(desktop)]
    #[test]
    fn skipped_items_convert_into_report_entries() {
        use crate::tray::menu_builder::sanitize_items;

        let items = vec![
            TrayMenuItem::Action {
                id: "tray.stale".into(),
                label: "Stale".into(),
                accelerator: None,
                payload: TrayActionPayload::Native {
                    action: "self-destruct".into(),
                },
                disabled: None,
                checked: None,
            },
            TrayMenuItem::Separator {
                id: "tray.sep".into(),
            },
            TrayMenuItem::Separator {
                id: "tray.sep".into(),
            },
        ];
        let entries: Vec<TraySkippedMenuItem> = sanitize_items(&items)
            .skipped
            .into_iter()
            .map(Into::into)
            .collect();
        assert_eq!(
            entries,
            vec![
                TraySkippedMenuItem {
                    id: "tray.stale".into(),
                    reason: "tray menu references unknown native action 'self-destruct'".into(),
                },
                TraySkippedMenuItem {
                    id: "tray.sep".into(),
                    reason: "tray menu duplicate id 'tray.sep'".into(),
                },
            ]
        );
    }

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
