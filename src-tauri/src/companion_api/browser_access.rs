//! Browser-access configuration for the desktop Companion server.
//!
//! # Why this exists
//!
//! A paired *mobile* client trusts the desktop by pinning the SHA-256 of its
//! self-signed certificate's SubjectPublicKeyInfo — pinning it does at the
//! native layer, outside any TLS trust store. A *browser* cannot do that: it
//! validates against the system roots and refuses a self-signed peer outright,
//! with no JavaScript escape hatch. So the HTTPS listener on
//! `https://<host>:27890`, which every mobile pairing uses, is unreachable
//! from a browser tab unless the user manually clicks through a certificate
//! interstitial — and re-does it whenever the cert rotates.
//!
//! The way out is the one origin a browser trusts without a certificate:
//! **loopback**. `http://127.0.0.1` is "potentially trustworthy" per the
//! Secure Contexts spec, so it is exempt from mixed-content blocking and needs
//! no chain at all. This module configures a second, *plaintext, loopback-only*
//! listener for exactly that case.
//!
//! # Why it is off by default
//!
//! The plaintext listener carries the same device plane as the HTTPS one, and
//! plaintext on loopback is readable by any other process on the machine that
//! can bind or sniff loopback. Every request still needs a DPoP-bound device
//! access token, so this widens *exposure*, not *authority* — but it is a real
//! widening, and an install that never opens the web client should not pay it.
//! It stays off until the user turns it on in Settings → Companion.
//!
//! The allowed origins are the same list the CORS policy enforces, so enabling
//! browser access and naming the browser that may use it is one decision, not
//! two that can drift.
//!
//! Config file: `<data_dir>/cognia/browser-access.json`

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const CONFIG_FILE: &str = "browser-access.json";
const CONFIG_SUBDIR: &str = "cognia";

/// Loopback port for the plaintext browser listener.
///
/// One above the HTTPS `DEFAULT_PORT` (27890) and, like it, outside the 789x
/// range a local Clash/mixed proxy claims.
pub const DEFAULT_BROWSER_PORT: u16 = 27891;

/// Origins offered as the starting point in Settings — the ports `pnpm dev`
/// and `pnpm start` serve the web client on. Never applied implicitly: an
/// origin only takes effect once it is in the saved config.
pub const SUGGESTED_ORIGINS: [&str; 2] = ["http://localhost:3000", "http://127.0.0.1:3000"];

/// On-disk shape. Absent file == the default, which is "off".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAccessConfig {
    /// Whether to bind the plaintext loopback listener at all.
    pub enabled: bool,
    /// Exact browser origins allowed to reach this Host (scheme + host + port).
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    /// Loopback port for the plaintext listener.
    #[serde(default = "default_browser_port")]
    pub port: u16,
}

fn default_browser_port() -> u16 {
    DEFAULT_BROWSER_PORT
}

impl Default for BrowserAccessConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            allowed_origins: Vec::new(),
            port: DEFAULT_BROWSER_PORT,
        }
    }
}

impl BrowserAccessConfig {
    /// Reject anything that cannot be an exact browser origin.
    ///
    /// Normalizes the trailing slash, drops duplicates, and holds every entry
    /// to the same transport rule as `web_origin`: HTTPS anywhere, HTTP only on
    /// loopback. An origin that survives here is one the CORS layer will echo
    /// verbatim, so a wildcard, a path, or credentials in the URL must never
    /// get this far.
    pub fn sanitized(mut self) -> Result<Self, String> {
        let mut seen = Vec::new();
        for raw in self.allowed_origins.drain(..) {
            let normalized = normalize_origin(&raw)
                .ok_or_else(|| format!("`{raw}` is not an exact http(s) browser origin"))?;
            if !seen.contains(&normalized) {
                seen.push(normalized);
            }
        }
        self.allowed_origins = seen;
        if self.port == 0 {
            self.port = DEFAULT_BROWSER_PORT;
        }
        if self.enabled && self.allowed_origins.is_empty() {
            return Err("at least one browser origin is required to enable browser access".into());
        }
        Ok(self)
    }

    /// Whether the plaintext listener should be bound.
    pub fn listener_enabled(&self) -> bool {
        self.enabled && !self.allowed_origins.is_empty()
    }

    /// The origin a "pair in browser" link should target.
    ///
    /// The first configured origin. There is no cleverness to add: the list is
    /// ordered by the user, and a Host with several allowed browsers has no way
    /// to know which one is in front of them right now.
    pub fn primary_origin(&self) -> Option<&str> {
        self.allowed_origins.first().map(String::as_str)
    }
}

/// Normalize one origin, or `None` when it cannot be one.
pub fn normalize_origin(raw: &str) -> Option<String> {
    let value = raw.trim().trim_end_matches('/');
    if value.is_empty() {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if !super::web_origin::is_secure_or_loopback(&url)
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(value.to_string())
}

fn config_path(data_dir: Option<&Path>) -> PathBuf {
    match data_dir {
        Some(dir) => dir.join(CONFIG_SUBDIR).join(CONFIG_FILE),
        None => std::env::temp_dir().join(CONFIG_SUBDIR).join(CONFIG_FILE),
    }
}

/// Read the config. A missing OR unreadable file yields the default.
///
/// Failing closed on a corrupt file is deliberate: the default is "no browser
/// access", so the worst case of an unparseable config is a feature that stays
/// off, never one that silently opens.
pub fn load(data_dir: Option<&Path>) -> BrowserAccessConfig {
    let path = config_path(data_dir);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return BrowserAccessConfig::default();
    };
    serde_json::from_str::<BrowserAccessConfig>(&raw)
        .ok()
        .and_then(|config| config.sanitized().ok())
        .unwrap_or_default()
}

/// Persist the config after validating it.
pub fn save(
    data_dir: Option<&Path>,
    config: BrowserAccessConfig,
) -> Result<BrowserAccessConfig, String> {
    let sanitized = config.sanitized()?;
    let path = config_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(&sanitized).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mut perms) = std::fs::metadata(&path).map(|m| m.permissions()) {
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(&path, perms);
        }
    }
    Ok(sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cognia-browser-access-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn default_is_off_with_no_origins() {
        let config = BrowserAccessConfig::default();
        assert!(!config.enabled);
        assert!(!config.listener_enabled());
        assert_eq!(config.port, DEFAULT_BROWSER_PORT);
        assert_eq!(config.primary_origin(), None);
    }

    #[test]
    fn sanitize_normalizes_and_dedupes() {
        let config = BrowserAccessConfig {
            enabled: true,
            allowed_origins: vec![
                "http://localhost:3000/".into(),
                "http://localhost:3000".into(),
                "https://web.example".into(),
            ],
            port: 0,
        }
        .sanitized()
        .unwrap();
        assert_eq!(
            config.allowed_origins,
            vec!["http://localhost:3000", "https://web.example"]
        );
        assert_eq!(config.port, DEFAULT_BROWSER_PORT);
        assert_eq!(config.primary_origin(), Some("http://localhost:3000"));
    }

    #[test]
    fn sanitize_rejects_anything_that_is_not_an_exact_origin() {
        for bad in [
            "http://web.example",          // plaintext off-loopback
            "https://web.example/path",    // path
            "https://web.example/?a=b",    // query
            "https://user:pw@web.example", // credentials
            "*",
            "not a url",
        ] {
            let result = BrowserAccessConfig {
                enabled: true,
                allowed_origins: vec![bad.into()],
                port: DEFAULT_BROWSER_PORT,
            }
            .sanitized();
            assert!(result.is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn enabling_without_an_origin_is_refused() {
        // An enabled listener with an empty allowlist would bind a plaintext
        // port that answers nothing — all cost, no capability.
        assert!(BrowserAccessConfig {
            enabled: true,
            allowed_origins: Vec::new(),
            port: DEFAULT_BROWSER_PORT,
        }
        .sanitized()
        .is_err());
    }

    #[test]
    fn disabled_config_may_keep_its_origins_for_the_next_enable() {
        let config = BrowserAccessConfig {
            enabled: false,
            allowed_origins: vec!["http://localhost:3000".into()],
            port: DEFAULT_BROWSER_PORT,
        }
        .sanitized()
        .unwrap();
        assert!(!config.listener_enabled());
        assert_eq!(config.primary_origin(), Some("http://localhost:3000"));
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = temp_dir("round-trip");
        let saved = save(
            Some(&dir),
            BrowserAccessConfig {
                enabled: true,
                allowed_origins: vec!["http://127.0.0.1:3000/".into()],
                port: 27891,
            },
        )
        .unwrap();
        assert_eq!(saved.allowed_origins, vec!["http://127.0.0.1:3000"]);
        let loaded = load(Some(&dir));
        assert!(loaded.listener_enabled());
        assert_eq!(loaded.allowed_origins, vec!["http://127.0.0.1:3000"]);
    }

    #[test]
    fn a_corrupt_config_reads_as_off_rather_than_open() {
        let dir = temp_dir("corrupt");
        let path = dir.join(CONFIG_SUBDIR).join(CONFIG_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(!load(Some(&dir)).enabled);

        // Valid JSON that would enable a wildcard must also fail closed.
        std::fs::write(
            &path,
            r#"{"enabled":true,"allowedOrigins":["*"],"port":27891}"#,
        )
        .unwrap();
        assert!(!load(Some(&dir)).enabled);
    }

    #[test]
    fn missing_file_is_the_default() {
        let dir = temp_dir("missing");
        assert!(!load(Some(&dir)).enabled);
    }
}
