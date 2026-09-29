//! Importing sign-ins from the browsers installed on this machine
//! (ADR-0073, amended by ADR-0201; crate split in ADR-0196 P6g).
//!
//! - [`browsers`] names every supported browser and finds its profiles on
//!   macOS, Windows and Linux.
//! - [`crypto`] resolves a Chromium profile's value key (macOS Keychain,
//!   Windows DPAPI, Linux Secret Service, behind [`crypto::OsSecrets`]) and
//!   decrypts `v10`/`v11` values; `v20` App-Bound values are never decrypted,
//!   only counted.
//! - [`chromium`], [`firefox`] and [`safari`] read each engine's cookie store;
//!   [`scope`] decides which cookies an import admits; [`import`] ties them
//!   together for the desktop's commands.
//! - [`passwords`] imports saved passwords (Chromium `Login Data`, Firefox
//!   `logins.json` + `key4.db`, password-manager CSV exports) into the
//!   Rust-only [`passwords::vault`], which keeps every value in the
//!   `cognia-secrets` encrypted store.
//!
//! Where cookies go is the host's business: it takes an
//! [`import::CookieBatch`] and hands it to a [`CookieSink`] (the desktop's
//! embedded webview) or the local Chromium runtime, from
//! `src-tauri/src/browser/cookie_import`. Values never leave Rust except
//! into the target cookie store.

use std::fmt;

use thiserror::Error;

pub mod browsers;
pub mod chromium;
pub mod crypto;
pub mod firefox;
pub mod import;
pub mod passwords;
pub mod safari;
pub mod scope;
pub mod secret;
pub mod system;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SameSite {
    Unspecified,
    None,
    Lax,
    Strict,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ImportedCookie {
    pub host_key: String,
    pub name: String,
    pub value: String,
    pub path: String,
    pub expires_unix: Option<i64>,
    pub is_secure: bool,
    pub is_httponly: bool,
    pub same_site: SameSite,
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

impl Drop for ImportedCookie {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.value);
    }
}

/// The macOS Keychain generic-password read the host performs for a
/// Chromium browser's Safe Storage passphrase.
pub trait Keychain {
    fn read(&self, service: &str, account: &str) -> Result<String, ImportError>;
}

/// A destination for collected cookies. Returns the cookies it accepted.
pub trait CookieSink {
    fn inject(&self, cookies: &[ImportedCookie]) -> Result<Vec<ImportedCookie>, ImportError>;
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ImportError {
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
    /// The browser or profile is not on this machine, or the profile holds no
    /// data of the requested kind.
    #[error("no_profile")]
    NoProfile,
    /// macOS refuses to open Safari's store without Full Disk Access.
    #[error("full_disk_access_required")]
    FullDiskAccessRequired,
    /// The browser does not exist on this operating system.
    #[error("unsupported_os")]
    UnsupportedOs,
    /// The running browser holds an exclusive lock on its database (Windows).
    #[error("browser_running")]
    DatabaseLocked,
    /// Firefox's key database is protected by a primary password.
    #[error("primary_password_set")]
    PrimaryPasswordSet,
    /// A file (CSV export, `logins.json`, `key4.db`) is not in the expected
    /// format.
    #[error("invalid_format")]
    InvalidFormat,
    /// The encrypted secret store refused a read or write.
    #[error("secret_store_unavailable")]
    SecretStore,
    /// No vault credential has the requested id.
    #[error("credential_not_found")]
    CredentialNotFound,
    /// Another vault credential already has this origin, realm and username.
    #[error("credential_exists")]
    CredentialExists,
}

impl ImportError {
    /// Stable machine-readable code for IPC error strings.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Database => "database_unreadable",
            Self::Decryption => "decryption_failed",
            Self::InvalidDomain => "invalid_domain",
            Self::Injection => "injection_failed",
            Self::PermissionDenied => "permission_denied",
            Self::NoProfile => "no_profile",
            Self::FullDiskAccessRequired => "full_disk_access_required",
            Self::UnsupportedOs => "unsupported_os",
            Self::DatabaseLocked => "browser_running",
            Self::PrimaryPasswordSet => "primary_password_set",
            Self::InvalidFormat => "invalid_format",
            Self::SecretStore => "secret_store_unavailable",
            Self::CredentialNotFound => "credential_not_found",
            Self::CredentialExists => "credential_exists",
        }
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
    fn error_codes_are_stable_and_distinct() {
        let all = [
            ImportError::Database,
            ImportError::Decryption,
            ImportError::InvalidDomain,
            ImportError::Injection,
            ImportError::PermissionDenied,
            ImportError::NoProfile,
            ImportError::FullDiskAccessRequired,
            ImportError::UnsupportedOs,
            ImportError::DatabaseLocked,
            ImportError::PrimaryPasswordSet,
            ImportError::InvalidFormat,
            ImportError::SecretStore,
            ImportError::CredentialNotFound,
            ImportError::CredentialExists,
        ];
        let codes = all
            .iter()
            .map(ImportError::code)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(codes.len(), all.len());
        assert_eq!(
            ImportError::PrimaryPasswordSet.code(),
            "primary_password_set"
        );
        assert_eq!(
            ImportError::FullDiskAccessRequired.code(),
            "full_disk_access_required"
        );
    }
}
