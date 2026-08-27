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
//! ## One core, three admitted sets
//!
//! The union is not what every caller wants, and a caller that takes the union
//! when it meant one half of it is how a widening leaks. So the shapes are
//! named ([`OriginKind`]) and each caller says which it admits:
//!
//! * [`normalize_browser_plane_origin`] — both. The saved allowlist and
//!   `COGNIA_ALLOWED_WEB_ORIGINS` are the browser plane's door and must agree
//!   exactly, or an origin accepted in Settings is refused at request time and
//!   the failure surfaces as an unexplained 403 inside a tab.
//! * [`normalize_web_origin`] — web only. `web_origin::enforce`'s embed-token
//!   branch does not consult the allowlist at all; it admits whatever the
//!   *request itself* presents and defers to the release policy. Handing that
//!   branch the union would let every installed extension reach
//!   `/api/apps/*/embed-token`, which is a widening nobody asked for.
//! * [`normalize_extension_origin`] — extension only. `browser/register` binds
//!   an origin to a device forever; a web origin there would bind a device to
//!   something that is not an extension.
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

/// The scheme an extension page is served from.
///
/// Chromium only, and deliberately so. Firefox serves from `moz-extension:`
/// and Safari from `safari-web-extension:`, both with a UUID host that
/// [`is_extension_id`] refuses on sight — so listing either scheme without
/// also teaching the id predicate about UUIDs would admit nothing and only
/// look like it did. The extension itself is Chromium-only too
/// (`minimum_chrome_version: "116"` in `browser-extension/wxt.config.ts`,
/// `chrome.sidePanel`), so there is no client on the other side to lock out.
const EXTENSION_SCHEME: &str = "chrome-extension";

/// The length of a Chromium extension id.
const EXTENSION_ID_LEN: usize = 32;

/// The origin shapes the browser plane knows about.
///
/// Named rather than a bool pair so a call site reads as what it admits, and
/// so [`canonical_origin`] can branch on the one thing that actually differs
/// between them: whether `Url::origin()` is usable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OriginKind {
    /// `https://…`, or `http://` on loopback — the shared transport predicate.
    Web,
    /// A Cognia-shaped browser-extension origin.
    Extension,
}

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
    url.scheme() == EXTENSION_SCHEME
        && url.port().is_none()
        && url.host_str().is_some_and(is_extension_id)
}

/// Which shape `url` is, or `None` when it is neither.
fn origin_kind(url: &Url) -> Option<OriginKind> {
    if is_cognia_extension_origin(url) {
        return Some(OriginKind::Extension);
    }
    if super::web_origin::is_secure_or_loopback(url) {
        return Some(OriginKind::Web);
    }
    None
}

/// The origin `url` serializes to, exactly as a browser would send it.
///
/// This is the whole reason normalization returns a rebuilt string rather than
/// the caller's input: every consumer compares an allowlist entry to the
/// `Origin` header by **string equality** (`WebOriginPolicy::evaluate`), and a
/// device's bound origin is compared the same way on every request. An entry
/// that is a valid origin but not the *canonical* one — `https://x.test:443`
/// with the default port spelled out, a scheme or host the user typed in mixed
/// case, an IDN host the browser sends as punycode — would be saved happily
/// and then never match anything, which is the unexplained-403 this module
/// exists to prevent.
fn canonical_origin(url: &Url, kind: OriginKind) -> Option<String> {
    match kind {
        // `Url::origin()` is opaque ("null") for a non-special scheme, so the
        // tuple is rebuilt by hand. Both halves are already canonical: the URL
        // Standard lowercases the scheme during parsing, and `is_extension_id`
        // admits only an all-lowercase host.
        OriginKind::Extension => Some(format!("{}://{}", url.scheme(), url.host_str()?)),
        // `ascii_serialization` drops the default port, lowercases the scheme
        // and host, and emits the punycode form of an IDN host — which is what
        // the browser puts in `Origin`.
        OriginKind::Web => {
            let origin = url.origin();
            origin.is_tuple().then(|| origin.ascii_serialization())
        }
    }
}

/// Normalize one origin to its canonical form, admitting only `admitted`.
///
/// Rejects anything carrying a path, query, fragment or credentials, so an
/// entry is always a bare origin. The guards run even though
/// [`canonical_origin`] would discard those parts anyway: silently normalizing
/// `https://x.test/admin` to `https://x.test` would tell the user their path
/// meant something, and an allowlist that quietly widens what it was given is
/// worse than one that refuses.
fn normalize_origin(raw: &str, admitted: &[OriginKind]) -> Option<String> {
    let value = raw.trim().trim_end_matches('/');
    if value.is_empty() {
        return None;
    }
    let url = Url::parse(value).ok()?;
    let kind = origin_kind(&url)?;
    if !admitted.contains(&kind) {
        return None;
    }
    // A bare extension origin parses with an empty path; an http(s) one with
    // "/". Accept both only where the scheme actually produces them.
    let path_is_bare = match kind {
        OriginKind::Extension => matches!(url.path(), "" | "/"),
        OriginKind::Web => url.path() == "/",
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
    canonical_origin(&url, kind)
}

/// Normalize one browser-plane allowlist entry, or `None` when it cannot be one.
///
/// The union. One function rather than a predicate each call site re-wraps:
/// the two callers (`browser_access::normalize_origin`, saved config, and
/// `web_origin::normalize_allowed_origin`, `COGNIA_ALLOWED_WEB_ORIGINS`) must
/// agree exactly, or an origin accepted in Settings is refused at request time.
pub fn normalize_browser_plane_origin(raw: &str) -> Option<String> {
    normalize_origin(raw, &[OriginKind::Web, OriginKind::Extension])
}

/// Normalize one **web** origin, refusing an extension one.
///
/// For the caller that admits whatever a request presents rather than
/// consulting an allowlist — see the module docs.
pub fn normalize_web_origin(raw: &str) -> Option<String> {
    normalize_origin(raw, &[OriginKind::Web])
}

/// Normalize one **extension** origin, refusing a web one.
///
/// For `browser/register`, which binds the result to a device permanently.
pub fn normalize_extension_origin(raw: &str) -> Option<String> {
    normalize_origin(raw, &[OriginKind::Extension])
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
    fn an_extension_origin_normalizes_to_itself_with_or_without_a_trailing_slash() {
        let raw = format!("{EXTENSION_SCHEME}://{ID}");
        assert_eq!(normalize_browser_plane_origin(&raw), Some(raw.clone()));
        assert_eq!(
            normalize_browser_plane_origin(&format!("{raw}/")),
            Some(raw)
        );
    }

    #[test]
    fn only_chromium_extension_origins_are_admitted() {
        // Firefox and Safari serve extension pages from their own schemes with
        // a UUID host. Listing those schemes without teaching `is_extension_id`
        // about UUIDs would admit nothing while looking like it did, so the
        // module states Chromium-only rather than implying otherwise.
        for other in [
            format!("moz-extension://{ID}"),
            format!("safari-web-extension://{ID}"),
            // The phantom alias that no browser has ever emitted.
            format!("extension://{ID}"),
            "moz-extension://6c1b2f5e-0f4a-4a1e-8f1a-9f2c3d4e5a6b".to_string(),
        ] {
            assert_eq!(
                normalize_browser_plane_origin(&other),
                None,
                "{other} should be refused"
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
    fn an_entry_is_canonicalized_to_what_the_browser_will_actually_send() {
        // Every one of these is a valid origin the user could reasonably type,
        // and every one of them used to be stored verbatim and then never
        // string-match the `Origin` header — a saved allowlist entry that 403s
        // forever with nothing to see in Settings.
        for (typed, sent) in [
            // The default port, spelled out.
            ("https://app.example.com:443", "https://app.example.com"),
            ("http://127.0.0.1:80", "http://127.0.0.1"),
            // Mixed case: `Url::parse` lowercases the scheme and the host of a
            // special scheme, but the raw input kept whatever was typed.
            ("HTTPS://App.Example.COM", "https://app.example.com"),
            // An IDN host reaches the wire as punycode.
            ("https://例え.jp", "https://xn--r8jz45g.jp"),
            // A non-default port is part of the origin and survives.
            (
                "https://app.example.com:8443",
                "https://app.example.com:8443",
            ),
        ] {
            assert_eq!(
                normalize_browser_plane_origin(typed).as_deref(),
                Some(sent),
                "{typed} should normalize to {sent}"
            );
        }
        // Same rule for an extension origin typed with a mixed-case scheme.
        assert_eq!(
            normalize_browser_plane_origin(&format!("Chrome-Extension://{ID}")).as_deref(),
            Some(format!("chrome-extension://{ID}").as_str())
        );
    }

    #[test]
    fn each_caller_admits_only_the_shape_it_asked_for() {
        let extension = format!("chrome-extension://{ID}");
        // The union admits both.
        assert!(normalize_browser_plane_origin(&extension).is_some());
        assert!(normalize_browser_plane_origin("https://app.example.com").is_some());
        // The web-only rule refuses an extension origin. This is what keeps
        // `enforce`'s embed-token branch — which admits whatever the request
        // presents, without an allowlist — from opening to every installed
        // extension.
        assert_eq!(normalize_web_origin(&extension), None);
        assert_eq!(
            normalize_web_origin("https://app.example.com").as_deref(),
            Some("https://app.example.com")
        );
        // The extension-only rule refuses a web origin, so `browser/register`
        // cannot bind a device to something that is not an extension.
        assert_eq!(normalize_extension_origin("https://app.example.com"), None);
        assert_eq!(normalize_extension_origin("http://localhost:3000"), None);
        assert_eq!(
            normalize_extension_origin(&extension).as_deref(),
            Some(extension.as_str())
        );
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
