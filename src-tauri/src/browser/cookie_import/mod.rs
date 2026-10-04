//! Import sign-ins from the browsers on this machine into the embedded
//! preview or the local Chromium runtime without exposing values across the
//! renderer IPC boundary (ADR-0073, amended by ADR-0201), and sign the
//! preview out again.
//!
//! Reading and decrypting live in `cognia-browser-cookies`; this module holds
//! the command shells, the macOS Keychain adapter, and the sinks.
//!
//! Bulk imports need OS user presence (`cognia_secrets::user_presence`,
//! the same check and `user_presence_*` error codes as the password vault):
//! a chosen set of domains, every domain, and any import into the local
//! Chromium runtime. A one-site import into the embedded preview keeps the
//! ADR-0073 flow without a prompt.

#[cfg(target_os = "macos")]
mod inject_macos;
#[cfg(target_os = "macos")]
mod keychain_macos;
mod sinks;

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use tauri::{Manager, Webview};

use cognia_browser_cookies::browsers::{Browser, HostDirs, Os};
use cognia_browser_cookies::import::{
    collect_cookies, cookie_domains, cookie_sources, CookieBatch, DomainCount, SourceInfo,
};
use cognia_browser_cookies::scope::{site_of_host, CookieScope};
use cognia_browser_cookies::system::SystemSecrets;
use cognia_browser_cookies::{chromium, ImportError, ImportedCookie, Keychain};

use crate::browser::embedded::EMBED_LABEL;
use cognia_secrets::user_presence::{self, UserPresenceError};

/// The only window whose renderer may import sign-ins or manage saved
/// passwords. Other webviews (the preview itself, the pet, popouts) are
/// refused.
pub(crate) const OWNER_WINDOW_LABEL: &str = "main";

pub(crate) fn require_main_window(label: &str) -> Result<(), String> {
    if label == OWNER_WINDOW_LABEL {
        Ok(())
    } else {
        Err("forbidden_caller".into())
    }
}

/// The host's macOS Keychain adapter; elsewhere Keychain reads are refused
/// (Windows and Linux keys come from DPAPI and the Secret Service).
pub(crate) fn host_keychain() -> Box<dyn Keychain + Send> {
    #[cfg(target_os = "macos")]
    {
        Box::new(keychain_macos::MacKeychain)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(cognia_browser_cookies::system::NoKeychain)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CookieSinkKind {
    Embedded,
    Local,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CookieImportV2Result {
    Ok {
        injected: usize,
        #[serde(rename = "skippedAppBound")]
        skipped_app_bound: usize,
        domains: Vec<String>,
    },
    PermissionDenied,
    FullDiskAccessRequired,
    NoProfile,
    NoMatchingCookies,
    Unsupported {
        reason: String,
    },
}

/// What clearing a site's sign-in removed. Counts only: like the import, no
/// cookie name or value crosses the IPC boundary.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CookieClearResult {
    /// Cookies removed from the preview's store.
    removed: usize,
    /// The registrable domain they were matched against.
    domain: String,
}

/// What signing the preview out of every site removed.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CookieClearAllResult {
    removed: usize,
}

/// Typed, non-error outcomes of a failed read; anything else is a command
/// error carrying the error code.
fn result_for_error(error: ImportError) -> Result<CookieImportV2Result, String> {
    match error {
        ImportError::PermissionDenied => Ok(CookieImportV2Result::PermissionDenied),
        ImportError::FullDiskAccessRequired => Ok(CookieImportV2Result::FullDiskAccessRequired),
        ImportError::NoProfile => Ok(CookieImportV2Result::NoProfile),
        ImportError::UnsupportedOs | ImportError::DatabaseLocked => {
            Ok(CookieImportV2Result::Unsupported {
                reason: error.code().into(),
            })
        }
        other => Err(other.code().into()),
    }
}

fn summarize(injected: &[ImportedCookie], skipped_app_bound: usize) -> CookieImportV2Result {
    if injected.is_empty() && skipped_app_bound == 0 {
        return CookieImportV2Result::NoMatchingCookies;
    }
    let domains = injected
        .iter()
        .map(|cookie| site_of_host(&cookie.host_key))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    CookieImportV2Result::Ok {
        injected: injected.len(),
        skipped_app_bound,
        domains,
    }
}

/// Every browser cookies can be imported from, with its profiles or the
/// reason it cannot be used. No Keychain, DPAPI or Secret Service access.
#[tauri::command]
pub async fn browser_cookie_sources(webview: Webview) -> Result<Vec<SourceInfo>, String> {
    require_main_window(webview.label())?;
    tokio::task::spawn_blocking(|| cookie_sources(Os::current(), &HostDirs::detect()))
        .await
        .map_err(|_| "cookie source worker failed".to_string())
}

/// A profile's sites and cookie counts, read without decrypting any value.
#[tauri::command]
pub async fn browser_cookie_domains(
    webview: Webview,
    browser: Browser,
    profile: String,
) -> Result<Vec<DomainCount>, String> {
    require_main_window(webview.label())?;
    tokio::task::spawn_blocking(move || {
        cookie_domains(browser, &profile, Os::current(), &HostDirs::detect())
    })
    .await
    .map_err(|_| "cookie domain worker failed".to_string())?
    .map_err(|error| error.code().to_string())
}

async fn inject_embedded(
    app: &tauri::AppHandle,
    cookies: Vec<ImportedCookie>,
) -> Result<Vec<ImportedCookie>, String> {
    if app.get_webview(EMBED_LABEL).is_none() {
        return Err("embedded_not_open".into());
    }
    #[cfg(target_os = "macos")]
    {
        use cognia_browser_cookies::CookieSink;
        let app = app.clone();
        tokio::task::spawn_blocking(move || {
            inject_macos::WkWebviewSink::new(app)
                .inject(&cookies)
                .map_err(|error| error.code().to_string())
        })
        .await
        .map_err(|_| "cookie injection worker failed".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let webview = app
            .get_webview(EMBED_LABEL)
            .ok_or_else(|| "embedded_not_open".to_string())?;
        tokio::task::spawn_blocking(move || sinks::inject_with_tauri(&webview, &cookies))
            .await
            .map_err(|_| "cookie injection worker failed".to_string())
    }
}

async fn inject_local(
    app: &tauri::AppHandle,
    session_id: Option<String>,
    cookies: Vec<ImportedCookie>,
) -> Result<Vec<ImportedCookie>, String> {
    let session_id = session_id
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "session_required".to_string())?;
    let payload = serde_json::json!({
        "sessionId": session_id,
        "cookies": sinks::runtime_cookies(&cookies),
    });
    let response =
        crate::browser::local::rpc_privileged(app, "browser.cookies.set", payload).await?;
    let count = sinks::runtime_injected_count(&response, cookies.len());
    let mut injected = cookies;
    injected.truncate(count);
    Ok(injected)
}

/// Whether an import of `scope` into `sink` must first pass OS user presence:
/// every multi-site scope and every import into the local runtime.
pub(crate) fn import_needs_presence(scope: &CookieScope, sink: CookieSinkKind) -> bool {
    matches!(sink, CookieSinkKind::Local)
        || matches!(scope, CookieScope::Domains { .. } | CookieScope::All)
}

/// The prompt reason for an import that needs presence.
fn presence_reason(scope: &CookieScope) -> &'static str {
    match scope {
        CookieScope::All => "import sign-ins for every site",
        CookieScope::Domains { .. } => "import sign-ins for the chosen sites",
        CookieScope::Site { .. } => "import sign-ins into the local browser",
    }
}

/// A presence failure as the command error string (`user_presence_denied`,
/// `user_presence_cancelled`, …) — the same codes the password commands use.
fn presence_error(error: UserPresenceError) -> String {
    error.to_string()
}

/// Ask for OS user presence off the async workers.
async fn require_presence(reason: &'static str) -> Result<(), String> {
    tokio::task::spawn_blocking(move || user_presence::verify(reason).map_err(presence_error))
        .await
        .map_err(|_| "user presence worker failed".to_string())?
}

/// Import one profile's cookies of `scope` into `sink`. Values are read,
/// decrypted and injected in Rust; the renderer gets counts and sites.
/// Multi-site scopes and the local sink require OS user presence first.
#[tauri::command]
pub async fn browser_cookie_import_v2(
    app: tauri::AppHandle,
    webview: Webview,
    browser: Browser,
    profile: String,
    scope: CookieScope,
    sink: CookieSinkKind,
    session_id: Option<String>,
) -> Result<CookieImportV2Result, String> {
    require_main_window(webview.label())?;
    if import_needs_presence(&scope, sink) {
        require_presence(presence_reason(&scope)).await?;
    }
    let collected = tokio::task::spawn_blocking(move || -> Result<CookieBatch, ImportError> {
        let keychain = host_keychain();
        let secrets = SystemSecrets::new(keychain.as_ref());
        collect_cookies(
            browser,
            &profile,
            &scope,
            Os::current(),
            &HostDirs::detect(),
            &secrets,
        )
    })
    .await
    .map_err(|_| "cookie import worker failed".to_string())?;
    let batch = match collected {
        Ok(batch) => batch,
        Err(error) => return result_for_error(error),
    };
    let CookieBatch {
        cookies,
        skipped_app_bound,
    } = batch;
    if cookies.is_empty() {
        return Ok(summarize(&[], skipped_app_bound));
    }
    let injected = match sink {
        CookieSinkKind::Embedded => inject_embedded(&app, cookies).await?,
        CookieSinkKind::Local => inject_local(&app, session_id, cookies).await?,
    };
    Ok(summarize(&injected, skipped_app_bound))
}

/// The System Settings pane Safari cookie import needs (Privacy & Security
/// → Full Disk Access).
const FULL_DISK_ACCESS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/// Open System Settings at Full Disk Access (macOS). The URL is fixed; the
/// renderer passes nothing.
#[tauri::command]
pub async fn browser_open_full_disk_access_settings(webview: Webview) -> Result<(), String> {
    require_main_window(webview.label())?;
    #[cfg(target_os = "macos")]
    {
        let status = tokio::process::Command::new("/usr/bin/open")
            .arg(FULL_DISK_ACCESS_URL)
            .status()
            .await
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("open_failed".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = FULL_DISK_ACCESS_URL;
        Err("unsupported_os".into())
    }
}

/// Whether a cookie stored under `cookie_domain` belongs to `site`, a
/// registrable domain: the site itself or any subdomain, host-only (`a.b.com`)
/// or domain (`.b.com`) alike. The same scope the import reads from, so a clear
/// removes exactly what an import could have put there — and nothing of an
/// unrelated site that merely ends in the same letters (`notexample.com`).
fn cookie_belongs_to_site(cookie_domain: &str, site: &str) -> bool {
    let domain = cookie_domain
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    !domain.is_empty()
        && (domain == site
            || domain
                .strip_suffix(site)
                .is_some_and(|prefix| prefix.ends_with('.')))
}

/// Remove the current site's cookies from the embedded preview — the way out
/// of an import (ADR-0073), and a plain "sign out here" for any site.
///
/// Scoped like the import: `domain` must be the host the preview is showing,
/// and only that host's registrable domain is touched. The preview shares the
/// main window's website data store, so clearing *all* browsing data would wipe
/// Cognia's own storage; per-cookie deletion is the only safe grain. The store
/// is read off the async runtime because WebView2's cookie reads deadlock on a
/// synchronous command thread.
#[tauri::command]
pub async fn browser_cookie_clear(
    app: tauri::AppHandle,
    domain: String,
) -> Result<CookieClearResult, String> {
    let site = chromium::registrable_domain(&domain).map_err(|error| error.to_string())?;
    let webview = app
        .get_webview(EMBED_LABEL)
        .ok_or_else(|| "embedded browser is not open".to_string())?;
    let current_host = webview
        .url()
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned));
    if current_host.as_deref() != Some(domain.as_str()) {
        return Err(ImportError::InvalidDomain.to_string());
    }
    let matched_site = site.clone();
    let removed = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let cookies = webview
            .cookies()
            .map_err(|_| "cookie store could not be read".to_string())?;
        let mut removed = 0;
        for cookie in cookies {
            let belongs = cookie
                .domain()
                .is_some_and(|cookie_domain| cookie_belongs_to_site(cookie_domain, &matched_site));
            if !belongs {
                continue;
            }
            webview
                .delete_cookie(cookie)
                .map_err(|_| "cookie could not be removed".to_string())?;
            removed += 1;
        }
        Ok(removed)
    })
    .await
    .map_err(|_| "cookie clear worker failed".to_string())??;
    Ok(CookieClearResult {
        removed,
        domain: site,
    })
}

/// Whether a cookie stored under `cookie_domain` belongs to a public website —
/// the only kind a sign-out-everywhere may remove. Local development hosts,
/// IP literals and the app's own `tauri.localhost` origin share this store and
/// are left alone: they are not "sites you are signed in to", and the app's
/// own origin must not lose state it did not ask to lose.
fn is_public_site_cookie(cookie_domain: &str) -> bool {
    let host = cookie_domain
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return false;
    }
    chromium::registrable_domain(&host).is_ok()
}

/// Remove every public site's cookies from the preview — what "clear all data"
/// does to the sign-ins it would otherwise leave behind, imported or typed in.
///
/// The preview shares its website data store with the main window, so any
/// webview reaches the same cookies; the preview need not be open.
#[tauri::command]
pub async fn browser_cookie_clear_all(
    app: tauri::AppHandle,
) -> Result<CookieClearAllResult, String> {
    let webview = app
        .get_webview(EMBED_LABEL)
        .or_else(|| app.get_webview("main"))
        .or_else(|| app.webviews().into_values().next())
        .ok_or_else(|| "no webview is available".to_string())?;
    let removed = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let cookies = webview
            .cookies()
            .map_err(|_| "cookie store could not be read".to_string())?;
        let mut removed = 0;
        for cookie in cookies {
            if !cookie.domain().is_some_and(is_public_site_cookie) {
                continue;
            }
            webview
                .delete_cookie(cookie)
                .map_err(|_| "cookie could not be removed".to_string())?;
            removed += 1;
        }
        Ok(removed)
    })
    .await
    .map_err(|_| "cookie clear worker failed".to_string())??;
    Ok(CookieClearAllResult { removed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_all_touches_public_sites_only() {
        assert!(is_public_site_cookie(".github.com"));
        assert!(is_public_site_cookie("accounts.google.com"));
        assert!(!is_public_site_cookie("localhost"));
        assert!(!is_public_site_cookie("tauri.localhost"));
        assert!(!is_public_site_cookie("app.localhost"));
        assert!(!is_public_site_cookie("printer.local"));
        assert!(!is_public_site_cookie("127.0.0.1"));
        assert!(!is_public_site_cookie("com"));
        assert!(!is_public_site_cookie(""));
    }

    #[test]
    fn clear_matches_the_site_and_its_subdomains_only() {
        assert!(cookie_belongs_to_site("example.com", "example.com"));
        assert!(cookie_belongs_to_site(".example.com", "example.com"));
        assert!(cookie_belongs_to_site("www.example.com", "example.com"));
        assert!(cookie_belongs_to_site(
            ".Accounts.Example.com",
            "example.com"
        ));
        assert!(!cookie_belongs_to_site("notexample.com", "example.com"));
        assert!(!cookie_belongs_to_site(
            "example.com.evil.io",
            "example.com"
        ));
        assert!(!cookie_belongs_to_site("", "example.com"));
        assert!(!cookie_belongs_to_site(".", "example.com"));
    }

    #[test]
    fn clear_result_carries_counts_not_cookie_data() {
        let json = serde_json::to_value(CookieClearResult {
            removed: 3,
            domain: "example.com".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "removed": 3, "domain": "example.com" })
        );
    }

    #[test]
    fn only_the_main_window_may_import() {
        assert_eq!(require_main_window("main"), Ok(()));
        for label in ["browser-embed", "pet", "main-2", ""] {
            assert_eq!(require_main_window(label), Err("forbidden_caller".into()));
        }
    }

    #[test]
    fn typed_outcomes_for_read_failures() {
        assert_eq!(
            result_for_error(ImportError::PermissionDenied),
            Ok(CookieImportV2Result::PermissionDenied)
        );
        assert_eq!(
            result_for_error(ImportError::FullDiskAccessRequired),
            Ok(CookieImportV2Result::FullDiskAccessRequired)
        );
        assert_eq!(
            result_for_error(ImportError::NoProfile),
            Ok(CookieImportV2Result::NoProfile)
        );
        assert_eq!(
            result_for_error(ImportError::UnsupportedOs),
            Ok(CookieImportV2Result::Unsupported {
                reason: "unsupported_os".into()
            })
        );
        assert_eq!(
            result_for_error(ImportError::DatabaseLocked),
            Ok(CookieImportV2Result::Unsupported {
                reason: "browser_running".into()
            })
        );
        assert_eq!(
            result_for_error(ImportError::InvalidDomain),
            Err("invalid_domain".into())
        );
    }

    fn imported(host: &str) -> ImportedCookie {
        ImportedCookie {
            host_key: host.into(),
            name: "n".into(),
            value: "secret-value".into(),
            path: "/".into(),
            expires_unix: None,
            is_secure: true,
            is_httponly: true,
            same_site: cognia_browser_cookies::SameSite::Lax,
        }
    }

    #[test]
    fn summaries_carry_counts_and_sites_never_values() {
        assert_eq!(summarize(&[], 0), CookieImportV2Result::NoMatchingCookies);
        let result = summarize(
            &[
                imported(".github.com"),
                imported("api.github.com"),
                imported("x.org"),
            ],
            2,
        );
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "kind": "ok",
                "injected": 3,
                "skippedAppBound": 2,
                "domains": ["github.com", "x.org"]
            })
        );
        assert!(!json.to_string().contains("secret-value"));
        assert_eq!(
            serde_json::to_value(summarize(&[], 4)).unwrap()["skippedAppBound"],
            4
        );
    }

    #[test]
    fn result_kinds_serialize_as_the_ipc_contract() {
        for (result, kind) in [
            (CookieImportV2Result::PermissionDenied, "permission_denied"),
            (
                CookieImportV2Result::FullDiskAccessRequired,
                "full_disk_access_required",
            ),
            (CookieImportV2Result::NoProfile, "no_profile"),
            (
                CookieImportV2Result::NoMatchingCookies,
                "no_matching_cookies",
            ),
        ] {
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                serde_json::json!({ "kind": kind })
            );
        }
        assert_eq!(
            serde_json::from_value::<CookieSinkKind>(serde_json::json!("local")).unwrap(),
            CookieSinkKind::Local
        );
    }

    #[test]
    fn bulk_and_local_imports_need_user_presence() {
        let site = CookieScope::Site {
            domain: "github.com".into(),
        };
        let domains = CookieScope::Domains {
            domains: vec!["github.com".into()],
        };
        assert!(!import_needs_presence(&site, CookieSinkKind::Embedded));
        assert!(import_needs_presence(&site, CookieSinkKind::Local));
        assert!(import_needs_presence(&domains, CookieSinkKind::Embedded));
        assert!(import_needs_presence(&domains, CookieSinkKind::Local));
        assert!(import_needs_presence(
            &CookieScope::All,
            CookieSinkKind::Embedded
        ));
        assert!(import_needs_presence(
            &CookieScope::All,
            CookieSinkKind::Local
        ));
        for scope in [&site, &domains, &CookieScope::All] {
            assert!(!presence_reason(scope).trim().is_empty());
        }
    }

    #[test]
    fn presence_failures_use_the_vault_error_codes() {
        assert_eq!(
            presence_error(UserPresenceError::Denied),
            "user_presence_denied"
        );
        assert_eq!(
            presence_error(UserPresenceError::Cancelled),
            "user_presence_cancelled"
        );
        assert_eq!(
            presence_error(UserPresenceError::Unavailable),
            "user_presence_unavailable"
        );
        assert_eq!(
            presence_error(UserPresenceError::Failed("x".into())),
            "user_presence_failed: x"
        );
    }

    #[test]
    fn the_full_disk_access_url_is_fixed() {
        assert_eq!(
            FULL_DISK_ACCESS_URL,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        );
    }
}
