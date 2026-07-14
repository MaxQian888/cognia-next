//! Native child-webview embedding for the code-server "Pro IDE" pane.
//!
//! Mirrors the in-app browser's embedded-webview primitive (`browser/embedded.rs`
//! — a native `Window::add_child` pinned over a reserved DOM rect) but as a
//! SEPARATE webview (`codeserver-embed`) so code-server and the browser preview
//! coexist without fighting over one webview or losing VS Code state on switch.
//! Unlike the browser embed, this webview injects NO selection overlay and only
//! ever points at a loopback code-server (`http://127.0.0.1:<port>`), which is
//! spawned + health-polled by `process.rs` before the frontend navigates here.
//!
//! Desktop-only (needs the `tauri/unstable` multi-webview API); every body is
//! `#[cfg(desktop)]` with a clear error stub elsewhere.

use tauri::AppHandle;

/// Label of the single code-server pane webview (child of "main"), distinct
/// from the browser preview's `browser-embed`.
pub const CODESERVER_EMBED_LABEL: &str = "codeserver-embed";

/// Accept only a loopback `http://127.0.0.1|localhost:<port>` URL. The pane can
/// never be pointed at a remote origin, so `--auth none` on code-server stays
/// safe (reachable only from this machine).
fn validate_loopback_url(raw: &str) -> Result<url::Url, String> {
    let parsed = raw
        .parse::<url::Url>()
        .map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "http" {
        return Err("code-server pane requires an http loopback URL".to_string());
    }
    match parsed.host_str() {
        Some("127.0.0.1") | Some("localhost") => Ok(parsed),
        _ => Err("code-server pane only allows a loopback host".to_string()),
    }
}

#[cfg(desktop)]
fn logical_rect(x: f64, y: f64, width: f64, height: f64) -> tauri::Rect {
    tauri::Rect {
        position: tauri::LogicalPosition::new(x, y).into(),
        size: tauri::LogicalSize::new(width, height).into(),
    }
}

/// Create (or re-navigate) the code-server pane at the given logical bounds.
#[tauri::command]
pub async fn codeserver_embed_create(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let parsed = validate_loopback_url(&url)?;
    #[cfg(desktop)]
    {
        use tauri::webview::WebviewBuilder;
        use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

        if let Some(wv) = app.get_webview(CODESERVER_EMBED_LABEL) {
            wv.navigate(parsed).map_err(|e| e.to_string())?;
            return Ok(CODESERVER_EMBED_LABEL.to_string());
        }
        let window = app
            .get_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        // No overlay init script and no on_navigation interception: code-server
        // is our own trusted loopback app, not a remote page to be visually
        // edited.
        let builder = WebviewBuilder::new(CODESERVER_EMBED_LABEL, WebviewUrl::External(parsed));
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(x, y),
                LogicalSize::new(width, height),
            )
            .map_err(|e| format!("code-server webview: {e}"))?;
        // Bounds are driven explicitly from the reserved-rect observer.
        let _ = webview.set_auto_resize(false);
        Ok(CODESERVER_EMBED_LABEL.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (parsed, x, y, width, height);
        Err("code-server pane is only available on desktop".to_string())
    }
}

#[tauri::command]
pub async fn codeserver_embed_set_bounds(
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
            .get_webview(CODESERVER_EMBED_LABEL)
            .ok_or_else(|| "code-server pane is not open".to_string())?;
        wv.set_bounds(logical_rect(x, y, width, height))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, x, y, width, height);
        Err("desktop only".to_string())
    }
}

/// Show at the given bounds, or hide by parking the webview off-screen (the
/// native layer can't be CSS-clipped, so this is how it yields to overlays /
/// a switched-away tab).
#[tauri::command]
pub async fn codeserver_embed_set_visible(
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
            .get_webview(CODESERVER_EMBED_LABEL)
            .ok_or_else(|| "code-server pane is not open".to_string())?;
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

#[tauri::command]
pub async fn codeserver_embed_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = validate_loopback_url(&url)?;
    #[cfg(desktop)]
    {
        use tauri::Manager;
        app.get_webview(CODESERVER_EMBED_LABEL)
            .ok_or_else(|| "code-server pane is not open".to_string())?
            .navigate(parsed)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, parsed);
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn codeserver_embed_destroy(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        if let Some(wv) = app.get_webview(CODESERVER_EMBED_LABEL) {
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
    fn label_is_distinct_from_browser_embed() {
        assert_eq!(CODESERVER_EMBED_LABEL, "codeserver-embed");
        assert_ne!(CODESERVER_EMBED_LABEL, "browser-embed");
    }

    #[test]
    fn accepts_loopback_http() {
        assert!(validate_loopback_url("http://127.0.0.1:43117/").is_ok());
        assert!(validate_loopback_url("http://localhost:8080/?x=1").is_ok());
    }

    #[test]
    fn rejects_remote_and_non_http() {
        // Remote host — the pane must never point off-machine.
        assert!(validate_loopback_url("http://example.com/").is_err());
        assert!(validate_loopback_url("http://10.0.0.5:80/").is_err());
        // HTTPS / other schemes rejected (code-server serves plain http on loopback).
        assert!(validate_loopback_url("https://127.0.0.1/").is_err());
        assert!(validate_loopback_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn rejects_malformed() {
        assert!(validate_loopback_url("not a url").is_err());
    }
}
