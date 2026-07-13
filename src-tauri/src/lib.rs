mod a2ui_bridge;
mod account_auth;
mod agents;
// ADR-0067 Tier B prep — extracted to `crates/cognia-secrets`; re-aliased so
// `crate::api_key::ApiKeyState` (claude, subscription, companion_api, headless)
// resolves unchanged.
pub use cognia_secrets::api_key;
// ADR-0067 Phase 5 — automation/sandbox/cua_sandbox extracted to the
// `crates/cognia-automation` cluster; re-aliased so all three module paths
// (generate_handler! + .manage()) resolve unchanged.
pub use cognia_automation::automation;
mod browser;
mod canvas;
mod capture;
// ADR-0067 follow-up — extracted to `crates/cognia-ccswitch`; re-aliased so
// `ccswitch::…` (generate_handler! + .manage()) resolves unchanged.
pub use cognia_ccswitch as ccswitch;
mod claude;
mod cli_bridge;
// ADR-0067 Phase 6 — extracted to cognia-core; re-aliased so `crate::command_error`
// (claude, logging, plugin_api/vscode, top-level) resolves unchanged.
pub use cognia_core::command_error;
mod commands;
pub mod companion_api;
// ADR-0067 Tier B — extracted to `crates/cognia-connectors` (isolates the
// matrix-sdk E2EE stack); re-aliased so `crate::connectors::…` (companion_api,
// plugin_api, headless, generate_handler! + .manage()) resolves unchanged.
pub use cognia_connectors as connectors;
pub mod crash;
pub use cognia_automation::cua_sandbox;
mod external_agent;
mod files;
pub mod fleet;
mod fonts;
// ADR-0067 — extracted to `crates/cognia-core`; re-aliased so `crate::fs_atomic`
// (fleet, ccswitch, automation, top-level modules) resolves unchanged.
pub use cognia_core::fs_atomic;
// ADR-0067 follow-up — extracted to `crates/cognia-gateway`; re-aliased so
// `gateway::…` (generate_handler! + .manage()) resolves unchanged.
pub use cognia_gateway as gateway;
// ADR-0067 Phase 2 — extracted to `crates/cognia-git`; re-aliased so every
// `crate::git::…` reference (incl. `generate_handler!` + `.manage()`) resolves.
pub use cognia_git as git;
mod github;
pub mod headless;
mod hooks;
mod keyring_secrets;
mod logging;
mod mcp_oauth;
mod mcp_server;
// ADR-0067 Phase 3 — extracted to `crates/cognia-ocr`; re-aliased so
// `crate::ocr::{NativeOcrRegistry, install_default_backends, commands::…}` resolve.
pub use cognia_ocr as ocr;
mod parse;
mod perf;
mod pet_window;
// ADR-0067 Tier B — extracted to `crates/cognia-plugin-runtime` (isolates
// wasmtime/cranelift); re-aliased so `crate::plugin_api::…` (companion_api,
// cli_bridge, generate_handler! + .manage()) resolves unchanged.
pub use cognia_plugin_runtime as plugin_api;
mod plugins;
mod proxy_config;
// ADR-0067 follow-up — extracted to `crates/cognia-remote-control`;
// re-aliased so `crate::remote_control::…` (gateway, generate_handler!)
// resolves unchanged.
pub use cognia_remote_control as remote_control;
pub use cognia_automation::sandbox;
// ADR-0067 Phase 6 — scheduler/workflow/timing extracted to the
// cognia-scheduling cluster; re-aliased so all three module paths resolve.
pub use cognia_scheduling::scheduler;
// ADR-0067 Tier B prep — extracted to `crates/cognia-secrets`; re-aliased so
// every `crate::secret_store::…` call site (subscription, connectors, gateway,
// remote_control, tts, plugin_api, companion_api, mcp_oauth, headless) resolves
// unchanged. `keyring_secrets`/`proxy_config` stay as app-side facades because
// they keep their `#[tauri::command]` shells.
pub use cognia_secrets::secret_store;
mod session_import;
mod session_import_watch;
mod settings;
mod shell;
// ADR-0067 follow-up — extracted to `crates/cognia-skills` (zero coupling);
// re-aliased so `crate::skills::…` (companion_api rpc + generate_handler!)
// resolves unchanged.
pub use cognia_skills as skills;
mod subscription;
mod supervision_backoff;
// ADR-0067 Tier B — extracted to `crates/cognia-terminal`; re-aliased so
// `crate::terminal::…` (companion_api rpc/ws_terminal, plugin_api cli_exec,
// generate_handler! + .manage()) resolves unchanged.
pub use cognia_terminal as terminal;
pub use cognia_scheduling::timing;
// ADR-0067 follow-up — extracted to `crates/cognia-tts`; re-aliased so
// `crate::tts::…` (generate_handler!) resolves unchanged.
pub use cognia_tts as tts;
mod twin;
// ADR-0067 Phase 4 — extracted to `crates/cognia-vector`; re-aliased so
// `crate::vector::{VectorState, VectorRegistry, commands::…}` resolve.
pub use cognia_vector as vector;
mod wallpaper;
mod webclone;
pub use cognia_scheduling::workflow;

mod webview_watchdog;
mod window_behavior;
mod window_recovery;
mod window_utils;

#[cfg(desktop)]
mod menu;
mod shortcuts;
mod tray;

use api_key::ApiKeyState;
use claude::sidecar::{kill_sidecar, SidecarState};
use tauri::{Emitter, Manager, State};
use window_behavior::WindowBehavior;

#[cfg(desktop)]
use tauri::WindowEvent;

#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
use tauri_plugin_global_shortcut::ShortcutState;

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
    // Ordered `[name, value]` pairs forwarded as `ANTHROPIC_CUSTOM_HEADER_*` at
    // spawn (CCSwitch relays that gate 1M behind `anthropic-beta`, etc.). Only
    // meaningful for callers that manage headers: `None` leaves the existing
    // set untouched, `Some([])` explicitly clears it.
    custom_headers: Option<Vec<(String, String)>>,
) -> Result<(), String> {
    state.set_provider(api_key, base_url).await;
    if let Some(headers) = custom_headers {
        state.set_custom_headers(headers).await;
    }
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

/// Forwards `cognia-vector`'s credential persistence to the OS keyring via
/// `keyring_secrets` (ADR-0067 Phase 4). Installed once at boot so the extracted
/// vector crate never depends on `secret_store`/`keyring_secrets` directly.
struct KeyringVectorCredentialStore;

impl cognia_vector::CredentialStore for KeyringVectorCredentialStore {
    fn set(&self, namespace: &str, key: &str, value: &str) -> Result<(), String> {
        keyring_secrets::set(namespace, key, value)
    }
    fn get(&self, namespace: &str, key: &str) -> Result<Option<String>, String> {
        keyring_secrets::get(namespace, key)
    }
    fn clear(&self, namespace: &str, key: &str) -> Result<(), String> {
        keyring_secrets::clear(namespace, key)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ADR-0067 Phase 4 — install the vector credential store before any command
    // (or the managed VectorRegistry) can touch provider credentials.
    vector::install_credential_store(Box::new(KeyringVectorCredentialStore));

    // ADR-0067 Tier B — the extracted terminal crate can't reach cli_bridge's
    // managed-download registry; hand it the snapshot provider before any
    // terminal can spawn.
    terminal::commands::set_managed_cli_dirs_provider(cli_bridge::detect::managed_dirs_snapshot);

    // ADR-0067 Tier B — the extracted plugin runtime can't reach
    // claude::sidecar; hand its vscode LSP host the sidecar-dir resolver.
    plugin_api::vscode::commands::set_sidecar_dir_resolver(claude::sidecar::sidecar_dir);

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
            .plugin(
                // The pet overlay owns its own position via PetSettings, so
                // exclude it from the window-state plugin's save/restore.
                //
                // Restore SIZE/POSITION/MAXIMIZED/DECORATIONS but NOT FULLSCREEN
                // or VISIBLE:
                //   - FULLSCREEN: a window saved fullscreen on a display that is
                //     later disconnected/rearranged restores into a macOS Space
                //     on an absent monitor — the app boots alive but invisible
                //     (see window_recovery + ADR notes). Re-centering can't undo
                //     a fullscreen Space, so we never restore it.
                //   - VISIBLE: visibility is owned by the boot path — the window
                //     is created hidden (`visible:false`) and revealed only after
                //     the renderer signals first paint (white-flash fix). Letting
                //     the plugin restore a stale hidden/visible bit would fight
                //     that handshake.
                tauri_plugin_window_state::Builder::default()
                    // "island": the fleet overlay recomputes its top-center
                    // placement on every open/resize; persisted coordinates
                    // would fight it (same rationale as the pet).
                    .with_denylist(&["pet", "pet-popup", "island"])
                    .with_state_flags(
                        tauri_plugin_window_state::StateFlags::all()
                            & !tauri_plugin_window_state::StateFlags::FULLSCREEN
                            & !tauri_plugin_window_state::StateFlags::VISIBLE,
                    )
                    .build(),
            )
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        // Every chord we own is registered into the unified
                        // `ShortcutRegistry`. The handler delegates to its
                        // `dispatch` method, which runs the built-in side
                        // effect (window toggle / open logs / kill switch)
                        // for the three pre-seeded ids and emits
                        // `shortcut://triggered` for renderer-bound entries.
                        if event.state() != ShortcutState::Pressed {
                            return;
                        }
                        let registry = app.state::<std::sync::Arc<shortcuts::ShortcutRegistry>>();
                        registry.dispatch(app, shortcut);
                    })
                    .build(),
            )
            .plugin(tauri_plugin_autostart::Builder::new().build())
            .plugin(tauri_plugin_cli::init());
    }

    // macOS: the desktop-pet windows are reclassed to non-activating NSPanels
    // (`pet_window/macos_panel.rs`); `WebviewWindow::to_panel` needs this
    // plugin's manager to be registered.
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
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
        // Shell plugin powers the one-click cloudflared tunnel button in
        // Settings → GitHub Delivery → Repos. Scope is locked to the
        // `cloudflared` binary in `tauri.conf.json`; we don't expose a
        // generic shell to the renderer.
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        // ADR-pluginset expansion — see `docs/content/docs/en/adr/` once an ADR
        // exists. `persisted-scope` survives fs/asset grants across restarts;
        // `upload` ships chunked upload/download with progress events; `positioner`
        // is the window-placement helper consumed by the tray UI.
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_upload::init())
        .plugin(tauri_plugin_positioner::init())
        .manage(claude::SidecarState::new())
        .manage(ApiKeyState::new())
        // ADR-0025 — unified subscription module. In-process cache of the
        // active account + resolved env per provider. Populated lazily by
        // `subscription_set_active`; readers (sidecar spawn, external-agent
        // env-builder) consume it via `subscription_get_active`.
        .manage(subscription::ActiveAccountState::new())
        .manage(WindowBehavior::new())
        // Runtime white-screen watchdog state (ADR window-recovery). Written by
        // the renderer heartbeat command, read by the polling loop spawned in
        // setup() once the main window exists.
        .manage(webview_watchdog::WebviewWatchdog::new())
        .manage(std::sync::Arc::new(shortcuts::ShortcutRegistry::default()))
        .manage(connectors::ConnectorsState::new())
        .manage(connectors::commands::ConnectorsServer(std::sync::Arc::new(
            tokio::sync::Mutex::new(None),
        )))
        .manage(remote_control::RemoteControlState::new())
        .manage(gateway::GatewayState::new())
        .manage(mcp_server::McpServerState::new())
        .manage(companion_api::CompanionServerState::with_data_dir(
            dirs::data_dir(),
        ))
        // ADR-0021 — process-wide WebRTC signaling registry. One hub per app
        // instance; the renderer pushes device registrations via
        // `companion_signaling_sync_devices` after Dexie hydration completes.
        .manage(companion_api::signaling::SignalingHub::new())
        // ADR-0024 — Native OCR registry. Backends are populated in the
        // setup hook after platform detection (Windows MSIX check, etc.).
        .manage(ocr::NativeOcrRegistry::new())
        // Performance panel — ref-counted process/runtime/span sampler. The
        // loop is started/stopped on demand from the renderer (panel
        // mount/unmount), so this `.manage(...)` only registers the control
        // surface + sample ring; nothing samples while the panel is closed.
        .manage(perf::PerfState::new())
        // CLI bridge — loopback-only HTTP listener that `cognia-cli` talks
        // to for `install`/`uninstall`/`reload`. Spawned at app boot in the
        // setup hook below; this `.manage(...)` just registers the state
        // wrapper so the handle survives for the app's lifetime.
        .manage(cli_bridge::CliBridgeServerState::new())
        .setup(|app| {
            // Phase B follow-up — install the keyring-backed push credential
            // store and reinstate any FCM/APNs dispatchers the user uploaded
            // in a prior session.
            //
            // Deferred off the synchronous startup path via `spawn_blocking`:
            // keyring access (store init + dispatcher reinstall) is blocking
            // OS-credential I/O that can spike to hundreds of ms on a cold
            // credential subsystem, which would delay window paint (setup()
            // runs before the event loop / window show). No push command fires
            // during boot — a connector has to be running first — and the
            // pre-install push path already warns gracefully, so installing a
            // moment later is safe.
            tauri::async_runtime::spawn_blocking(|| {
                companion_api::push_creds::install(
                    companion_api::push_creds::KeyringPushCredStore::new(),
                );
                if let Err(err) = companion_api::push_creds::reinstall_persisted_dispatchers() {
                    log::warn!("push-creds reinstall failed: {err}");
                }
            });
            // Seed the FS allowed-roots registry (shadow-mode containment for the
            // raw read/write/ensure_dir commands). Pure in-memory inserts — the
            // renderer extends it with the active workspace roots once it loads.
            files::seed_default_allowed_roots();
            let _ = app;
            Ok(())
        })
        .manage(external_agent::commands::ExternalAgentState::default())
        .manage(external_agent::commands::AcpTerminalState::default())
        .manage(scheduler::SchedulerState::new(
            dirs::data_dir().map(|d| d.join("cognia").join("scheduler_metadata.sqlite")),
        ))
        .manage(vector::VectorState::new(
            dirs::data_dir().map(|d| d.join("cognia").join("vectors.sqlite")),
        ))
        .manage(vector::VectorRegistry::new())
        .manage(plugin_api::PluginRuntimeState::new(
            dirs::data_dir()
                .map(|d| d.join("cognia").join("plugins"))
                .unwrap_or_else(|| std::path::PathBuf::from(".")),
        ))
        // Python plugin runtime (subprocess JSON-RPC host) — separate state
        // from PluginRuntimeState: subprocess handles vs install-dir ledger.
        .manage(plugin_api::python::PythonRuntimeState::new(
            dirs::data_dir()
                .map(|d| d.join("cognia").join("python"))
                .unwrap_or_else(|| std::path::PathBuf::from(".")),
        ))
        .manage(plugin_api::wasm::WasmPluginState::default())
        // ADR-0028 Phase 14 — OAuth refresh watchers per Anthropic account.
        .manage(subscription::anthropic::credential::WatcherRegistry::new())
        // Integrated terminal (`src-tauri/src/terminal/`) — VSCode-style
        // PTY sessions exposed to the renderer via `tauri::ipc::Channel`.
        // The store outlives the window; dropping it on app shutdown
        // cascades into per-session Drop kills.
        .manage(terminal::TerminalState::new())
        // Headless (unattended) terminal sessions — workflow nodes running
        // shell lines with no visible dock tab. Independent of TerminalState
        // so dock listing / audit views never see them.
        .manage(terminal::headless::HeadlessTerminalState::new())
        // Source Control panel (ADR-0038) — the watcher map per active repo.
        // Stateless commands aside, this is the subsystem's only managed state.
        .manage(git::GitWatcherState::new())
        // CCSwitch live db watch (Phase 4.2) — single owner over cc-switch.db,
        // emits `ccswitch://db-changed` so the CCSwitch section refreshes when
        // the user switches providers in cc-switch itself.
        .manage(ccswitch::watcher::CcswitchWatcherState::new())
        .manage(session_import_watch::SessionImportWatcherState::new())
        .manage(plugin_api::vscode::VscodeExtensionState::new(
            dirs::data_dir()
                .map(|d| d.join("cognia").join("vscode-extensions"))
                .unwrap_or_else(|| std::path::PathBuf::from(".")),
        ))
        // Automation subsystem state — registered via `app.manage` from
        // setup() below so the worker thread can hold a Tauri `AppHandle`
        // and emit `automation:worker-restart` / `automation:worker-dead`
        // events on backend panic (ADR-0020 W1). See the matching setup
        // block in `.setup(|app| { ... })`.
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::menu_action_ids,
            commands::set_window_background_color,
            account_auth::account_password_create_verifier,
            account_auth::account_password_verify,
            claude::commands::claude_send,
            claude::commands::claude_interrupt,
            claude::commands::claude_compact,
            claude::commands::claude_restore,
            claude::commands::claude_approve,
            claude::commands::claude_plugin_tool_response,
            claude::commands::claude_tool_result_decision,
            claude::commands::claude_protocol_adapter_message,
            claude::commands::claude_close_session,
            claude::commands::claude_session_control,
            claude::commands::claude_sidecar_status,
            claude::commands::sidecar_restart_count,
            claude::mcp_test::test_mcp_server,
            // Hooks runtime bridge — external agents (claude-code/codex/opencode)
            // reach the settings.json hook runtime via run_agent_hook; the trust
            // gate for project/local-scope hooks is seeded by set_trusted_workspaces.
            hooks::commands::run_agent_hook,
            hooks::commands::set_trusted_workspaces,
            agents::commands::read_agent_config,
            agents::commands::write_agent_config,
            // ADR-0062 — external-agent session-history import. Reads OpenCode's
            // local SQLite store read-only for the session importer.
            session_import::opencode_sessions_read,
            session_import_watch::session_import_watch_start,
            session_import_watch::session_import_watch_stop,
            ccswitch::commands::ccswitch_status,
            ccswitch::commands::ccswitch_list_providers,
            ccswitch::commands::ccswitch_list_mcp_servers,
            ccswitch::commands::ccswitch_list_prompts,
            ccswitch::commands::ccswitch_list_skills,
            ccswitch::commands::write_codex_auth_env,
            ccswitch::commands::write_gemini_settings_env,
            ccswitch::commands::write_opencode_auth_env,
            ccswitch::watcher::ccswitch_watch_start,
            ccswitch::watcher::ccswitch_watch_stop,
            // ADR-0025 — unified subscription module. Provider-agnostic CRUD,
            // active-pointer management, and provider preset persistence.
            subscription::commands::subscription_init,
            subscription::commands::subscription_list_accounts,
            subscription::commands::subscription_get_account,
            subscription::commands::subscription_save_account,
            subscription::commands::subscription_delete_account,
            subscription::commands::subscription_rename_account,
            subscription::commands::subscription_set_active,
            subscription::commands::subscription_get_active,
            subscription::commands::subscription_get_preset,
            subscription::commands::subscription_set_preset,
            subscription::commands::subscription_list_presets,
            subscription::commands::subscription_save_preset,
            subscription::commands::subscription_delete_preset,
            subscription::commands::subscription_set_default_preset,
            subscription::commands::subscription_authed_get,
            // ADR-0028 — per-`query()` env injection (per-session multi-account).
            subscription::commands::claude_env_for_account,
            subscription::commands::claude_proxy_env_for_session,
            // ADR-0028 — sandbox dispatch + health probe. Phase 4.5
            // plugin consumes sandbox_exec via plugin_tool_exec → renderer
            // → Tauri.
            sandbox::sandbox_health_probe,
            sandbox::sandbox_health_check,
            sandbox::sandbox_exec,
            subscription::anthropic::commands::anthropic_oauth_save_pkce_result,
            subscription::anthropic::commands::anthropic_oauth_discover,
            subscription::codex::commands::codex_oauth_discover,
            subscription::codex::commands::codex_oauth_request_device_code,
            subscription::codex::commands::codex_oauth_poll_device_code,
            subscription::codex::commands::codex_oauth_refresh,
            subscription::codex::commands::codex_oauth_revoke,
            subscription::opencode::commands::opencode_oauth_discover,
            subscription::opencode::commands::opencode_save_zen_key,
            subscription::opencode::commands::opencode_adopt_discovered,
            claude_set_api_key,
            claude_set_provider_env,
            claude_set_oauth_bearer,
            claude_has_api_key,
            claude_has_oauth_bearer,
            claude_restart_sidecar,
            canvas::python_exec::canvas_run_python,
            window_behavior::set_close_behavior,
            window_behavior::get_close_behavior,
            window_behavior::resolve_close_request,
            webview_watchdog::webview_heartbeat,
            webview_watchdog::webview_take_recovery_notice,
            pet_window::open_pet_window,
            pet_window::close_pet_window,
            pet_window::destroy_pet_window,
            pet_window::pet_window_set_ignore_cursor_events,
            pet_window::pet_window_set_position,
            pet_window::pet_window_get_position,
            pet_window::pet_window_get_work_area,
            pet_window::pet_window_get_surfaces,
            pet_window::is_pet_window_open,
            capture::get_foreground_app,
            pet_window::show_main_window,
            pet_window::open_pet_popup,
            pet_window::close_pet_popup,
            pet_window::pet_popup_resize,
            fleet::fleet_monitor_start,
            fleet::fleet_monitor_restore,
            fleet::fleet_monitor_stop,
            fleet::fleet_monitor_status,
            fleet::fleet_get_snapshot,
            fleet::fleet_permission_respond,
            fleet::fleet_opencode_send_message,
            fleet::control::fleet_focus_terminal,
            fleet::codex::fleet_codex_install,
            fleet::codex::fleet_codex_uninstall,
            fleet::codex::fleet_codex_status,
            fleet::opencode::fleet_opencode_install,
            fleet::opencode::fleet_opencode_uninstall,
            fleet::opencode::fleet_opencode_status,
            fleet::install::fleet_scripts_install,
            fleet::install::fleet_scripts_uninstall,
            fleet::install::fleet_scripts_status,
            fleet::island_window::open_island_window,
            fleet::island_window::close_island_window,
            fleet::island_window::is_island_window_open,
            fleet::island_window::island_resize,
            fleet::island_window::island_list_monitors,
            fleet::island_window::island_set_monitor,
            tray::commands::tray_set_menu,
            tray::commands::tray_set_icon_state,
            tray::commands::tray_set_tooltip,
            tray::commands::tray_set_title,
            tray::commands::tray_get_current_menu,
            tray::commands::tray_get_icon_state,
            tray::commands::tray_get_tooltip,
            tray::commands::tray_get_title,
            tray::commands::tray_register_icon,
            shortcuts::commands::shortcut_bind,
            shortcuts::commands::shortcut_unbind,
            shortcuts::commands::shortcut_list,
            shortcuts::commands::shortcut_check_conflict,
            shortcuts::commands::shortcut_get_chord_for_id,
            plugin_api::tray_items::plugin_tray_item_register,
            plugin_api::tray_items::plugin_tray_item_unregister,
            plugin_api::tray_items::plugin_tray_item_list,
            plugin_api::tray_items::plugin_tray_item_unregister_by_plugin,
            files::read_text_file,
            files::write_text_file,
            files::write_text_file_confined,
            files::ensure_dir,
            files::ensure_dir_confined,
            files::fs_set_allowed_roots,
            files::fs_allow_dialog_path,
            files::scan_claude_skills,
            files::read_claude_user_config,
            files::default_export_dir,
            files::fs_search_workspace,
            files::fs_search_content_workspace,
            files::fs_read_workspace_file,
            files::fs_write_workspace_file,
            files::fs_list_workspace_dir,
            files::fs_stat_workspace_file,
            files::fs_create_workspace_dir,
            files::fs_delete_workspace_entry,
            files::fs_rename_workspace_entry,
            files::fs_copy_workspace_entry,
            files::slash_commands_scan,
            files::memory_append,
            skills::native::skills_scan_dir,
            skills::native::skills_scan_native,
            skills::native::skills_scan_codex,
            skills::native::skills_move_to_trash,
            skills::native::skills_uninstall_native,
            skills::install::skills_install_native,
            skills::install::skills_install_mirrored,
            skills::install::skills_empty_trash,
            skills::install::skills_list_trash,
            skills::remote::skills_fetch_remote_md,
            skills::remote::skills_fetch_remote_json,
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
            terminal::commands::terminal_spawn,
            terminal::commands::terminal_reattach,
            terminal::commands::terminal_write,
            terminal::commands::terminal_resize,
            terminal::commands::terminal_kill,
            terminal::exec::terminal_exec,
            terminal::complete::terminal_complete_paths,
            terminal::path_scan::terminal_list_path_executables,
            fonts::os_list_fonts,
            webclone::web_clone_snapshot,
            terminal::headless::terminal_headless_exec,
            terminal::headless::terminal_headless_spawn,
            terminal::headless::terminal_headless_run,
            terminal::headless::terminal_headless_kill,
            terminal::commands::terminal_list_for_project,
            terminal::commands::terminal_list_all,
            terminal::commands::terminal_kill_port,
            tts::keyring::tts_keyring_get,
            tts::keyring::tts_keyring_set,
            tts::keyring::tts_keyring_delete,
            tts::keyring::tts_keyring_list_providers,
            keyring_secrets::keyring_secret_get,
            keyring_secrets::keyring_secret_set,
            keyring_secrets::keyring_secret_clear,
            cli_bridge::cli_bridge_status,
            cli_bridge::cli_bridge_renderer_response,
            cli_bridge::resolve_cli_home,
            cli_bridge::write_cli_home_file,
            cli_bridge::plugin_install_from_directory,
            cli_bridge::preview_local_manifest,
            cli_bridge::detect::detect_binary,
            cli_bridge::detect::detect_binary_invalidate,
            cli_bridge::download::download_cognia_cli,
            tts::edge::tts_edge_synthesize,
            tts::proxy::tts_proxy_fetch,
            tts::realtime::tts_realtime_synthesize,
            tts::realtime::tts_realtime_cancel,
            external_agent::commands::spawn_external_agent,
            external_agent::commands::send_to_external_agent,
            external_agent::commands::kill_external_agent,
            external_agent::commands::get_external_agent_status,
            external_agent::commands::list_external_agents,
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
            logging::commands::tracing_logging_get_levels,
            logging::commands::tracing_logging_set_levels,
            logging::commands::logs_query,
            logging::commands::logs_list_files,
            crash::commands::crash_set_context,
            crash::commands::crash_push_breadcrumb,
            crash::commands::crash_list_reports,
            crash::commands::crash_read_report,
            crash::commands::crash_open_report_dir,
            crash::commands::crash_delete_report,
            crash::commands::crash_take_pending,
            crash::commands::crash_logging_diagnostics,
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
            scheduler::commands::scheduler_arm_task,
            scheduler::commands::scheduler_disarm_task,
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
            vector::commands::vector_count_points,
            vector::commands::vector_get_stats,
            vector::commands::vector_scroll_points,
            vector::commands::vector_rename_collection,
            vector::commands::vector_export_collection,
            vector::commands::vector_import_collection,
            // Cloud vector backends (ADR-0022) — dispatch through VectorRegistry.
            vector::commands::vector_save_credentials,
            vector::commands::vector_delete_credentials,
            vector::commands::vector_list_configured_providers,
            vector::commands::vector_cloud_create_collection,
            vector::commands::vector_cloud_delete_collection,
            vector::commands::vector_cloud_list_collections,
            vector::commands::vector_cloud_get_collection,
            vector::commands::vector_cloud_upsert,
            vector::commands::vector_cloud_delete_points,
            vector::commands::vector_cloud_get_points,
            vector::commands::vector_cloud_query,
            vector::commands::vector_cloud_scroll,
            vector::commands::vector_cloud_count,
            vector::commands::vector_cloud_truncate,
            vector::commands::vector_cloud_health_check,
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
            mcp_server::commands::orchestration_proxy_response,
            mcp_oauth::mcp_oauth_status,
            mcp_oauth::mcp_oauth_load_entry,
            mcp_oauth::mcp_oauth_clear,
            mcp_oauth::mcp_oauth_authenticate,
            mcp_oauth::mcp_oauth_refresh,
            companion_api::commands::companion_server_start,
            companion_api::commands::companion_server_stop,
            companion_api::commands::companion_server_status,
            companion_api::commands::companion_issue_pair_jwt,
            companion_api::commands::companion_seed_deny_list,
            companion_api::commands::companion_revoke_device,
            companion_api::commands::companion_unrevoke_device,
            companion_api::commands::companion_set_remote_control,
            companion_api::commands::companion_seed_remote_control,
            companion_api::commands::companion_sync_pull_response,
            companion_api::commands::companion_message_response,
            companion_api::commands::companion_desktop_write_response,
            companion_api::commands::companion_get_tls_fingerprint,
            companion_api::commands::companion_tls_paths,
            companion_api::commands::companion_mdns_start,
            companion_api::commands::companion_mdns_stop,
            companion_api::commands::companion_mdns_status,
            companion_api::commands::companion_tunnel_start,
            companion_api::commands::companion_tunnel_stop,
            companion_api::commands::companion_tunnel_current,
            companion_api::commands::companion_tunnel_save_named_config,
            companion_api::commands::companion_tunnel_get_config,
            companion_api::commands::companion_tunnel_set_mode,
            companion_api::commands::companion_tunnel_clear_named,
            // ADR-0021 — WebRTC WAN signaling control surface.
            companion_api::signaling::commands::companion_signaling_sync_devices,
            companion_api::signaling::commands::companion_signaling_configure,
            companion_api::signaling::commands::companion_signaling_status,
            companion_api::signaling::commands::companion_signaling_devices_status,
            companion_api::signaling::commands::companion_signaling_reconnect_device,
            companion_api::commands::companion_push_configure_fcm,
            companion_api::commands::companion_push_configure_apns,
            companion_api::commands::companion_push_clear_fcm,
            companion_api::commands::companion_push_clear_apns,
            companion_api::commands::companion_push_status,
            companion_api::commands::companion_test_local_reachability,
            proxy_config::commands::proxy_set,
            proxy_config::commands::proxy_get_active,
            proxy_config::commands::proxy_detect,
            proxy_config::commands::proxy_identify_clash,
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
            connectors::commands::connectors_lark_ws_open,
            connectors::commands::connectors_lark_ws_close,
            connectors::commands::connectors_reset_all_ws,
            connectors::commands::connectors_attachment_fetch,
            connectors::commands::connectors_attachment_read,
            connectors::commands::connectors_media_upload,
            connectors::commands::connectors_matrix_crypto_init,
            connectors::commands::connectors_matrix_crypto_outgoing_requests,
            connectors::commands::connectors_matrix_crypto_mark_request_sent,
            connectors::commands::connectors_matrix_crypto_receive_sync_changes,
            connectors::commands::connectors_matrix_crypto_decrypt_event,
            connectors::commands::connectors_matrix_crypto_encrypt_event,
            connectors::commands::connectors_matrix_crypto_share_room_key,
            connectors::commands::connectors_matrix_crypto_update_tracked_users,
            connectors::commands::connectors_matrix_crypto_get_missing_sessions,
            connectors::commands::connectors_matrix_crypto_encrypt_attachment,
            connectors::commands::connectors_matrix_crypto_decrypt_attachment,
            connectors::commands::connectors_lark_upload_file,
            connectors::commands::connectors_lark_upload_image,
            connectors::commands::connectors_onebot_probe,
            remote_control::commands::remote_control_get_status,
            remote_control::commands::remote_control_start,
            remote_control::commands::remote_control_stop,
            remote_control::commands::remote_control_get_token,
            remote_control::commands::remote_control_rotate_token,
            remote_control::commands::remote_control_update_config,
            remote_control::commands::remote_control_set_signing_secret,
            remote_control::commands::remote_control_get_signing_secret,
            remote_control::commands::remote_control_query_response,
            gateway::commands::gateway_get_status,
            gateway::commands::gateway_get_config,
            gateway::commands::gateway_update_config,
            gateway::commands::gateway_start,
            gateway::commands::gateway_stop,
            gateway::commands::gateway_list_keys,
            gateway::commands::gateway_create_key,
            gateway::commands::gateway_update_key,
            gateway::commands::gateway_delete_key,
            gateway::commands::gateway_reveal_key,
            gateway::commands::gateway_reset_key_quota,
            gateway::commands::gateway_push_snapshot,
            gateway::commands::gateway_decision_response,
            workflow::commands::workflow_register_trigger,
            workflow::commands::workflow_unregister_trigger,
            workflow::commands::workflow_persist_run_state,
            workflow::commands::workflow_reload_in_flight_runs,
            workflow::commands::workflow_ack_completed,
            workflow::commands::workflow_get_webhook_url,
            workflow::commands::workflow_webhook_respond,
            plugin_api::scan::plugin_scan_directory,
            plugin_api::cli_exec::plugin_cli_exec,
            plugin_api::python::commands::plugin_python_initialize,
            plugin_api::python::commands::plugin_python_runtime_info,
            plugin_api::python::commands::plugin_python_load,
            plugin_api::python::commands::plugin_python_get_tools,
            plugin_api::python::commands::plugin_python_call_tool,
            plugin_api::python::commands::plugin_python_call,
            plugin_api::python::commands::plugin_python_eval,
            plugin_api::python::commands::plugin_python_import,
            plugin_api::python::commands::plugin_python_module_call,
            plugin_api::python::commands::plugin_python_module_getattr,
            plugin_api::python::commands::plugin_python_call_hook,
            plugin_api::python::commands::plugin_python_push_config,
            plugin_api::python::commands::plugin_python_install_deps,
            plugin_api::python::commands::plugin_python_is_initialized,
            plugin_api::python::commands::plugin_python_get_info,
            plugin_api::python::commands::plugin_python_unload,
            plugin_api::python::commands::plugin_python_list,
            plugin_api::lifecycle::plugin_load,
            plugin_api::lifecycle::plugin_enable,
            plugin_api::lifecycle::plugin_disable,
            plugin_api::lifecycle::plugin_unload,
            plugin_api::lifecycle::plugin_install,
            plugin_api::lifecycle::plugin_uninstall,
            plugin_api::lifecycle::plugin_get_all,
            plugin_api::lifecycle::plugin_runtime_snapshot,
            plugin_api::lifecycle::plugin_set_state,
            plugin_api::lifecycle::plugin_set_status,
            plugin_api::lifecycle::plugin_get_state,
            plugin_api::permissions::plugin_permission_grant,
            plugin_api::permissions::plugin_permission_list,
            plugin_api::permissions::plugin_permission_revoke,
            plugin_api::api_bridge::plugin_api_invoke,
            plugin_api::api_bridge::plugin_api_batch_invoke,
            plugin_api::api_bridge::plugin_get_capabilities,
            plugin_api::api_bridge::plugin_set_shell_allowlist,
            plugin_api::api_bridge::plugin_set_network_allowlist,
            plugin_api::fs_watcher::plugin_fs_watch,
            plugin_api::fs_watcher::plugin_fs_unwatch,
            plugin_api::window_ops::plugin_window_minimize,
            plugin_api::window_ops::plugin_window_maximize,
            plugin_api::window_ops::plugin_window_unmaximize,
            plugin_api::window_ops::plugin_window_set_always_on_top,
            plugin_api::shortcut_ops::plugin_shortcut_register,
            plugin_api::shortcut_ops::plugin_shortcut_unregister,
            plugin_api::context_menu::plugin_context_menu_register,
            plugin_api::context_menu::plugin_context_menu_unregister,
            plugin_api::notification::plugin_show_notification,
            plugin_api::process_ops::plugin_process_kill,
            plugin_api::signature::plugin_generate_keypair,
            plugin_api::signature::plugin_create_signature,
            plugin_api::signature::plugin_verify_signature,
            plugin_api::signature::plugin_verify_detached_signature,
            plugin_api::signature::plugin_public_key_fingerprint,
            plugin_api::wasm::commands::plugin_wasm_load,
            plugin_api::wasm::commands::plugin_wasm_activate,
            plugin_api::wasm::commands::plugin_wasm_deactivate,
            plugin_api::wasm::commands::plugin_wasm_call,
            plugin_api::wasm::commands::plugin_wasm_unload,
            plugin_api::wasm::commands::plugin_wasm_list,
            plugin_api::wasm::installer::plugin_wasm_install_from_url,
            plugin_api::wasm::installer::plugin_wasm_install_from_git,
            plugin_api::github::installer::plugin_install_from_github,
            plugin_api::vscode::commands::plugin_vscode_install_vsix,
            plugin_api::vscode::commands::plugin_load_vscode,
            plugin_api::vscode::commands::plugin_activate_vscode,
            plugin_api::vscode::commands::plugin_deactivate_vscode,
            plugin_api::vscode::commands::plugin_unload_vscode,
            plugin_api::vscode::commands::plugin_invoke_vscode_rpc,
            plugin_api::vscode::commands::plugin_vscode_send_response,
            plugin_api::vscode::commands::ensure_system_lsp_host,
            plugin_api::backup::plugin_backup_create,
            plugin_api::backup::plugin_backup_restore,
            plugin_api::backup::plugin_backup_delete,
            plugin_api::marketplace::plugin_marketplace_versions,
            plugin_api::marketplace::plugin_get_directory,
            plugin_api::marketplace::plugin_read_verification,
            plugin_api::marketplace::plugin_download_version,
            plugin_api::marketplace::plugin_invalidate_cache,
            plugin_api::devtools::plugin_dev_server_start,
            plugin_api::devtools::plugin_dev_server_stop,
            plugin_api::devtools::plugin_dev_server_watch,
            plugin_api::devtools::plugin_dev_server_unwatch,
            plugin_api::devtools::plugin_watch_start,
            plugin_api::devtools::plugin_watch_stop,
            plugin_api::devtools::plugin_reload,
            plugin_api::devtools::plugin_list_dev_plugins,
            automation::commands::desktop_capabilities,
            automation::commands::desktop_subscribe_events,
            automation::commands::desktop_unsubscribe,
            automation::commands::desktop_get_focus,
            automation::commands::desktop_read_tree,
            automation::commands::desktop_find,
            automation::commands::desktop_screenshot,
            automation::commands::desktop_click,
            automation::commands::desktop_type,
            automation::commands::desktop_paste,
            automation::commands::desktop_launch_app,
            automation::commands::desktop_keys,
            automation::commands::desktop_invoke_pattern,
            automation::commands::desktop_mouse_move,
            automation::commands::desktop_drag,
            automation::commands::desktop_scroll,
            automation::commands::desktop_hold_key,
            automation::commands::desktop_mouse_button,
            automation::commands::desktop_window_op,
            automation::commands::desktop_cursor_position,
            automation::commands::desktop_pick_at_point,
            automation::commands::automation_execute,
            cua_sandbox::cua_sandbox_start,
            cua_sandbox::cua_sandbox_stop,
            cua_sandbox::cua_sandbox_health,
            automation::commands::automation_audit_snapshot,
            automation::commands::automation_policy_get,
            automation::commands::automation_policy_set,
            automation::commands::automation_settings_get,
            automation::commands::automation_settings_set,
            automation::commands::automation_set_enabled,
            automation::commands::automation_kill_switch_engaged,
            automation::commands::automation_kill_switch,
            automation::commands::automation_consent_respond,
            automation::commands::automation_drain_init_failure,
            automation::commands::desktop_pick_session_start,
            automation::commands::desktop_pick_session_cancel,
            automation::record::commands::record_start,
            automation::record::commands::record_stop,
            automation::record::commands::record_status,
            automation::record::commands::record_cancel,
            automation::commands::virtual_display_health_probe,
            automation::commands::virtual_display_setup,
            automation::commands::virtual_display_probe,
            automation::commands::virtual_display_release,
            automation::commands::virtual_display_arm,
            // In-app browser (v0/Lovable-style visual editing) — embedded pane.
            browser::embedded::browser_embed_create,
            browser::embedded::browser_embed_set_bounds,
            browser::embedded::browser_embed_set_visible,
            browser::embedded::browser_embed_navigate,
            browser::embedded::browser_embed_reload,
            browser::embedded::browser_embed_set_select_mode,
            browser::embedded::browser_embed_capture,
            browser::embedded::browser_embed_destroy,
            // Agent browser loop (Phase 1) — snapshot/act/console/network + nav.
            browser::embedded::browser_embed_snapshot,
            browser::embedded::browser_embed_act,
            browser::embedded::browser_embed_drain_console,
            browser::embedded::browser_embed_drain_network,
            browser::embedded::browser_embed_back,
            browser::embedded::browser_embed_forward,
            browser::embedded::browser_embed_stop,
            browser::embedded::browser_embed_get_url,
            browser::embedded::browser_embed_get_title,
            browser::embedded::browser_embed_has_text,
            browser::embedded::browser_embed_has_selector,
            browser::embedded::browser_embed_evaluate,
            browser::embedded::browser_embed_network_state,
            plugins::computer_use::commands::plugin_computer_use_execute,
            plugins::computer_use::commands::plugin_computer_use_bash,
            plugins::computer_use::commands::plugin_computer_use_text_editor,
            twin::code_repo::twin_parse_git_repo,
            github::workspace::github_workspace_clone,
            github::workspace::github_workspace_commit_and_push,
            github::workspace::github_workspace_remove,
            github::workspace::github_workspace_stat,
            // Source Control panel (ADR-0038).
            git::commands::git_is_repo,
            git::commands::git_repo_state,
            git::commands::git_status,
            git::commands::git_diff_file,
            git::commands::git_diff_commit,
            git::commands::git_commit_files,
            git::commands::git_diff_refs_files,
            git::commands::git_diff_refs_file,
            git::commands::git_diff_staged_all,
            git::commands::git_log,
            git::commands::git_file_history,
            git::commands::git_refs,
            git::commands::git_blame,
            git::commands::git_branches,
            git::commands::git_remotes,
            git::commands::git_tags,
            git::commands::git_stash_list,
            git::commands::git_conflicts,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_discard,
            git::commands::git_discard_all,
            git::commands::git_commit,
            git::commands::git_checkout_branch,
            git::commands::git_create_branch,
            git::commands::git_delete_branch,
            git::commands::git_rename_branch,
            git::commands::git_worktree_add,
            git::commands::git_worktree_remove,
            git::commands::git_worktree_list,
            git::commands::git_worktree_commit,
            git::commands::git_worktree_prune,
            git::commands::git_fetch,
            git::commands::git_pull,
            git::commands::git_push,
            git::commands::git_sync,
            git::commands::git_remote_add,
            git::commands::git_remote_remove,
            git::commands::git_create_tag,
            git::commands::git_delete_tag,
            git::commands::git_push_tag,
            git::commands::git_reset,
            git::commands::git_restore,
            git::commands::git_rebase,
            git::commands::git_cherry_pick,
            git::commands::git_revert,
            git::commands::git_sequencer_continue,
            git::commands::git_sequencer_abort,
            git::commands::git_rebase_commits,
            git::commands::git_interactive_rebase,
            git::commands::git_stash_push,
            git::commands::git_stash_pop,
            git::commands::git_stash_apply,
            git::commands::git_stash_drop,
            git::commands::git_resolve_conflict,
            git::commands::git_init,
            git::commands::git_ignore_add,
            git::commands::git_merge,
            git::commands::git_merge_abort,
            git::commands::git_watch_start,
            git::commands::git_watch_stop,
            ocr::native::ocr_extract_native,
            ocr::native::ocr_list_native_backends,
            ocr::native::ocr_model_status,
            ocr::native::ocr_download_model,
            ocr::msix::ocr_msix_status,
            // Native document parsing (liteparse / PDFium) — feature-gated;
            // the default build answers `unsupported` and TS falls back.
            parse::parse_document_native,
            // Performance panel — process/runtime/span sampling + hotspots.
            perf::commands::perf_snapshot,
            perf::commands::perf_start_sampling,
            perf::commands::perf_set_interval,
            perf::commands::perf_stop_sampling,
            perf::commands::perf_hotspots,
            perf::commands::perf_reset_hotspots,
            perf::commands::perf_system_details,
            perf::commands::perf_list_traces,
            perf::commands::perf_open_trace_dir,
        ])
        .setup(|app| {
            // Startup timing anchor (perf/tauri-startup-unblock). `setup()` runs
            // on the main thread before the event loop starts, so its wall time
            // directly gates window paint. After the lazy-init work
            // (scheduler/vector/workflow opens + keyring now deferred), this
            // number is the residual synchronous startup cost — log it so the
            // before/after can be compared from the app logs.
            let setup_start = std::time::Instant::now();

            // ADR-0020 W1 — automation subsystem. We construct the
            // worker thread with an `AppHandle` so it can emit
            // `automation:worker-restart` / `automation:worker-dead`
            // events when the backend panics. Built here (instead of
            // `.manage({...})`) because the handle is only available
            // after `App` is built.
            {
                let app_handle = app.handle().clone();
                // The closure captures `app_handle` by clone on each
                // invocation so the worker thread (which may rebuild the
                // backend several times after a panic) can keep emitting
                // `automation:backend-init-failed` if reinit fails too.
                let app_handle_for_builder = app_handle.clone();
                let app_handle_for_vdd = app_handle.clone();
                let worker = automation::Worker::spawn_with_app(Some(app_handle), move || {
                    automation::make_default_backend_with_app(Some(app_handle_for_builder.clone()))
                });
                // ADR-0020 — hydrate the gate + policy from disk so a
                // configured tier / whitelist / per-action policy survives a
                // restart (previously this booted to `default()`, silently
                // dropping every persisted setting on every launch).
                let gate = automation::PermissionGate::new(automation::persist::load_settings());
                let audit = automation::AuditRing::new();
                let consent = automation::ConsentBroker::new();
                let policy = automation::persist::load_policy_state();
                // Screen-off Computer Use (ADR-0020 follow-up). Dedicated
                // thread owns the bundled parsec-vdd device + 100ms keep-alive
                // ping; the audit ring + app handle let it emit
                // `automation:event` rows on virtual-display enter / release.
                let virtual_display = automation::VirtualDisplayController::spawn(
                    automation::virtual_display::build_driver,
                    Some(audit.clone()),
                    Some(app_handle_for_vdd),
                );
                // ADR-0020 remote-target — registry of running cua desktop
                // sandboxes. Shared (Arc-backed clone) between the managed
                // state the `cua_sandbox_*` lifecycle commands read and the
                // `AutomationState` the `cua_route` dispatch layer reads, so
                // both see the same running containers.
                // Live UI-event delivery (trigger.desktop.event): watcher
                // threads forward focus-changed events through this sink to
                // `automation:uia-event`, which the TS workflow fan-out
                // (`lib/workflow/runtime/desktop-event-trigger.ts`) consumes.
                automation::events::wire_uia_event_sink(app.handle().clone());
                let cua_registry = cua_sandbox::CuaSandboxRegistry::default();
                app.manage(cua_registry.clone());
                app.manage(automation::commands::AutomationState::new(
                    worker,
                    gate,
                    audit,
                    consent,
                    policy,
                    virtual_display,
                    cua_registry,
                ));
            }

            // Bootstrap native logging in *all* builds. Installs tauri-plugin-log
            // with stdout / file / webview targets and mirrors records into the
            // OS-native platform logger (EventLog / OSLog / journald). The
            // frontend's unified logger consumes the webview target via
            // `log://log` events.
            if let Err(error) = logging::bootstrap(app) {
                log::warn!("native_logging bootstrap failed: {error}");
            }

            // Crash subsystem. Register the app handle so capture paths can emit
            // `crash://captured` to the webview; detect an abnormal previous
            // exit (BEFORE writing this session's sentinel) and stash it for the
            // next-launch dialog; then mark this session running. Finally push
            // an initial meta snapshot to the out-of-process monitor so an
            // immediate native crash still carries app state.
            {
                crash::install_app_handle(app.handle().clone());
                let pending = crash::sentinel::take_pending();
                crash::sentinel::mark_start();
                app.manage(crash::commands::PendingCrashState::new(pending));
                crash::context::publish_to_monitor();
            }

            // Retention sweep — crash reports (30d / 50) + rotated logs (keep
            // 5). Off the hot path: spawn a thread so a slow disk never delays
            // window paint. Failures are best-effort; the outcome is recorded
            // for the diagnostics command.
            std::thread::spawn(|| {
                if let Some(dir) = crash::crash_reports_dir() {
                    crash::retention::prune_crash_reports(
                        &dir,
                        &crash::retention::RetentionPolicy::default(),
                        chrono::Utc::now(),
                    );
                }
                if let Some(log_dir) = logging::native_bootstrap::log_dir() {
                    crash::retention::prune_rotated_logs(
                        &log_dir,
                        crash::retention::ROTATED_LOG_KEEP,
                    );
                }
            });

            // ADR-0024 — install the OCR native backends. Each enabled
            // Cargo feature (`ocr-tesseract`, `ocr-windows`, `ocr-apple`)
            // contributes its backend; absent features land a placeholder
            // that reports `MissingBinding` so the frontend can fall back.
            {
                let ocr_state = app.state::<ocr::NativeOcrRegistry>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    ocr::install_default_backends(&ocr_state).await;
                });
            }

            // Workflow subsystem (ADR 0011) — construct the cron daemon +
            // SQLite run-state mirror once we have an AppHandle (needed for
            // the trigger emitter). Skip silently if the data dir resolution
            // fails; web mode never reaches this branch and `manage` falls
            // back to a no-op state via the empty in-memory mirror.
            match dirs::data_dir() {
                Some(data_dir) => {
                    let mirror_path = workflow::default_mirror_path(&data_dir);
                    let emitter = std::sync::Arc::new(workflow::AppHandleEmitter {
                        handle: app.handle().clone(),
                    });
                    match workflow::WorkflowState::open(mirror_path, emitter.clone()) {
                        Ok(state) => {
                            // Spawn the cron loop once. Cloning is cheap — the
                            // inner Arc is shared, so the daemon held by the
                            // managed state and the spawned loop drive the same
                            // schedule registry.
                            state.cron.clone().spawn();

                            // Spawn the webhook router on a tokio task so the
                            // axum listener is up by the time the renderer
                            // calls `workflow_get_webhook_url`. Port 0 lets
                            // the OS pick — the bound port flows back through
                            // the URL command. Errors (port collision, etc.)
                            // are logged but don't block app startup.
                            let webhook_clone = state.webhook.clone();
                            let webhook_emitter = emitter.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(err) = webhook_clone.start(webhook_emitter, 0).await {
                                    log::warn!("workflow webhook router start failed: {err}");
                                }
                            });

                            app.manage(state);
                        }
                        Err(err) => {
                            log::warn!("workflow mirror open failed: {err}");
                        }
                    }
                }
                None => {
                    log::warn!("dirs::data_dir() unavailable — workflow mirror not initialized");
                }
            }

            // App-scheduler alarm daemon (headless timing) — build + spawn it
            // now that an AppHandle exists for the `scheduler:task-due` emitter.
            // The SchedulerState was `.manage()`-d earlier (cheap, lazy); we
            // only attach the daemon here. Mirrors the workflow cron daemon so
            // chat/agent/skill tasks fire while minimized to the tray.
            {
                let scheduler_state = app.state::<scheduler::SchedulerState>();
                scheduler_state.install_alarm(std::sync::Arc::new(
                    scheduler::AppHandleTaskDueEmitter {
                        handle: app.handle().clone(),
                    },
                ));
            }

            // Seed the unified shortcut registry with the three built-in
            // bindings. The registry owns OS-level register/unregister so the
            // renderer can rebind any of these at runtime without our help.
            // Routing logic lives in the plugin builder's handler above
            // (delegates to `ShortcutRegistry::dispatch`).
            #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
            {
                let registry = app
                    .state::<std::sync::Arc<shortcuts::ShortcutRegistry>>()
                    .inner()
                    .clone();
                shortcuts::registry::seed_builtins(app.handle(), &registry);
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

            // Honor the user's window close-button preference. `Quit` lets the
            // runtime tear the window down (the app exits); `Tray` hides the
            // window so the app keeps living in the system tray; `Ask`
            // intercepts the close and asks the frontend to show the
            // exit-confirmation dialog. The tray menu's "Quit" always exits
            // cleanly regardless, since it routes through PredefinedMenuItem.
            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                use window_behavior::CloseBehavior;

                // Recover a window the window-state plugin restored off-screen
                // (a monitor was disconnected/rearranged since last exit). Runs
                // while the window is still hidden, so the user only ever sees
                // it centered on a live display. FULLSCREEN restore is already
                // disabled at the plugin level above.
                window_recovery::recenter_if_offscreen(&window);

                // White-flash safety net. The window is created hidden
                // (`visible:false`); the renderer reveals it via
                // `getCurrentWindow().show()` after first paint. If the
                // renderer never gets there (JS crash, hung hydrate), force the
                // window visible after a grace period so a boot failure can
                // never leave an alive-but-invisible process.
                {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                        if let Some(window) = handle.get_webview_window("main") {
                            if !window.is_visible().unwrap_or(true) {
                                log::warn!(
                                    "main window still hidden 8s after boot; force-showing (renderer never signaled first paint)"
                                );
                                window_utils::bring_window_to_front(&window);
                            }
                        }
                    });
                }

                // Runtime white-screen watchdog. The renderer beats a
                // realm-lifetime heartbeat; if it goes silent while the window
                // is visible (renderer process crash, hung main thread, a page
                // navigated to a blank/broken document) the React error
                // boundaries can't fire — the JS realm is dead — so this loop
                // reloads the page back to its last-known-good route. This is
                // the runtime counterpart to the boot-time force-show above and
                // window_recovery's off-screen recenter.
                {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        loop {
                            tokio::time::sleep(webview_watchdog::POLL_INTERVAL).await;
                            let Some(window) = handle.get_webview_window("main") else {
                                continue;
                            };
                            let watchdog = handle.state::<webview_watchdog::WebviewWatchdog>();
                            let visible = window.is_visible().unwrap_or(false);
                            match watchdog.poll(std::time::Instant::now(), visible) {
                                webview_watchdog::WatchdogAction::Recover => {
                                    let url = watchdog.last_url();
                                    webview_watchdog::recover(&window, url.as_deref());
                                    watchdog.note_recovery(std::time::Instant::now());
                                }
                                webview_watchdog::WatchdogAction::GaveUp => {
                                    if watchdog.mark_gave_up_logged() {
                                        log::error!(
                                            "webview-watchdog: page still blank after {} reloads; giving up auto-recovery",
                                            webview_watchdog::MAX_RECOVERIES
                                        );
                                    }
                                }
                                webview_watchdog::WatchdogAction::Idle => {}
                            }
                        }
                    });
                }

                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let behavior = handle.state::<WindowBehavior>();
                        match behavior.close_behavior() {
                            CloseBehavior::Quit => {}
                            CloseBehavior::Tray => {
                                api.prevent_close();
                                if let Some(w) = handle.get_webview_window("main") {
                                    let _ = w.hide();
                                }
                            }
                            CloseBehavior::Ask => {
                                api.prevent_close();
                                let _ = handle.emit("app://close-requested", ());
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

            // Inbound LLM gateway auto-start (ADR-0043 M3). Mirrors the
            // remote-control gate: only starts when `enabled` is persisted
            // true AND the keyring still has a token (`GatewayState::new()`
            // clears `enabled` when the token is missing). Requests are
            // served from the renderer-pushed routing snapshot, so a
            // window-closed boot serves nothing until the first push — that's
            // intentional (the SERVICE_UNAVAILABLE body tells the caller).
            {
                let app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let gw_state = app.state::<gateway::GatewayState>();
                    // Load the persisted config (port / allowlist / timeouts /
                    // retry / model exposure / bind interface / enabled) before
                    // the auto-start check. A missing / corrupt file leaves the
                    // in-memory defaults (gateway stays off).
                    if let Ok(dir) = app.path().app_data_dir() {
                        gw_state
                            .hydrate_from_disk(dir.join("cognia").join("gateway-config.json"));
                    }
                    if gw_state.config().enabled {
                        match gw_state.start(app.clone()).await {
                            Ok(()) => log::info!("inbound gateway listener started"),
                            Err(e) => log::warn!("inbound gateway auto-start skipped: {e}"),
                        }
                    }
                });
            }

            // CLI bridge auto-start (plugin-author tooling). Binds an
            // ephemeral loopback port, writes the endpoint discovery file
            // so `cognia plugin install` etc. can find us. Best-effort —
            // failure is logged and the rest of the app keeps booting.
            {
                let app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let bridge_state = app.state::<cli_bridge::CliBridgeServerState>();
                    match cli_bridge::init(app.clone(), bridge_state.inner()).await {
                        Ok(port) => log::info!("cli_bridge listening on 127.0.0.1:{port}"),
                        Err(e) => log::warn!("cli_bridge auto-start failed: {e:#}"),
                    }
                });
            }

            log::info!(
                "native setup() completed in {:?} (heavy subsystem opens are lazy/spawned)",
                setup_start.elapsed()
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Graceful teardown — stop the loopback CLI bridge before the
            // process tears down its tokio runtime so the axum socket is
            // released cleanly. `shutdown` is idempotent and safe to call
            // even when the bridge was never spawned (mobile, init failures).
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                let state = app_handle.state::<cli_bridge::CliBridgeServerState>();
                cli_bridge::shutdown(state.inner());
                // ADR-0020 remote-target — stop any running cua sandbox
                // containers so we don't leak them past app exit.
                let cua = app_handle
                    .state::<cua_sandbox::CuaSandboxRegistry>()
                    .inner()
                    .clone();
                tauri::async_runtime::block_on(cua.shutdown_all());
                // Kill external-agent processes (auto-spawned `opencode serve`,
                // ACP `npx …` shims) and their ACP terminals so they are not
                // orphaned past app exit.
                let agents = app_handle
                    .state::<external_agent::commands::ExternalAgentState>()
                    .inner()
                    .0
                    .clone();
                let terminals = app_handle
                    .state::<external_agent::commands::AcpTerminalState>()
                    .inner()
                    .0
                    .clone();
                tauri::async_runtime::block_on(async move {
                    let _ = agents.kill_all().await;
                    let _ = terminals.kill_all().await;
                });
                // Graceful shutdown — clear the crash sentinel so the next
                // launch doesn't mistake this clean exit for a crash.
                crash::sentinel::mark_clean_exit();
            }
        });
}
