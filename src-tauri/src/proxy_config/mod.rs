//! Centralized proxy configuration for outbound HTTP & WebSocket traffic.
//!
//! The frontend writes a config via the `proxy_set` Tauri command (see
//! `commands.rs`), which persists into the `OnceLock<RwLock<ProxyConfig>>`
//! below. Every reqwest builder in the crate consults this module to decide
//! whether to wrap a `Proxy` and what URL to target. WSS connections route
//! through `wsproxy::connect_via_proxy` when the user opts in.
//!
//! Companion of `lib/network/proxy-config.ts` on the TS side. The two
//! representations stay in sync because the frontend is the only writer and
//! pushes whenever it commits a settings change.
pub mod clients;
pub mod commands;
pub mod detect;
pub mod wsproxy;

use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyProtocol {
    Http,
    Https,
    Socks5,
}

impl Default for ProxyProtocol {
    fn default() -> Self {
        Self::Http
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyMode {
    Off,
    Manual,
    Auto,
}

impl Default for ProxyMode {
    fn default() -> Self {
        Self::Off
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    #[serde(default)]
    pub mode: ProxyMode,
    #[serde(default)]
    pub protocol: ProxyProtocol,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub bypass: Vec<String>,
    /// When false, the WSS dialer skips the proxy even when `mode != Off`.
    #[serde(default = "default_proxy_websockets")]
    pub proxy_websockets: bool,
}

fn default_proxy_websockets() -> bool {
    true
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            mode: ProxyMode::Off,
            protocol: ProxyProtocol::Http,
            host: String::new(),
            port: 0,
            username: None,
            password: None,
            bypass: vec![
                "localhost".to_string(),
                "127.0.0.1".to_string(),
                "::1".to_string(),
            ],
            proxy_websockets: true,
        }
    }
}

impl ProxyConfig {
    pub fn is_active(&self) -> bool {
        !matches!(self.mode, ProxyMode::Off) && !self.host.trim().is_empty() && self.port > 0
    }

    /// `http://user:pass@host:port` (or `socks5://...`). Returns `None` when
    /// the config isn't actionable.
    pub fn proxy_url(&self) -> Option<String> {
        if !self.is_active() {
            return None;
        }
        let scheme = match self.protocol {
            ProxyProtocol::Http => "http",
            ProxyProtocol::Https => "https",
            ProxyProtocol::Socks5 => "socks5",
        };
        let auth = match (self.username.as_deref(), self.password.as_deref()) {
            (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => {
                format!("{}:{}@", urlencoding::encode(u), urlencoding::encode(p))
            }
            _ => String::new(),
        };
        Some(format!("{scheme}://{auth}{}:{}", self.host, self.port))
    }

    /// True when the host portion of `target_url` matches a bypass entry.
    /// Mirrors `lib/network/proxy-config.ts:shouldBypass`.
    pub fn should_bypass(&self, target_url: &str) -> bool {
        if self.bypass.is_empty() {
            return false;
        }
        let host = match url::Url::parse(target_url) {
            Ok(u) => u.host_str().unwrap_or("").to_lowercase(),
            Err(_) => return false,
        };
        if host.is_empty() {
            return false;
        }
        self.bypass.iter().any(|raw| {
            let entry = raw.trim().to_lowercase();
            if entry.is_empty() {
                return false;
            }
            if let Some(suffix) = entry.strip_prefix('.') {
                host == suffix || host.ends_with(&entry)
            } else {
                host == entry
            }
        })
    }

    /// Build a `reqwest::Proxy` honouring the bypass list. Returns `None`
    /// when the config is inactive.
    pub fn build_reqwest_proxy(&self) -> Option<reqwest::Proxy> {
        let url = self.proxy_url()?;
        let bypass = self.bypass.clone();
        let proxy = reqwest::Proxy::custom(move |target| {
            let target_str = target.as_str();
            // Reuse `should_bypass` shape inline — the closure captures only
            // bypass + url (proxy_url already encodes auth).
            let host = target.host_str().unwrap_or("").to_lowercase();
            for raw in &bypass {
                let entry = raw.trim().to_lowercase();
                if entry.is_empty() {
                    continue;
                }
                let matches = if let Some(suffix) = entry.strip_prefix('.') {
                    host == suffix || host.ends_with(&entry)
                } else {
                    host == entry
                };
                if matches {
                    return None;
                }
            }
            let _ = target_str; // unused beyond host extraction
            url.parse::<reqwest::Url>().ok()
        });
        Some(proxy)
    }

    /// Env vars suitable for spawning a child process. Mirrors the TS
    /// `proxyEnvVars` helper so the Node sidecar sees the same proxy.
    pub fn env_vars(&self) -> Vec<(String, String)> {
        let Some(url) = self.proxy_url() else {
            return Vec::new();
        };
        let mut out = vec![
            ("HTTP_PROXY".to_string(), url.clone()),
            ("HTTPS_PROXY".to_string(), url.clone()),
            ("http_proxy".to_string(), url.clone()),
            ("https_proxy".to_string(), url.clone()),
        ];
        if !self.bypass.is_empty() {
            let no_proxy = self.bypass.join(",");
            out.push(("NO_PROXY".to_string(), no_proxy.clone()));
            out.push(("no_proxy".to_string(), no_proxy));
        }
        out
    }

    /// Base64-encoded `Proxy-Authorization` header value, or None when no
    /// credentials are configured. Used by the WSS CONNECT tunnel.
    pub fn basic_auth_header(&self) -> Option<String> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        match (self.username.as_deref(), self.password.as_deref()) {
            (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => {
                let credentials = format!("{u}:{p}");
                Some(format!("Basic {}", B64.encode(credentials)))
            }
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Process-wide state — populated by the `proxy_set` command, read by every
// outbound HTTP/WS call site.
// ---------------------------------------------------------------------------

static CURRENT: OnceLock<RwLock<ProxyConfig>> = OnceLock::new();

fn slot() -> &'static RwLock<ProxyConfig> {
    CURRENT.get_or_init(|| RwLock::new(ProxyConfig::default()))
}

/// Snapshot of the live config. Cheap clone — fields are short strings.
pub fn current() -> ProxyConfig {
    slot().read().expect("proxy config lock poisoned").clone()
}

/// Replace the live config. The renderer is the only writer: it calls the
/// `proxy_set` Tauri command after every settings save, and once on startup
/// after it loads the persisted proxy config. There is no Rust-side boot
/// initialization, so the process default stays [`ProxyMode::Off`] until that
/// first renderer push lands.
pub fn set_current(cfg: ProxyConfig) {
    *slot().write().expect("proxy config lock poisoned") = cfg;
}

// `urlencoding` lives in the reqwest dep tree; expose a tiny shim so the
// proxy_url helper above doesn't need its own crate. We use a hand-rolled
// implementation rather than pulling in a fresh dep.
mod urlencoding {
    /// Percent-encode a single value the same way `encodeURIComponent` does.
    pub fn encode(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        for byte in input.bytes() {
            let safe = matches!(
                byte,
                b'A'..=b'Z'
                    | b'a'..=b'z'
                    | b'0'..=b'9'
                    | b'-'
                    | b'_'
                    | b'.'
                    | b'~'
                    | b'!'
                    | b'*'
                    | b'\''
                    | b'('
                    | b')'
            );
            if safe {
                out.push(byte as char);
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manual(host: &str, port: u16) -> ProxyConfig {
        ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: host.to_string(),
            port,
            ..ProxyConfig::default()
        }
    }

    #[test]
    fn default_is_inactive() {
        let cfg = ProxyConfig::default();
        assert!(!cfg.is_active());
        assert_eq!(cfg.proxy_url(), None);
    }

    #[test]
    fn off_mode_overrides_host_and_port() {
        let mut cfg = manual("127.0.0.1", 7890);
        cfg.mode = ProxyMode::Off;
        assert!(!cfg.is_active());
    }

    #[test]
    fn manual_with_host_port_is_active() {
        let cfg = manual("127.0.0.1", 7890);
        assert!(cfg.is_active());
        assert_eq!(cfg.proxy_url(), Some("http://127.0.0.1:7890".to_string()));
    }

    #[test]
    fn proxy_url_includes_auth_when_both_creds_set() {
        let mut cfg = manual("proxy.corp", 8080);
        cfg.username = Some("alice".to_string());
        cfg.password = Some("secret".to_string());
        assert_eq!(
            cfg.proxy_url(),
            Some("http://alice:secret@proxy.corp:8080".to_string())
        );
    }

    #[test]
    fn proxy_url_url_encodes_auth() {
        let mut cfg = manual("proxy.corp", 8080);
        cfg.username = Some("alice@corp".to_string());
        cfg.password = Some("p:w@rd!".to_string());
        let url = cfg.proxy_url().unwrap();
        assert!(url.contains("alice%40corp"));
        assert!(url.contains("p%3Aw%40rd!"));
    }

    #[test]
    fn proxy_url_omits_auth_when_only_one_cred() {
        let mut cfg = manual("proxy.corp", 8080);
        cfg.username = Some("alice".to_string());
        cfg.password = None;
        assert_eq!(cfg.proxy_url(), Some("http://proxy.corp:8080".to_string()));
    }

    #[test]
    fn socks5_protocol_renders_socks_scheme() {
        let mut cfg = manual("127.0.0.1", 7891);
        cfg.protocol = ProxyProtocol::Socks5;
        assert_eq!(cfg.proxy_url(), Some("socks5://127.0.0.1:7891".to_string()));
    }

    #[test]
    fn should_bypass_matches_loopback() {
        let cfg = ProxyConfig::default();
        assert!(cfg.should_bypass("http://127.0.0.1:3000/api"));
        assert!(cfg.should_bypass("http://localhost/foo"));
    }

    #[test]
    fn should_bypass_matches_domain_suffix() {
        let mut cfg = ProxyConfig::default();
        cfg.bypass = vec![".internal".to_string()];
        assert!(cfg.should_bypass("https://api.internal/foo"));
        assert!(cfg.should_bypass("https://internal/foo"));
        assert!(!cfg.should_bypass("https://api.example.com/foo"));
    }

    #[test]
    fn should_bypass_returns_false_for_invalid_url() {
        let cfg = ProxyConfig::default();
        assert!(!cfg.should_bypass("not-a-url"));
    }

    #[test]
    fn env_vars_empty_when_inactive() {
        let cfg = ProxyConfig::default();
        assert!(cfg.env_vars().is_empty());
    }

    #[test]
    fn env_vars_emit_both_casings_and_no_proxy() {
        let cfg = manual("127.0.0.1", 7890);
        let env: std::collections::HashMap<_, _> = cfg.env_vars().into_iter().collect();
        assert_eq!(env.get("HTTP_PROXY").unwrap(), "http://127.0.0.1:7890");
        assert_eq!(env.get("https_proxy").unwrap(), "http://127.0.0.1:7890");
        // Default bypass list is non-empty → NO_PROXY is set.
        assert!(env.get("NO_PROXY").unwrap().contains("127.0.0.1"));
    }

    #[test]
    fn basic_auth_header_only_when_creds_set() {
        let mut cfg = manual("x", 1);
        assert!(cfg.basic_auth_header().is_none());
        cfg.username = Some("alice".to_string());
        cfg.password = Some("secret".to_string());
        // base64("alice:secret") = "YWxpY2U6c2VjcmV0"
        assert_eq!(
            cfg.basic_auth_header().unwrap(),
            "Basic YWxpY2U6c2VjcmV0".to_string()
        );
    }

    #[test]
    fn current_starts_inactive_and_set_replaces_it() {
        // Note: relies on test ordering not mattering — every test reads/writes
        // the same OnceLock. We snapshot/restore around each mutation.
        let prev = current();
        set_current(manual("10.0.0.1", 1080));
        assert_eq!(current().host, "10.0.0.1");
        set_current(prev);
    }

    #[test]
    fn build_reqwest_proxy_returns_none_when_inactive() {
        let cfg = ProxyConfig::default();
        assert!(cfg.build_reqwest_proxy().is_none());
    }

    #[test]
    fn build_reqwest_proxy_returns_some_when_active() {
        let cfg = manual("127.0.0.1", 7890);
        assert!(cfg.build_reqwest_proxy().is_some());
    }

    #[test]
    fn protocol_default_is_http() {
        let p: ProxyProtocol = Default::default();
        assert_eq!(p, ProxyProtocol::Http);
    }

    #[test]
    fn mode_default_is_off() {
        let m: ProxyMode = Default::default();
        assert_eq!(m, ProxyMode::Off);
    }
}
