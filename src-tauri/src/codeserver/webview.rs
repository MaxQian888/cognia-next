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

/// Resolve the optional pane background hex the renderer sent.
///
/// `None` means "leave the platform default", which is what a pre-appearance-sync
/// claim passes. A *present but malformed* value is an error rather than a silent
/// fallback: falling back would reintroduce the white flash this parameter exists
/// to remove, with nothing to tell anyone why.
fn resolve_pane_background(hex: Option<&str>) -> Result<Option<tauri::window::Color>, String> {
    match hex {
        Some(raw) => crate::commands::parse_hex_color(raw)
            .map(Some)
            .map_err(|e| e.to_string()),
        None => Ok(None),
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
///
/// `background` is the app's resolved `--background` token as `#RRGGBB`. A native
/// webview paints its own background before the page it is loading has any, and
/// the platform default is white — so on the first spawn (and on every navigate)
/// the pane flashed a white rectangle over a dark app. Painting it in the app
/// background instead makes the load invisible.
#[tauri::command]
pub async fn codeserver_embed_create(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    background: Option<String>,
) -> Result<String, String> {
    let parsed = validate_loopback_url(&url)?;
    // Parsed up front so a malformed hex is reported rather than silently
    // falling back to the platform's white.
    let color = resolve_pane_background(background.as_deref())?;
    #[cfg(desktop)]
    {
        use tauri::webview::WebviewBuilder;
        use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

        if let Some(wv) = app.get_webview(CODESERVER_EMBED_LABEL) {
            if let Some(color) = color {
                let _ = wv.set_background_color(Some(color));
            }
            wv.navigate(parsed).map_err(|e| e.to_string())?;
            return Ok(CODESERVER_EMBED_LABEL.to_string());
        }
        let window = app
            .get_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        // No overlay init script and no on_navigation interception: code-server
        // is our own trusted loopback app, not a remote page to be visually
        // edited.
        let mut builder = WebviewBuilder::new(CODESERVER_EMBED_LABEL, WebviewUrl::External(parsed));
        if let Some(color) = color {
            builder = builder.background_color(color);
        }
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
        let _ = (parsed, x, y, width, height, color);
        Err("code-server pane is only available on desktop".to_string())
    }
}

/// Repaint the pane's own background without navigating.
///
/// Called on a theme flip: code-server repaints itself from `settings.json`, but
/// the *webview's* background is what shows through during a reload and in any
/// gap around the workbench, so it has to follow the app too.
#[tauri::command]
pub async fn codeserver_embed_set_background(app: AppHandle, hex: String) -> Result<(), String> {
    let color = resolve_pane_background(Some(&hex))?.expect("Some input yields Some color");
    #[cfg(desktop)]
    {
        use tauri::Manager;
        // Not an error when the pane is closed: the theme sync fires on every
        // palette change, most of which happen with no Pro IDE open.
        if let Some(wv) = app.get_webview(CODESERVER_EMBED_LABEL) {
            wv.set_background_color(Some(color))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, color);
        Ok(())
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

    #[test]
    fn pane_background_is_optional() {
        // A claim that lands before the appearance sync has run passes nothing,
        // and must not be treated as an error.
        assert_eq!(resolve_pane_background(None).unwrap(), None);
    }

    #[test]
    fn pane_background_parses_the_app_background_hex() {
        let color = resolve_pane_background(Some("#0b1220")).unwrap().unwrap();
        assert_eq!(
            (color.0, color.1, color.2, color.3),
            (0x0b, 0x12, 0x20, 255)
        );
    }

    #[test]
    fn pane_background_rejects_a_malformed_value_instead_of_flashing_white() {
        assert!(resolve_pane_background(Some("rebeccapurple")).is_err());
        assert!(resolve_pane_background(Some("#fff")).is_err());
        assert!(resolve_pane_background(Some("")).is_err());
    }
}
