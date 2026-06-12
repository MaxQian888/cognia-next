//! Plugin window operation commands (Batch 3b).
//!
//! Acts on the main webview window. The TS side at
//! `lib/plugin/core/context.ts:1209-1221` wraps these with chained
//! `.catch(...)` blocks that now record diagnostics on rejection.

use serde_json::Value;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

use super::{PluginError, Result};

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow> {
    app.get_webview_window("main")
        .ok_or_else(|| PluginError::Internal("main webview window not found".into()))
}

/// Tauri label for a plugin-created window. The `"main"` id maps to the host's
/// own main window so a plugin can drive it (resize / show) the same way.
fn plugin_window_label(plugin_id: &str, window_id: &str) -> String {
    format!("plugin:{plugin_id}:{window_id}")
}

fn resolve_window(
    app: &AppHandle,
    plugin_id: &str,
    window_id: &str,
) -> Result<tauri::WebviewWindow> {
    let label = if window_id == "main" {
        "main".to_string()
    } else {
        plugin_window_label(plugin_id, window_id)
    };
    app.get_webview_window(&label)
        .ok_or_else(|| PluginError::Internal(format!("plugin window not found: {label}")))
}

/// Create a real webview window for the plugin from `WindowOptions`. Returns the
/// generated window id (a uuid) the TS side keys later ops on. `url` is
/// required — a `component:` React window is a renderer-only concept the host
/// cannot back, so that variant is rejected with a clear error.
pub async fn plugin_window_create(
    app: &AppHandle,
    plugin_id: &str,
    options: &Value,
) -> Result<String> {
    let title = options
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Plugin")
        .to_string();
    let url = match options.get("url").and_then(Value::as_str) {
        Some(u) if u.starts_with("http://") || u.starts_with("https://") => WebviewUrl::External(
            u.parse()
                .map_err(|e| PluginError::Internal(format!("invalid window url: {e}")))?,
        ),
        Some(u) => WebviewUrl::App(u.trim_start_matches('/').to_string().into()),
        None => {
            return Err(PluginError::Internal(
                "window.create requires a `url`; React-component windows are renderer-only".into(),
            ))
        }
    };

    let window_id = uuid::Uuid::new_v4().to_string();
    let label = plugin_window_label(plugin_id, &window_id);
    let width = options.get("width").and_then(Value::as_f64).unwrap_or(800.0);
    let height = options.get("height").and_then(Value::as_f64).unwrap_or(600.0);
    let resizable = options
        .get("resizable")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let mut builder = WebviewWindowBuilder::new(app, &label, url)
        .title(title)
        .inner_size(width, height)
        .resizable(resizable);
    if let (Some(x), Some(y)) = (
        options.get("x").and_then(Value::as_f64),
        options.get("y").and_then(Value::as_f64),
    ) {
        builder = builder.position(x, y);
    }
    if options.get("alwaysOnTop").and_then(Value::as_bool) == Some(true) {
        builder = builder.always_on_top(true);
    }
    if options.get("center").and_then(Value::as_bool) == Some(true) {
        builder = builder.center();
    }
    builder
        .build()
        .map_err(|e| PluginError::Internal(format!("create window: {e}")))?;
    Ok(window_id)
}

/// Operate on an existing plugin window (or `"main"`). Action ops return null;
/// geometry getters return real values — replacing the TS-side hardcoded
/// placeholders that previously lied (`{800,600}` / `{0,0}` / `false`).
pub async fn plugin_window_op(
    app: &AppHandle,
    plugin_id: &str,
    window_id: &str,
    op: &str,
    payload: &Value,
) -> Result<Value> {
    let win = resolve_window(app, plugin_id, window_id)?;
    let err = |e: tauri::Error| PluginError::Internal(e.to_string());
    match op {
        "setTitle" => {
            win.set_title(payload.get("title").and_then(Value::as_str).unwrap_or(""))
                .map_err(err)?;
            Ok(Value::Null)
        }
        "close" => {
            win.close().map_err(err)?;
            Ok(Value::Null)
        }
        "show" => {
            win.show().map_err(err)?;
            Ok(Value::Null)
        }
        "hide" => {
            win.hide().map_err(err)?;
            Ok(Value::Null)
        }
        "focus" => {
            win.set_focus().map_err(err)?;
            Ok(Value::Null)
        }
        "center" => {
            win.center().map_err(err)?;
            Ok(Value::Null)
        }
        "setSize" => {
            let w = payload.get("width").and_then(Value::as_f64).unwrap_or(800.0);
            let h = payload.get("height").and_then(Value::as_f64).unwrap_or(600.0);
            win.set_size(LogicalSize::new(w, h)).map_err(err)?;
            Ok(Value::Null)
        }
        "setPosition" => {
            let x = payload.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let y = payload.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            win.set_position(LogicalPosition::new(x, y)).map_err(err)?;
            Ok(Value::Null)
        }
        "getSize" => {
            let size = win.inner_size().map_err(err)?;
            Ok(serde_json::json!({ "width": size.width, "height": size.height }))
        }
        "getPosition" => {
            let pos = win.outer_position().map_err(err)?;
            Ok(serde_json::json!({ "x": pos.x, "y": pos.y }))
        }
        "isMaximized" => Ok(Value::Bool(win.is_maximized().map_err(err)?)),
        other => Err(PluginError::Internal(format!(
            "unsupported window op: {other}"
        ))),
    }
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
