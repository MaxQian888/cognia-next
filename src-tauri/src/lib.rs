mod a2ui_bridge;
mod agents;
mod anthropic_subscription;
mod api_key;
mod canvas;
mod ccswitch;
mod claude;
mod commands;
mod connectors;
mod external_agent;
mod files;
mod hooks;
mod logging;
mod mcp_server;
mod proxy_config;
mod remote_control;
mod scheduler;
mod settings;
mod shell;
mod skills;
mod tts;
mod vector;
mod wallpaper;

mod window_behavior;

#[cfg(desktop)]
mod menu;
#[cfg(desktop)]
mod tray;

use api_key::ApiKeyState;
use claude::sidecar::{kill_sidecar, SidecarState};
use tauri::{Emitter, Manager, State};
use window_behavior::WindowBehavior;

#[cfg(desktop)]
use tauri::WindowEvent;

#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(desktop)]
use tauri_plugin_deep_link::DeepLinkExt;

/// Push a fresh Anthropic API key into the in-process store. The frontend
/// triggers a sidecar restart afterwards via `claude_restart_sidecar`.
///
/// Kept as a thin compat wrapper around `set_provider` so any caller that
/// hasn't migrated to `claude_set_provider_env` yet still works. Leaves the
/// existing `ANTHROPIC_BASE_URL` (if set) untouched.
#[tauri::command]
async fn claude_set_api_key(
    state: State<'_, ApiKeyState>,
    key: Option<String>,
) -> Result<(), String> {
    state.set(key).await;
    Ok(())
}

/// Replace the Anthropic provider env (api key + optional base URL) atomically.
/// Used by the CCSwitch provider-switch flow so the sidecar restart sees a
/// coherent pair instead of an api-key/base-url straddling two providers.
#[tauri::command]
async fn claude_set_provider_env(
    state: State<'_, ApiKeyState>,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<(), String> {
    state.set_provider(api_key, base_url).await;
    Ok(())
}

/// Whether an Anthropic API key has been registered (UI badge).
#[tauri::command]
async fn claude_has_api_key(state: State<'_, ApiKeyState>) -> Result<bool, String> {
    Ok(state.get().await.is_some())
}

/// Push the Claude OAuth bearer (Pro/Max subscription or Console flow) into
/// the in-process store. The frontend follows up with `claude_restart_sidecar`
/// so the next spawn sees the new env. Pass `None` to clear.
#[tauri::command]
async fn claude_set_oauth_bearer(
    state: State<'_, ApiKeyState>,
    token: Option<String>,
) -> Result<(), String> {
    state.set_oauth_bearer(token).await;
    Ok(())
}

/// Whether a Claude OAuth bearer is currently registered (UI badge).
#[tauri::command]
async fn claude_has_oauth_bearer(state: State<'_, ApiKeyState>) -> Result<bool, String> {
    Ok(state.get_oauth_bearer().await.is_some())
}

/// Stop the running sidecar so the next `claude_send` spawns a new one. Used
/// after API key changes — the SDK reads `ANTHROPIC_API_KEY` at init time.
#[tauri::command]
async fn claude_restart_sidecar(state: State<'_, SidecarState>) -> Result<(), String> {
    kill_sidecar(state.inner().clone()).await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // single-instance MUST be registered first per Tauri docs. When a duplicate
    // launch is attempted, focus the existing window and forward args/cwd. The
    // `deep-link` cargo feature also forwards URL args so the running instance
    // receives `cognia://...` events on win/linux re-launches.
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            log::info!("second instance launched: args={args:?} cwd={cwd}");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit(
                "cli://second-instance",
                serde_json::json!({ "args": args, "cwd": cwd }),
            );
        }));
    }

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    {
        builder = builder
            .plugin(tauri_plugin_window_state::Builder::default().build())
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        // Two chords share this handler:
                        //   Ctrl+Shift+Space — toggle main window visibility
                        //   Ctrl+Shift+L     — surface the window and emit
                        //                       `tray://open-logs` so the renderer
                        //                       navigates to /logs (same handler the
                        //                       tray + View menu use).
                        if event.state() != ShortcutState::Pressed {
                            return;
                        }
                        let toggle_chord =
                            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                        let logs_chord =
                            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyL);
                        if shortcut == &toggle_chord {
                            if let Some(window) = app.get_webview_window("main") {
                                let visible = window.is_visible().unwrap_or(false);
                                let focused = window.is_focused().unwrap_or(false);
                                if visible && focused {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        } else if shortcut == &logs_chord {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                            let _ = app.emit("tray://open-logs", serde_json::Value::Null);
                        }
                    })
                    .build(),
            )
            .plugin(tauri_plugin_autostart::Builder::new().build())
            .plugin(tauri_plugin_cli::init());
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(claude::SidecarState::new())
        .manage(ApiKeyState::new())
        .manage(WindowBehavior::new())
        .manage(connectors::ConnectorsState::new())
        .manage(connectors::commands::ConnectorsServer(std::sync::Arc::new(
            tokio::sync::Mutex::new(None),
        )))
        .manage(remote_control::RemoteControlState::new())
        .manage(mcp_server::McpServerState::new())
        .manage(external_agent::commands::ExternalAgentState::default())
        .manage(external_agent::commands::AcpTerminalState::default())
        .manage(scheduler::SchedulerState::new(
            dirs::data_dir().map(|d| d.join("cognia").join("scheduler_metadata.sqlite")),
        ))
        .manage(vector::VectorState::new(
            dirs::data_dir().map(|d| d.join("cognia").join("vectors.sqlite")),
        ))
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            claude::commands::claude_send,
            claude::commands::claude_interrupt,
            claude::commands::claude_approve,
            claude::commands::claude_close_session,
            claude::commands::claude_sidecar_status,
            claude::mcp_test::test_mcp_server,
            agents::commands::read_agent_config,
            agents::commands::write_agent_config,
            ccswitch::commands::ccswitch_status,
            ccswitch::commands::ccswitch_list_providers,
            ccswitch::commands::ccswitch_list_mcp_servers,
            ccswitch::commands::ccswitch_list_prompts,
            ccswitch::commands::ccswitch_list_skills,
            anthropic_subscription::commands::claude_sub_save_token,
            anthropic_subscription::commands::claude_sub_load_token,
            anthropic_subscription::commands::claude_sub_clear_token,
            claude_set_api_key,
            claude_set_provider_env,
            claude_set_oauth_bearer,
            claude_has_api_key,
            claude_has_oauth_bearer,
            claude_restart_sidecar,
            canvas::python_exec::canvas_run_python,
            window_behavior::set_tray_on_close,
            window_behavior::get_tray_on_close,
            files::read_text_file,
            files::write_text_file,
            files::ensure_dir,
            files::scan_claude_skills,
            files::read_claude_user_config,
            files::default_export_dir,
            files::fs_search_workspace,
            files::fs_read_workspace_file,
            files::slash_commands_scan,
            files::memory_append,
            skills::native::skills_scan_dir,
            skills::native::skills_scan_native,
            skills::native::skills_uninstall_native,
            skills::install::skills_install_native,
            skills::remote::skills_fetch_remote_md,
            skills::registry::skills_load_registry,
            skills::scanner::skills_scan_security,
            skills::scanner::skills_scan_resources,
            settings::read_claude_user_settings,
            settings::read_claude_project_settings,
            settings::read_claude_local_settings,
            settings::read_claude_effective_settings,
            settings::write_claude_settings_env,
            settings::write_claude_user_settings,
            settings::write_claude_project_settings,
            settings::write_claude_local_settings,
            shell::shell_exec,
            tts::keyring::tts_keyring_get,
            tts::keyring::tts_keyring_set,
            tts::keyring::tts_keyring_delete,
            tts::keyring::tts_keyring_list_providers,
            tts::edge::tts_edge_synthesize,
            tts::proxy::tts_proxy_fetch,
            external_agent::commands::spawn_external_agent,
            external_agent::commands::send_to_external_agent,
            external_agent::commands::kill_external_agent,
            external_agent::commands::get_external_agent_status,
            external_agent::commands::list_external_agents,
            external_agent::commands::receive_external_agent_stderr,
            external_agent::commands::is_external_agent_running,
            external_agent::commands::get_external_agent_info,
            external_agent::commands::set_external_agent_running,
            external_agent::commands::set_external_agent_failed,
            external_agent::commands::kill_all_external_agents,
            external_agent::commands::acp_terminal_create,
            external_agent::commands::acp_terminal_output,
            external_agent::commands::acp_terminal_kill,
            external_agent::commands::acp_terminal_release,
            external_agent::commands::acp_terminal_wait_for_exit,
            external_agent::commands::acp_terminal_write,
            external_agent::commands::acp_terminal_get_session_terminals,
            external_agent::commands::acp_terminal_kill_session_terminals,
            external_agent::commands::acp_terminal_is_running,
            external_agent::commands::acp_terminal_get_info,
            external_agent::commands::acp_terminal_list,
            external_agent::commands::check_command_exists,
            logging::commands::native_logging_get_readiness,
            logging::commands::native_logging_get_log_directory,
            logging::commands::native_logging_open_log_directory,
            logging::commands::platform_logging_get_status,
            logging::commands::platform_logging_set_config,
            logging::commands::platform_logging_forward,
            scheduler::commands::scheduler_get_capabilities,
            scheduler::commands::scheduler_is_available,
            scheduler::commands::scheduler_is_elevated,
            scheduler::commands::scheduler_create_task,
            scheduler::commands::scheduler_update_task,
            scheduler::commands::scheduler_delete_task,
            scheduler::commands::scheduler_get_task,
            scheduler::commands::scheduler_list_tasks,
            scheduler::commands::scheduler_enable_task,
            scheduler::commands::scheduler_disable_task,
            scheduler::commands::scheduler_run_task_now,
            scheduler::commands::scheduler_validate_task,
            scheduler::commands::scheduler_confirm_task,
            scheduler::commands::scheduler_cancel_confirmation,
            scheduler::commands::scheduler_request_elevation,
            scheduler::commands::scheduler_get_pending_confirmations,
            vector::commands::vector_create_collection,
            vector::commands::vector_delete_collection,
            vector::commands::vector_list_collections,
            vector::commands::vector_get_collection,
            vector::commands::vector_upsert_points,
            vector::commands::vector_delete_points,
            vector::commands::vector_delete_all_points,
            vector::commands::vector_get_points,
            vector::commands::vector_search_points,
            vector::commands::vector_truncate_collection,
            vector::commands::vector_reset_store,
            vector::commands::vector_get_store_size,
            a2ui_bridge::commands::a2ui_bridge_runtime_paths,
            wallpaper::commands::wallpaper_save,
            wallpaper::commands::wallpaper_list,
            wallpaper::commands::wallpaper_delete,
            wallpaper::commands::wallpaper_resolve_path,
            wallpaper::commands::wallpaper_read_data_url,
            mcp_server::commands::mcp_server_start,
            mcp_server::commands::mcp_server_stop,
            mcp_server::commands::mcp_server_restart,
            mcp_server::commands::mcp_server_status,
            proxy_config::commands::proxy_set,
            proxy_config::commands::proxy_get_active,
            proxy_config::commands::proxy_detect,
            proxy_config::commands::proxy_test,
            proxy_config::commands::proxy_http_request,
            connectors::commands::connectors_register_adapter,
            connectors::commands::connectors_unregister_adapter,
            connectors::commands::connectors_health,
            connectors::commands::connectors_start_server,
            connectors::commands::connectors_stop_server,
            connectors::commands::connectors_keyring_set,
            connectors::commands::connectors_keyring_get,
            connectors::commands::connectors_keyring_delete,
            connectors::commands::connectors_keyring_list,
            connectors::commands::connectors_http_request,
            connectors::commands::connectors_ws_open,
            connectors::commands::connectors_ws_send,
            connectors::commands::connectors_ws_close,
            connectors::commands::connectors_attachment_fetch,
            remote_control::commands::remote_control_get_status,
            remote_control::commands::remote_control_start,
            remote_control::commands::remote_control_stop,
            remote_control::commands::remote_control_get_token,
            remote_control::commands::remote_control_rotate_token,
            remote_control::commands::remote_control_update_config,
            remote_control::commands::remote_control_set_signing_secret,
            remote_control::commands::remote_control_get_signing_secret,
        ])
        .setup(|app| {
            // Bootstrap native logging in *all* builds. Installs tauri-plugin-log
            // with stdout / file / webview targets and mirrors records into the
            // OS-native platform logger (EventLog / OSLog / journald). The
            // frontend's unified logger consumes the webview target via
            // `log://log` events.
            if let Err(error) = logging::bootstrap(app) {
                log::warn!("native_logging bootstrap failed: {error}");
            }

            // Register the default global shortcuts. Routing logic lives in the
            // plugin builder's handler above.
            //   Ctrl+Shift+Space — show/hide main window
            //   Ctrl+Shift+L     — open the Log Panel (/logs)
            #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
            {
                let toggle_chord =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                if let Err(e) = app.global_shortcut().register(toggle_chord) {
                    log::warn!("failed to register Ctrl+Shift+Space shortcut: {e}");
                }
                let logs_chord =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyL);
                if let Err(e) = app.global_shortcut().register(logs_chord) {
                    log::warn!("failed to register Ctrl+Shift+L (open logs) shortcut: {e}");
                }
            }

            // Deep-link runtime registration & event listener. On Linux/dev-Windows
            // the OS doesn't auto-register schemes from the bundle config —
            // `register_all` does it at runtime. Idempotent on macOS and release
            // Windows, where the bundle already registered the scheme.
            #[cfg(desktop)]
            {
                #[cfg(any(target_os = "linux", all(debug_assertions, target_os = "windows")))]
                {
                    if let Err(e) = app.deep_link().register_all() {
                        log::warn!("failed to register deep-link schemes: {e}");
                    }
                }
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                    log::info!("deep-link received: {urls:?}");
                    let _ = app_handle.emit("deep-link://received", urls);
                });
            }

            // Forward initial CLI matches to the frontend on first launch. The
            // `cli://second-instance` event covers re-launches.
            #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
            {
                use tauri_plugin_cli::CliExt;
                match app.cli().matches() {
                    Ok(matches) => {
                        if let Ok(payload) = serde_json::to_value(&matches) {
                            let _ = app.emit("cli://matches", payload);
                        }
                    }
                    Err(e) => log::warn!("failed to read CLI matches: {e}"),
                }
            }

            // Build the application menu and the system tray. Both route their
            // events through `app.on_menu_event` and `tray://*` events that the
            // frontend subscribes to.
            #[cfg(desktop)]
            {
                if let Err(e) = menu::install(app) {
                    log::warn!("failed to install application menu: {e}");
                }
                if let Err(e) = tray::install(app) {
                    log::warn!("failed to install tray icon: {e}");
                }
            }

            // Honor the user's "minimize to tray on close" preference. When the
            // flag is on, intercept the close request and hide the window instead
            // of letting the runtime tear it down — the tray menu's "Quit" still
            // exits cleanly.
            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let behavior = handle.state::<WindowBehavior>();
                        if behavior.tray_on_close() {
                            api.prevent_close();
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }

            // A2UI bridge socket — listens for `a2ui_dispatch` lines emitted
            // by `sidecar/a2ui-mcp.mjs` (spawned by external agents like
            // Claude Code CLI). The path is exposed via the
            // `COGNIA_BRIDGE_SOCKET` env var; adapters propagate it through
            // `McpServer.config.env` when projecting a2ui-bridge.
            {
                let app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    a2ui_bridge::spawn(app).await;
                });
            }

            // Remote-control inbound listener auto-start. Per ADR-0005, only
            // starts when `inbound.enabled` is persisted true AND the OS
            // keyring still has a token — `RemoteControlState::new()` already
            // clears `enabled` to false when the token is missing, so this
            // spawn is a safe no-op on a fresh install.
            {
                let app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let rc_state = app.state::<remote_control::RemoteControlState>();
                    if rc_state.config().inbound.enabled {
                        match rc_state.start(app.clone()).await {
                            Ok(()) => log::info!("remote-control inbound listener started"),
                            Err(e) => log::warn!("remote-control auto-start skipped: {e}"),
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
