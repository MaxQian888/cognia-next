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
/// The quick-panel popover window opened by a tray click.
pub mod panel;

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
    // Last reported tray-icon rectangle — the quick panel's placement anchor.
    let anchor_state = Arc::new(panel::TrayPanelAnchorStore::default());
    app.manage(menu_state.clone());
    app.manage(icon_state.clone());
    app.manage(anchor_state);

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
            let app = tray.app_handle();

            // Record the icon's screen rectangle from EVERY event that carries
            // one, not just the left-click we act on. A right-click (menu) or
            // a hover still tells us where the icon sits, so a panel opened
            // later from a menu item or a shortcut lands under the icon rather
            // than in the fallback corner.
            if let Some((rect, point)) = tray_event_geometry(&event) {
                let scale = app
                    .monitor_from_point(point.x, point.y)
                    .ok()
                    .flatten()
                    .or_else(|| app.primary_monitor().ok().flatten())
                    .map(|m| m.scale_factor())
                    .unwrap_or(1.0);
                panel::record_anchor(app, panel::anchor_from_tray_rect(rect, scale));
            }

            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // What a left-click does is a user preference, read straight
                // from disk: this handler runs with no renderer involvement at
                // all (the main window may be hidden, booting, or closed to
                // the tray), so there is nothing to ask.
                match panel::load_config().left_click {
                    panel::TrayLeftClickAction::Panel => {
                        if let Err(error) = panel::toggle_panel_inner(app) {
                            log::warn!("tray: quick panel toggle failed: {error}");
                            // Never leave a click dead: fall back to the
                            // pre-panel behaviour so the icon still does
                            // something the user recognises.
                            toggle_main_window(app);
                        }
                    }
                    panel::TrayLeftClickAction::ToggleWindow => toggle_main_window(app),
                    panel::TrayLeftClickAction::None => {}
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// The icon rectangle carried by every positional tray event. `Leave` is
/// deliberately included: its rect is still the icon's, and taking it costs
/// nothing while covering platforms that fire it without a preceding `Enter`.
#[cfg(desktop)]
fn tray_event_geometry(
    event: &TrayIconEvent,
) -> Option<(&tauri::Rect, tauri::PhysicalPosition<f64>)> {
    match event {
        TrayIconEvent::Click { rect, position, .. }
        | TrayIconEvent::DoubleClick { rect, position, .. }
        | TrayIconEvent::Enter { rect, position, .. }
        | TrayIconEvent::Move { rect, position, .. }
        | TrayIconEvent::Leave { rect, position, .. } => Some((rect, *position)),
        // `TrayIconEvent` is `#[non_exhaustive]`; a future variant without a
        // rect simply leaves the previous anchor in place.
        _ => None,
    }
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

/// Run a native tray action by name, from somewhere other than the OS menu.
///
/// The quick panel offers the same native actions the menu does, and routing
/// them here rather than reimplementing them renderer-side means "Open Cognia"
/// from the panel and from the menu are literally the same code — including the
/// legacy `tray://*` events existing listeners depend on. Rejects anything
/// outside [`dto::NATIVE_ACTIONS`] so a malformed stored action can't reach an
/// arbitrary branch.
#[cfg(desktop)]
pub fn run_native_action<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: &str,
) -> Result<(), String> {
    if !dto::NATIVE_ACTIONS.contains(&action) {
        return Err(format!("unknown native tray action: {action}"));
    }
    apply_native(app, action);
    Ok(())
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
        "tray-panel-toggle" => {
            // Same entry point as the left-click, exposed as a menu row so the
            // panel is still reachable when the user has rebound left-click to
            // "toggle window" or "do nothing".
            if let Err(error) = panel::toggle_panel_inner(app) {
                log::warn!("tray: quick panel toggle failed: {error}");
            }
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
            // The renderer opens the in-app report dialog; make sure it is visible.
            window_utils::bring_main_window_to_front(app);
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
    fn tray_event_geometry_keeps_the_physical_monitor_lookup_point() {
        let event = TrayIconEvent::Move {
            id: tauri::tray::TrayIconId::new("test"),
            position: tauri::PhysicalPosition::new(3200.0, 120.0),
            rect: tauri::Rect {
                position: tauri::Position::Logical(tauri::LogicalPosition::new(1600.0, 60.0)),
                size: tauri::Size::Logical(tauri::LogicalSize::new(24.0, 24.0)),
            },
        };

        let (_, point) = tray_event_geometry(&event).expect("move events carry tray geometry");

        assert_eq!(point, tauri::PhysicalPosition::new(3200.0, 120.0));
    }

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
