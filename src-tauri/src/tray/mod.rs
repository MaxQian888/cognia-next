//! System-tray installation + lifecycle.
//!
//! The renderer is the source of truth for the menu layout (see plan
//! §"i18n strategy"). At Rust startup we register the tray with a hard-coded
//! English bootstrap menu (`defaults::bootstrap_items`) so the icon appears
//! immediately; the renderer replaces this within milliseconds via
//! `tray_set_menu` once the locale + persisted layout are loaded.
//!
//! Click dispatch:
//!   - `payload.kind == "native"` → Rust performs the action directly AND
//!     emits the legacy `tray://<x>` / `automation:kill-switch` events for
//!     back-compat with existing renderer listeners.
//!   - Slash / command payloads → emits the new unified
//!     `tray://item-clicked` event with the payload; the renderer routes
//!     via `dispatchSlashCommand` / `executeCommand`.

// Pure-data modules — compile on every target.
pub mod commands;
pub mod defaults;
pub mod dto;

// Desktop-only sub-modules. Mobile builds rely on the stub commands in
// `commands.rs` and never construct a menu / set an icon.
#[cfg(desktop)]
pub mod icon_state;
#[cfg(desktop)]
pub mod menu_builder;

#[cfg(desktop)]
use std::collections::HashMap;
#[cfg(desktop)]
use std::sync::Arc;

#[cfg(desktop)]
use parking_lot::Mutex;
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri::{App, Emitter, Manager};

#[cfg(desktop)]
use crate::window_utils;

use self::dto::{TrayActionPayload, TrayMenuItem};

pub const TRAY_ICON_ID: &str = "main-tray";

/// Process-wide tray menu state. Lives in `app.manage(...)` on desktop;
/// mobile builds never read it (commands return stubbed errors) but the
/// type itself compiles everywhere so the commands module can take it as
/// a `State` parameter without cfg-gating the function signature.
#[derive(Default)]
pub struct TrayMenuStateStore {
    #[cfg(desktop)]
    inner: Mutex<TrayMenuStateInner>,
    #[cfg(not(desktop))]
    _phantom: (),
}

#[cfg(desktop)]
#[derive(Default)]
struct TrayMenuStateInner {
    items: Vec<TrayMenuItem>,
    index: HashMap<String, TrayActionPayload>,
    tooltip: Option<String>,
    /// Text next to the icon (macOS menu bar / Linux appindicator; Windows
    /// ignores it). Used by the renderer's taskbar usage readout.
    title: Option<String>,
}

#[cfg(desktop)]
impl TrayMenuStateStore {
    pub fn snapshot_items(&self) -> Vec<TrayMenuItem> {
        self.inner.lock().items.clone()
    }

    pub fn lookup_payload(&self, id: &str) -> Option<TrayActionPayload> {
        self.inner.lock().index.get(id).cloned()
    }

    pub fn set_layout(&self, items: Vec<TrayMenuItem>, index: HashMap<String, TrayActionPayload>) {
        let mut guard = self.inner.lock();
        guard.items = items;
        guard.index = index;
    }

    pub fn set_tooltip(&self, tooltip: Option<String>) {
        self.inner.lock().tooltip = tooltip;
    }

    pub fn tooltip(&self) -> Option<String> {
        self.inner.lock().tooltip.clone()
    }

    pub fn set_title(&self, title: Option<String>) {
        self.inner.lock().title = title;
    }

    pub fn title(&self) -> Option<String> {
        self.inner.lock().title.clone()
    }
}

#[cfg(not(desktop))]
impl TrayMenuStateStore {
    pub fn snapshot_items(&self) -> Vec<TrayMenuItem> {
        Vec::new()
    }
    pub fn lookup_payload(&self, _id: &str) -> Option<TrayActionPayload> {
        None
    }
    pub fn set_layout(
        &self,
        _items: Vec<TrayMenuItem>,
        _index: std::collections::HashMap<String, TrayActionPayload>,
    ) {
    }
    pub fn set_tooltip(&self, _tooltip: Option<String>) {}
    pub fn tooltip(&self) -> Option<String> {
        None
    }
    pub fn set_title(&self, _title: Option<String>) {}
    pub fn title(&self) -> Option<String> {
        None
    }
}

/// Build the system tray icon and register click + menu handlers. Called
/// once during `tauri::Builder::setup` (desktop only).
#[cfg(desktop)]
pub fn install(app: &App) -> tauri::Result<()> {
    use self::icon_state::TrayIconStateStore;
    use self::menu_builder::{build_menu, BuiltMenu};

    let handle = app.handle();

    // Process-wide stores — shared across the icon callback, the IPC
    // commands, and the renderer-driven menu rebuilds.
    let menu_state = Arc::new(TrayMenuStateStore::default());
    let icon_state = Arc::new(TrayIconStateStore::default());
    app.manage(menu_state.clone());
    app.manage(icon_state.clone());

    let bootstrap = defaults::bootstrap_items();
    let BuiltMenu { menu, index } = build_menu(handle, &bootstrap).map_err(|e| {
        // Bootstrap layout is hard-coded in `defaults::bootstrap_items` and
        // its tests guarantee it can never violate the builder's invariants
        // — so any failure here is a logic bug, not a runtime condition we
        // recover from. Surface via the closest pre-existing tauri::Error
        // variant rather than pulling in `anyhow` for one call site.
        log::error!("bootstrap tray menu failed: {e}");
        tauri::Error::AssetNotFound(format!("tray bootstrap menu: {e}"))
    })?;
    menu_state.set_layout(bootstrap, index);

    let menu_state_for_menu = menu_state.clone();
    let _tray = TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?,
        )
        .tooltip("Cognia")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id().0.as_str();
            log::info!("tray menu event: {id}");
            dispatch_click(app, id, &menu_state_for_menu);
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click toggles the main window — same UX as
            // Ctrl+Shift+Space (see lib.rs global-shortcut handler).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(desktop)]
fn dispatch_click<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    state: &TrayMenuStateStore,
) {
    let Some(payload) = state.lookup_payload(id) else {
        // Quit's predefined item never enters the index — Tauri handles it.
        // Anything else that ends up here is a malformed layout.
        log::warn!("tray click for unknown id: {id}");
        return;
    };

    // Always emit the unified event so renderer-side dispatchers and tests
    // can observe every tray click through one channel.
    let _ = app.emit(
        "tray://item-clicked",
        serde_json::json!({ "id": id, "payload": payload }),
    );

    match &payload {
        TrayActionPayload::Native { action } => apply_native(app, action.as_str()),
        TrayActionPayload::Slash { .. } | TrayActionPayload::Command { .. } => {
            // Renderer side picks these up via the unified event.
        }
    }
}

/// Toggle the main window: hide it when it's already visible AND focused,
/// otherwise bring it to the front. Shared by the tray left-click handler and
/// the `toggle-window` menu action so both behave identically.
#[cfg(desktop)]
fn toggle_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else {
            window_utils::bring_window_to_front(&window);
        }
    }
}

#[cfg(desktop)]
fn apply_native<R: tauri::Runtime>(app: &tauri::AppHandle<R>, action: &str) {
    match action {
        "show" => {
            window_utils::bring_main_window_to_front(app);
        }
        "hide" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        "toggle-window" => {
            toggle_main_window(app);
        }
        // Renderer-handled actions: Rust just emits the matching legacy event
        // (mirroring the `settings` / `open-logs` pattern) so the existing
        // `hooks/system/use-tauri-events.ts` listeners run the real work
        // (clipboard, OS opener, autostart plugin) renderer-side.
        "open-data-folder" => {
            let _ = app.emit("tray://open-data-folder", serde_json::Value::Null);
        }
        "copy-diagnostics" => {
            let _ = app.emit("tray://copy-diagnostics", serde_json::Value::Null);
        }
        "open-docs" => {
            let _ = app.emit("tray://open-docs", serde_json::Value::Null);
        }
        "report-issue" => {
            let _ = app.emit("tray://report-issue", serde_json::Value::Null);
        }
        "check-updates" => {
            window_utils::bring_main_window_to_front(app);
            let _ = app.emit("tray://check-updates", serde_json::Value::Null);
        }
        "toggle-autostart" => {
            let _ = app.emit("tray://toggle-autostart", serde_json::Value::Null);
        }
        "noop" => {
            // Inert info rows in the live status section carry this action so
            // they pass `validate_payload`; clicking a disabled row never
            // fires, and an enabled one is intentionally a no-op.
        }
        "new-chat" => {
            window_utils::bring_main_window_to_front(app);
            // Legacy event — preserve the channel that existing renderer
            // listeners in `hooks/system/use-tauri-events.ts:111-198`
            // already subscribe to.
            let _ = app.emit("tray://new-chat", serde_json::Value::Null);
        }
        "settings" => {
            window_utils::bring_main_window_to_front(app);
            let _ = app.emit("tray://settings", serde_json::Value::Null);
        }
        "open-logs" => {
            window_utils::bring_main_window_to_front(app);
            let _ = app.emit("tray://open-logs", serde_json::Value::Null);
        }
        "automation-kill" => {
            // Was the least complete of the three triggers: engine flag + event
            // only, leaving consent grants, a screen-off virtual display and a
            // live recording all running.
            let state = app.state::<crate::automation::commands::AutomationState>();
            crate::automation::kill_switch::engage(
                app,
                &state,
                crate::automation::kill_switch::KillSwitchCause::Tray,
            );
        }
        "pet-toggle" => {
            // Toggle the desktop pet: hide if visible, otherwise open with
            // defaults. The tray has no PetWindowOpts from the renderer, so
            // the open path uses the persisted-size-agnostic defaults.
            let handle = app.app_handle();
            if crate::pet_window::is_pet_window_open_inner(handle) {
                let _ = crate::pet_window::close_pet_window_inner(handle);
            } else {
                let _ = crate::pet_window::open_pet_window_inner(
                    handle,
                    crate::pet_window::PetWindowOpts::default(),
                );
            }
        }
        "pet-disable-click-through" => {
            // Click-through recovery path — re-enable cursor events so a
            // pointer-trapped overlay becomes interactive again. Routed
            // through the shared helper so the renderer hears the
            // `pet://state-changed` broadcast and its settings store resyncs.
            let _ = crate::pet_window::set_pet_click_through_inner(app.app_handle(), false);
        }
        "island-toggle" => {
            // Toggle the fleet agent-monitor island (hide if visible, else
            // open at defaults) — mirrors "pet-toggle".
            let handle = app.app_handle();
            if crate::fleet::island_window::is_island_window_open_inner(handle) {
                let _ = crate::fleet::island_window::close_island_window_inner(handle);
            } else {
                let _ = crate::fleet::island_window::open_island_window_inner(
                    handle,
                    crate::fleet::island_window::IslandWindowOpts::default(),
                );
            }
        }
        "quit" => {
            // Handled by PredefinedMenuItem::quit — should never reach here
            // because the builder routes quit-natives away from the index.
            log::warn!("native quit slipped past PredefinedMenuItem");
        }
        other => {
            log::warn!("native action '{other}' has no Rust handler");
        }
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn menu_state_store_round_trips_layout_and_index() {
        let store = TrayMenuStateStore::default();
        let items = defaults::bootstrap_items();
        let mut idx = HashMap::new();
        idx.insert(
            "tray-show".to_string(),
            TrayActionPayload::Native {
                action: "show".into(),
            },
        );
        store.set_layout(items.clone(), idx);

        assert_eq!(store.snapshot_items().len(), items.len());
        assert!(matches!(
            store.lookup_payload("tray-show"),
            Some(TrayActionPayload::Native { ref action }) if action == "show"
        ));
        assert!(store.lookup_payload("missing").is_none());
    }

    #[test]
    fn tooltip_round_trips_through_store() {
        let store = TrayMenuStateStore::default();
        assert!(store.tooltip().is_none());
        store.set_tooltip(Some("Cognia (idle)".into()));
        assert_eq!(store.tooltip().as_deref(), Some("Cognia (idle)"));
        store.set_tooltip(None);
        assert!(store.tooltip().is_none());
    }

    #[test]
    fn title_round_trips_through_store() {
        let store = TrayMenuStateStore::default();
        assert!(store.title().is_none());
        store.set_title(Some("42%".into()));
        assert_eq!(store.title().as_deref(), Some("42%"));
        store.set_title(None);
        assert!(store.title().is_none());
    }
}
