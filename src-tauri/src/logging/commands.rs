//! Native logging readiness commands
//!
//! Exposes native logging startup readiness to the frontend runtime.

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

use crate::logging::native_bootstrap;
use crate::logging::platform;
use crate::logging::query;
use crate::logging::tracing_setup;

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
        .map_err(|error| command_error("failed_to_resolve_log_directory", error))?;

    Ok(log_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn native_logging_open_log_directory(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| command_error("failed_to_resolve_log_directory", error))?;

    if !log_dir.exists() {
        return Err("log_directory_missing".to_string());
    }

    app.opener()
        .open_path(log_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| command_error("failed_to_open_log_directory", error))?;
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

#[tauri::command]
pub async fn tracing_logging_get_levels() -> Result<tracing_setup::TracingLevelsStatus, String> {
    Ok(tracing_setup::get_levels())
}

#[tauri::command]
pub async fn tracing_logging_set_levels(
    rules: Vec<tracing_setup::TargetLevel>,
    default_level: Option<String>,
) -> Result<tracing_setup::TracingLevelsStatus, String> {
    Ok(tracing_setup::set_levels(rules, default_level))
}

#[tauri::command]
pub async fn logs_query(
    query: query::NativeLogQuery,
) -> Result<query::NativeLogQueryResult, String> {
    query::query_native_logs(&query)
}

#[tauri::command]
pub async fn logs_list_files() -> Result<Vec<query::NativeLogFileInfo>, String> {
    query::list_native_log_files()
}

fn command_error(code: &str, error: impl std::fmt::Display) -> String {
    format!(
        "{code}:{}",
        platform::sanitize_error_message(error.to_string())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_error_normalizes_and_bounds_platform_details() {
        let raw = format!("{}\n\t{}", "io failure ".repeat(80), "tail");

        let err = command_error("failed_to_resolve_log_directory", raw);

        assert!(err.starts_with("failed_to_resolve_log_directory:"));
        assert!(!err.contains('\n'));
        assert!(!err.contains('\t'));

        let detail = err
            .strip_prefix("failed_to_resolve_log_directory:")
            .expect("prefix should be present");
        assert!(detail.len() <= 256);
    }
}
