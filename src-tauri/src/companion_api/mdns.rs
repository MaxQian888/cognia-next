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

    /// The fullname this host is currently advertising, if any.
    ///
    /// A browsing desktop sees its own advertisement like any other. Comparing
    /// against this is how a result is marked as self — exactly, and without
    /// the side effect of materialising TLS material just to identify
    /// ourselves by fingerprint.
    pub fn current_fullname(&self) -> Option<String> {
        self.inner
            .lock()
            .as_ref()
            .map(|broadcaster| broadcaster.fullname().to_string())
    }
}

impl Default for BroadcasterState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Browse — the discovery half
// ---------------------------------------------------------------------------

/// One `_cognia._tcp` host seen on the LAN.
///
/// Mirrors what the mobile scanner already extracts from the same
/// advertisement (`lib/connectivity/mdns-discovery.ts`), so both discovery
/// surfaces describe a host with the same fields.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHost {
    /// `cognia-ab12cd._cognia._tcp.local.` — the mDNS identity, and the key
    /// the caller compares against its own broadcast to recognise itself.
    pub fullname: String,
    /// Instance label without the service suffix, e.g. `cognia-ab12cd`.
    pub instance_name: String,
    /// Advertised host name, e.g. `cognia-ab12cd.local.`.
    pub hostname: String,
    /// Every address the instance resolved to, IPv4 first.
    pub addresses: Vec<String>,
    pub port: u16,
    /// TXT `ver` — the advertised app version, when present.
    pub app_version: Option<String>,
    /// TXT `fp` — the TLS SPKI fingerprint, so a client can pin before it
    /// makes its first request.
    pub tls_fingerprint: Option<String>,
}

impl DiscoveredHost {
    /// `https://<addr>:<port>` for the first address, which is the base URL a
    /// client would actually dial. `None` when the instance resolved with no
    /// usable address.
    pub fn base_url(&self) -> Option<String> {
        self.addresses.first().map(|addr| {
            if addr.contains(':') {
                // IPv6 literals must be bracketed inside a URL authority.
                format!("https://[{addr}]:{}", self.port)
            } else {
                format!("https://{addr}:{}", self.port)
            }
        })
    }
}

fn instance_name_of(fullname: &str) -> String {
    fullname
        .strip_suffix(&format!(".{SERVICE_TYPE}"))
        .unwrap_or(fullname)
        .to_string()
}

/// Browse the LAN for `_cognia._tcp` hosts for `timeout`, then stop.
///
/// A bounded one-shot sweep rather than a live subscription: the desktop
/// surfaces that need this (the Add-host form) ask once when the user opens
/// them and once more when the user hits rescan. Holding a daemon open for the
/// life of the app to service a form nobody has opened would keep a multicast
/// socket and a background thread alive for nothing.
///
/// **Blocking** — it parks on the event channel until the deadline. Call it
/// from a blocking context (`spawn_blocking`), never from the UI thread.
///
/// Addresses are sorted IPv4-first because the companion TLS certificate is
/// issued for the v4 literal; a v6-first candidate would fail the hostname
/// check on a dual-stack LAN.
pub fn browse_once(timeout: std::time::Duration) -> Result<Vec<DiscoveredHost>, MdnsError> {
    use std::collections::HashMap as StdHashMap;

    let daemon = ServiceDaemon::new()?;
    let receiver = daemon.browse(SERVICE_TYPE)?;
    let deadline = std::time::Instant::now() + timeout;

    // Keyed by fullname so a host that re-announces (or answers on several
    // interfaces) collapses to one entry, last resolution winning — that is
    // the one with the most complete address set.
    let mut found: StdHashMap<String, DiscoveredHost> = StdHashMap::new();

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(service)) => {
                let mut addresses: Vec<String> =
                    service.addresses.iter().map(|ip| ip.to_string()).collect();
                addresses.sort_by_key(|addr| (addr.contains(':'), addr.clone()));

                found.insert(
                    service.fullname.clone(),
                    DiscoveredHost {
                        instance_name: instance_name_of(&service.fullname),
                        fullname: service.fullname.clone(),
                        hostname: service.host.clone(),
                        addresses,
                        port: service.port,
                        app_version: service
                            .txt_properties
                            .get_property_val_str("ver")
                            .map(str::to_string),
                        tls_fingerprint: service
                            .txt_properties
                            .get_property_val_str("fp")
                            .map(str::to_string),
                    },
                );
            }
            // Every other event (SearchStarted, ServiceFound, ServiceRemoved,
            // SearchStopped) is progress noise for a one-shot sweep: only a
            // resolution carries an address we can connect to.
            Ok(_) => {}
            // Channel closed or nothing arrived before the deadline — either
            // way the sweep is over and whatever resolved so far is the answer.
            Err(_) => break,
        }
    }

    // Best-effort: the daemon is dropped either way, this just stops it
    // promptly instead of at the next GC tick.
    let _ = daemon.shutdown();

    let mut hosts: Vec<DiscoveredHost> = found.into_values().collect();
    hosts.sort_by(|a, b| a.instance_name.cmp(&b.instance_name));
    Ok(hosts)
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

    fn host(addresses: &[&str], port: u16) -> DiscoveredHost {
        DiscoveredHost {
            fullname: format!("cognia-ab12cd.{SERVICE_TYPE}"),
            instance_name: "cognia-ab12cd".into(),
            hostname: "cognia-ab12cd.local.".into(),
            addresses: addresses.iter().map(|a| a.to_string()).collect(),
            port,
            app_version: Some("1.2.3".into()),
            tls_fingerprint: Some("fingerprint-a".into()),
        }
    }

    #[test]
    fn instance_name_strips_the_service_suffix() {
        assert_eq!(
            instance_name_of("cognia-ab12cd._cognia._tcp.local."),
            "cognia-ab12cd"
        );
        // A name that does not carry the suffix is passed through rather than
        // truncated to nothing.
        assert_eq!(instance_name_of("bare-name"), "bare-name");
    }

    #[test]
    fn base_url_is_https_on_the_advertised_port() {
        assert_eq!(
            host(&["192.168.1.9"], 27890).base_url().as_deref(),
            Some("https://192.168.1.9:27890")
        );
    }

    #[test]
    fn an_ipv6_address_is_bracketed() {
        // Unbracketed, `https://fe80::1:27890` parses with `:27890` swallowed
        // into the address — the client would dial the wrong port, or fail to
        // parse the URL at all.
        assert_eq!(
            host(&["fe80::1"], 27890).base_url().as_deref(),
            Some("https://[fe80::1]:27890")
        );
    }

    #[test]
    fn a_host_that_resolved_without_an_address_has_no_base_url() {
        assert_eq!(host(&[], 27890).base_url(), None);
    }

    #[test]
    fn a_stopped_broadcaster_advertises_no_fullname() {
        let state = BroadcasterState::new();
        assert_eq!(state.current_fullname(), None);
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
