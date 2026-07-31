use std::sync::mpsc;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{
    ns_string, NSDate, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieExpires, NSHTTPCookieName,
    NSHTTPCookiePath, NSHTTPCookiePropertyKey, NSHTTPCookieSameSiteLax, NSHTTPCookieSameSitePolicy,
    NSHTTPCookieSameSiteStrict, NSHTTPCookieSecure, NSHTTPCookieValue, NSMutableDictionary,
    NSString,
};
use objc2_web_kit::WKWebView;
use tauri::{AppHandle, Manager};

use super::{CookieSink, ImportError, ImportedCookie, SameSite};
use crate::browser::embedded::EMBED_LABEL;

pub(super) struct WkWebviewSink {
    app: AppHandle,
}

impl WkWebviewSink {
    pub(super) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

fn make_cookie(cookie: &ImportedCookie) -> Option<Retained<NSHTTPCookie>> {
    unsafe {
        let name = NSString::from_str(&cookie.name);
        let value = NSString::from_str(&cookie.value);
        let domain = NSString::from_str(&cookie.host_key);
        let path = NSString::from_str(&cookie.path);
        let properties: Retained<NSMutableDictionary<NSHTTPCookiePropertyKey, AnyObject>> =
            NSMutableDictionary::from_slices(
                &[
                    NSHTTPCookieName,
                    NSHTTPCookieValue,
                    NSHTTPCookieDomain,
                    NSHTTPCookiePath,
                ],
                &[&name, &value, &domain, &path],
            );
        if cookie.is_secure {
            properties.insert(NSHTTPCookieSecure, ns_string!("TRUE"));
        }
        if cookie.is_httponly {
            properties.insert(ns_string!("HttpOnly"), ns_string!("TRUE"));
        }
        if let Some(expires_unix) = cookie.expires_unix {
            let expires = NSDate::dateWithTimeIntervalSince1970(expires_unix as f64);
            properties.insert(NSHTTPCookieExpires, &expires);
        }
        match cookie.same_site {
            SameSite::Lax => properties.insert(NSHTTPCookieSameSitePolicy, NSHTTPCookieSameSiteLax),
            SameSite::Strict => {
                properties.insert(NSHTTPCookieSameSitePolicy, NSHTTPCookieSameSiteStrict)
            }
            SameSite::None => properties.insert(NSHTTPCookieSameSitePolicy, ns_string!("none")),
            SameSite::Unspecified => {}
        }
        NSHTTPCookie::cookieWithProperties(&properties)
    }
}

fn prepare_native_cookies(
    cookies: &[ImportedCookie],
) -> Vec<(ImportedCookie, Retained<NSHTTPCookie>)> {
    cookies
        .iter()
        .filter_map(|cookie| make_cookie(cookie).map(|native| (cookie.clone(), native)))
        .collect()
}

impl CookieSink for WkWebviewSink {
    fn inject(&self, cookies: &[ImportedCookie]) -> Result<Vec<ImportedCookie>, ImportError> {
        if cookies.is_empty() {
            return Ok(Vec::new());
        }
        let webview = self
            .app
            .get_webview(EMBED_LABEL)
            .ok_or(ImportError::Injection)?;
        let owned = cookies.to_vec();
        let (tx, rx) = mpsc::sync_channel(1);
        webview
            .with_webview(move |platform_webview| unsafe {
                let view: &WKWebView = &*platform_webview.inner().cast();
                let native = prepare_native_cookies(&owned);
                if native.is_empty() {
                    let _ = tx.send(Ok(Vec::new()));
                    return;
                }
                let imported = Arc::new(
                    native
                        .iter()
                        .map(|(source, _)| source.clone())
                        .collect::<Vec<_>>(),
                );
                let remaining = Arc::new(AtomicUsize::new(native.len()));
                let store = view.configuration().websiteDataStore().httpCookieStore();
                for (_, cookie) in native {
                    let imported = Arc::clone(&imported);
                    let remaining = Arc::clone(&remaining);
                    let completion_tx = tx.clone();
                    let completion = block2::RcBlock::new(move || {
                        if remaining.fetch_sub(1, Ordering::AcqRel) == 1 {
                            let _ = completion_tx.send(Ok((*imported).clone()));
                        }
                    });
                    store.setCookie_completionHandler(&cookie, Some(&completion));
                }
            })
            .map_err(|_| ImportError::Injection)?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| ImportError::Injection)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn imported_cookie(same_site: SameSite) -> ImportedCookie {
        ImportedCookie {
            host_key: ".example.com".into(),
            name: "session".into(),
            value: "secret".into(),
            path: "/account".into(),
            expires_unix: Some(1_700_000_000),
            is_secure: true,
            is_httponly: true,
            same_site,
        }
    }

    #[test]
    fn maps_security_expiry_and_same_site_properties() {
        let cookie = make_cookie(&imported_cookie(SameSite::Strict)).unwrap();
        assert_eq!(cookie.name().to_string(), "session");
        assert_eq!(cookie.value().to_string(), "secret");
        assert_eq!(cookie.domain().to_string(), ".example.com");
        assert_eq!(cookie.path().to_string(), "/account");
        assert!(cookie.isSecure());
        assert!(cookie.isHTTPOnly());
        assert_eq!(
            cookie.expiresDate().unwrap().timeIntervalSince1970() as i64,
            1_700_000_000
        );
        for (same_site, expected) in [(SameSite::Lax, "lax"), (SameSite::Strict, "strict")] {
            assert_eq!(
                make_cookie(&imported_cookie(same_site))
                    .unwrap()
                    .sameSitePolicy()
                    .unwrap()
                    .to_string(),
                expected
            );
        }
        assert!(make_cookie(&imported_cookie(SameSite::None)).is_some());
    }

    #[test]
    fn leaves_optional_properties_absent_when_unspecified() {
        let mut source = imported_cookie(SameSite::Unspecified);
        source.expires_unix = None;
        source.is_secure = false;
        source.is_httponly = false;
        let cookie = make_cookie(&source).unwrap();
        assert!(!cookie.isSecure());
        assert!(!cookie.isHTTPOnly());
        assert!(cookie.expiresDate().is_none());
        assert!(cookie.sameSitePolicy().is_none());
    }

    #[test]
    fn skips_individual_cookies_that_foundation_rejects() {
        let valid = imported_cookie(SameSite::Lax);
        let mut invalid = imported_cookie(SameSite::Lax);
        invalid.name.clear();
        let prepared = prepare_native_cookies(&[valid.clone(), invalid]);
        assert_eq!(prepared.len(), 1);
        assert_eq!(prepared[0].0, valid);
    }
}
