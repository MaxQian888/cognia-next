//! Injected overlay script + the page->Rust selection channel.
//!
//! The previewed dev-server page is a *remote* context: Tauri injects no IPC
//! bridge into it and granting app-command access to remote origins via ACL is
//! brittle. So the overlay signals a selection by navigating to a sentinel URL
//! (`https://cognia.invalid/__cognia_select?data=<json>`); the webview's
//! `on_navigation` handler intercepts that host+path, parses the payload, emits
//! `browser://element-selected`, and cancels the navigation. This needs no
//! capability grant and works on both WKWebView and WebView2.

/// The selection overlay, injected verbatim via `initialization_script`. Single
/// source of truth with the Jest suite — both load the same bytes.
pub const OVERLAY_JS: &str = include_str!("../../../lib/browser/overlay.injected.js");

/// Sentinel host the overlay navigates to on selection. A reserved TLD that
/// never resolves, so even an un-cancelled navigation cannot leak anywhere.
pub const SENTINEL_HOST: &str = "cognia.invalid";
pub const SENTINEL_PATH: &str = "/__cognia_select";

/// Parse a navigation URL into a selection payload, or `None` if it is not the
/// selection sentinel. The `url` crate percent-decodes the `data` query for us.
pub fn parse_selection(raw: &str) -> Option<serde_json::Value> {
    let parsed = url::Url::parse(raw).ok()?;
    if parsed.host_str() != Some(SENTINEL_HOST) || parsed.path() != SENTINEL_PATH {
        return None;
    }
    let data = parsed
        .query_pairs()
        .find(|(k, _)| k == "data")
        .map(|(_, v)| v.into_owned())?;
    serde_json::from_str::<serde_json::Value>(&data).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sentinel(json: &str) -> String {
        let mut u = url::Url::parse("https://cognia.invalid/__cognia_select").unwrap();
        u.query_pairs_mut().append_pair("data", json);
        u.to_string()
    }

    #[test]
    fn overlay_js_is_embedded() {
        assert!(OVERLAY_JS.contains("__cogniaSetSelectMode"));
        assert!(OVERLAY_JS.contains("__cognia_select"));
    }

    #[test]
    fn parses_a_valid_selection_payload() {
        let url = sentinel(r##"{"selector":"#go","tagName":"button"}"##);
        let payload = parse_selection(&url).expect("should parse");
        assert_eq!(payload["selector"], "#go");
        assert_eq!(payload["tagName"], "button");
    }

    #[test]
    fn handles_percent_encoded_unicode_payloads() {
        // encodeURIComponent-style escaping round-trips through query_pairs.
        let url = sentinel(r#"{"text":"按钮 & <tag>"}"#);
        let payload = parse_selection(&url).expect("should parse");
        assert_eq!(payload["text"], "按钮 & <tag>");
    }

    #[test]
    fn rejects_non_sentinel_navigations() {
        assert!(parse_selection("http://localhost:3000/").is_none());
        assert!(parse_selection("https://cognia.invalid/other").is_none());
        assert!(parse_selection("not a url").is_none());
    }

    #[test]
    fn rejects_sentinel_without_valid_json() {
        let url = sentinel("not-json");
        assert!(parse_selection(&url).is_none());
    }
}
