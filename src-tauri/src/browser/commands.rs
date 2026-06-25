//! Shared helpers for the in-app browser, used by the embedded webview module
//! (`embedded.rs`). The previewed page is a *remote* context with no IPC bridge;
//! the only page→Rust channel is the selection sentinel intercepted in
//! `on_navigation` (see `overlay.rs`), so there are no standalone window
//! commands here — everything renders inside the main window via `embedded.rs`.

use tauri::{AppHandle, Emitter};

use super::overlay;

/// Reject anything that is not an `http(s)` URL before it reaches a webview.
pub fn validate_external_url(raw: &str) -> Result<url::Url, String> {
    if !(raw.starts_with("http://") || raw.starts_with("https://")) {
        return Err("browser preview only supports http(s) URLs".to_string());
    }
    raw.parse::<url::Url>().map_err(|e| format!("invalid url: {e}"))
}

/// JS string literal for safe interpolation into an `eval` call.
pub(crate) fn js_string(value: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

/// Shared `on_navigation` handler for the embedded preview webview. Intercepts
/// the selection sentinel (emitting `browser://element-selected` and
/// cancelling), and reports real navigations. Returns whether navigation
/// should proceed.
pub(crate) fn handle_navigation(app: &AppHandle, pane_label: &str, url_str: &str) -> bool {
    if let Some(mut payload) = overlay::parse_selection(url_str) {
        if let Some(obj) = payload.as_object_mut() {
            // `paneId` (webview label), distinct from the element's own `id`
            // field already present in the overlay payload.
            obj.insert(
                "paneId".into(),
                serde_json::Value::String(pane_label.to_string()),
            );
        }
        let _ = app.emit("browser://element-selected", &payload);
        return false; // cancel the sentinel navigation
    }
    if url_str.starts_with("http://") || url_str.starts_with("https://") {
        let _ = app.emit(
            "browser://navigated",
            serde_json::json!({ "paneId": pane_label, "url": url_str }),
        );
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        assert!(validate_external_url("http://localhost:3000/").is_ok());
        assert!(validate_external_url("https://example.com").is_ok());
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("ftp://x/y").is_err());
    }

    #[test]
    fn rejects_malformed_urls() {
        assert!(validate_external_url("http://").is_err());
    }

    #[test]
    fn js_string_escapes_quotes() {
        assert_eq!(js_string(r#"a"b"#).unwrap(), r#""a\"b""#);
    }
}
