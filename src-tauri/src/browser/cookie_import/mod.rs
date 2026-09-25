//! Import Chromium cookies into the embedded browser without exposing values
//! across the renderer IPC boundary (ADR-0073).

mod chromium;
#[cfg(target_os = "macos")]
mod inject_macos;
#[cfg(target_os = "macos")]
mod keychain_macos;

use std::fmt;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use tauri::Manager;

use crate::browser::embedded::EMBED_LABEL;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChromiumBrowser {
    Chrome,
    Edge,
    Brave,
    Chromium,
}

impl ChromiumBrowser {
    fn safe_storage_service(self) -> &'static str {
        match self {
            Self::Chrome => "Chrome Safe Storage",
            Self::Edge => "Microsoft Edge Safe Storage",
            Self::Brave => "Brave Safe Storage",
            Self::Chromium => "Chromium Safe Storage",
        }
    }

    fn keychain_account(self) -> &'static str {
        match self {
            Self::Chrome => "Chrome",
            Self::Edge => "Microsoft Edge",
            Self::Brave => "Brave",
            Self::Chromium => "Chromium",
        }
    }

    fn profiles_root_at(self, home: &Path) -> PathBuf {
        let support = home.join("Library/Application Support");
        match self {
            Self::Chrome => support.join("Google/Chrome"),
            Self::Edge => support.join("Microsoft Edge"),
            Self::Brave => support.join("BraveSoftware/Brave-Browser"),
            Self::Chromium => support.join("Chromium"),
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CookieImportAvailability {
    supported: bool,
    profiles: Vec<String>,
    reason: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CookieImportResult {
    Ok {
        injected: usize,
        names: Vec<String>,
        domains: Vec<String>,
    },
    Unsupported {
        reason: String,
    },
    PermissionDenied,
    NoProfile,
    NoMatchingCookies,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SameSite {
    Unspecified,
    None,
    Lax,
    Strict,
}

#[derive(Clone, PartialEq, Eq)]
struct ImportedCookie {
    host_key: String,
    name: String,
    value: String,
    path: String,
    expires_unix: Option<i64>,
    is_secure: bool,
    is_httponly: bool,
    same_site: SameSite,
}

impl fmt::Debug for ImportedCookie {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ImportedCookie")
            .field("host_key", &self.host_key)
            .field("name", &self.name)
            .field("value", &"[REDACTED]")
            .field("path", &self.path)
            .field("expires_unix", &self.expires_unix)
            .field("is_secure", &self.is_secure)
            .field("is_httponly", &self.is_httponly)
            .field("same_site", &self.same_site)
            .finish()
    }
}

trait Keychain {
    fn read(&self, service: &str, account: &str) -> Result<String, ImportError>;
}

trait CookieSink {
    fn inject(&self, cookies: &[ImportedCookie]) -> Result<Vec<ImportedCookie>, ImportError>;
}

#[derive(Debug, Error)]
enum ImportError {
    #[error("cookie database could not be read")]
    Database,
    #[error("cookie decryption failed")]
    Decryption,
    #[error("invalid target domain")]
    InvalidDomain,
    #[error("cookie injection failed")]
    Injection,
    #[error("keychain access was denied")]
    PermissionDenied,
}

fn is_supported_platform(platform: &str) -> bool {
    platform == "macos"
}

fn unsupported_result_for(platform: &str) -> Option<CookieImportResult> {
    (!is_supported_platform(platform)).then(|| CookieImportResult::Unsupported {
        reason: "macos_only".into(),
    })
}

fn profile_path(root: &Path, profile: &str) -> Option<PathBuf> {
    let path = Path::new(profile);
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(name)), None) if !name.is_empty() => Some(root.join(name)),
        _ => None,
    }
}

fn availability_for(
    platform: &str,
    browser: ChromiumBrowser,
    home: Option<&Path>,
) -> CookieImportAvailability {
    if !is_supported_platform(platform) {
        return CookieImportAvailability {
            supported: false,
            profiles: Vec::new(),
            reason: Some("macos_only".into()),
        };
    }
    let Some(home) = home else {
        return CookieImportAvailability {
            supported: true,
            profiles: Vec::new(),
            reason: Some("no_profiles".into()),
        };
    };
    let root = browser.profiles_root_at(home);
    let mut profiles = std::fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| chromium::find_cookie_database(&entry.path()).is_some())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect::<Vec<_>>();
    profiles.sort();
    CookieImportAvailability {
        supported: true,
        reason: profiles.is_empty().then(|| "no_profiles".into()),
        profiles,
    }
}

#[tauri::command]
pub fn browser_cookie_import_available(browser: ChromiumBrowser) -> CookieImportAvailability {
    availability_for(std::env::consts::OS, browser, dirs::home_dir().as_deref())
}

#[tauri::command]
pub async fn browser_cookie_import(
    app: tauri::AppHandle,
    browser: ChromiumBrowser,
    profile: String,
    domain: String,
) -> Result<CookieImportResult, String> {
    if let Some(result) = unsupported_result_for(std::env::consts::OS) {
        return Ok(result);
    }

    #[cfg(target_os = "macos")]
    {
        let current_host = app
            .get_webview(EMBED_LABEL)
            .and_then(|webview| webview.url().ok())
            .and_then(|url| url.host_str().map(str::to_owned));
        if current_host.as_deref() != Some(domain.as_str())
            || chromium::registrable_domain(&domain).is_err()
        {
            return Err(ImportError::InvalidDomain.to_string());
        }
        let Some(home) = dirs::home_dir() else {
            return Ok(CookieImportResult::NoProfile);
        };
        let root = browser.profiles_root_at(&home);
        let Some(profile_dir) = profile_path(&root, &profile) else {
            return Ok(CookieImportResult::NoProfile);
        };
        if chromium::find_cookie_database(&profile_dir).is_none() {
            return Ok(CookieImportResult::NoProfile);
        }

        let result = tokio::task::spawn_blocking(move || {
            chromium::import_profile(
                &profile_dir,
                &domain,
                browser.safe_storage_service(),
                browser.keychain_account(),
                &keychain_macos::MacKeychain,
                &inject_macos::WkWebviewSink::new(app),
            )
        })
        .await
        .map_err(|_| "cookie import worker failed".to_string())?;

        match result {
            Ok(summary) if summary.injected == 0 => Ok(CookieImportResult::NoMatchingCookies),
            Ok(summary) => Ok(CookieImportResult::Ok {
                injected: summary.injected,
                names: summary.names,
                domains: summary.domains,
            }),
            Err(ImportError::PermissionDenied) => Ok(CookieImportResult::PermissionDenied),
            Err(error) => Err(error.to_string()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, browser, profile, domain);
        unreachable!("unsupported platforms return before platform dispatch")
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
pub async fn browser_cookie_clear_all(app: tauri::AppHandle) -> Result<CookieClearAllResult, String> {
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
        assert!(cookie_belongs_to_site(".Accounts.Example.com", "example.com"));
        assert!(!cookie_belongs_to_site("notexample.com", "example.com"));
        assert!(!cookie_belongs_to_site("example.com.evil.io", "example.com"));
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
    fn imported_cookie_debug_redacts_the_value() {
        let cookie = ImportedCookie {
            host_key: ".example.com".into(),
            name: "session".into(),
            value: "top-secret".into(),
            path: "/".into(),
            expires_unix: None,
            is_secure: true,
            is_httponly: true,
            same_site: SameSite::Lax,
        };

        let debug = format!("{cookie:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains("top-secret"));
    }

    #[test]
    fn browser_keychain_metadata_matches_chromium_variants() {
        assert_eq!(
            ChromiumBrowser::Chrome.safe_storage_service(),
            "Chrome Safe Storage"
        );
        assert_eq!(ChromiumBrowser::Edge.keychain_account(), "Microsoft Edge");
        assert_eq!(
            ChromiumBrowser::Brave.safe_storage_service(),
            "Brave Safe Storage"
        );
        assert_eq!(ChromiumBrowser::Chromium.keychain_account(), "Chromium");
    }

    #[test]
    fn non_macos_is_typed_unsupported() {
        let availability = availability_for("windows", ChromiumBrowser::Chrome, None);
        assert_eq!(
            availability,
            CookieImportAvailability {
                supported: false,
                profiles: Vec::new(),
                reason: Some("macos_only".into()),
            }
        );
        assert_eq!(
            unsupported_result_for("windows"),
            Some(CookieImportResult::Unsupported {
                reason: "macos_only".into(),
            })
        );
        assert_eq!(unsupported_result_for("macos"), None);
    }

    #[test]
    fn discovers_only_profiles_with_cookie_databases_in_sorted_order() {
        let home = tempfile::tempdir().unwrap();
        let root = ChromiumBrowser::Chrome.profiles_root_at(home.path());
        for profile in ["Profile 2", "Default", "Empty"] {
            std::fs::create_dir_all(root.join(profile).join("Network")).unwrap();
        }
        std::fs::write(root.join("Profile 2/Network/Cookies"), []).unwrap();
        std::fs::write(root.join("Default/Cookies"), []).unwrap();
        std::fs::write(root.join("not-a-profile"), []).unwrap();

        assert_eq!(
            availability_for("macos", ChromiumBrowser::Chrome, Some(home.path())),
            CookieImportAvailability {
                supported: true,
                profiles: vec!["Default".into(), "Profile 2".into()],
                reason: None,
            }
        );
    }

    #[test]
    fn reports_no_profiles_when_home_or_cookie_databases_are_missing() {
        let expected = CookieImportAvailability {
            supported: true,
            profiles: Vec::new(),
            reason: Some("no_profiles".into()),
        };
        assert_eq!(
            availability_for("macos", ChromiumBrowser::Chrome, None),
            expected
        );
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            availability_for("macos", ChromiumBrowser::Chrome, Some(home.path())),
            expected
        );
    }

    #[test]
    fn rejects_profile_path_traversal() {
        let root = Path::new("/profiles");
        assert_eq!(profile_path(root, "Default"), Some(root.join("Default")));
        assert_eq!(profile_path(root, "../Default"), None);
        assert_eq!(profile_path(root, "Profile 1/Cookies"), None);
        assert_eq!(profile_path(root, "/absolute"), None);
    }
}
