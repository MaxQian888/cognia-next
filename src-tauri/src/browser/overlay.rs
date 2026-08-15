//! Injected overlay script + the page->Rust selection channel.
//!
//! The previewed dev-server page is a *remote* context: Tauri injects no IPC
//! bridge into it and granting app-command access to remote origins via ACL is
//! brittle. So the overlay signals a selection by navigating to a sentinel URL
//! (`https://cognia.invalid/__cognia_select?data=<signal>`); the webview's
//! `on_navigation` handler intercepts that host+path, parses the small signal, emits
//! `browser://element-selected`, and cancels the navigation. This needs no
//! capability grant and works on both WKWebView and WebView2.

/// The selection overlay, injected verbatim via `initialization_script`. Single
/// source of truth with the Jest suite — both load the same bytes.
pub const OVERLAY_JS: &str = include_str!("../../../lib/browser/overlay.injected.js");

/// Sentinel host the overlay navigates to on selection. A reserved TLD that
/// never resolves, so even an un-cancelled navigation cannot leak anywhere.
pub const SENTINEL_HOST: &str = "cognia.invalid";
pub const SENTINEL_PATH: &str = "/__cognia_select";
/// Sentinel path the overlay hits to report SPA navigations (history.pushState
/// / replaceState / popstate / hashchange), which never reach `on_navigation`
/// as real document loads.
pub const NAV_SENTINEL_PATH: &str = "/__cognia_nav";
/// Sentinel path the overlay hits once a real document has finished loading
/// (`window` `load`). `on_navigation` never fires a "load complete" event, so
/// the page reports it here — letting the preview pane swap its loading
/// placeholder for the painted page.
pub const LOADED_SENTINEL_PATH: &str = "/__cognia_loaded";
/// ADR-0127 push channels (`overlay.injected.js` `enqueueSentinel`): a batch
/// of new console entries / completed requests, and a "DOM changed" marker
/// carrying a per-document sequence + mutation count. Cancelled like the
/// other sentinels; re-emitted as `browser://console` / `browser://network` /
/// `browser://snapshot`.
pub const CONSOLE_SENTINEL_PATH: &str = "/__cognia_console";
pub const NETWORK_SENTINEL_PATH: &str = "/__cognia_network";
pub const SNAPSHOT_SENTINEL_PATH: &str = "/__cognia_snapshot";

/// Parse a sentinel navigation (`https://cognia.invalid/<path>?data=<json>`)
/// into its JSON payload, or `None` if `raw` is not that sentinel. The `url`
/// crate percent-decodes the `data` query for us.
fn parse_sentinel(raw: &str, path: &str) -> Option<serde_json::Value> {
    let parsed = url::Url::parse(raw).ok()?;
    if parsed.host_str() != Some(SENTINEL_HOST) || parsed.path() != path {
        return None;
    }
    let data = parsed
        .query_pairs()
        .find(|(k, _)| k == "data")
        .map(|(_, v)| v.into_owned())?;
    serde_json::from_str::<serde_json::Value>(&data).ok()
}

/// Parse a navigation URL into a selection payload, or `None` if it is not the
/// selection sentinel.
pub fn parse_selection(raw: &str) -> Option<serde_json::Value> {
    parse_sentinel(raw, SENTINEL_PATH)
}

/// Parse a navigation URL into an SPA-navigation payload (`{"url": …}`), or
/// `None` if it is not the SPA-nav sentinel.
pub fn parse_spa_navigation(raw: &str) -> Option<serde_json::Value> {
    parse_sentinel(raw, NAV_SENTINEL_PATH)
}

/// Parse a navigation URL into a load-complete payload (`{"url": …}`), or
/// `None` if it is not the load-complete sentinel.
pub fn parse_loaded(raw: &str) -> Option<serde_json::Value> {
    parse_sentinel(raw, LOADED_SENTINEL_PATH)
}

/// Parse a console-push sentinel (`{"entries": [...]}`), or `None`.
pub fn parse_console_push(raw: &str) -> Option<serde_json::Value> {
    parse_sentinel(raw, CONSOLE_SENTINEL_PATH)
}

/// Parse a network-push sentinel (`{"entries": [...]}`), or `None`.
pub fn parse_network_push(raw: &str) -> Option<serde_json::Value> {
    parse_sentinel(raw, NETWORK_SENTINEL_PATH)
}

/// Parse a snapshot-dirty sentinel (`{"url","seq","mutations"}`), or `None`.
pub fn parse_snapshot_dirty(raw: &str) -> Option<serde_json::Value> {
    parse_sentinel(raw, SNAPSHOT_SENTINEL_PATH)
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
        assert!(OVERLAY_JS.contains("__cognia_nav"));
        assert!(OVERLAY_JS.contains("__cognia_loaded"));
        assert!(OVERLAY_JS.contains("__cogniaFind"));
    }

    #[test]
    fn parses_a_valid_selection_signal() {
        let url = sentinel(r##"{"count":1,"generation":7}"##);
        let payload = parse_selection(&url).expect("should parse");
        assert_eq!(payload["count"], 1);
        assert_eq!(payload["generation"], 7);
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

    #[test]
    fn parses_spa_navigation_payload() {
        let mut u = url::Url::parse("https://cognia.invalid/__cognia_nav").unwrap();
        u.query_pairs_mut()
            .append_pair("data", r#"{"url":"http://localhost:3000/app#tab"}"#);
        let payload = parse_spa_navigation(u.as_str()).expect("should parse");
        assert_eq!(payload["url"], "http://localhost:3000/app#tab");
    }

    #[test]
    fn spa_and_selection_sentinels_do_not_cross_match() {
        let sel = sentinel(r##"{"selector":"#x"}"##);
        assert!(parse_spa_navigation(&sel).is_none());
        let mut u = url::Url::parse("https://cognia.invalid/__cognia_nav").unwrap();
        u.query_pairs_mut()
            .append_pair("data", r#"{"url":"http://a/"}"#);
        assert!(parse_selection(u.as_str()).is_none());
    }

    #[test]
    fn parses_loaded_payload() {
        let mut u = url::Url::parse("https://cognia.invalid/__cognia_loaded").unwrap();
        u.query_pairs_mut()
            .append_pair("data", r#"{"url":"http://localhost:3000/"}"#);
        let payload = parse_loaded(u.as_str()).expect("should parse");
        assert_eq!(payload["url"], "http://localhost:3000/");
    }

    #[test]
    fn loaded_sentinel_does_not_cross_match_selection_or_nav() {
        let sel = sentinel(r##"{"selector":"#x"}"##);
        assert!(parse_loaded(&sel).is_none());
        let mut nav = url::Url::parse("https://cognia.invalid/__cognia_nav").unwrap();
        nav.query_pairs_mut()
            .append_pair("data", r#"{"url":"http://a/"}"#);
        assert!(parse_loaded(nav.as_str()).is_none());
        let mut loaded = url::Url::parse("https://cognia.invalid/__cognia_loaded").unwrap();
        loaded
            .query_pairs_mut()
            .append_pair("data", r#"{"url":"http://a/"}"#);
        assert!(parse_selection(loaded.as_str()).is_none());
        assert!(parse_spa_navigation(loaded.as_str()).is_none());
    }
}
