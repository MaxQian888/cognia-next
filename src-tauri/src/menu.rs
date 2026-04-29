use tauri::{
    menu::{
        AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
    },
    App, Emitter, Manager,
};

/// Build the application menu (File / Edit / View / Window / Help) and route
/// menu events to the frontend as `menu://<id>` events.
///
/// On macOS the standard `App` submenu (about, services, hide, quit) is
/// inserted automatically by the predefined items used here.
pub fn install(app: &App) -> tauri::Result<()> {
    let handle = app.handle();

    // File
    let new_chat = MenuItemBuilder::new("New Chat")
        .id("new-chat")
        .accelerator("CmdOrCtrl+N")
        .build(handle)?;
    let open_workspace = MenuItemBuilder::new("Open Workspace…")
        .id("open-workspace")
        .accelerator("CmdOrCtrl+O")
        .build(handle)?;
    let file = SubmenuBuilder::new(handle, "File")
        .item(&new_chat)
        .item(&open_workspace)
        .separator()
        .item(&PredefinedMenuItem::quit(handle, None)?)
        .build()?;

    // Edit — predefined items adapt per-platform.
    let edit = SubmenuBuilder::new(handle, "Edit")
        .item(&PredefinedMenuItem::undo(handle, None)?)
        .item(&PredefinedMenuItem::redo(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, None)?)
        .item(&PredefinedMenuItem::copy(handle, None)?)
        .item(&PredefinedMenuItem::paste(handle, None)?)
        .item(&PredefinedMenuItem::select_all(handle, None)?)
        .build()?;

    // View
    let reload = MenuItemBuilder::new("Reload")
        .id("reload")
        .accelerator("CmdOrCtrl+R")
        .build(handle)?;
    let toggle_devtools = MenuItemBuilder::new("Toggle DevTools")
        .id("toggle-devtools")
        .accelerator("CmdOrCtrl+Alt+I")
        .build(handle)?;
    let open_logs = MenuItemBuilder::new("Open Log Panel")
        .id("open-logs")
        .accelerator("CmdOrCtrl+Shift+L")
        .build(handle)?;
    let view = SubmenuBuilder::new(handle, "View")
        .item(&reload)
        .item(&toggle_devtools)
        .separator()
        .item(&open_logs)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(handle, None)?)
        .build()?;

    // Window
    let window_menu = SubmenuBuilder::new(handle, "Window")
        .item(&PredefinedMenuItem::minimize(handle, None)?)
        .item(&PredefinedMenuItem::maximize(handle, None)?)
        .item(&PredefinedMenuItem::close_window(handle, None)?)
        .build()?;

    // Help
    let documentation = MenuItemBuilder::new("Documentation")
        .id("documentation")
        .build(handle)?;
    let about = PredefinedMenuItem::about(
        handle,
        Some("About Cognia"),
        Some(
            AboutMetadataBuilder::new()
                .name(Some("Cognia"))
                .version(Some(env!("CARGO_PKG_VERSION")))
                .build(),
        ),
    )?;
    let help = SubmenuBuilder::new(handle, "Help")
        .item(&documentation)
        .item(&about)
        .build()?;

    let menu = MenuBuilder::new(handle)
        .items(&[&file, &edit, &view, &window_menu, &help])
        .build()?;

    app.set_menu(menu)?;

    // Route all custom menu items through `menu://<id>` events. Predefined
    // items (cut/copy/paste/quit/etc.) are handled by the OS directly.
    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        log::info!("menu event: {id}");
        match id {
            "reload" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.location.reload()");
                }
            }
            "toggle-devtools" =>
            {
                #[cfg(debug_assertions)]
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
            }
            _ => {
                let _ = app.emit(&format!("menu://{id}"), serde_json::Value::Null);
            }
        }
    });

    Ok(())
}
