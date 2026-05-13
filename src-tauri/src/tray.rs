use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Emitter, Manager,
};

/// Build the system tray icon with a context menu (Show / New chat / Settings
/// / Quit) and route clicks. Left-click toggles the main window, mirroring
/// the Ctrl+Shift+Space global shortcut.
pub fn install(app: &App) -> tauri::Result<()> {
    let handle = app.handle();

    let show = MenuItemBuilder::new("Show Cognia")
        .id("tray-show")
        .build(handle)?;
    let new_chat = MenuItemBuilder::new("New Chat")
        .id("tray-new-chat")
        .build(handle)?;
    let settings = MenuItemBuilder::new("Settings")
        .id("tray-settings")
        .build(handle)?;
    let open_logs = MenuItemBuilder::new("Open Log Panel")
        .id("tray-open-logs")
        .build(handle)?;
    let automation_kill = MenuItemBuilder::new("🛑 Engage automation kill switch")
        .id("tray-automation-kill")
        .build(handle)?;
    let quit = PredefinedMenuItem::quit(handle, Some("Quit"))?;

    let menu = MenuBuilder::new(handle)
        .item(&show)
        .item(&new_chat)
        .item(&settings)
        .separator()
        .item(&open_logs)
        .item(&automation_kill)
        .separator()
        .item(&quit)
        .build()?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?,
        )
        .tooltip("Cognia")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            log::info!("tray menu event: {id}");
            match id {
                "tray-show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                "tray-new-chat" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("tray://new-chat", serde_json::Value::Null);
                }
                "tray-settings" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("tray://settings", serde_json::Value::Null);
                }
                "tray-open-logs" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("tray://open-logs", serde_json::Value::Null);
                }
                "tray-automation-kill" => {
                    // Flip the Rust-side gate immediately, then emit so the
                    // renderer can toast / refresh its mirror.
                    let state = app.state::<crate::automation::commands::AutomationState>();
                    state.gate.engage_kill_switch();
                    let _ = app.emit("automation:kill-switch", serde_json::Value::Null);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click toggles the main window — same UX as Ctrl+Shift+Space.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let visible = window.is_visible().unwrap_or(false);
                    let focused = window.is_focused().unwrap_or(false);
                    if visible && focused {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}
