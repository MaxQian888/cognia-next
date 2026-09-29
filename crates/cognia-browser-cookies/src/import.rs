//! The v2 cookie import (ADR-0201): which browsers and profiles exist, which
//! domains a profile holds (without decrypting anything), and collecting the
//! cookies of a scope for the host to inject.

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

use serde::Serialize;

use crate::browsers::{
    chromium_profiles, chromium_user_data_dir, resolve_chromium_profile, Browser, BrowserKind,
    HostDirs, Os, ProfileData, ProfileInfo, ALL_BROWSERS,
};
use crate::chromium::{find_cookie_database, snapshot_database};
use crate::crypto::{resolve_chromium_key, OsSecrets};
use crate::firefox::{firefox_profiles, firefox_roots, resolve_firefox_profile};
use crate::safari::SAFARI_PROFILE_ID;
use crate::scope::{site_of_host, CookieScope, ScopeFilter};
use crate::{chromium, firefox, safari, ImportError, ImportedCookie};

/// Cookies collected for injection, plus how many `v20` App-Bound rows the
/// scope matched but could not be read.
#[derive(Default)]
pub struct CookieBatch {
    pub cookies: Vec<ImportedCookie>,
    pub skipped_app_bound: usize,
}

impl fmt::Debug for CookieBatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CookieBatch")
            .field("cookies", &self.cookies.len())
            .field("skipped_app_bound", &self.skipped_app_bound)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub browser: Browser,
    pub label: String,
    pub kind: BrowserKind,
    pub profiles: Vec<ProfileInfo>,
    pub supported: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DomainCount {
    pub domain: String,
    pub count: u32,
}

fn unavailable(browser: Browser, reason: &str) -> SourceInfo {
    SourceInfo {
        browser,
        label: browser.label().into(),
        kind: browser.kind(),
        profiles: Vec::new(),
        supported: false,
        reason: Some(reason.into()),
    }
}

fn available(browser: Browser, profiles: Vec<ProfileInfo>) -> SourceInfo {
    SourceInfo {
        browser,
        label: browser.label().into(),
        kind: browser.kind(),
        profiles,
        supported: true,
        reason: None,
    }
}

fn source_for(browser: Browser, os: Os, dirs: &HostDirs, data: ProfileData) -> SourceInfo {
    if !browser.exists_on(os) {
        return unavailable(browser, "unsupported_os");
    }
    match browser.kind() {
        BrowserKind::Chromium => match chromium_user_data_dir(browser, os, dirs) {
            Some(root) => available(browser, chromium_profiles(&root, data)),
            None => unavailable(browser, "not_installed"),
        },
        BrowserKind::Firefox => {
            if !firefox_roots(os, dirs).iter().any(|root| root.is_dir()) {
                return unavailable(browser, "not_installed");
            }
            available(browser, firefox_profiles(os, dirs, data))
        }
        BrowserKind::Safari => match safari::probe(os, dirs) {
            Ok(_) => available(
                browser,
                vec![ProfileInfo {
                    id: SAFARI_PROFILE_ID.into(),
                    name: browser.label().into(),
                }],
            ),
            Err(ImportError::FullDiskAccessRequired) => {
                unavailable(browser, "full_disk_access_required")
            }
            Err(_) => unavailable(browser, "not_installed"),
        },
    }
}

/// Every browser cookies can be imported from, in a fixed order.
pub fn cookie_sources(os: Os, dirs: &HostDirs) -> Vec<SourceInfo> {
    ALL_BROWSERS
        .into_iter()
        .map(|browser| source_for(browser, os, dirs, ProfileData::Cookies))
        .collect()
}

/// Every browser saved passwords can be imported from (Chromium browsers and
/// Firefox; Safari's passwords are exported through CSV).
pub fn password_sources(os: Os, dirs: &HostDirs) -> Vec<SourceInfo> {
    ALL_BROWSERS
        .into_iter()
        .filter(|browser| browser.kind() != BrowserKind::Safari)
        .map(|browser| source_for(browser, os, dirs, ProfileData::Passwords))
        .collect()
}

pub(crate) enum ResolvedProfile {
    Chromium {
        user_data_dir: PathBuf,
        profile_dir: PathBuf,
    },
    Firefox {
        profile_dir: PathBuf,
    },
    Safari,
}

pub(crate) fn resolve_profile(
    browser: Browser,
    profile: &str,
    os: Os,
    dirs: &HostDirs,
    data: ProfileData,
) -> Result<ResolvedProfile, ImportError> {
    if !browser.exists_on(os) {
        return Err(ImportError::UnsupportedOs);
    }
    match browser.kind() {
        BrowserKind::Chromium => {
            let user_data_dir =
                chromium_user_data_dir(browser, os, dirs).ok_or(ImportError::NoProfile)?;
            let profile_dir = resolve_chromium_profile(&user_data_dir, profile, data)
                .ok_or(ImportError::NoProfile)?;
            Ok(ResolvedProfile::Chromium {
                user_data_dir,
                profile_dir,
            })
        }
        BrowserKind::Firefox => resolve_firefox_profile(os, dirs, profile, data)
            .map(|profile_dir| ResolvedProfile::Firefox { profile_dir })
            .ok_or(ImportError::NoProfile),
        BrowserKind::Safari => {
            if data == ProfileData::Passwords || profile != SAFARI_PROFILE_ID {
                return Err(ImportError::NoProfile);
            }
            Ok(ResolvedProfile::Safari)
        }
    }
}

fn aggregate(counts: BTreeMap<String, u32>) -> Vec<DomainCount> {
    let mut by_site = BTreeMap::<String, u32>::new();
    for (host, count) in counts {
        let site = site_of_host(&host);
        if site.is_empty() {
            continue;
        }
        *by_site.entry(site).or_insert(0) += count;
    }
    let mut domains = by_site
        .into_iter()
        .map(|(domain, count)| DomainCount { domain, count })
        .collect::<Vec<_>>();
    domains.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.domain.cmp(&b.domain)));
    domains
}

/// A profile's sites (registrable domains) and cookie counts. No value is
/// read or decrypted, and no OS secret is requested.
pub fn cookie_domains(
    browser: Browser,
    profile: &str,
    os: Os,
    dirs: &HostDirs,
) -> Result<Vec<DomainCount>, ImportError> {
    let counts = match resolve_profile(browser, profile, os, dirs, ProfileData::Cookies)? {
        ResolvedProfile::Chromium { profile_dir, .. } => {
            let source = find_cookie_database(&profile_dir).ok_or(ImportError::NoProfile)?;
            let snapshot = snapshot_database(&source)?;
            chromium::cookie_host_counts(&snapshot.path)?
        }
        ResolvedProfile::Firefox { profile_dir } => {
            let snapshot = snapshot_database(&profile_dir.join("cookies.sqlite"))?;
            firefox::cookie_host_counts(&snapshot.path)?
        }
        ResolvedProfile::Safari => safari::cookie_host_counts(os, dirs)?,
    };
    Ok(aggregate(counts))
}

/// Read and decrypt the cookies of `scope` from one profile.
pub fn collect_cookies(
    browser: Browser,
    profile: &str,
    scope: &CookieScope,
    os: Os,
    dirs: &HostDirs,
    secrets: &dyn OsSecrets,
) -> Result<CookieBatch, ImportError> {
    let filter = ScopeFilter::new(scope)?;
    match resolve_profile(browser, profile, os, dirs, ProfileData::Cookies)? {
        ResolvedProfile::Chromium {
            user_data_dir,
            profile_dir,
        } => {
            let source = find_cookie_database(&profile_dir).ok_or(ImportError::NoProfile)?;
            let snapshot = snapshot_database(&source)?;
            let key = resolve_chromium_key(browser, os, &user_data_dir, secrets)?;
            chromium::read_cookie_database(&snapshot.path, &filter, key.as_ref())
        }
        ResolvedProfile::Firefox { profile_dir } => {
            let snapshot = snapshot_database(&profile_dir.join("cookies.sqlite"))?;
            firefox::read_cookie_database(&snapshot.path, &filter)
        }
        ResolvedProfile::Safari => safari::read_cookies(os, dirs, &filter),
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::chromium::test_support::{encrypt_cookie, insert, SCHEMA};
    use crate::crypto::test_support::{write_windows_local_state, FakeSecrets};
    use crate::crypto::ChromiumKey;
    use crate::safari::test_support::{file, page, FixtureCookie};

    fn chromium_profile(
        root: &std::path::Path,
        id: &str,
        key: &ChromiumKey,
        rows: &[(&str, &str, &[u8])],
    ) {
        let profile = root.join(id);
        std::fs::create_dir_all(profile.join("Network")).unwrap();
        let conn = Connection::open(profile.join("Network/Cookies")).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for (host, name, prefix) in rows {
            insert(
                &conn,
                host,
                name,
                &encrypt_cookie(key, prefix, host, &format!("{name}-value")),
                "",
            );
        }
    }

    #[test]
    fn lists_every_browser_with_typed_reasons() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::Linux);
        let key = ChromiumKey::linux(None);
        chromium_profile(
            &home.path().join(".config/google-chrome"),
            "Default",
            &key,
            &[],
        );
        std::fs::create_dir_all(home.path().join(".mozilla/firefox")).unwrap();

        let sources = cookie_sources(Os::Linux, &dirs);
        assert_eq!(sources.len(), ALL_BROWSERS.len());
        let by = |browser: Browser| {
            sources
                .iter()
                .find(|source| source.browser == browser)
                .unwrap()
        };
        assert!(by(Browser::Chrome).supported);
        assert_eq!(by(Browser::Chrome).profiles[0].id, "Default");
        assert_eq!(by(Browser::Edge).reason.as_deref(), Some("not_installed"));
        assert_eq!(
            by(Browser::Safari).reason.as_deref(),
            Some("unsupported_os")
        );
        assert_eq!(by(Browser::Arc).reason.as_deref(), Some("unsupported_os"));
        assert!(by(Browser::Firefox).supported);
        assert!(by(Browser::Firefox).profiles.is_empty());

        let json = serde_json::to_value(by(Browser::Chrome)).unwrap();
        assert_eq!(json["browser"], "chrome");
        assert_eq!(json["kind"], "chromium");
        assert_eq!(json["label"], "Google Chrome");

        let passwords = password_sources(Os::Linux, &dirs);
        assert!(passwords
            .iter()
            .all(|source| source.browser != Browser::Safari));
        assert!(passwords
            .iter()
            .find(|source| source.browser == Browser::Chrome)
            .unwrap()
            .profiles
            .is_empty());
    }

    #[test]
    fn safari_sources_report_access_and_install_state() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::MacOs);
        let safari_source = |sources: Vec<SourceInfo>| {
            sources
                .into_iter()
                .find(|source| source.browser == Browser::Safari)
                .unwrap()
        };
        assert_eq!(
            safari_source(cookie_sources(Os::MacOs, &dirs))
                .reason
                .as_deref(),
            Some("not_installed")
        );
        let store = home
            .path()
            .join("Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies");
        std::fs::create_dir_all(store.parent().unwrap()).unwrap();
        std::fs::write(
            &store,
            file(&[page(&[FixtureCookie {
                domain: ".apple.com",
                name: "a",
                path: "/",
                value: "v",
                flags: 0,
                expiry_mac: 0.0,
            }])]),
        )
        .unwrap();
        let source = safari_source(cookie_sources(Os::MacOs, &dirs));
        assert!(source.supported);
        assert_eq!(source.profiles[0].id, "default");
        assert_eq!(
            cookie_domains(Browser::Safari, "default", Os::MacOs, &dirs).unwrap(),
            vec![DomainCount {
                domain: "apple.com".into(),
                count: 1
            }]
        );
        let batch = collect_cookies(
            Browser::Safari,
            "default",
            &CookieScope::All,
            Os::MacOs,
            &dirs,
            &FakeSecrets::default(),
        )
        .unwrap();
        assert_eq!(batch.cookies.len(), 1);
        assert_eq!(
            collect_cookies(
                Browser::Safari,
                "other",
                &CookieScope::All,
                Os::MacOs,
                &dirs,
                &FakeSecrets::default()
            )
            .map(|batch| batch.cookies.len()),
            Err(ImportError::NoProfile)
        );
    }

    #[test]
    fn domains_are_grouped_by_site_and_sorted_by_count() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::Windows);
        let root = home.path().join("AppData/Local/Microsoft/Edge/User Data");
        let key = ChromiumKey::Gcm([1; 32]);
        chromium_profile(
            &root,
            "Profile 1",
            &key,
            &[
                (".github.com", "a", b"v10"),
                ("api.github.com", "b", b"v20"),
                ("x.org", "c", b"v10"),
                ("localhost", "d", b"v10"),
            ],
        );
        let secrets = FakeSecrets::default();
        let domains = cookie_domains(Browser::Edge, "Profile 1", Os::Windows, &dirs).unwrap();
        assert_eq!(
            domains,
            vec![
                DomainCount {
                    domain: "github.com".into(),
                    count: 2
                },
                DomainCount {
                    domain: "localhost".into(),
                    count: 1
                },
                DomainCount {
                    domain: "x.org".into(),
                    count: 1
                },
            ]
        );
        // Listing never asks the OS for a key.
        assert!(secrets.calls.borrow().is_empty());
    }

    #[test]
    fn collects_windows_cookies_counting_app_bound_rows() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::Windows);
        let root = home.path().join("AppData/Local/Google/Chrome/User Data");
        let key_bytes = [2_u8; 32];
        let key = ChromiumKey::Gcm(key_bytes);
        chromium_profile(
            &root,
            "Default",
            &key,
            &[
                (".github.com", "a", b"v10"),
                (".github.com", "b", b"v20"),
                ("x.org", "c", b"v10"),
            ],
        );
        write_windows_local_state(&root, &key_bytes);
        let secrets = FakeSecrets::default();
        let batch = collect_cookies(
            Browser::Chrome,
            "Default",
            &CookieScope::Domains {
                domains: vec!["github.com".into()],
            },
            Os::Windows,
            &dirs,
            &secrets,
        )
        .unwrap();
        assert_eq!(batch.cookies.len(), 1);
        assert_eq!(batch.cookies[0].value, "a-value");
        assert_eq!(batch.skipped_app_bound, 1);
        assert_eq!(secrets.calls.borrow().as_slice(), ["dpapi"]);
        assert_eq!(
            format!("{batch:?}"),
            "CookieBatch { cookies: 1, skipped_app_bound: 1 }"
        );
    }

    #[test]
    fn collects_macos_arc_cookies_through_the_keychain() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::MacOs);
        let root = home
            .path()
            .join("Library/Application Support/Arc/User Data");
        let key = ChromiumKey::macos("arc-pass");
        chromium_profile(&root, "Default", &key, &[(".github.com", "s", b"v10")]);
        let secrets = FakeSecrets {
            keychain: Some(Ok("arc-pass".into())),
            ..Default::default()
        };
        let batch = collect_cookies(
            Browser::Arc,
            "Default",
            &CookieScope::Site {
                domain: "www.github.com".into(),
            },
            Os::MacOs,
            &dirs,
            &secrets,
        )
        .unwrap();
        assert_eq!(batch.cookies.len(), 1);
        assert_eq!(
            secrets.calls.borrow().as_slice(),
            ["keychain:Arc Safe Storage:Arc"]
        );
        let denied = FakeSecrets::default();
        assert_eq!(
            collect_cookies(
                Browser::Arc,
                "Default",
                &CookieScope::All,
                Os::MacOs,
                &dirs,
                &denied
            )
            .map(|batch| batch.cookies.len()),
            Err(ImportError::PermissionDenied)
        );
    }

    #[test]
    fn collects_firefox_cookies_without_os_secrets() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::MacOs);
        let root = home.path().join("Library/Application Support/Firefox");
        let relative = crate::firefox::test_support::write_root(&root, &home.path().join("abs"));
        crate::firefox::test_support::write_cookie_db(
            &relative,
            &[(".example.com", "n", "v", 0, "")],
        );
        let secrets = FakeSecrets::default();
        let batch = collect_cookies(
            Browser::Firefox,
            "Profiles/abc.default-release",
            &CookieScope::All,
            Os::MacOs,
            &dirs,
            &secrets,
        )
        .unwrap();
        assert_eq!(batch.cookies.len(), 1);
        assert!(secrets.calls.borrow().is_empty());
        assert_eq!(
            cookie_domains(
                Browser::Firefox,
                "Profiles/abc.default-release",
                Os::MacOs,
                &dirs
            )
            .unwrap()[0]
                .domain,
            "example.com"
        );
    }

    #[test]
    fn unknown_profiles_and_foreign_oses_are_typed() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::Linux);
        let secrets = FakeSecrets::default();
        assert_eq!(
            collect_cookies(
                Browser::Chrome,
                "Default",
                &CookieScope::All,
                Os::Linux,
                &dirs,
                &secrets
            )
            .map(|batch| batch.cookies.len()),
            Err(ImportError::NoProfile)
        );
        assert_eq!(
            cookie_domains(Browser::Safari, "default", Os::Linux, &dirs),
            Err(ImportError::UnsupportedOs)
        );
        assert_eq!(
            collect_cookies(
                Browser::Chrome,
                "Default",
                &CookieScope::Domains { domains: vec![] },
                Os::Linux,
                &dirs,
                &secrets
            )
            .map(|batch| batch.cookies.len()),
            Err(ImportError::InvalidDomain)
        );
    }
}
