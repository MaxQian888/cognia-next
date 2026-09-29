//! Where imported cookies go (ADR-0201): the embedded preview or the local
//! Chromium runtime. Values leave Rust only into those cookie stores.
//!
//! - Embedded on macOS: `WKHTTPCookieStore`, one completion per cookie
//!   (`inject_macos.rs`, ADR-0073).
//! - Embedded on Windows / Linux: Tauri's `Webview::set_cookie` (WebView2
//!   `ICoreWebView2CookieManager`, WebKitGTK `WebKitCookieManager`).
//! - Local Chromium: the privileged runtime op `browser.cookies.set`, which the
//!   renderer cannot call (`browser_local_rpc` refuses it).

use cognia_browser_cookies::{ImportedCookie, SameSite};

#[cfg(any(not(target_os = "macos"), test))]
/// An RFC 7231 IMF-fixdate (`Wed, 21 Oct 2015 07:28:00 GMT`) for a Unix time.
pub(super) fn http_date(unix: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = unix.div_euclid(86_400);
    let seconds = unix.rem_euclid(86_400);
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT",
        DAYS[days.rem_euclid(7) as usize],
        day,
        MONTHS[(month - 1) as usize],
        year,
        seconds / 3_600,
        (seconds % 3_600) / 60,
        seconds % 60
    )
}

#[cfg(any(not(target_os = "macos"), test))]
/// The attribute string a Tauri cookie is parsed from. Tauri exposes only
/// `Cookie` (not the `cookie` crate's `SameSite`/`Expiration`), so attributes
/// go through `Cookie::parse`.
///
/// A domain cookie (`.github.com`) is written as `Domain=..github.com`: the
/// `cookie` crate strips exactly one leading dot when the webview adapters
/// read `domain()`, so they receive `.github.com` and create a domain cookie;
/// a host-only cookie keeps its bare host.
pub(super) fn cookie_attributes(cookie: &ImportedCookie) -> String {
    // One extra leading dot survives the `cookie` crate's strip (see above).
    let domain = if cookie.host_key.starts_with('.') {
        format!(".{}", cookie.host_key)
    } else {
        cookie.host_key.clone()
    };
    let path = if cookie.path.is_empty() {
        "/"
    } else {
        cookie.path.as_str()
    };
    let mut attributes = format!("cognia=1; Domain={domain}; Path={path}");
    if cookie.is_secure {
        attributes.push_str("; Secure");
    }
    if cookie.is_httponly {
        attributes.push_str("; HttpOnly");
    }
    match cookie.same_site {
        SameSite::Lax => attributes.push_str("; SameSite=Lax"),
        SameSite::Strict => attributes.push_str("; SameSite=Strict"),
        SameSite::None => attributes.push_str("; SameSite=None"),
        SameSite::Unspecified => {}
    }
    if let Some(expires) = cookie.expires_unix {
        attributes.push_str("; Expires=");
        attributes.push_str(&http_date(expires));
    }
    attributes
}

#[cfg(any(not(target_os = "macos"), test))]
/// A Tauri cookie carrying `cookie`'s name, value and attributes.
pub(super) fn tauri_cookie(cookie: &ImportedCookie) -> Option<tauri::webview::Cookie<'static>> {
    let mut built = tauri::webview::Cookie::parse(cookie_attributes(cookie)).ok()?;
    built.set_name(cookie.name.clone());
    built.set_value(cookie.value.clone());
    Some(built)
}

/// Set every cookie on the embedded webview through Tauri. Blocking: call it
/// off the async runtime (WebView2's cookie manager deadlocks on a
/// synchronous command thread). Returns the cookies the webview accepted.
#[cfg(not(target_os = "macos"))]
pub(super) fn inject_with_tauri(
    webview: &tauri::Webview,
    cookies: &[ImportedCookie],
) -> Vec<ImportedCookie> {
    cookies
        .iter()
        .filter(|cookie| {
            tauri_cookie(cookie).is_some_and(|built| webview.set_cookie(built).is_ok())
        })
        .cloned()
        .collect()
}

/// The `browser.cookies.set` payload for the local runtime (Playwright
/// `addCookies` shape: `expires` is Unix seconds, `-1` for a session cookie).
pub(super) fn runtime_cookies(cookies: &[ImportedCookie]) -> Vec<serde_json::Value> {
    cookies
        .iter()
        .map(|cookie| {
            let mut entry = serde_json::json!({
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.host_key,
                "path": if cookie.path.is_empty() { "/" } else { cookie.path.as_str() },
                "expires": cookie.expires_unix.unwrap_or(-1),
                "secure": cookie.is_secure,
                "httpOnly": cookie.is_httponly,
            });
            let same_site = match cookie.same_site {
                SameSite::Lax => Some("Lax"),
                SameSite::Strict => Some("Strict"),
                SameSite::None => Some("None"),
                SameSite::Unspecified => None,
            };
            if let Some(same_site) = same_site {
                entry["sameSite"] = serde_json::Value::from(same_site);
            }
            entry
        })
        .collect()
}

/// How many cookies the runtime reports it set; the batch size when the
/// response carries no count.
pub(super) fn runtime_injected_count(response: &serde_json::Value, sent: usize) -> usize {
    ["set", "injected", "count"]
        .iter()
        .find_map(|key| response.get(*key).and_then(serde_json::Value::as_u64))
        .map(|count| (count as usize).min(sent))
        .unwrap_or(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(host: &str, same_site: SameSite, expires: Option<i64>) -> ImportedCookie {
        ImportedCookie {
            host_key: host.into(),
            name: "session".into(),
            value: "a;b=c".into(),
            path: String::new(),
            expires_unix: expires,
            is_secure: true,
            is_httponly: true,
            same_site,
        }
    }

    #[test]
    fn formats_http_dates() {
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(1_445_412_480), "Wed, 21 Oct 2015 07:28:00 GMT");
        assert_eq!(http_date(951_782_400), "Tue, 29 Feb 2000 00:00:00 GMT");
        assert_eq!(http_date(4_102_444_799), "Thu, 31 Dec 2099 23:59:59 GMT");
    }

    #[test]
    fn keeps_domain_and_host_only_cookies_apart() {
        let domain =
            tauri_cookie(&cookie(".github.com", SameSite::Lax, Some(1_700_000_000))).unwrap();
        assert_eq!(domain.domain(), Some(".github.com"));
        assert_eq!(domain.name(), "session");
        assert_eq!(domain.value(), "a;b=c");
        assert_eq!(domain.path(), Some("/"));
        assert_eq!(domain.secure(), Some(true));
        assert_eq!(domain.http_only(), Some(true));
        assert!(domain.same_site().is_some());
        assert_eq!(
            domain.expires_datetime().map(|at| at.unix_timestamp()),
            Some(1_700_000_000)
        );
        let host_only =
            tauri_cookie(&cookie("www.github.com", SameSite::Unspecified, None)).unwrap();
        assert_eq!(host_only.domain(), Some("www.github.com"));
        assert!(host_only.same_site().is_none());
        assert!(host_only.expires_datetime().is_none());
    }

    #[test]
    fn same_site_attributes_are_written_verbatim() {
        assert!(cookie_attributes(&cookie("a.com", SameSite::Strict, None))
            .ends_with("; SameSite=Strict"));
        assert!(
            cookie_attributes(&cookie("a.com", SameSite::None, None)).ends_with("; SameSite=None")
        );
        assert!(
            !cookie_attributes(&cookie("a.com", SameSite::Unspecified, None)).contains("SameSite")
        );
    }

    #[test]
    fn builds_the_runtime_payload() {
        let payload = runtime_cookies(&[
            cookie(".a.com", SameSite::Lax, Some(10)),
            cookie("b.com", SameSite::Unspecified, None),
        ]);
        assert_eq!(
            payload[0],
            serde_json::json!({
                "name": "session", "value": "a;b=c", "domain": ".a.com", "path": "/",
                "expires": 10, "secure": true, "httpOnly": true, "sameSite": "Lax"
            })
        );
        assert_eq!(payload[1]["expires"], -1);
        assert!(payload[1].get("sameSite").is_none());
    }

    #[test]
    fn reads_the_runtime_count() {
        assert_eq!(
            runtime_injected_count(&serde_json::json!({ "set": 3 }), 5),
            3
        );
        assert_eq!(
            runtime_injected_count(&serde_json::json!({ "injected": 9 }), 5),
            5
        );
        assert_eq!(runtime_injected_count(&serde_json::json!({}), 5), 5);
        assert_eq!(runtime_injected_count(&serde_json::Value::Null, 2), 2);
    }
}
