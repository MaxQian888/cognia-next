//! Browser-plane origin admission.
//!
//! The browser plane is the only door a tab can reach this Host on
//! (`browser_access`), and until now its allowlist accepted exactly one shape:
//! an `https://` origin, or `http://` on loopback. That predicate —
//! [`super::web_origin::is_secure_or_loopback`] — is deliberately NOT widened
//! here, because it is shared with `lark_entry`'s `COGNIA_LARK_*` base-URL
//! validation. Teaching it about `chrome-extension://` would also teach Lark
//! that an extension page is an acceptable webhook base, which it is not.
//!
//! So admission for the browser plane is its own union: the transport
//! predicate, OR a Cognia browser-extension origin. Every other caller of
//! `is_secure_or_loopback` keeps the narrower rule it was written for.
//!
//! ## Why the path check could not simply be reused
//!
//! `chrome-extension:` is not a *special* scheme in the URL Standard, so a
//! bare extension origin parses with an **empty** path, not `"/"`:
//!
//! ```text
//! chrome-extension://abcdefghijklmnopabcdefghijklmnop
//!   → host "abcdefghijklmnopabcdefghijklmnop", path "", origin "null"
//! ```
//!
//! The existing `url.path() != "/"` guard therefore rejects a perfectly valid
//! extension origin. The path check below is scheme-aware for that reason.
//!
//! Note also that the URL Standard says a non-special URL's *origin* is opaque
//! ("null"), while Chrome nonetheless sends `Origin: chrome-extension://<id>`
//! on requests from an extension page. Admission is therefore decided on the
//! parsed host, never on `Url::origin()`.

use url::Url;

/// Schemes an extension page is served from.
///
/// Chrome and Edge both use `chrome-extension:`. `extension:` is accepted as
/// the cross-browser alias, so a build that emits it is not silently locked
/// out; both still have to satisfy the id shape below.
const EXTENSION_SCHEMES: [&str; 2] = ["chrome-extension", "extension"];

/// The length of a Chromium extension id.
const EXTENSION_ID_LEN: usize = 32;

/// Whether `host` is a Chromium extension id.
///
/// Chromium derives the id from the packed key by mapping each of 16 hex
/// digits onto `a`–`p`, so the id is always exactly 32 characters from that
/// alphabet, always lowercase. Anything else — a wildcard, a domain, a
/// truncated id — is not an id, and there is deliberately no relaxed form:
/// this list is an allowlist of exact origins, and a fuzzy match on it would
/// hand the browser plane to whatever else happens to be installed.
fn is_extension_id(host: &str) -> bool {
    host.len() == EXTENSION_ID_LEN
        && host
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() && byte <= b'p')
}

/// Whether `url` is a Cognia-shaped browser-extension origin.
///
/// Shape only — this says the string *could* name an extension, not that the
/// operator has allowed that particular one. The saved allowlist is what
/// decides which id may talk to this Host.
pub fn is_cognia_extension_origin(url: &Url) -> bool {
    EXTENSION_SCHEMES.contains(&url.scheme())
        && url.port().is_none()
        && url.host_str().is_some_and(is_extension_id)
}

/// Normalize one browser-plane origin, or `None` when it cannot be one.
///
/// One function rather than a predicate each call site re-wraps: the two
/// callers (`browser_access::normalize_origin`, saved config, and
/// `web_origin::normalize_allowed_origin`, `COGNIA_ALLOWED_WEB_ORIGINS`) must
/// agree exactly, or an origin accepted in Settings is refused at request
/// time and the failure surfaces as an unexplained 403 inside a tab.
///
/// Rejects anything carrying a path, query, fragment or credentials, so an
/// allowlist entry is always a bare origin and can be compared to the `Origin`
/// header by string equality.
pub fn normalize_browser_plane_origin(raw: &str) -> Option<String> {
    let value = raw.trim().trim_end_matches('/');
    if value.is_empty() {
        return None;
    }
    let url = Url::parse(value).ok()?;
    let extension = is_cognia_extension_origin(&url);
    if !extension && !super::web_origin::is_secure_or_loopback(&url) {
        return None;
    }
    // A bare extension origin parses with an empty path; an http(s) one with
    // "/". Accept both only where the scheme actually produces them.
    let path_is_bare = if extension {
        matches!(url.path(), "" | "/")
    } else {
        url.path() == "/"
    };
    if !path_is_bare
        || url.host_str().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "abcdefghijklmnopabcdefghijklmnop";

    #[test]
    fn a_bare_extension_origin_parses_with_an_empty_path() {
        // The reason this module exists: the shared http(s) normalizer's
        // `path() != "/"` guard would reject this URL outright.
        let url = Url::parse(&format!("chrome-extension://{ID}")).expect("parses");
        assert_eq!(url.path(), "");
        assert_eq!(url.host_str(), Some(ID));
        assert!(is_cognia_extension_origin(&url));
    }

    #[test]
    fn both_extension_schemes_are_accepted_and_normalize_to_themselves() {
        for scheme in EXTENSION_SCHEMES {
            let raw = format!("{scheme}://{ID}");
            assert_eq!(normalize_browser_plane_origin(&raw), Some(raw.clone()));
            assert_eq!(
                normalize_browser_plane_origin(&format!("{raw}/")),
                Some(raw)
            );
        }
    }

    #[test]
    fn the_http_and_https_rule_still_applies_unchanged() {
        assert_eq!(
            normalize_browser_plane_origin("http://localhost:3000"),
            Some("http://localhost:3000".to_string())
        );
        assert_eq!(
            normalize_browser_plane_origin("https://app.example.com"),
            Some("https://app.example.com".to_string())
        );
        // Plaintext off-machine is still refused — widening the browser plane
        // to extensions must not widen it to the network.
        assert_eq!(normalize_browser_plane_origin("http://example.com"), None);
    }

    #[test]
    fn anything_that_is_not_an_exact_extension_id_is_refused() {
        for bad in [
            "chrome-extension://*",
            "chrome-extension://",
            // 31 characters.
            "chrome-extension://abcdefghijklmnopabcdefghijklmno",
            // 33 characters.
            "chrome-extension://abcdefghijklmnopabcdefghijklmnopq",
            // `q` is outside the a–p alphabet.
            "chrome-extension://qbcdefghijklmnopabcdefghijklmnop",
            // Uppercase: opaque hosts are not case-folded, and real ids are
            // always lowercase.
            "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop:8080",
            "moz-extension://abcdefghijklmnopabcdefghijklmnop",
            "safari-web-extension://abcdefghijklmnopabcdefghijklmnop",
        ] {
            assert_eq!(
                normalize_browser_plane_origin(bad),
                None,
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn an_extension_origin_carrying_more_than_an_origin_is_refused() {
        for bad in [
            format!("chrome-extension://{ID}/sidepanel.html"),
            format!("chrome-extension://{ID}?a=1"),
            format!("chrome-extension://{ID}#frag"),
            format!("chrome-extension://user@{ID}"),
        ] {
            assert_eq!(
                normalize_browser_plane_origin(&bad),
                None,
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn the_shared_transport_predicate_is_not_widened() {
        // The guard for this module's whole reason to exist: `lark_entry` and
        // every other caller of `is_secure_or_loopback` must keep refusing an
        // extension origin as a base URL.
        let url = Url::parse(&format!("chrome-extension://{ID}")).expect("parses");
        assert!(!super::super::web_origin::is_secure_or_loopback(&url));
    }
}
