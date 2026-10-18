//! Remote desktop web consoles and external apps on the desktop
//! (ADR-0234 Phase 5).
//!
//! A web console (the user's own Guacamole or MeshCentral page) runs in one
//! native child webview, `remote-console`, pinned over the viewer page's
//! reserved box like the code-server pane (`codeserver/webview.rs`). The page
//! is a top-level navigation, so the console's framing and cookie rules apply
//! as in a browser. It gets no init script and no IPC (every capability is
//! local-only), stays on http(s), opens no new windows and downloads nothing:
//! file transfer is out of scope for remote desktops.
//!
//! The console keeps its sign-in in its own website data store, separate from
//! the app and the in-app browser: a fixed `data_store_identifier` on macOS 14
//! and later, a `remote-console` data directory on Windows and Linux. Older
//! macOS has no custom stores and WebKit would fall back to the app's default
//! one, so there the console is private and asks for a sign-in each time.
//!
//! `remote_desktop_open_app` opens a RustDesk link from Rust after
//! re-parsing it, so the renderer's opener scope stays http(s), mailto and
//! tel.

use cognia_remote_desktop::{console::check_open_url, launch::parse_rustdesk_uri};
use tauri::AppHandle;

pub const REMOTE_CONSOLE_LABEL: &str = "remote-console";

/// The console's own WebKit store (macOS 14+). Fixed so a sign-in survives
/// restarts; never shared with another webview.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CONSOLE_DATA_STORE: [u8; 16] = [
    0x7c, 0x0b, 0x52, 0x34, 0x1e, 0x8a, 0x4f, 0x2d, 0x9b, 0x61, 0x2a, 0x44, 0xd3, 0x0e, 0x95, 0x17,
];

/// Where the console may navigate: anything http(s), so a console's own
/// single sign-on redirect works. Every other scheme (`file:`, app schemes,
/// `javascript:`) is refused.
fn navigation_allowed(url: &url::Url) -> bool {
    matches!(url.scheme(), "https" | "http")
}

/// Whether this macOS can give the console its own data store.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn custom_store_available(os_version: &str) -> bool {
    os_version
        .split('.')
        .next()
        .and_then(|major| major.trim().parse::<u32>().ok())
        .is_some_and(|major| major >= 14)
}

/// Whether a page load in `label` takes the console with it. The console
/// belongs to the viewer page in the main webview; once that webview starts
/// loading a new document (reload, hard navigation, renderer restart), React
/// never unmounts the viewer, so the shell has to close the console itself.
fn closes_for_page_load(label: &str, started: bool) -> bool {
    started && label == "main"
}

/// Close the console when the main webview starts loading a new document.
/// Called from the app's `on_page_load` hook.
pub fn close_on_owner_reload<R: tauri::Runtime>(webview: &tauri::Webview<R>, started: bool) {
    if !closes_for_page_load(webview.label(), started) {
        return;
    }
    #[cfg(desktop)]
    {
        use tauri::Manager;
        if let Some(console) = webview.app_handle().get_webview(REMOTE_CONSOLE_LABEL) {
            if let Err(error) = console.close() {
                log::warn!("remote console could not close after its page reloaded: {error}");
            }
        }
    }
}

fn checked(url: &str) -> Result<url::Url, String> {
    check_open_url(url).map_err(|error| error.code.to_string())
}

#[cfg(desktop)]
fn logical_rect(x: f64, y: f64, width: f64, height: f64) -> tauri::Rect {
    tauri::Rect {
        position: tauri::LogicalPosition::new(x, y).into(),
        size: tauri::LogicalSize::new(width, height).into(),
    }
}

/// Open the console at the given logical bounds, or re-navigate the one
/// already open.
#[tauri::command]
pub async fn remote_console_open(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed = checked(&url)?;
    #[cfg(desktop)]
    {
        use tauri::webview::{NewWindowResponse, WebviewBuilder};
        use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

        if let Some(webview) = app.get_webview(REMOTE_CONSOLE_LABEL) {
            webview.navigate(parsed).map_err(|e| e.to_string())?;
            return webview
                .set_bounds(logical_rect(x, y, width, height))
                .map_err(|e| e.to_string());
        }
        let window = app
            .get_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        let mut builder = WebviewBuilder::new(REMOTE_CONSOLE_LABEL, WebviewUrl::External(parsed))
            .on_navigation(navigation_allowed)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false);
        #[cfg(target_os = "macos")]
        {
            builder = if custom_store_available(&tauri_plugin_os::version().to_string()) {
                builder.data_store_identifier(CONSOLE_DATA_STORE)
            } else {
                builder.incognito(true)
            };
        }
        #[cfg(not(target_os = "macos"))]
        {
            let directory = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("remote-console-webview");
            builder = builder.data_directory(directory);
        }
        let webview = window
            .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height))
            .map_err(|e| format!("remote console webview: {e}"))?;
        let _ = webview.set_auto_resize(false);
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, parsed, x, y, width, height);
        Err("remote consoles open in a browser here".to_string())
    }
}

#[tauri::command]
pub async fn remote_console_set_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        app.get_webview(REMOTE_CONSOLE_LABEL)
            .ok_or_else(|| "remote console is not open".to_string())?
            .set_bounds(logical_rect(x, y, width, height))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, x, y, width, height);
        Err("desktop only".to_string())
    }
}

/// Show at the given bounds, or park off-screen: a native layer cannot be
/// clipped by CSS, so this is how it yields to dialogs and hidden pages.
#[tauri::command]
pub async fn remote_console_set_visible(
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
        let rect = if visible {
            logical_rect(x, y, width, height)
        } else {
            logical_rect(-32000.0, -32000.0, 0.0, 0.0)
        };
        app.get_webview(REMOTE_CONSOLE_LABEL)
            .ok_or_else(|| "remote console is not open".to_string())?
            .set_bounds(rect)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, visible, x, y, width, height);
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn remote_console_reload(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        app.get_webview(REMOTE_CONSOLE_LABEL)
            .ok_or_else(|| "remote console is not open".to_string())?
            .reload()
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

/// Closing a console that is not open is a no-op.
#[tauri::command]
pub async fn remote_console_close(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        if let Some(webview) = app.get_webview(REMOTE_CONSOLE_LABEL) {
            webview.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(())
    }
}

/// Hand a RustDesk link to the installed app. Only the exact
/// `rustdesk://connection/new/…` form the Host builds is opened.
#[tauri::command]
pub async fn remote_desktop_open_app(app: AppHandle, uri: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    parse_rustdesk_uri(&uri).map_err(|error| error.code.to_string())?;
    app.opener()
        .open_url(uri, None::<&str>)
        .map_err(|_| "remote_desktop_launch_app_missing".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_console_stays_on_web_pages() {
        for allowed in ["https://gw.example.com/#/client/x", "http://mesh.lan/?gotonode=n", "https://idp.example.com/sso"] {
            assert!(navigation_allowed(&url::Url::parse(allowed).unwrap()), "{allowed}");
        }
        for refused in [
            "file:///etc/passwd",
            "rustdesk://connection/new/123456789",
            "javascript:alert(1)",
            "tauri://localhost/",
            "data:text/html,hi",
        ] {
            assert!(!navigation_allowed(&url::Url::parse(refused).unwrap()), "{refused}");
        }
    }

    #[test]
    fn opening_rechecks_the_link_the_renderer_passed() {
        assert!(checked("https://gw.example.com/#/client/x").is_ok());
        assert_eq!(
            checked("https://mesh.example.com/?gotonode=n&logintoken=x").unwrap_err(),
            "remote_desktop_console_url_has_credentials"
        );
        assert_eq!(checked("file:///etc/passwd").unwrap_err(), "remote_desktop_console_url_invalid");
    }

    #[test]
    fn a_new_main_document_closes_the_console() {
        assert!(closes_for_page_load("main", true));
        assert!(!closes_for_page_load("main", false));
        // The console's own loads and other windows leave it open.
        assert!(!closes_for_page_load(REMOTE_CONSOLE_LABEL, true));
        assert!(!closes_for_page_load("pet", true));
        assert!(!closes_for_page_load("browser-embed", true));
    }

    #[test]
    fn only_macos_14_and_later_get_a_separate_store() {
        assert!(custom_store_available("14.0.0"));
        assert!(custom_store_available("15.5"));
        assert!(custom_store_available("26.1"));
        assert!(!custom_store_available("13.6.7"));
        assert!(!custom_store_available("Unknown"));
    }

    #[test]
    fn the_console_store_is_its_own() {
        assert_ne!(CONSOLE_DATA_STORE, [0; 16]);
        assert_ne!(REMOTE_CONSOLE_LABEL, "browser-embed");
        assert_ne!(REMOTE_CONSOLE_LABEL, "codeserver-embed");
    }
}
