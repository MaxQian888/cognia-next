//! Importing a site's cookies from a local Chromium profile (ADR-0196 P6g).
//!
//! [`chromium`] finds a profile's cookie database, copies it aside, decrypts
//! the values with the browser's Safe Storage passphrase and keeps the ones
//! that belong to the target site. Where the passphrase comes from and where
//! the cookies go are the host's business, behind [`Keychain`] and
//! [`CookieSink`]: the desktop reads the macOS keychain and injects into its
//! embedded WebKit view, both in `src-tauri/src/browser/cookie_import`.

use std::fmt;

use thiserror::Error;

pub mod chromium;

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

pub trait Keychain {
    fn read(&self, service: &str, account: &str) -> Result<String, ImportError>;
}

pub trait CookieSink {
    fn inject(&self, cookies: &[ImportedCookie]) -> Result<Vec<ImportedCookie>, ImportError>;
}

#[derive(Debug, Error)]
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
}
