//! Native logging — top-level module.
//!
//! Wires `tauri-plugin-log` to a configured set of targets (stdout / file /
//! webview) and a fern Dispatch chain that mirrors records to the OS-native
//! platform logger (Windows EventLog / macOS OSLog / Linux journald). The
//! frontend's unified logger consumes the webview target via the
//! `log://log` event and merges those records into the in-app log panel.
//!
//! The module is organised as:
//! - `platform` — cross-platform PlatformLogger trait + per-OS impls
//! - `native_bootstrap` — bootstrap planner (Full/Fallback/Disabled) and
//!   global readiness state queryable from the frontend
//! - `commands` — six Tauri commands the frontend invokes for readiness
//!   queries, log-directory access, and platform-logging config

pub mod commands;
pub mod native_bootstrap;
pub mod platform;
pub mod tracing_setup;

use crate::crash::retention::LOG_MAX_FILE_SIZE;
use tauri::App;
use tauri_plugin_log::{Builder as LogBuilder, RotationStrategy};

/// Bootstrap native logging. Plans the active targets, installs the
/// `tauri-plugin-log` plugin with the resolved targets, registers the
/// platform logger dispatch hook, and records the readiness state for
/// frontend queries.
///
/// Run unconditionally (release + debug). The bootstrap planner downgrades
/// to a `Fallback` (stdout + webview only) if the persistent log directory
/// can't be prepared, and to `Disabled` if `should_register` is false.
pub fn bootstrap(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let plan = native_bootstrap::plan_native_logging_bootstrap(true);

    // `LogBuilder::default()` already seeds `[Stdout, LogDir(None)]`. Using
    // `.target(...)` would append, producing duplicate stdout/file writes —
    // call `.targets(...)` (plural) so the planned set, plus the platform
    // dispatch target, fully replaces the defaults.
    let targets = plan
        .targets()
        .into_iter()
        .chain(std::iter::once(platform::dispatch_target()));
    // Cap the live `cognia.log` and let the plugin rotate. KeepAll preserves
    // every rotated file (the plugin can't "keep N"); the startup
    // `prune_rotated_logs` sweep supplies the missing count cap so the
    // rotation set stays bounded.
    let builder = LogBuilder::default()
        .level(log::LevelFilter::Info)
        // `fontdb::Database::load_system_fonts` (used by `os_list_fonts`) walks
        // every installed OS font and logs a WARN for each one it can't parse.
        // Windows ships proprietary/malformed faces like `mstmc.ttf` (Media
        // Center) that no TrueType parser accepts — the face is simply skipped,
        // so the warning is pure noise. Silence fontdb below Error.
        .level_for("fontdb", log::LevelFilter::Error)
        .max_file_size(LOG_MAX_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepAll)
        .targets(targets);

    if let Err(error) = app.handle().plugin(builder.build()) {
        log::warn!("native_logging: failed to install tauri-plugin-log: {error}");
        // Even if the plugin install fails, keep the recorded readiness
        // state so the frontend can surface the degraded status.
    }

    native_bootstrap::apply_native_logging_bootstrap(&plan);

    // Install the structured tracing subscriber alongside the plugin (separate
    // native subscriber; the plugin keeps ownership of the global `log` logger).
    // Non-fatal: a failure just means no `cognia-structured.log`.
    if !tracing_setup::init() {
        log::warn!("native_logging: structured tracing subscriber not installed");
    }

    Ok(())
}
