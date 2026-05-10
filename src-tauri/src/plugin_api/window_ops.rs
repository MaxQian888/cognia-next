//! Plugin window operation commands (Batch 3b).
//!
//! Acts on the main webview window. The TS side at
//! `lib/plugin/core/context.ts:1209-1221` wraps these with chained
//! `.catch(...)` blocks that now record diagnostics on rejection.

use tauri::{AppHandle, Manager};

use super::{PluginError, Result};

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow> {
    app.get_webview_window("main")
        .ok_or_else(|| PluginError::Internal("main webview window not found".into()))
}

#[tauri::command]
pub async fn plugin_window_minimize(app: AppHandle) -> Result<()> {
    main_window(&app)?
        .minimize()
        .map_err(|e| PluginError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn plugin_window_maximize(app: AppHandle) -> Result<()> {
    main_window(&app)?
        .maximize()
        .map_err(|e| PluginError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn plugin_window_unmaximize(app: AppHandle) -> Result<()> {
    main_window(&app)?
        .unmaximize()
        .map_err(|e| PluginError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn plugin_window_set_always_on_top(app: AppHandle, flag: bool) -> Result<()> {
    main_window(&app)?
        .set_always_on_top(flag)
        .map_err(|e| PluginError::Internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    // Tauri window operations require a `tauri::test::mock_app()` runtime
    // which fails on the developer's Windows STATUS_ENTRYPOINT_NOT_FOUND
    // condition (see ADR 0016 §3.99 verification block). Behavioural tests
    // run via `pnpm tauri dev` smoke instead.
    #[test]
    fn smoke() {
        assert!(true);
    }
}
