//! Centralized proxy configuration for outbound HTTP & WebSocket traffic.
//!
//! The frontend submits sanitized settings via the app-side `proxy_apply`
//! command. After keyring hydration, the command installs the runtime config
//! below. Every managed reqwest builder consults this module to decide whether
//! to attach a proxy connector or explicitly disable ambient proxy handling.
//! WSS connections route through `wsproxy::connect_via_proxy` when enabled.
//!
//! Companion of `lib/network/proxy-config.ts` on the TS side. The two
//! representations stay in sync because the frontend is the only writer and
//! pushes whenever it commits a settings change.
pub mod clients;
pub mod detect;
pub mod wsproxy;

use std::fmt;
use std::net::IpAddr;
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

#[derive(Clone, Serialize, Deserialize)]
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

impl fmt::Debug for ProxyConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProxyConfig")
            .field("mode", &self.mode)
            .field("protocol", &self.protocol)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("bypass", &self.bypass)
            .field("proxy_websockets", &self.proxy_websockets)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProxyErrorCode {
    ProxyNotInitialized,
    ProxyInvalidConfig,
    ProxyCredentialUnavailable,
    ProxyConnectFailed,
    ProxyTransportUnsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyError {
    pub code: ProxyErrorCode,
    pub message: String,
}

impl ProxyError {
    pub fn new(code: ProxyErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ProxyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for ProxyError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DirectReason {
    Off,
    Bypass,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProxyRouteSummary {
    Direct {
        reason: DirectReason,
    },
    Proxy {
        protocol: ProxyProtocol,
        host: String,
        port: u16,
    },
}

#[derive(Debug, Clone)]
enum ProxyRuntimeState {
    Uninitialized,
    Ready(ProxyConfig),
    Blocked(ProxyError),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRuntimeStatus {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<ProxyRouteSummary>,
    pub credential_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<ProxyErrorCode>,
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

    pub fn validate(&self) -> Result<(), ProxyError> {
        if matches!(self.mode, ProxyMode::Off) {
            return Ok(());
        }
        if let Err(reason) = validate_proxy_host(&self.host) {
            return Err(ProxyError::new(
                ProxyErrorCode::ProxyInvalidConfig,
                format!("proxy host is not usable: {reason}"),
            ));
        }
        if self.port == 0 {
            return Err(ProxyError::new(
                ProxyErrorCode::ProxyInvalidConfig,
                "enabled proxy requires a host and non-zero port",
            ));
        }
        if self
            .username
            .as_deref()
            .is_some_and(|value| !value.is_empty())
            && self.password.as_deref().is_none_or(str::is_empty)
        {
            return Err(ProxyError::new(
                ProxyErrorCode::ProxyCredentialUnavailable,
                "proxy username is configured but its keyring password is unavailable",
            ));
        }
        Ok(())
    }

    /// Credential-bearing URL for native connector construction only. Never
    /// return this value over IPC or include it in logs/errors.
    pub fn credentialed_proxy_url(&self) -> Result<Option<String>, ProxyError> {
        if !self.is_active() {
            self.validate()?;
            return Ok(None);
        }
        self.validate()?;
        let scheme = match self.protocol {
            ProxyProtocol::Http => "http",
            ProxyProtocol::Https => "https",
            // reqwest interprets socks5h as proxy-side DNS resolution.
            ProxyProtocol::Socks5 => "socks5h",
        };
        let auth = match (self.username.as_deref(), self.password.as_deref()) {
            (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => {
                format!("{}:{}@", urlencoding::encode(u), urlencoding::encode(p))
            }
            _ => String::new(),
        };
        Ok(Some(format!(
            "{scheme}://{auth}{}",
            authority(&self.host, self.port)
        )))
    }

    pub fn route_for(&self, target_url: &str) -> Result<ProxyRouteSummary, ProxyError> {
        self.validate()?;
        if matches!(self.mode, ProxyMode::Off) {
            return Ok(ProxyRouteSummary::Direct {
                reason: DirectReason::Off,
            });
        }
        if self.should_bypass(target_url) {
            return Ok(ProxyRouteSummary::Direct {
                reason: DirectReason::Bypass,
            });
        }
        Ok(ProxyRouteSummary::Proxy {
            protocol: self.protocol,
            host: self.host.clone(),
            port: self.port,
        })
    }

    pub fn websocket_route_for(&self, target_url: &str) -> Result<ProxyRouteSummary, ProxyError> {
        let route = self.route_for(target_url)?;
        if matches!(route, ProxyRouteSummary::Proxy { .. }) && !self.proxy_websockets {
            return Err(ProxyError::new(
                ProxyErrorCode::ProxyConnectFailed,
                "public WebSocket traffic is blocked because WebSocket proxying is disabled",
            ));
        }
        Ok(route)
    }

    /// True when the host portion of `target_url` matches a bypass entry.
    /// Mirrors `lib/network/proxy-config.ts:shouldBypass`.
    pub fn should_bypass(&self, target_url: &str) -> bool {
        if self.bypass.is_empty() {
            return false;
        }
        // Bracket-stripped once, for every branch. `Url::host_str` keeps the
        // brackets on an IPv6 literal, so the literal comparison below used to
        // test `"[::1]" == "::1"` and never match — with `::1` in the DEFAULT
        // bypass list, loopback IPv6 was silently proxied. Mirrors
        // `normalizeProxyHostForMatch` on the TS side.
        let host = match url::Url::parse(target_url) {
            Ok(u) => normalize_host_for_match(u.host_str().unwrap_or("")),
            Err(_) => return false,
        };
        if host.is_empty() {
            return false;
        }
        let target_ip = host.parse::<IpAddr>().ok();
        self.bypass.iter().any(|raw| {
            let entry = normalize_host_for_match(raw);
            if entry.is_empty() {
                return false;
            }
            if let Some((network, prefix)) = parse_cidr(&entry) {
                target_ip.is_some_and(|target| ip_in_cidr(target, network, prefix))
            } else if let Some(suffix) = entry.strip_prefix('.') {
                host == suffix || host.ends_with(&entry)
            } else {
                host == entry
            }
        })
    }

    /// Build a `reqwest::Proxy` honouring the bypass list.
    pub fn build_reqwest_proxy(&self) -> Result<Option<reqwest::Proxy>, ProxyError> {
        let Some(url) = self.credentialed_proxy_url()? else {
            return Ok(None);
        };
        let parsed_url = url.parse::<reqwest::Url>().map_err(|_| {
            ProxyError::new(
                ProxyErrorCode::ProxyInvalidConfig,
                "proxy endpoint could not be parsed",
            )
        })?;
        let bypass = self.bypass.clone();
        let proxy = reqwest::Proxy::custom(move |target| {
            let host = normalize_host_for_match(target.host_str().unwrap_or(""));
            let target_ip = host.parse::<IpAddr>().ok();
            for raw in &bypass {
                let entry = normalize_host_for_match(raw);
                if entry.is_empty() {
                    continue;
                }
                let matches = if let Some((network, prefix)) = parse_cidr(&entry) {
                    target_ip.is_some_and(|target| ip_in_cidr(target, network, prefix))
                } else if let Some(suffix) = entry.strip_prefix('.') {
                    host == suffix || host.ends_with(&entry)
                } else {
                    host == entry
                };
                if matches {
                    return None;
                }
            }
            Some(parsed_url.clone())
        });
        Ok(Some(proxy))
    }

    pub fn apply_reqwest_policy(
        &self,
        builder: reqwest::ClientBuilder,
        target_url: &str,
    ) -> Result<(reqwest::ClientBuilder, ProxyRouteSummary), ProxyError> {
        let route = self.route_for(target_url)?;
        let builder = match route {
            ProxyRouteSummary::Direct { .. } => builder.no_proxy(),
            ProxyRouteSummary::Proxy { .. } => {
                let proxy = self.build_reqwest_proxy()?.ok_or_else(|| {
                    ProxyError::new(
                        ProxyErrorCode::ProxyInvalidConfig,
                        "active proxy did not produce a connector",
                    )
                })?;
                builder.proxy(proxy)
            }
        };
        Ok((builder, route))
    }

    /// Env vars suitable for spawning a child process. Mirrors the TS
    /// `proxyEnvVars` helper so the Node sidecar sees the same proxy.
    pub fn env_vars(&self) -> Vec<(String, String)> {
        let Ok(Some(mut url)) = self.credentialed_proxy_url() else {
            return Vec::new();
        };
        // Node/undici resolves SOCKS destinations through the proxy but only
        // accepts the standard socks5 scheme. `socks5h` is reqwest-specific.
        if url.starts_with("socks5h://") {
            url.replace_range(..9, "socks5://");
        }
        let mut out = vec![
            ("HTTP_PROXY".to_string(), url.clone()),
            ("HTTPS_PROXY".to_string(), url.clone()),
            ("ALL_PROXY".to_string(), url.clone()),
            ("http_proxy".to_string(), url.clone()),
            ("https_proxy".to_string(), url.clone()),
            ("all_proxy".to_string(), url.clone()),
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

/// Why a proxy host was refused. Mirrors `ProxyHostRejection` in
/// `lib/network/proxy-config.ts`; the two must agree or the UI accepts a value
/// the native side then rejects (or worse, silently mangles).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyHostRejection {
    Empty,
    Scheme,
    Userinfo,
    Path,
    PortInHost,
    IllegalCharacter,
    Malformed,
}

impl fmt::Display for ProxyHostRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::Empty => "a host is required",
            Self::Scheme => "drop the scheme (http:// / socks5://)",
            Self::Userinfo => "credentials belong in the keyring, not the host",
            Self::PortInHost => "the port belongs in its own field",
            Self::Path => "a host cannot carry a path, query or fragment",
            Self::IllegalCharacter => "the host contains a character a DNS name cannot",
            Self::Malformed => "the host is not a valid name or IP literal",
        };
        formatter.write_str(text)
    }
}

/// Validate a proxy host. Mirrors `validateProxyHost` in
/// `lib/network/proxy-config.ts` — see that function for why each class is
/// refused rather than accepted and mangled later.
pub fn validate_proxy_host(raw: &str) -> Result<String, ProxyHostRejection> {
    let host = raw.trim();
    if host.is_empty() {
        return Err(ProxyHostRejection::Empty);
    }
    if host.contains("://") {
        return Err(ProxyHostRejection::Scheme);
    }
    if host.contains('@') {
        return Err(ProxyHostRejection::Userinfo);
    }
    if host.contains('/') || host.contains('?') || host.contains('#') {
        return Err(ProxyHostRejection::Path);
    }
    if !host.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '[' | ']')
    }) {
        return Err(ProxyHostRejection::IllegalCharacter);
    }

    let bare = strip_brackets(host);
    if host.starts_with('[') {
        if !host.ends_with(']') || bare.parse::<std::net::Ipv6Addr>().is_err() {
            return Err(ProxyHostRejection::Malformed);
        }
        return Ok(bare.to_string());
    }
    if host.contains(':') {
        return if host.parse::<std::net::Ipv6Addr>().is_ok() {
            Ok(host.to_string())
        } else {
            Err(ProxyHostRejection::PortInHost)
        };
    }
    if host.starts_with('.') || host.ends_with('.') || host.contains("..") {
        return Err(ProxyHostRejection::Malformed);
    }
    Ok(host.to_string())
}

/// `host:port` for a URL, TCP dial, or CONNECT line.
///
/// IPv6 literals must be bracketed or the last group is read as the port:
/// `::1:8080` is not a parse of `::1` port 8080, it is a different (invalid)
/// address that `TcpStream::connect` refuses. Mirrors `formatProxyAuthority`
/// on the TS side.
pub fn authority(host: &str, port: u16) -> String {
    let bare = strip_brackets(host.trim());
    if bare.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{bare}]:{port}")
    } else {
        format!("{bare}:{port}")
    }
}

/// Lowercase and strip the brackets a URL parser keeps on an IPv6 literal.
pub fn normalize_host_for_match(host: &str) -> String {
    strip_brackets(host.trim()).to_lowercase()
}

fn strip_brackets(value: &str) -> &str {
    value
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(value)
}

fn parse_cidr(entry: &str) -> Option<(IpAddr, u8)> {
    let (network, prefix) = entry.rsplit_once('/')?;
    let network = network.parse::<IpAddr>().ok()?;
    let prefix = prefix.parse::<u8>().ok()?;
    let max = if network.is_ipv4() { 32 } else { 128 };
    (prefix <= max).then_some((network, prefix))
}

fn ip_in_cidr(target: IpAddr, network: IpAddr, prefix: u8) -> bool {
    if prefix == 0 {
        return target.is_ipv4() == network.is_ipv4();
    }
    match (target, network) {
        (IpAddr::V4(target), IpAddr::V4(network)) => {
            let shift = 32 - u32::from(prefix);
            (u32::from(target) >> shift) == (u32::from(network) >> shift)
        }
        (IpAddr::V6(target), IpAddr::V6(network)) => {
            let shift = 128 - u32::from(prefix);
            (u128::from(target) >> shift) == (u128::from(network) >> shift)
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Process-wide state — populated by the `proxy_apply` command, read by every
// outbound HTTP/WS call site.
// ---------------------------------------------------------------------------

static CURRENT: OnceLock<RwLock<ProxyRuntimeState>> = OnceLock::new();

fn slot() -> &'static RwLock<ProxyRuntimeState> {
    CURRENT.get_or_init(|| RwLock::new(ProxyRuntimeState::Uninitialized))
}

/// Snapshot of initialized live config. Never substitutes a direct default.
pub fn current() -> Result<ProxyConfig, ProxyError> {
    match slot().read().expect("proxy config lock poisoned").clone() {
        ProxyRuntimeState::Ready(config) => Ok(config),
        ProxyRuntimeState::Uninitialized => Err(ProxyError::new(
            ProxyErrorCode::ProxyNotInitialized,
            "network proxy policy has not been initialized",
        )),
        ProxyRuntimeState::Blocked(error) => Err(error),
    }
}

pub fn apply_current(config: ProxyConfig) -> Result<(), ProxyError> {
    if let Err(error) = config.validate() {
        *slot().write().expect("proxy config lock poisoned") =
            ProxyRuntimeState::Blocked(error.clone());
        return Err(error);
    }
    *slot().write().expect("proxy config lock poisoned") = ProxyRuntimeState::Ready(config);
    Ok(())
}

pub fn block_current(error: ProxyError) {
    *slot().write().expect("proxy config lock poisoned") = ProxyRuntimeState::Blocked(error);
}

pub fn runtime_status() -> ProxyRuntimeStatus {
    match slot().read().expect("proxy config lock poisoned").clone() {
        ProxyRuntimeState::Uninitialized => ProxyRuntimeStatus {
            state: "uninitialized",
            route: None,
            credential_configured: false,
            error_code: Some(ProxyErrorCode::ProxyNotInitialized),
        },
        ProxyRuntimeState::Blocked(error) => ProxyRuntimeStatus {
            state: "blocked",
            route: None,
            credential_configured: false,
            error_code: Some(error.code),
        },
        ProxyRuntimeState::Ready(config) => ProxyRuntimeStatus {
            state: "ready",
            route: if matches!(config.mode, ProxyMode::Off) {
                Some(ProxyRouteSummary::Direct {
                    reason: DirectReason::Off,
                })
            } else {
                Some(ProxyRouteSummary::Proxy {
                    protocol: config.protocol,
                    host: config.host.clone(),
                    port: config.port,
                })
            },
            credential_configured: config.password.is_some(),
            error_code: None,
        },
    }
}

pub fn apply_reqwest_policy(
    builder: reqwest::ClientBuilder,
    target_url: &str,
) -> Result<(reqwest::ClientBuilder, ProxyRouteSummary), ProxyError> {
    current()?.apply_reqwest_policy(builder, target_url)
}

/// Build a client bound to the live policy for `target_url`.
///
/// The one-line form of "apply the policy, then build", named so that every
/// outbound Rust call site reads the same and so `audit:network-egress` has a
/// single symbol to look for.
///
/// Call it **per request target**, not once at startup. Two reasons:
///
///   - the policy is per-URL — the bypass list can route one host direct and
///     the next through the proxy, and a client built for one is wrong for the
///     other;
///   - the policy is mutable — the user can switch Off/Manual/Auto at any
///     time, and a client cached in a struct field keeps whatever was true
///     when it was constructed. Worse, a client built during the renderer
///     hydration window inherits `install_uninitialized_proxy_environment`'s
///     deliberate black hole (`http://127.0.0.1:9`) and never recovers.
///
/// reqwest clients share a connection pool per client, so rebuilding costs a
/// fresh pool; for the call sites here (auth discovery, workspace control
/// plane) that is far cheaper than being wrong.
pub fn managed_client(
    builder: reqwest::ClientBuilder,
    target_url: &str,
) -> Result<reqwest::Client, ProxyError> {
    let (builder, _route) = apply_reqwest_policy(builder, target_url)?;
    builder.build().map_err(|error| {
        ProxyError::new(
            ProxyErrorCode::ProxyInvalidConfig,
            format!("managed HTTP client build failed: {error}"),
        )
    })
}

/// Remove ambient proxy routing before desktop services or plugins create
/// clients. Cognia's initialized runtime policy is the sole routing authority;
/// active clients receive an explicit connector and direct clients call
/// `.no_proxy()`.
pub fn clear_inherited_proxy_environment() {
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        std::env::remove_var(key);
    }
}

/// Keep libraries outside the managed client factory fail-closed during the
/// renderer hydration window. Loopback remains reachable for in-process RPC.
pub fn install_uninitialized_proxy_environment() {
    clear_inherited_proxy_environment();
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        std::env::set_var(key, "http://127.0.0.1:9");
    }
    for key in ["NO_PROXY", "no_proxy"] {
        std::env::set_var(key, "localhost,127.0.0.1,::1");
    }
}

/// Proxy environment for a child process that is *permitted* to use the
/// network and is spawned with `env_clear()`.
///
/// Children that inherit the parent environment already see these — the
/// `proxy_apply` command mirrors the live policy into the process via
/// [`install_process_proxy_environment`]. A child spawned with `env_clear()`
/// does not, and would go direct around whatever the user configured. That is
/// what this returns the values for.
///
/// Three cases, and the third is the one that matters:
///
///   - policy Ready and active → the real proxy variables;
///   - policy Ready and Off    → nothing, so the child dials direct;
///   - policy Uninitialized or Blocked → the same deliberate black hole
///     [`install_uninitialized_proxy_environment`] installs. A child spawned
///     during the renderer hydration window must not be the one path that
///     silently escapes the policy just because it was early.
///
/// Only call this for a child that is allowed network. Network-off, a plugin
/// without a network grant, and a sandbox deny policy all take precedence:
/// handing proxy credentials to a process that must not reach the network
/// would widen its permissions, not narrow them.
pub fn child_network_env() -> Vec<(String, String)> {
    match slot().read().expect("proxy config lock poisoned").clone() {
        ProxyRuntimeState::Ready(config) => config.env_vars(),
        ProxyRuntimeState::Uninitialized | ProxyRuntimeState::Blocked(_) => {
            let mut out = Vec::new();
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                out.push((key.to_string(), "http://127.0.0.1:9".to_string()));
            }
            for key in ["NO_PROXY", "no_proxy"] {
                out.push((key.to_string(), "localhost,127.0.0.1,::1".to_string()));
            }
            out
        }
    }
}

/// Mirror an initialized policy into the process environment for native
/// plugins whose HTTP stack is owned by Tauri (notably the updater). Managed
/// reqwest clients still use explicit connectors or `.no_proxy()`.
pub fn install_process_proxy_environment(config: &ProxyConfig) {
    clear_inherited_proxy_environment();
    for (key, value) in config.env_vars() {
        std::env::set_var(key, value);
    }
}

#[cfg(test)]
fn reset_uninitialized() {
    *slot().write().expect("proxy config lock poisoned") = ProxyRuntimeState::Uninitialized;
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    static NETWORK_ENV_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        assert_eq!(cfg.credentialed_proxy_url().unwrap(), None);
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
        assert_eq!(
            cfg.credentialed_proxy_url().unwrap(),
            Some("http://127.0.0.1:7890".to_string())
        );
    }

    #[test]
    fn proxy_url_includes_auth_when_both_creds_set() {
        let mut cfg = manual("proxy.corp", 8080);
        cfg.username = Some("alice".to_string());
        cfg.password = Some("secret".to_string());
        assert_eq!(
            cfg.credentialed_proxy_url().unwrap(),
            Some("http://alice:secret@proxy.corp:8080".to_string())
        );
    }

    #[test]
    fn proxy_url_url_encodes_auth() {
        let mut cfg = manual("proxy.corp", 8080);
        cfg.username = Some("alice@corp".to_string());
        cfg.password = Some("p:w@rd!".to_string());
        let url = cfg.credentialed_proxy_url().unwrap().unwrap();
        assert!(url.contains("alice%40corp"));
        assert!(url.contains("p%3Aw%40rd!"));
    }

    #[test]
    fn proxy_url_rejects_a_username_without_keyring_password() {
        let mut cfg = manual("proxy.corp", 8080);
        cfg.username = Some("alice".to_string());
        cfg.password = None;
        assert_eq!(
            cfg.credentialed_proxy_url().unwrap_err().code,
            ProxyErrorCode::ProxyCredentialUnavailable
        );
    }

    #[test]
    fn socks5_protocol_renders_socks_scheme() {
        let mut cfg = manual("127.0.0.1", 7891);
        cfg.protocol = ProxyProtocol::Socks5;
        assert_eq!(
            cfg.credentialed_proxy_url().unwrap(),
            Some("socks5h://127.0.0.1:7891".to_string())
        );
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
    fn should_bypass_matches_ipv4_and_ipv6_cidr() {
        let mut cfg = ProxyConfig::default();
        cfg.bypass = vec!["10.42.0.0/16".into(), "2001:db8::/32".into()];
        assert!(cfg.should_bypass("https://10.42.9.8/path"));
        assert!(!cfg.should_bypass("https://10.43.9.8/path"));
        assert!(cfg.should_bypass("https://[2001:db8:abcd::1]/path"));
        assert!(!cfg.should_bypass("https://[2001:db9::1]/path"));
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
    fn runtime_starts_fail_closed_and_apply_replaces_it() {
        static TEST_STATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = TEST_STATE.lock().unwrap();
        reset_uninitialized();
        assert_eq!(
            current().unwrap_err().code,
            ProxyErrorCode::ProxyNotInitialized
        );
        apply_current(manual("10.0.0.1", 1080)).unwrap();
        assert_eq!(current().unwrap().host, "10.0.0.1");
        reset_uninitialized();
    }

    #[tokio::test]
    async fn managed_client_is_fail_closed_before_the_policy_is_installed() {
        let _guard = NETWORK_ENV_TEST.lock().unwrap();
        reset_uninitialized();

        // Not "direct by default": a client built during the hydration window
        // must refuse rather than quietly leak the request around a proxy the
        // user is about to configure.
        let error = managed_client(reqwest::Client::builder(), "https://api.example.com")
            .expect_err("uninitialized policy must not produce a client");
        assert_eq!(error.code, ProxyErrorCode::ProxyNotInitialized);

        reset_uninitialized();
    }

    #[tokio::test]
    async fn managed_client_sends_through_the_proxy_and_follows_a_later_policy_change() {
        let _guard = NETWORK_ENV_TEST.lock().unwrap();
        let (proxy_port, proxy_request) = serve_captured_request("proxy").await;
        let (origin_port, origin_request) = serve_captured_request("origin").await;

        apply_current(manual("127.0.0.1", proxy_port)).unwrap();
        let proxied = managed_client(reqwest::Client::builder(), "http://service.example/data")
            .unwrap()
            .get("http://service.example/data")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(proxied, "proxy");
        // Proof it really traversed the proxy rather than resolving the host:
        // a forward proxy receives an absolute-form request line.
        assert!(proxy_request
            .await
            .unwrap()
            .to_ascii_lowercase()
            .contains("http://service.example/data"));

        // The user switches the proxy off. A client cached in a struct field
        // would keep tunnelling; the next `managed_client` must go direct.
        apply_current(ProxyConfig::default()).unwrap();
        let direct = managed_client(
            reqwest::Client::builder(),
            &format!("http://127.0.0.1:{origin_port}/after-change"),
        )
        .unwrap()
        .get(format!("http://127.0.0.1:{origin_port}/after-change"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
        assert_eq!(direct, "origin");
        assert!(origin_request
            .await
            .unwrap()
            .to_ascii_lowercase()
            .contains("/after-change"));

        reset_uninitialized();
    }

    #[test]
    fn validate_proxy_host_accepts_names_ipv4_and_either_ipv6_form() {
        assert_eq!(validate_proxy_host("proxy.corp").unwrap(), "proxy.corp");
        assert_eq!(validate_proxy_host("  10.0.0.1 ").unwrap(), "10.0.0.1");
        assert_eq!(validate_proxy_host("::1").unwrap(), "::1");
        // Brackets are normalized away; `authority` puts them back.
        assert_eq!(validate_proxy_host("[2001:db8::1]").unwrap(), "2001:db8::1");
    }

    #[test]
    fn validate_proxy_host_names_the_mistake() {
        // Mirrors the TS cases one-for-one; the two sides must agree or the UI
        // accepts a value the native side rejects.
        use ProxyHostRejection::*;
        assert_eq!(validate_proxy_host("").unwrap_err(), Empty);
        assert_eq!(validate_proxy_host("   ").unwrap_err(), Empty);
        assert_eq!(validate_proxy_host("http://proxy.corp").unwrap_err(), Scheme);
        assert_eq!(
            validate_proxy_host("socks5://proxy.corp").unwrap_err(),
            Scheme
        );
        assert_eq!(
            validate_proxy_host("user:pw@proxy.corp").unwrap_err(),
            Userinfo
        );
        assert_eq!(validate_proxy_host("proxy.corp/path").unwrap_err(), Path);
        assert_eq!(validate_proxy_host("proxy.corp?a=1").unwrap_err(), Path);
        assert_eq!(
            validate_proxy_host("proxy.corp:8080").unwrap_err(),
            PortInHost
        );
        assert_eq!(validate_proxy_host(".corp").unwrap_err(), Malformed);
        assert_eq!(validate_proxy_host("proxy..corp").unwrap_err(), Malformed);
        assert_eq!(validate_proxy_host("[proxy.corp]").unwrap_err(), Malformed);
        assert_eq!(validate_proxy_host("[::1").unwrap_err(), Malformed);
    }

    #[test]
    fn validate_proxy_host_refuses_parser_resolver_differential_bytes() {
        use ProxyHostRejection::IllegalCharacter;
        assert_eq!(
            validate_proxy_host("proxy\0.corp").unwrap_err(),
            IllegalCharacter
        );
        assert_eq!(
            validate_proxy_host("proxy\r\n.corp").unwrap_err(),
            IllegalCharacter
        );
        assert_eq!(
            validate_proxy_host("proxy%2ecorp").unwrap_err(),
            IllegalCharacter
        );
    }

    #[test]
    fn config_validation_rejects_a_host_the_dialler_could_never_use() {
        let mut cfg = manual("proxy.corp:8080", 8080);
        assert!(cfg.validate().is_err());
        assert!(!cfg.is_active() || cfg.credentialed_proxy_url().is_err());

        cfg.host = "http://proxy.corp".to_string();
        assert!(cfg.validate().is_err());

        cfg.host = "proxy.corp".to_string();
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn authority_brackets_ipv6_and_leaves_the_rest_alone() {
        assert_eq!(authority("proxy.corp", 8080), "proxy.corp:8080");
        assert_eq!(authority("10.0.0.1", 1080), "10.0.0.1:1080");
        // `::1:8080` is not "::1 port 8080" — `TcpStream::connect` refuses it.
        assert_eq!(authority("::1", 8080), "[::1]:8080");
        assert_eq!(authority("[2001:db8::1]", 3128), "[2001:db8::1]:3128");
    }

    #[test]
    fn credentialed_url_brackets_an_ipv6_proxy() {
        let cfg = manual("::1", 8080);
        assert_eq!(
            cfg.credentialed_proxy_url().unwrap().unwrap(),
            "http://[::1]:8080"
        );
    }

    #[test]
    fn bypass_matches_a_bracketed_ipv6_target_against_a_bare_entry() {
        // `Url::host_str` returns `"[::1]"`, so the literal comparison used to
        // test `"[::1]" == "::1"` and never match — with `::1` in the DEFAULT
        // bypass list, loopback IPv6 was silently proxied.
        let mut cfg = manual("proxy.corp", 8080);
        cfg.bypass = vec!["::1".to_string()];
        assert!(cfg.should_bypass("http://[::1]:3000/health"));
        assert!(!cfg.should_bypass("http://[2001:db8::1]/x"));

        cfg.bypass = vec!["[::1]".to_string()];
        assert!(cfg.should_bypass("http://[::1]:3000/health"));

        cfg.bypass = vec!["2001:db8::/32".to_string()];
        assert!(cfg.should_bypass("http://[2001:db8::5]/x"));
        assert!(!cfg.should_bypass("http://[2001:dead::5]/x"));
    }

    #[test]
    fn child_network_env_covers_ready_off_and_uninitialized() {
        static TEST_STATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = TEST_STATE.lock().unwrap();

        // Uninitialized: the same black hole the process environment gets, so
        // a child spawned during hydration cannot be the one path that escapes.
        reset_uninitialized();
        let early: std::collections::HashMap<_, _> = child_network_env().into_iter().collect();
        assert_eq!(early.get("HTTPS_PROXY").unwrap(), "http://127.0.0.1:9");
        assert_eq!(early.get("NO_PROXY").unwrap(), "localhost,127.0.0.1,::1");

        // Blocked behaves the same — a credential we cannot read is not a
        // reason to let the child out.
        block_current(ProxyError::new(
            ProxyErrorCode::ProxyCredentialUnavailable,
            "test",
        ));
        let blocked: std::collections::HashMap<_, _> = child_network_env().into_iter().collect();
        assert_eq!(blocked.get("HTTPS_PROXY").unwrap(), "http://127.0.0.1:9");

        // Off: nothing, so the child dials direct.
        apply_current(ProxyConfig::default()).unwrap();
        assert!(child_network_env().is_empty());

        // Active: the real values, in both casings.
        apply_current(manual("proxy.corp", 8080)).unwrap();
        let active: std::collections::HashMap<_, _> = child_network_env().into_iter().collect();
        assert_eq!(active.get("HTTPS_PROXY").unwrap(), "http://proxy.corp:8080");
        assert_eq!(active.get("https_proxy").unwrap(), "http://proxy.corp:8080");

        reset_uninitialized();
    }

    #[test]
    fn build_reqwest_proxy_returns_none_when_inactive() {
        let cfg = ProxyConfig::default();
        assert!(cfg.build_reqwest_proxy().unwrap().is_none());
    }

    #[test]
    fn build_reqwest_proxy_returns_some_when_active() {
        let cfg = manual("127.0.0.1", 7890);
        assert!(cfg.build_reqwest_proxy().unwrap().is_some());
    }

    #[test]
    fn debug_output_redacts_password() {
        let mut cfg = manual("proxy.corp", 8080);
        cfg.username = Some("alice".into());
        cfg.password = Some("super-secret".into());
        let rendered = format!("{cfg:?}");
        assert!(!rendered.contains("super-secret"));
        assert!(rendered.contains("<redacted>"));
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

    async fn serve_captured_request(body: &'static str) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 512];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (port, handle)
    }

    #[tokio::test]
    async fn reqwest_proxy_auth_stays_on_proxy_and_bypass_is_direct() {
        let _guard = NETWORK_ENV_TEST.lock().unwrap();
        let (proxy_port, proxy_request) = serve_captured_request("proxy").await;
        let (origin_port, origin_request) = serve_captured_request("origin").await;
        let mut cfg = manual("127.0.0.1", proxy_port);
        cfg.username = Some("alice".into());
        cfg.password = Some("secret".into());
        cfg.bypass = vec!["127.0.0.1".into()];

        let (builder, route) = cfg
            .apply_reqwest_policy(reqwest::Client::builder(), "http://service.example/data")
            .unwrap();
        assert!(matches!(route, ProxyRouteSummary::Proxy { .. }));
        let client = builder.build().unwrap();
        assert_eq!(
            client
                .get("http://service.example/data")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "proxy"
        );
        assert_eq!(
            client
                .get(format!("http://127.0.0.1:{origin_port}/bypass"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "origin"
        );

        let proxy_request = proxy_request.await.unwrap().to_ascii_lowercase();
        let origin_request = origin_request.await.unwrap().to_ascii_lowercase();
        assert!(proxy_request.contains("proxy-authorization: basic ywxpy2u6c2vjcmv0"));
        assert!(!origin_request.contains("proxy-authorization"));
    }

    #[tokio::test]
    async fn off_policy_ignores_ambient_proxy_environment() {
        let _guard = NETWORK_ENV_TEST.lock().unwrap();
        const KEYS: [&str; 6] = [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "no_proxy",
        ];
        let saved: Vec<_> = KEYS
            .iter()
            .map(|key| ((*key).to_string(), std::env::var_os(key)))
            .collect();
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            std::env::set_var(key, "http://127.0.0.1:9");
        }
        for key in ["NO_PROXY", "no_proxy"] {
            std::env::set_var(key, "");
        }

        let (origin_port, origin_request) = serve_captured_request("direct").await;
        let url = format!("http://127.0.0.1:{origin_port}/off");
        let (builder, route) = ProxyConfig::default()
            .apply_reqwest_policy(reqwest::Client::builder(), &url)
            .unwrap();
        assert_eq!(
            route,
            ProxyRouteSummary::Direct {
                reason: DirectReason::Off
            }
        );
        let result = builder
            .build()
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();

        for (key, value) in saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        assert_eq!(result, "direct");
        assert!(origin_request
            .await
            .unwrap()
            .starts_with("GET /off HTTP/1.1"));
    }
}
