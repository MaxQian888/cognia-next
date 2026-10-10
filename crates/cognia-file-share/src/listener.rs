//! The built-in provider's listeners (ADR-0222 §7.3, §8).
//!
//! WebDAV and SFTP each get their own port, outside the companion router: no
//! 64 KiB body cap, no drain-as-mutation, and no trust in loopback — every
//! request authenticates with a grant's credential, wherever it came from.
//! Both are off until the user enables them, and bind loopback by default.
//!
//! Exposure:
//!
//! - `loopback` — `127.0.0.1` only. Clients on this machine, and the origin a
//!   tunnel forwards to.
//! - `lan` — `0.0.0.0`. WebDAV is served over HTTPS with the companion's
//!   self-signed certificate (its SPKI fingerprint is shown so a client can
//!   pin it); SFTP presents a persistent Ed25519 host key whose fingerprint is
//!   shown the same way.
//! - `tunnel` — a cloudflared tunnel to the loopback WebDAV origin: a quick
//!   tunnel (random `trycloudflare.com` URL) or a named one (a fixed hostname
//!   configured in the Cloudflare dashboard, its token kept in the secret
//!   store). Behind a tunnel the client's address comes from
//!   `CF-Connecting-IP`, used for backoff and audit only. SFTP stays on
//!   loopback: cloudflared quick tunnels carry HTTP.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use schemars::JsonSchema;
use tokio_util::sync::CancellationToken;

use crate::error::{FileShareError, FileShareResult};

pub const DEFAULT_WEBDAV_PORT: u16 = 27893;
pub const DEFAULT_SFTP_PORT: u16 = 27894;
/// Settings key of the stored [`ListenerConfig`].
pub const SETTINGS_KEY: &str = "listener";
/// Secret-store service for this crate's secrets.
pub const SECRET_SERVICE: &str = "com.cognia.file-share";
/// Secret-store account of the named tunnel token.
pub const TUNNEL_TOKEN_ACCOUNT: &str = "tunnel-token";
/// Secret-store account of the SFTP host key.
pub const HOST_KEY_ACCOUNT: &str = "sftp-host-key";

/// Where the listeners are reachable from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Exposure {
    Loopback,
    Lan,
    Tunnel,
}

/// Which cloudflared tunnel fronts WebDAV in `tunnel` exposure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TunnelMode {
    Quick,
    Named,
}

/// The stored listener settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListenerConfig {
    pub enabled: bool,
    pub exposure: Exposure,
    pub webdav: bool,
    pub sftp: bool,
    pub webdav_port: u16,
    pub sftp_port: u16,
    pub tunnel_mode: TunnelMode,
    /// Public hostname of a named tunnel (`files.example.com`).
    pub tunnel_hostname: Option<String>,
}

impl Default for ListenerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            exposure: Exposure::Loopback,
            webdav: true,
            sftp: true,
            webdav_port: DEFAULT_WEBDAV_PORT,
            sftp_port: DEFAULT_SFTP_PORT,
            tunnel_mode: TunnelMode::Quick,
            tunnel_hostname: None,
        }
    }
}

/// What the settings surface sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerConfigInput {
    #[serde(flatten)]
    pub config: ListenerConfig,
    /// A named tunnel's token: absent keeps the stored one, `""` clears it.
    #[serde(default)]
    pub tunnel_token: Option<String>,
}

fn is_hostname(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value.split('.').count() >= 2
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

impl ListenerConfig {
    /// Refuse a configuration that cannot run.
    pub fn validate(&self, tunnel_token_present: bool) -> FileShareResult<()> {
        for port in [self.webdav_port, self.sftp_port] {
            if port < 1024 {
                return Err(FileShareError::invalid(
                    "listener ports must be 1024 or higher",
                ));
            }
        }
        if self.webdav && self.sftp && self.webdav_port == self.sftp_port {
            return Err(FileShareError::invalid(
                "WebDAV and SFTP need different ports",
            ));
        }
        if !self.webdav && !self.sftp {
            return Err(FileShareError::invalid("turn on WebDAV, SFTP or both"));
        }
        if self.exposure == Exposure::Tunnel {
            if !self.webdav {
                return Err(FileShareError::invalid(
                    "a tunnel carries WebDAV; turn WebDAV on",
                ));
            }
            if self.tunnel_mode == TunnelMode::Named {
                let host = self.tunnel_hostname.as_deref().unwrap_or("");
                if !is_hostname(host) {
                    return Err(FileShareError::invalid(
                        "a named tunnel needs its public hostname",
                    ));
                }
                if !tunnel_token_present {
                    return Err(FileShareError::invalid(
                        "a named tunnel needs its connector token",
                    ));
                }
            }
        }
        Ok(())
    }

    /// The address WebDAV binds.
    pub fn webdav_bind(&self) -> SocketAddr {
        SocketAddr::new(self.bind_ip(true), self.webdav_port)
    }

    /// The address SFTP binds (loopback behind a tunnel).
    pub fn sftp_bind(&self) -> SocketAddr {
        SocketAddr::new(self.bind_ip(false), self.sftp_port)
    }

    fn bind_ip(&self, webdav: bool) -> IpAddr {
        match (self.exposure, webdav) {
            (Exposure::Lan, _) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            _ => IpAddr::V4(Ipv4Addr::LOCALHOST),
        }
    }

    /// Whether WebDAV terminates TLS itself.
    pub fn webdav_tls(&self) -> bool {
        self.exposure == Exposure::Lan
    }
}

/// One SFTP address a client can dial.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SftpEndpoint {
    pub host: String,
    pub port: u16,
}

/// Where a credential's protocols are reachable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Endpoints {
    pub webdav_urls: Vec<String>,
    pub sftp: Vec<SftpEndpoint>,
    /// `SHA256:…` of the SFTP host key, for the client to verify.
    pub sftp_host_key_fingerprint: Option<String>,
    /// Hex SHA-256 of the HTTPS certificate's public key (LAN WebDAV).
    pub tls_fingerprint: Option<String>,
    /// Set when nothing serves the protocols yet (`listener_off`,
    /// `sftpgo_unconfigured`, `sftpgo_no_public_endpoint`), so the UI can say
    /// what to turn on.
    pub unavailable_reason: Option<String>,
}

/// One listener component's failure, kept for the settings surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComponentError {
    pub component: String,
    pub message: String,
}

/// The listeners as they are now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListenerStatus {
    pub config: ListenerConfig,
    pub webdav_port: Option<u16>,
    pub sftp_port: Option<u16>,
    pub tunnel_url: Option<String>,
    /// The cloudflared child's pid, for the process registry.
    pub tunnel_pid: Option<u32>,
    pub tunnel_token_set: bool,
    pub errors: Vec<ComponentError>,
    pub endpoints: Endpoints,
}

/// The running listeners.
#[derive(Default)]
pub(crate) struct Runtime {
    pub webdav: Option<WebdavRun>,
    pub sftp: Option<SftpRun>,
    pub tunnel: Option<Arc<cognia_companion_connectivity::tunnel::TunnelHandle>>,
    pub tunnel_url: Option<String>,
    pub errors: Vec<ComponentError>,
    pub host_key_fingerprint: Option<String>,
    pub tls_fingerprint: Option<String>,
}

pub(crate) struct WebdavRun {
    pub port: u16,
    pub tls: bool,
    pub handle: axum_server::Handle<SocketAddr>,
}

pub(crate) struct SftpRun {
    pub port: u16,
    pub cancel: CancellationToken,
}

impl Runtime {
    pub fn stop(&mut self) {
        if let Some(webdav) = self.webdav.take() {
            webdav
                .handle
                .graceful_shutdown(Some(std::time::Duration::from_secs(2)));
        }
        if let Some(sftp) = self.sftp.take() {
            sftp.cancel.cancel();
        }
        if let Some(tunnel) = self.tunnel.take() {
            tunnel.stop();
        }
        self.tunnel_url = None;
        self.errors.clear();
    }

    pub fn is_running(&self) -> bool {
        self.webdav.is_some() || self.sftp.is_some()
    }
}

/// IPv4 addresses a LAN client can reach this machine on: private, CGNAT
/// (mesh VPNs) and other non-loopback, non-link-local unicast addresses.
pub fn lan_addresses() -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(_, ip)| match ip {
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() => {
                Some(v4)
            }
            _ => None,
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The endpoints the running built-in listeners offer.
pub(crate) fn builtin_endpoints(config: &ListenerConfig, runtime: &Runtime) -> Endpoints {
    if !runtime.is_running() {
        return Endpoints {
            unavailable_reason: Some("listener_off".into()),
            ..Endpoints::default()
        };
    }
    let mut endpoints = Endpoints {
        sftp_host_key_fingerprint: runtime
            .sftp
            .as_ref()
            .and(runtime.host_key_fingerprint.clone()),
        tls_fingerprint: runtime
            .webdav
            .as_ref()
            .filter(|run| run.tls)
            .and(runtime.tls_fingerprint.clone()),
        ..Endpoints::default()
    };
    let hosts: Vec<String> = match config.exposure {
        Exposure::Lan => lan_addresses().into_iter().map(|ip| ip.to_string()).collect(),
        _ => vec!["127.0.0.1".to_string()],
    };
    if let Some(webdav) = &runtime.webdav {
        let scheme = if webdav.tls { "https" } else { "http" };
        if let Some(public) = &runtime.tunnel_url {
            endpoints.webdav_urls.push(format!("{}/", public.trim_end_matches('/')));
        }
        for host in &hosts {
            endpoints
                .webdav_urls
                .push(format!("{scheme}://{host}:{}/", webdav.port));
        }
    }
    if let Some(sftp) = &runtime.sftp {
        let sftp_hosts = if config.exposure == Exposure::Lan {
            hosts.clone()
        } else {
            vec!["127.0.0.1".to_string()]
        };
        for host in sftp_hosts {
            endpoints.sftp.push(SftpEndpoint {
                host,
                port: sftp.port,
            });
        }
    }
    endpoints
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_off_and_loopback() {
        let config = ListenerConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.exposure, Exposure::Loopback);
        assert_eq!(config.webdav_bind().ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(config.sftp_bind().port(), DEFAULT_SFTP_PORT);
        assert!(!config.webdav_tls());
        assert!(config.validate(false).is_ok());
    }

    #[test]
    fn lan_binds_everywhere_with_tls_and_a_tunnel_keeps_sftp_local() {
        let lan = ListenerConfig {
            exposure: Exposure::Lan,
            ..ListenerConfig::default()
        };
        assert_eq!(lan.webdav_bind().ip(), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert_eq!(lan.sftp_bind().ip(), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert!(lan.webdav_tls());
        let tunnel = ListenerConfig {
            exposure: Exposure::Tunnel,
            ..ListenerConfig::default()
        };
        assert_eq!(tunnel.webdav_bind().ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(tunnel.sftp_bind().ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert!(!tunnel.webdav_tls());
    }

    #[test]
    fn invalid_configurations_are_refused() {
        let base = ListenerConfig::default();
        let cases = [
            ListenerConfig { webdav_port: 80, ..base.clone() },
            ListenerConfig { sftp_port: base.webdav_port, ..base.clone() },
            ListenerConfig { webdav: false, sftp: false, ..base.clone() },
            ListenerConfig { exposure: Exposure::Tunnel, webdav: false, ..base.clone() },
            ListenerConfig {
                exposure: Exposure::Tunnel,
                tunnel_mode: TunnelMode::Named,
                tunnel_hostname: Some("not a host".into()),
                ..base.clone()
            },
        ];
        for case in cases {
            assert!(case.validate(true).is_err(), "{case:?}");
        }
        let named = ListenerConfig {
            exposure: Exposure::Tunnel,
            tunnel_mode: TunnelMode::Named,
            tunnel_hostname: Some("files.example.com".into()),
            ..base
        };
        assert!(named.validate(false).is_err(), "a named tunnel needs a token");
        assert!(named.validate(true).is_ok());
    }

    #[test]
    fn nothing_running_offers_no_endpoint_and_says_why() {
        let endpoints = builtin_endpoints(&ListenerConfig::default(), &Runtime::default());
        assert!(endpoints.webdav_urls.is_empty());
        assert_eq!(endpoints.unavailable_reason.as_deref(), Some("listener_off"));
    }

    #[test]
    fn a_running_loopback_listener_offers_local_endpoints() {
        let runtime = Runtime {
            sftp: Some(SftpRun {
                port: 2222,
                cancel: CancellationToken::new(),
            }),
            host_key_fingerprint: Some("SHA256:abc".into()),
            ..Runtime::default()
        };
        let endpoints = builtin_endpoints(&ListenerConfig::default(), &runtime);
        assert_eq!(
            endpoints.sftp,
            vec![SftpEndpoint {
                host: "127.0.0.1".into(),
                port: 2222
            }]
        );
        assert_eq!(endpoints.sftp_host_key_fingerprint.as_deref(), Some("SHA256:abc"));
        assert!(endpoints.unavailable_reason.is_none());
    }

    #[test]
    fn lan_addresses_exclude_loopback_and_link_local() {
        for ip in lan_addresses() {
            assert!(!ip.is_loopback());
            assert!(!ip.is_link_local());
        }
    }
}
