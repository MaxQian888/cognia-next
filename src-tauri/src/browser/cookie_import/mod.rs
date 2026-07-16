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

#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
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

#[cfg(test)]
mod tests {
    use super::*;

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
