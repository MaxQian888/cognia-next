use tauri::{
    menu::{
        AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
    },
    App, Emitter, Manager,
};

const TOGGLE_RIGHT_SIDEBAR_MENU_ID: &str = "toggle-right-sidebar";
const TOGGLE_TERMINAL_MENU_ID: &str = "toggle-terminal";

// `MENU_IDS` lives in `crate::commands` so the `menu_action_ids` Tauri
// command can be registered on every platform — see
// `commands::MENU_IDS` and `commands::menu_action_ids`.

/// One native Go-menu entry: `(menu id, English label)`.
///
/// There is deliberately no accelerator column. A native
/// `CmdOrCtrl+<digit>` accelerator is taken by the OS menu before the
/// webview sees the key, so the Go menu's old ⌘1–⌘8 shadowed the workbench
/// activity shortcuts (`lib/shortcuts/app-catalog.ts`, ⌘1–⌘7). Pinned rail
/// destinations have ⌥1–⌥9 in the renderer instead.
type GoMenuItem = (&'static str, &'static str);

/// The native Go submenu, section by section — a separator goes between
/// sections. Mirrors `lib/desktop/go-menu.ts:GO_MENU_SECTIONS` id for id and
/// section for section: that table derives one `go-<id>` per entry of the
/// navigation catalog (`types/shell/sidebar.ts:SIDEBAR_NAV_META`) plus
/// `go-dms`, `go-canvas` and `go-settings`, and the in-app Menubar and
/// hamburger render it. Labels are the rail's `desktop.guildRail.*` English
/// strings. `lib/desktop/menu-actions.test.ts` parses this table and fails
/// when an id, the order, a section break or an English label drifts.
///
/// Every id here must be in `commands::MENU_IDS` and vice versa: the tests
/// below pin that, and `lib/desktop/menu-actions.test.ts` pins `MENU_IDS`
/// against the renderer's list.
const GO_MENU_SECTIONS: &[&[GoMenuItem]] = &[
    &[
        ("go-inbox", "Inbox"),
        ("go-workflows", "Workflows"),
        ("go-sites", "Sites"),
        ("go-twin", "Digital twin"),
        ("go-agents", "Agents"),
        ("go-skills", "Skills"),
        ("go-plugins", "Plugins"),
        ("go-squads", "Squads"),
        ("go-scheduler", "Scheduler"),
        ("go-discover", "Discover"),
    ],
    &[
        ("go-issues", "Issues"),
        ("go-templates", "Templates"),
        ("go-goals", "Goals"),
        ("go-pet", "Pet"),
        ("go-browser", "Browser"),
    ],
    &[
        ("go-a2ui", "Mini-Apps"),
        ("go-dms", "Chats"),
        ("go-conversations", "Conversations"),
        ("go-canvas", "Canvas"),
        ("go-files", "Files"),
    ],
    &[
        ("go-source-control", "Source Control"),
        ("go-agent-runs", "Agent runs"),
        ("go-workspace", "Workspace"),
        ("go-memory", "Memory"),
        ("go-servers", "Servers"),
        ("go-integrations", "Integrations"),
        ("go-devices", "Devices"),
        ("go-bots", "Bots"),
        ("go-eval", "Evaluation"),
        ("go-performance", "Performance"),
        ("go-me", "Me"),
    ],
    &[("go-logs", "Logs"), ("go-settings", "Settings")],
];

/// Build the application menu (File / Edit / View / Go / Tools / Window /
/// Help) and route menu events to the frontend as `menu://<id>` events.
///
/// On macOS the standard `App` submenu (about, services, hide, quit) is
/// inserted automatically by the predefined items used here.
pub fn install(app: &App) -> tauri::Result<()> {
    let handle = app.handle();

    // -------------------- File --------------------
    let new_chat = MenuItemBuilder::new("Quick Chat")
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
    let new_agent = MenuItemBuilder::new("New Agent")
        .id("new-agent")
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
        .item(&new_agent)
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
    // The artifact dock and the terminal used to be reachable only from icon
    // buttons in the in-window title bar. macOS suppresses that menubar, so
    // once those buttons folded into the Views dropdown these were the only two
    // panels with no menu entry at all.
    let toggle_right_sidebar = MenuItemBuilder::new("Toggle Right Sidebar")
        .id(TOGGLE_RIGHT_SIDEBAR_MENU_ID)
        .build(handle)?;
    let toggle_terminal = MenuItemBuilder::new("Toggle Terminal")
        .id(TOGGLE_TERMINAL_MENU_ID)
        .build(handle)?;
    let theme_light = MenuItemBuilder::new("Light")
        .id("theme-light")
        .build(handle)?;
    let theme_dark = MenuItemBuilder::new("Dark")
        .id("theme-dark")
        .build(handle)?;
    let theme_system = MenuItemBuilder::new("System")
        .id("theme-system")
        .build(handle)?;
    let theme_submenu = SubmenuBuilder::new(handle, "Theme")
        .item(&theme_light)
        .item(&theme_dark)
        .item(&theme_system)
        .build()?;
    let language_en = MenuItemBuilder::new("English")
        .id("language-en")
        .build(handle)?;
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
        .item(&toggle_right_sidebar)
        .item(&toggle_guild_rail)
        .item(&toggle_status_bar)
        .item(&toggle_terminal)
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
    let mut go = SubmenuBuilder::new(handle, "Go");
    for (index, section) in GO_MENU_SECTIONS.iter().enumerate() {
        if index > 0 {
            go = go.separator();
        }
        for &(id, label) in section.iter() {
            go = go.item(&MenuItemBuilder::new(label).id(id).build(handle)?);
        }
    }
    let go = go.build()?;

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

#[cfg(test)]
mod tests {
    use super::{GO_MENU_SECTIONS, TOGGLE_RIGHT_SIDEBAR_MENU_ID, TOGGLE_TERMINAL_MENU_ID};
    use std::collections::BTreeSet;

    fn go_menu_items() -> impl Iterator<Item = &'static super::GoMenuItem> {
        GO_MENU_SECTIONS.iter().flat_map(|section| section.iter())
    }

    #[test]
    fn go_menu_ids_are_exactly_the_registered_go_ids() {
        let mut table_ids = BTreeSet::new();
        for (id, _) in go_menu_items() {
            assert!(table_ids.insert(*id), "duplicate Go menu id: {id}");
        }
        let registered: BTreeSet<&str> = crate::commands::MENU_IDS
            .iter()
            .copied()
            .filter(|id| id.starts_with("go-"))
            .collect();
        assert_eq!(table_ids, registered);
    }

    /// No Go item may carry an accelerator: a native `CmdOrCtrl+<digit>`
    /// swallows the key before the webview, which is how the old ⌘1–⌘8
    /// shadowed the workbench's ⌘1–⌘7. The only place a Go item could get
    /// one is this module's Go builder, so pin that the builder never calls
    /// `.accelerator(` between the Go header and the Tools header.
    #[test]
    fn go_menu_items_carry_no_accelerator() {
        let source = include_str!("menu.rs");
        let go_start = source
            .find("// -------------------- Go --------------------")
            .expect("Go builder header");
        let tools_start = source
            .find("// -------------------- Tools --------------------")
            .expect("Tools builder header");
        assert!(go_start < tools_start);
        let go_builder = &source[go_start..tools_start];
        assert!(
            !go_builder.contains(".accelerator("),
            "the Go menu must not bind accelerators"
        );
    }

    #[test]
    fn go_menu_sections_and_labels_are_non_empty() {
        for section in GO_MENU_SECTIONS {
            assert!(!section.is_empty(), "empty Go menu section");
        }
        for (id, label) in go_menu_items() {
            assert!(!label.trim().is_empty(), "Go menu item {id} has no label");
        }
    }

    #[test]
    fn new_view_items_use_registered_menu_ids() {
        assert!(crate::commands::MENU_IDS.contains(&TOGGLE_RIGHT_SIDEBAR_MENU_ID));
        assert!(crate::commands::MENU_IDS.contains(&TOGGLE_TERMINAL_MENU_ID));
    }
}
