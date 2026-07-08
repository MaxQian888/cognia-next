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

/// What `on_navigation` should do with a requested URL. Pure classification so
/// the scheme policy is unit-testable without an `AppHandle`.
#[derive(Debug, PartialEq)]
pub(crate) enum NavDisposition {
    /// Selection sentinel: emit `browser://element-selected`, cancel.
    Selection(serde_json::Value),
    /// SPA-nav sentinel: emit `browser://navigated` for the reported URL, cancel.
    SpaNavigated(String),
    /// Load-complete sentinel: emit `browser://loaded` for the reported URL, cancel.
    Loaded(String),
    /// Real http(s) navigation: emit `browser://navigated`, proceed.
    AllowAndReport,
    /// Webview-internal document (`about:blank`/`about:srcdoc`): proceed silently.
    Allow,
    /// Any other scheme (`file:`, custom protocols, …) a remote page might
    /// redirect to: cancel. The embed is http(s)-only end to end.
    Block,
}

pub(crate) fn classify_navigation(url_str: &str) -> NavDisposition {
    if let Some(payload) = overlay::parse_selection(url_str) {
        return NavDisposition::Selection(payload);
    }
    if let Some(payload) = overlay::parse_spa_navigation(url_str) {
        let reported = payload.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if reported.starts_with("http://") || reported.starts_with("https://") {
            return NavDisposition::SpaNavigated(reported.to_string());
        }
        // Malformed / non-http payload: still cancel the sentinel navigation.
        return NavDisposition::Block;
    }
    if let Some(payload) = overlay::parse_loaded(url_str) {
        let reported = payload.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if reported.starts_with("http://") || reported.starts_with("https://") {
            return NavDisposition::Loaded(reported.to_string());
        }
        // Malformed / non-http payload: still cancel the sentinel navigation.
        return NavDisposition::Block;
    }
    if url_str.starts_with("http://") || url_str.starts_with("https://") {
        return NavDisposition::AllowAndReport;
    }
    if url_str.starts_with("about:") {
        return NavDisposition::Allow;
    }
    NavDisposition::Block
}

fn emit_navigated(app: &AppHandle, pane_label: &str, url_str: &str) {
    let _ = app.emit(
        "browser://navigated",
        serde_json::json!({ "paneId": pane_label, "url": url_str }),
    );
}

fn emit_loaded(app: &AppHandle, pane_label: &str, url_str: &str) {
    let _ = app.emit(
        "browser://loaded",
        serde_json::json!({ "paneId": pane_label, "url": url_str }),
    );
}

/// Shared `on_navigation` handler for the embedded preview webview. Intercepts
/// the selection + SPA-nav + load-complete sentinels (emitting the matching
/// event and cancelling), reports real http(s) navigations, and blocks every
/// non-http(s) scheme a remote page could redirect to. Returns whether
/// navigation should proceed.
pub(crate) fn handle_navigation(app: &AppHandle, pane_label: &str, url_str: &str) -> bool {
    match classify_navigation(url_str) {
        NavDisposition::Selection(mut payload) => {
            if let Some(obj) = payload.as_object_mut() {
                // `paneId` (webview label), distinct from the element's own
                // `id` field already present in the overlay payload.
                obj.insert(
                    "paneId".into(),
                    serde_json::Value::String(pane_label.to_string()),
                );
            }
            let _ = app.emit("browser://element-selected", &payload);
            false
        }
        NavDisposition::SpaNavigated(url) => {
            emit_navigated(app, pane_label, &url);
            false
        }
        NavDisposition::Loaded(url) => {
            emit_loaded(app, pane_label, &url);
            false
        }
        NavDisposition::AllowAndReport => {
            emit_navigated(app, pane_label, url_str);
            true
        }
        NavDisposition::Allow => true,
        NavDisposition::Block => false,
    }
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

    #[test]
    fn classifies_http_as_allow_and_report() {
        assert_eq!(
            classify_navigation("https://example.com/a"),
            NavDisposition::AllowAndReport
        );
        assert_eq!(
            classify_navigation("http://localhost:3000/"),
            NavDisposition::AllowAndReport
        );
    }

    #[test]
    fn classifies_webview_internal_about_as_silent_allow() {
        assert_eq!(classify_navigation("about:blank"), NavDisposition::Allow);
        assert_eq!(classify_navigation("about:srcdoc"), NavDisposition::Allow);
    }

    #[test]
    fn blocks_non_http_scheme_redirects() {
        assert_eq!(
            classify_navigation("file:///etc/passwd"),
            NavDisposition::Block
        );
        assert_eq!(
            classify_navigation("javascript:alert(1)"),
            NavDisposition::Block
        );
        assert_eq!(
            classify_navigation("myapp://steal?x=1"),
            NavDisposition::Block
        );
        assert_eq!(
            classify_navigation("data:text/html,<h1>x</h1>"),
            NavDisposition::Block
        );
    }

    #[test]
    fn classifies_selection_sentinel() {
        let url = "https://cognia.invalid/__cognia_select?data=%7B%22selector%22%3A%22%23go%22%7D";
        match classify_navigation(url) {
            NavDisposition::Selection(payload) => assert_eq!(payload["selector"], "#go"),
            other => panic!("expected Selection, got {other:?}"),
        }
    }

    #[test]
    fn classifies_spa_nav_sentinel_and_blocks_bad_payloads() {
        let ok =
            "https://cognia.invalid/__cognia_nav?data=%7B%22url%22%3A%22http%3A%2F%2Fa%2Fb%22%7D";
        assert_eq!(
            classify_navigation(ok),
            NavDisposition::SpaNavigated("http://a/b".to_string())
        );
        // Non-http reported URL: cancelled, never re-emitted.
        let bad =
            "https://cognia.invalid/__cognia_nav?data=%7B%22url%22%3A%22file%3A%2F%2F%2Fx%22%7D";
        assert_eq!(classify_navigation(bad), NavDisposition::Block);
    }

    #[test]
    fn classifies_loaded_sentinel_and_blocks_bad_payloads() {
        let ok =
            "https://cognia.invalid/__cognia_loaded?data=%7B%22url%22%3A%22http%3A%2F%2Fa%2Fb%22%7D";
        assert_eq!(
            classify_navigation(ok),
            NavDisposition::Loaded("http://a/b".to_string())
        );
        // Non-http reported URL: cancelled, never re-emitted.
        let bad = "https://cognia.invalid/__cognia_loaded?data=%7B%22url%22%3A%22file%3A%2F%2F%2Fx%22%7D";
        assert_eq!(classify_navigation(bad), NavDisposition::Block);
    }
}
