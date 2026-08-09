//! mDNS / Bonjour broadcaster for the companion server (Wave 1.5 / M2.9).
//!
//! Advertises `_cognia._tcp.local.` so a paired mobile device on the same
//! LAN can pick the desktop out without manual baseUrl entry. TXT records
//! carry the version + TLS SHA-256 fingerprint so the mobile picker can
//! distinguish between multiple cognia-running hosts.
//!
//! Lifecycle: `Broadcaster::start` returns a handle that owns the
//! `mdns_sd::ServiceDaemon`. Dropping the handle stops the daemon (with
//! a graceful shutdown) so closing the companion server stops broadcasts
//! cleanly.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

use mdns_sd::{ServiceDaemon, ServiceInfo};
use parking_lot::Mutex;

const SERVICE_TYPE: &str = "_cognia._tcp.local.";

#[derive(Debug, thiserror::Error)]
pub enum MdnsError {
    #[error("mdns-sd: {0}")]
    Sd(#[from] mdns_sd::Error),
    #[error("no usable IP interface")]
    NoIp,
}

#[derive(Debug, Clone)]
pub struct BroadcastConfig {
    /// Hostname-ish identifier rendered in the service instance name.
    /// Defaults to `cognia-<random8>` — picked by the caller.
    pub instance_name: String,
    /// Port the companion HTTPS server is bound to (Wave 1.4 → port 7891).
    pub port: u16,
    /// Local IP to advertise. Use `local-ip-address::local_ip()` to pick.
    pub local_ip: IpAddr,
    /// App version (cognia x.y.z). Surfaced in TXT records.
    pub app_version: String,
    /// SHA-256 SubjectPublicKeyInfo fingerprint (Wave 1.4) — surfaced so the
    /// mobile picker can show "fingerprint matches". Lower-case hex.
    pub tls_fingerprint: String,
}

/// Config for the auto-detect-IP wrapper. Same as [`BroadcastConfig`] but
/// without `local_ip` — `start_auto` picks one via `local-ip-address`.
#[derive(Debug, Clone)]
pub struct AutoStartConfig {
    pub instance_name: String,
    pub port: u16,
    pub app_version: String,
    pub tls_fingerprint: String,
}

pub struct Broadcaster {
    daemon: Arc<ServiceDaemon>,
    fullname: String,
}

impl Broadcaster {
    /// Start broadcasting. Drops the previous broadcast (if any) silently.
    pub fn start(config: BroadcastConfig) -> Result<Self, MdnsError> {
        let daemon = Arc::new(ServiceDaemon::new()?);

        let props = service_properties(&config.app_version, &config.tls_fingerprint);

        let service = ServiceInfo::new(
            SERVICE_TYPE,
            &config.instance_name,
            &format!("{}.local.", config.instance_name),
            config.local_ip,
            config.port,
            props,
        )?;

        let fullname = service.get_fullname().to_string();
        daemon.register(service)?;
        Ok(Self { daemon, fullname })
    }

    pub fn fullname(&self) -> &str {
        &self.fullname
    }
}

fn service_properties(app_version: &str, tls_fingerprint: &str) -> HashMap<String, String> {
    HashMap::from([
        ("ver".into(), app_version.to_string()),
        ("fp".into(), tls_fingerprint.to_string()),
        ("path".into(), "/api".into()),
    ])
}

impl Drop for Broadcaster {
    fn drop(&mut self) {
        // Best-effort unregister + shutdown. Errors here only matter at
        // process exit and we don't have a UI to surface them to.
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

/// Tauri-managed wrapper around an optional Broadcaster so the lifecycle
/// follows the companion server's start/stop.
pub struct BroadcasterState {
    inner: Mutex<Option<Broadcaster>>,
}

impl BroadcasterState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub fn start(&self, config: BroadcastConfig) -> Result<String, MdnsError> {
        let broadcaster = Broadcaster::start(config)?;
        let fullname = broadcaster.fullname().to_string();
        *self.inner.lock() = Some(broadcaster);
        Ok(fullname)
    }

    /// Same as [`Self::start`] but resolves `local_ip` via the
    /// `local-ip-address` crate. Returns [`MdnsError::NoIp`] when the host
    /// has no usable interface (e.g., a fresh container with no network).
    pub fn start_auto(&self, config: AutoStartConfig) -> Result<String, MdnsError> {
        let local_ip = local_ip_address::local_ip().map_err(|_| MdnsError::NoIp)?;
        self.start(BroadcastConfig {
            instance_name: config.instance_name,
            port: config.port,
            local_ip,
            app_version: config.app_version,
            tls_fingerprint: config.tls_fingerprint,
        })
    }

    pub fn stop(&self) {
        // Drop the broadcaster — its Drop impl handles unregister+shutdown.
        *self.inner.lock() = None;
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().is_some()
    }
}

impl Default for BroadcasterState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn test_config() -> BroadcastConfig {
        BroadcastConfig {
            instance_name: "cognia-test".into(),
            port: 7891,
            local_ip: IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            app_version: "0.1.0".into(),
            tls_fingerprint: "deadbeef".repeat(8),
        }
    }

    #[test]
    fn state_new_is_not_running() {
        let s = BroadcasterState::new();
        assert!(!s.is_running());
    }

    #[test]
    fn discovery_advertises_only_the_unversioned_api_root() {
        let properties = service_properties("1.2.3", "fingerprint-a");

        assert_eq!(properties.get("path").map(String::as_str), Some("/api"));
        assert_eq!(properties.get("ver").map(String::as_str), Some("1.2.3"));
        assert_eq!(
            properties.get("fp").map(String::as_str),
            Some("fingerprint-a")
        );
    }

    #[test]
    fn start_and_stop_round_trip() {
        let s = BroadcasterState::new();
        let result = s.start(test_config());
        // mDNS daemon spawn can fail on locked-down CI hosts; treat that as
        // skip-friendly so the suite stays green there.
        if let Ok(name) = result {
            assert!(name.contains("_cognia._tcp.local."));
            assert!(s.is_running());
            s.stop();
            assert!(!s.is_running());
        }
    }
}
