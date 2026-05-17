use tauri::{
    menu::{
        AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
    },
    App, Emitter, Manager,
};

// `MENU_IDS` lives in `crate::commands` so the `menu_action_ids` Tauri
// command can be registered on every platform — see
// `commands::MENU_IDS` and `commands::menu_action_ids`.

/// Build the application menu (File / Edit / View / Go / Tools / Window /
/// Help) and route menu events to the frontend as `menu://<id>` events.
///
/// On macOS the standard `App` submenu (about, services, hide, quit) is
/// inserted automatically by the predefined items used here.
pub fn install(app: &App) -> tauri::Result<()> {
    let handle = app.handle();

    // -------------------- File --------------------
    let new_chat = MenuItemBuilder::new("New Chat")
        .id("new-chat")
        .accelerator("CmdOrCtrl+N")
        .build(handle)?;
    let new_workflow = MenuItemBuilder::new("New Workflow")
        .id("new-workflow")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(handle)?;
    let new_agent_team = MenuItemBuilder::new("New Agent Team")
        .id("new-agent-team")
        .build(handle)?;
    let new_character = MenuItemBuilder::new("New Character")
        .id("new-character")
        .build(handle)?;
    let open_workspace = MenuItemBuilder::new("Open Workspace…")
        .id("open-workspace")
        .accelerator("CmdOrCtrl+O")
        .build(handle)?;
    let open_settings = MenuItemBuilder::new("Settings…")
        .id("open-settings")
        .accelerator("CmdOrCtrl+,")
        .build(handle)?;
    let open_logs_file = MenuItemBuilder::new("Open Log Panel")
        .id("open-logs")
        .accelerator("CmdOrCtrl+Shift+L")
        .build(handle)?;
    let file = SubmenuBuilder::new(handle, "File")
        .item(&new_chat)
        .item(&new_workflow)
        .item(&new_agent_team)
        .item(&new_character)
        .separator()
        .item(&open_workspace)
        .item(&open_settings)
        .item(&open_logs_file)
        .separator()
        .item(&PredefinedMenuItem::quit(handle, None)?)
        .build()?;

    // -------------------- Edit --------------------
    // Predefined items adapt per-platform.
    let edit = SubmenuBuilder::new(handle, "Edit")
        .item(&PredefinedMenuItem::undo(handle, None)?)
        .item(&PredefinedMenuItem::redo(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, None)?)
        .item(&PredefinedMenuItem::copy(handle, None)?)
        .item(&PredefinedMenuItem::paste(handle, None)?)
        .item(&PredefinedMenuItem::select_all(handle, None)?)
        .build()?;

    // -------------------- View --------------------
    let command_palette = MenuItemBuilder::new("Command Palette…")
        .id("command-palette")
        .accelerator("CmdOrCtrl+Shift+P")
        .build(handle)?;
    let toggle_sidebar = MenuItemBuilder::new("Toggle Sidebar")
        .id("toggle-sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(handle)?;
    let toggle_guild_rail = MenuItemBuilder::new("Toggle Guild Rail")
        .id("toggle-guild-rail")
        .build(handle)?;
    let toggle_status_bar = MenuItemBuilder::new("Toggle Status Bar")
        .id("toggle-status-bar")
        .build(handle)?;
    let theme_light = MenuItemBuilder::new("Light").id("theme-light").build(handle)?;
    let theme_dark = MenuItemBuilder::new("Dark").id("theme-dark").build(handle)?;
    let theme_system = MenuItemBuilder::new("System").id("theme-system").build(handle)?;
    let theme_submenu = SubmenuBuilder::new(handle, "Theme")
        .item(&theme_light)
        .item(&theme_dark)
        .item(&theme_system)
        .build()?;
    let language_en = MenuItemBuilder::new("English").id("language-en").build(handle)?;
    let language_zh = MenuItemBuilder::new("简体中文")
        .id("language-zh-cn")
        .build(handle)?;
    let language_submenu = SubmenuBuilder::new(handle, "Language")
        .item(&language_en)
        .item(&language_zh)
        .build()?;
    let reduce_motion = MenuItemBuilder::new("Reduce Motion")
        .id("toggle-reduce-motion")
        .build(handle)?;
    let reload = MenuItemBuilder::new("Reload")
        .id("reload")
        .accelerator("CmdOrCtrl+R")
        .build(handle)?;
    let toggle_devtools = MenuItemBuilder::new("Toggle DevTools")
        .id("toggle-devtools")
        .accelerator("CmdOrCtrl+Alt+I")
        .build(handle)?;
    let view = SubmenuBuilder::new(handle, "View")
        .item(&command_palette)
        .item(&toggle_sidebar)
        .item(&toggle_guild_rail)
        .item(&toggle_status_bar)
        .separator()
        .item(&theme_submenu)
        .item(&language_submenu)
        .item(&reduce_motion)
        .separator()
        .item(&reload)
        .item(&toggle_devtools)
        .item(&PredefinedMenuItem::fullscreen(handle, None)?)
        .build()?;

    // -------------------- Go --------------------
    let go_inbox = MenuItemBuilder::new("Inbox")
        .id("go-inbox")
        .accelerator("CmdOrCtrl+1")
        .build(handle)?;
    let go_workflows = MenuItemBuilder::new("Workflows")
        .id("go-workflows")
        .accelerator("CmdOrCtrl+2")
        .build(handle)?;
    let go_twin = MenuItemBuilder::new("Twin Workbench")
        .id("go-twin")
        .accelerator("CmdOrCtrl+3")
        .build(handle)?;
    let go_skills = MenuItemBuilder::new("Skills")
        .id("go-skills")
        .accelerator("CmdOrCtrl+4")
        .build(handle)?;
    let go_plugins = MenuItemBuilder::new("Plugins")
        .id("go-plugins")
        .accelerator("CmdOrCtrl+5")
        .build(handle)?;
    let go_agent_teams = MenuItemBuilder::new("Agent Teams")
        .id("go-agent-teams")
        .accelerator("CmdOrCtrl+6")
        .build(handle)?;
    let go_scheduler = MenuItemBuilder::new("Scheduler")
        .id("go-scheduler")
        .accelerator("CmdOrCtrl+7")
        .build(handle)?;
    let go_discover = MenuItemBuilder::new("Discover")
        .id("go-discover")
        .accelerator("CmdOrCtrl+8")
        .build(handle)?;
    let go_a2ui = MenuItemBuilder::new("Mini-Apps").id("go-a2ui").build(handle)?;
    let go_dms = MenuItemBuilder::new("Direct Messages").id("go-dms").build(handle)?;
    let go_canvas = MenuItemBuilder::new("Canvas").id("go-canvas").build(handle)?;
    let go_logs = MenuItemBuilder::new("Logs").id("go-logs").build(handle)?;
    let go_settings = MenuItemBuilder::new("Settings").id("go-settings").build(handle)?;
    let go = SubmenuBuilder::new(handle, "Go")
        .item(&go_inbox)
        .item(&go_workflows)
        .item(&go_twin)
        .item(&go_skills)
        .item(&go_plugins)
        .item(&go_agent_teams)
        .item(&go_scheduler)
        .item(&go_discover)
        .separator()
        .item(&go_a2ui)
        .item(&go_dms)
        .item(&go_canvas)
        .separator()
        .item(&go_logs)
        .item(&go_settings)
        .build()?;

    // -------------------- Tools --------------------
    let tools_command_palette = MenuItemBuilder::new("Command Palette…")
        .id("command-palette")
        .build(handle)?;
    let automation_kill = MenuItemBuilder::new("Automation Kill-Switch")
        .id("automation-kill-switch")
        .accelerator("CmdOrCtrl+Alt+K")
        .build(handle)?;
    let manage_connectors = MenuItemBuilder::new("Manage Connectors…")
        .id("manage-connectors")
        .build(handle)?;
    let manage_mcp = MenuItemBuilder::new("Manage MCP Server…")
        .id("manage-mcp-server")
        .build(handle)?;
    let plugin_devtools = MenuItemBuilder::new("Plugin DevTools")
        .id("plugin-devtools")
        .build(handle)?;
    let sidecar_restart = MenuItemBuilder::new("Restart Sidecar")
        .id("sidecar-restart")
        .build(handle)?;
    let clear_cache = MenuItemBuilder::new("Clear Cache…")
        .id("clear-cache")
        .build(handle)?;
    let tools = SubmenuBuilder::new(handle, "Tools")
        .item(&tools_command_palette)
        .separator()
        .item(&automation_kill)
        .item(&manage_connectors)
        .item(&manage_mcp)
        .separator()
        .item(&plugin_devtools)
        .item(&sidecar_restart)
        .item(&clear_cache)
        .build()?;

    // -------------------- Window --------------------
    let window_menu = SubmenuBuilder::new(handle, "Window")
        .item(&PredefinedMenuItem::minimize(handle, None)?)
        .item(&PredefinedMenuItem::maximize(handle, None)?)
        .item(&PredefinedMenuItem::close_window(handle, None)?)
        .build()?;

    // -------------------- Help --------------------
    let keyboard_shortcuts = MenuItemBuilder::new("Keyboard Shortcuts…")
        .id("keyboard-shortcuts")
        .build(handle)?;
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
        .item(&keyboard_shortcuts)
        .separator()
        .item(&documentation)
        .item(&about)
        .build()?;

    let menu = MenuBuilder::new(handle)
        .items(&[&file, &edit, &view, &go, &tools, &window_menu, &help])
        .build()?;

    app.set_menu(menu)?;

    // Route all custom menu items through `menu://<id>` events. Predefined
    // items (cut/copy/paste/quit/etc.) are handled by the OS directly.
    // `reload` and `toggle-devtools` are handled inline here because they
    // need direct webview access and there's no useful renderer-side
    // equivalent.
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

// Tests for `MENU_IDS` (uniqueness, kebab-case, canonical-set parity) live
// in `crate::commands::tests` next to the constant they exercise.
