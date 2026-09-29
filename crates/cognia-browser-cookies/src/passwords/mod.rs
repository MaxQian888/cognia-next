//! Saved-password import and the Rust-only password vault (ADR-0201).
//!
//! - [`chromium`]: `Login Data` / `Login Data For Account`, decrypted with the
//!   same per-OS key as cookies; `v20` rows are counted, never decrypted.
//! - [`firefox`] + [`nss`]: `logins.json` decrypted with the key stored in
//!   `key4.db` (NSS PBES2 / legacy 3DES). A primary password is detected and
//!   reported as [`ImportError::PrimaryPasswordSet`]; Cognia never asks for it.
//! - [`csv`]: exports from Chrome/Edge/Brave, Safari, Firefox, 1Password,
//!   Bitwarden, LastPass, or a generic `url,username,password` file.
//! - [`vault`]: where imported and saved passwords live — the encrypted
//!   `cognia-secrets` store, one entry per password plus one metadata entry.

use crate::browsers::{Browser, HostDirs, Os, ProfileData};
use crate::crypto::{resolve_chromium_key, OsSecrets};
use crate::import::{resolve_profile, ResolvedProfile};
use crate::secret::SecretString;
use crate::ImportError;

pub mod chromium;
pub mod csv;
pub mod firefox;
pub mod nss;
pub mod vault;

/// One credential read from a browser or an export, on its way into the
/// vault. `password` never appears in `Debug`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedCredential {
    /// `scheme://host[:port]`.
    pub origin: String,
    /// An HTTP-auth realm, when the credential is not a form login.
    pub realm: Option<String>,
    pub username: String,
    pub password: SecretString,
    /// Unix milliseconds.
    pub created_at: Option<i64>,
    pub last_used_at: Option<i64>,
    pub note: Option<String>,
}

#[derive(Debug, Default)]
pub struct CredentialBatch {
    pub credentials: Vec<ImportedCredential>,
    /// Rows that were not credentials Cognia can fill: blocklisted
    /// ("never save") entries, non-web origins, empty or undecryptable
    /// passwords.
    pub skipped: usize,
    /// Windows `v20` App-Bound rows.
    pub skipped_app_bound: usize,
    /// Machine-readable codes of per-file problems that did not stop the
    /// import.
    pub errors: Vec<String>,
}

/// The origin (`scheme://host[:port]`) of an http(s) URL. A bare host is read
/// as `https://`. Anything else (android://, chrome://, file://) is `None`.
pub fn normalize_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(trimmed)
        .ok()
        .filter(|url| url.has_host())
        .or_else(|| {
            (!trimmed.contains("://"))
                .then(|| url::Url::parse(&format!("https://{trimmed}")).ok())
                .flatten()
        })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none_or(str::is_empty) {
        return None;
    }
    let origin = parsed.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

/// Import every saved password of one Chromium or Firefox profile.
pub fn import_browser_passwords(
    browser: Browser,
    profile: &str,
    os: Os,
    dirs: &HostDirs,
    secrets: &dyn OsSecrets,
) -> Result<CredentialBatch, ImportError> {
    match resolve_profile(browser, profile, os, dirs, ProfileData::Passwords)? {
        ResolvedProfile::Chromium {
            user_data_dir,
            profile_dir,
        } => {
            let databases = crate::browsers::chromium_login_databases(&profile_dir);
            if databases.is_empty() {
                return Err(ImportError::NoProfile);
            }
            let key = resolve_chromium_key(browser, os, &user_data_dir, secrets)?;
            chromium::read_login_databases(&databases, key.as_ref())
        }
        ResolvedProfile::Firefox { profile_dir } => firefox::read_profile(&profile_dir),
        ResolvedProfile::Safari => Err(ImportError::NoProfile),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_origins() {
        assert_eq!(
            normalize_origin("https://accounts.google.com/signin?x=1").as_deref(),
            Some("https://accounts.google.com")
        );
        assert_eq!(
            normalize_origin("http://localhost:3000/login").as_deref(),
            Some("http://localhost:3000")
        );
        assert_eq!(
            normalize_origin("github.com").as_deref(),
            Some("https://github.com")
        );
        assert_eq!(
            normalize_origin("HTTPS://GitHub.com:443/").as_deref(),
            Some("https://github.com")
        );
        for bad in [
            "",
            "  ",
            "android://hash@com.example/",
            "chrome://settings",
            "file:///etc",
            "http://sn",
        ] {
            if bad == "http://sn" {
                // A bare single-label host is still an origin; LastPass's
                // secure-note marker is filtered by the CSV reader.
                assert_eq!(normalize_origin(bad).as_deref(), Some("http://sn"));
                continue;
            }
            assert_eq!(normalize_origin(bad), None, "{bad}");
        }
    }

    #[test]
    fn debug_of_an_imported_credential_redacts_the_password() {
        let credential = ImportedCredential {
            origin: "https://a.com".into(),
            realm: None,
            username: "me".into(),
            password: "hunter2".into(),
            created_at: None,
            last_used_at: None,
            note: None,
        };
        let debug = format!("{credential:?}");
        assert!(!debug.contains("hunter2"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn safari_and_missing_profiles_are_not_password_sources() {
        let home = tempfile::tempdir().unwrap();
        let dirs = HostDirs::from_home(home.path(), Os::MacOs);
        let secrets = crate::crypto::test_support::FakeSecrets::default();
        assert_eq!(
            import_browser_passwords(Browser::Safari, "default", Os::MacOs, &dirs, &secrets)
                .map(|b| b.skipped),
            Err(ImportError::NoProfile)
        );
        assert_eq!(
            import_browser_passwords(Browser::Chrome, "Default", Os::MacOs, &dirs, &secrets)
                .map(|b| b.skipped),
            Err(ImportError::NoProfile)
        );
    }
}
