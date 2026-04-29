//! Native logging readiness commands
//!
//! Exposes native logging startup readiness to the frontend runtime.

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

use crate::logging::native_bootstrap;
use crate::logging::platform;

#[tauri::command]
pub async fn native_logging_get_readiness(
) -> Result<native_bootstrap::NativeLoggingReadiness, String> {
    Ok(native_bootstrap::get_native_logging_readiness())
}

#[tauri::command]
pub async fn native_logging_get_log_directory(app: tauri::AppHandle) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("failed_to_resolve_log_directory:{error}"))?;

    Ok(log_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn native_logging_open_log_directory(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("failed_to_resolve_log_directory:{error}"))?;

    if !log_dir.exists() {
        return Err("log_directory_missing".to_string());
    }

    app.opener()
        .open_path(log_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| format!("failed_to_open_log_directory:{error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn platform_logging_get_status() -> Result<platform::PlatformLoggingStatus, String> {
    Ok(platform::get_platform_logging_status())
}

#[tauri::command]
pub async fn platform_logging_set_config(
    config: platform::PlatformLoggingConfigUpdate,
) -> Result<platform::PlatformLoggingStatus, String> {
    Ok(platform::set_platform_logging_config(config))
}

#[tauri::command]
pub async fn platform_logging_forward(
    entries: Vec<platform::PlatformLogEntry>,
) -> Result<(), String> {
    platform::forward_entries(&entries)
}
