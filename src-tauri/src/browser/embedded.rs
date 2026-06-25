//! Embedded child-webview preview (P1).
//!
//! Renders the dev server *inside* the main window as a side pane that tracks a
//! reserved DOM rect, using Tauri's built-in multi-webview API
//! (`Window::add_child`). That API requires the `tauri/unstable` feature
//! (enabled in `Cargo.toml`) and only exists on desktop, so every body here is
//! `#[cfg(desktop)]` with a stub elsewhere — the command surface stays
//! registrable on all targets (mobile shells just get a clear error).
//!
//! The native child webview always paints above the React layer and is not
//! clipped by CSS, so the frontend drives `set_bounds` on every layout change
//! and `set_visible(false)` to get out of the way of modals/overlays. Visual
//! positioning is verified via `pnpm tauri dev` smoke; the API surface is
//! compiler-verified by the `unstable` build.

use tauri::AppHandle;

use super::commands::{handle_navigation, js_string, validate_external_url};
use super::overlay;
use crate::automation::types::Screenshot;

/// Label of the single embedded preview webview (child of "main").
pub const EMBED_LABEL: &str = "browser-embed";

/// Compute the monitor-relative physical crop for the embedded webview.
/// `window_inner_pos` is the main window content origin (physical px), `embed`
/// is the reserved rect in logical px relative to that content area, `scale` is
/// the monitor scale factor, and `monitor_origin` is the primary monitor's
/// physical top-left. Pure so the coordinate math is unit-tested without a live
/// window. (Capture assumes the window is on the primary monitor — multi-monitor
/// capture is a known follow-up.)
#[cfg(desktop)]
fn compute_embed_capture_region(
    window_inner_pos: (i32, i32),
    embed: (f64, f64, f64, f64),
    scale: f64,
    monitor_origin: (i32, i32),
) -> crate::automation::types::Rect {
    crate::automation::types::Rect {
        x: window_inner_pos.0 + (embed.0 * scale).round() as i32 - monitor_origin.0,
        y: window_inner_pos.1 + (embed.1 * scale).round() as i32 - monitor_origin.1,
        width: (embed.2 * scale).round() as i32,
        height: (embed.3 * scale).round() as i32,
    }
}

#[cfg(desktop)]
fn logical_rect(x: f64, y: f64, width: f64, height: f64) -> tauri::Rect {
    tauri::Rect {
        position: tauri::LogicalPosition::new(x, y).into(),
        size: tauri::LogicalSize::new(width, height).into(),
    }
}

/// Create (or re-navigate) the embedded preview at the given logical bounds.
#[tauri::command]
pub async fn browser_embed_create(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let parsed = validate_external_url(&url)?;
    #[cfg(desktop)]
    {
        use tauri::webview::WebviewBuilder;
        use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

        if let Some(wv) = app.get_webview(EMBED_LABEL) {
            let js = format!("window.location.assign({})", js_string(parsed.as_str())?);
            wv.eval(&js).map_err(|e| e.to_string())?;
            return Ok(EMBED_LABEL.to_string());
        }
        let window = app
            .get_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        let nav_app = app.clone();
        let nav_label = EMBED_LABEL.to_string();
        let builder = WebviewBuilder::new(EMBED_LABEL, WebviewUrl::External(parsed))
            .initialization_script(overlay::OVERLAY_JS)
            .on_navigation(move |u| handle_navigation(&nav_app, &nav_label, u.as_str()));
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(x, y),
                LogicalSize::new(width, height),
            )
            .map_err(|e| format!("embed webview: {e}"))?;
        // We drive bounds explicitly from the reserved-rect observer, so opt out
        // of parent-resize auto-tracking (which would fight our set_bounds).
        let _ = webview.set_auto_resize(false);
        Ok(EMBED_LABEL.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (parsed, x, y, width, height);
        Err("embedded browser preview is only available on desktop".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_set_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        let wv = app
            .get_webview(EMBED_LABEL)
            .ok_or_else(|| "embedded preview is not open".to_string())?;
        wv.set_bounds(logical_rect(x, y, width, height))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, x, y, width, height);
        Err("desktop only".to_string())
    }
}

/// Show at the given bounds, or hide by parking the webview off-screen with
/// zero size (the native layer cannot be clipped, so this is how it yields to
/// overlapping app UI).
#[tauri::command]
pub async fn browser_embed_set_visible(
    app: AppHandle,
    visible: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        let wv = app
            .get_webview(EMBED_LABEL)
            .ok_or_else(|| "embedded preview is not open".to_string())?;
        let rect = if visible {
            logical_rect(x, y, width, height)
        } else {
            logical_rect(-32000.0, -32000.0, 0.0, 0.0)
        };
        wv.set_bounds(rect).map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, visible, x, y, width, height);
        Err("desktop only".to_string())
    }
}

#[cfg(desktop)]
fn eval_embed(app: &AppHandle, js: &str) -> Result<(), String> {
    use tauri::Manager;
    app.get_webview(EMBED_LABEL)
        .ok_or_else(|| "embedded preview is not open".to_string())?
        .eval(js)
        .map_err(|e| e.to_string())
}

/// Build the `window.__cogniaAct(ref, action, args)` call string. `args` is a
/// JSON object string that we pass *as a JS string literal* (double-encoded) so
/// the page can `JSON.parse` it back without quoting hazards.
#[cfg(desktop)]
fn build_act_call(reference: &str, action: &str, args_json: &str) -> Result<String, String> {
    Ok(format!(
        "window.__cogniaAct({}, {}, {})",
        js_string(reference)?,
        js_string(action)?,
        js_string(args_json)?
    ))
}

/// Evaluate JS in the embedded webview and return the JSON-serialized result.
/// Bridges Tauri's callback-style `eval_with_callback` (the only result-bearing
/// eval available on WKWebView/WebView2/WebKitGTK) to an async command via a
/// oneshot channel with a timeout.
#[cfg(desktop)]
async fn eval_embed_with_result(app: &AppHandle, js: &str) -> Result<String, String> {
    use std::sync::{Arc, Mutex};
    use tauri::Manager;
    let wv = app
        .get_webview(EMBED_LABEL)
        .ok_or_else(|| "embedded preview is not open".to_string())?;
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let slot = Arc::new(Mutex::new(Some(tx)));
    let cb = slot.clone();
    wv.eval_with_callback(js, move |result| {
        if let Ok(mut guard) = cb.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("embedded eval channel closed".to_string()),
        Err(_) => Err("embedded eval timed out".to_string()),
    }
}

/// Snapshot the embedded page's accessibility tree (JSON envelope from
/// `__cogniaSnapshot`).
#[tauri::command]
pub async fn browser_embed_snapshot(app: AppHandle) -> Result<String, String> {
    #[cfg(desktop)]
    {
        eval_embed_with_result(&app, "window.__cogniaSnapshot()").await
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

/// Perform an act-by-ref (`click`/`type`/`fill`/`select`/`hover`/`focus`).
#[tauri::command]
pub async fn browser_embed_act(
    app: AppHandle,
    reference: String,
    action: String,
    args: String,
) -> Result<String, String> {
    #[cfg(desktop)]
    {
        let call = build_act_call(&reference, &action, &args)?;
        eval_embed_with_result(&app, &call).await
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, reference, action, args);
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_drain_console(app: AppHandle) -> Result<String, String> {
    #[cfg(desktop)]
    {
        eval_embed_with_result(&app, "window.__cogniaDrainConsole()").await
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_drain_network(app: AppHandle) -> Result<String, String> {
    #[cfg(desktop)]
    {
        eval_embed_with_result(&app, "window.__cogniaDrainNetwork()").await
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_back(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        eval_embed(&app, "window.history.back()")
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_forward(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        eval_embed(&app, "window.history.forward()")
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_stop(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        eval_embed(&app, "window.stop()")
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

/// Whether the embedded page's visible text currently contains `text`.
/// (`__cogniaHasText` returns a boolean; `eval_with_callback` serializes it to
/// the JSON literal `true`/`false`.)
#[tauri::command]
pub async fn browser_embed_has_text(app: AppHandle, text: String) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        let call = format!("window.__cogniaHasText({})", js_string(&text)?);
        let raw = eval_embed_with_result(&app, &call).await?;
        Ok(raw.trim() == "true")
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, text);
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_get_url(app: AppHandle) -> Result<String, String> {
    #[cfg(desktop)]
    {
        eval_embed_with_result(&app, "String(window.location.href)").await
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_get_title(app: AppHandle) -> Result<String, String> {
    #[cfg(desktop)]
    {
        eval_embed_with_result(&app, "String(document.title)").await
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = validate_external_url(&url)?;
    #[cfg(desktop)]
    {
        eval_embed(
            &app,
            &format!("window.location.assign({})", js_string(parsed.as_str())?),
        )
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, parsed);
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_reload(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        eval_embed(&app, "window.location.reload()")
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_set_select_mode(app: AppHandle, on: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        eval_embed(&app, &format!("window.__cogniaSetSelectMode({})", on))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, on);
        Err("desktop only".to_string())
    }
}

/// Capture the embedded preview's on-screen region as a PNG. `x,y,width,height`
/// are the reserved rect (logical px, window-relative). Reuses the automation
/// screenshot pipeline (`capture_primary`) but bypasses its consent/audit gate —
/// this is our own embedded preview, not arbitrary screen content.
#[tauri::command]
pub async fn browser_embed_capture(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<Screenshot, String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        let win = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        let inner = win.inner_position().map_err(|e| e.to_string())?;
        let scale = win.scale_factor().map_err(|e| e.to_string())?;
        let monitor_origin = app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| {
                let p = m.position();
                (p.x, p.y)
            })
            .unwrap_or((0, 0));
        let region =
            compute_embed_capture_region((inner.x, inner.y), (x, y, width, height), scale, monitor_origin);
        let opts = crate::automation::types::ScreenshotOpts {
            region: Some(region),
            format: None,
            monitor_id: None,
        };
        crate::automation::platform::shared::screenshot::capture_primary(&opts)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, x, y, width, height);
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_destroy(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        if let Some(wv) = app.get_webview(EMBED_LABEL) {
            wv.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embed_label_is_stable() {
        assert_eq!(EMBED_LABEL, "browser-embed");
    }

    #[cfg(desktop)]
    #[test]
    fn logical_rect_maps_fields() {
        let r = logical_rect(10.0, 20.0, 100.0, 40.0);
        // Round-trips through the Logical variants.
        assert!(matches!(r.position, tauri::Position::Logical(_)));
        assert!(matches!(r.size, tauri::Size::Logical(_)));
    }

    #[cfg(desktop)]
    #[test]
    fn embed_capture_region_scales_and_offsets() {
        // Window content origin at physical (100, 50); embed at logical (10, 20)
        // sized 200x100; 2x display; primary monitor at origin.
        let r = compute_embed_capture_region((100, 50), (10.0, 20.0, 200.0, 100.0), 2.0, (0, 0));
        assert_eq!((r.x, r.y, r.width, r.height), (120, 90, 400, 200));
    }

    #[cfg(desktop)]
    #[test]
    fn embed_capture_region_subtracts_monitor_origin() {
        let r = compute_embed_capture_region((1920, 0), (0.0, 0.0, 50.0, 50.0), 1.0, (1920, 0));
        assert_eq!((r.x, r.y, r.width, r.height), (0, 0, 50, 50));
    }

    #[cfg(desktop)]
    #[test]
    fn act_call_is_json_safe() {
        let call = build_act_call("e1", "fill", r#"{"text":"a\"b"}"#).unwrap();
        assert!(call.starts_with("window.__cogniaAct("));
        assert!(call.contains(r#""e1""#));
        assert!(call.contains(r#""fill""#));
        // The args JSON is itself passed as a JS string literal (double-encoded),
        // so the inner quote is escaped twice.
        assert!(call.contains("a\\\\\\\""));
    }

    #[cfg(desktop)]
    #[test]
    fn act_call_escapes_injection_in_ref() {
        let call = build_act_call(r#"e"); alert(1)//"#, "click", "{}").unwrap();
        // The malicious ref is contained inside a JSON string literal.
        assert!(call.contains(r#"alert(1)"#));
        assert!(!call.contains(r#"e"); alert"#));
    }
}
