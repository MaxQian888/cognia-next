//! Live network measurements for the desktop status bar: how many bytes this
//! machine has moved, and how long one HTTP round trip to a chosen endpoint
//! takes.
//!
//! - [`read_interface_counters`] — cumulative receive / transmit byte counters
//!   summed over the machine's *physical* interfaces. Stateless: the caller
//!   samples twice and divides the delta by the interval, so two windows (or a
//!   window and a test) never share a baseline. Loopback is skipped because it
//!   is not the network, and tunnel / virtual interfaces are skipped because
//!   their traffic is already counted once on the physical link that carries
//!   it — a VPN or a TUN-mode proxy client would otherwise double the figure.
//! - [`LatencyProbe`] — times a `HEAD` against a URL through the live proxy
//!   policy ([`crate::proxy_config::apply_reqwest_policy`]), on a client it
//!   keeps between probes. Reusing the client keeps the connection alive, so a
//!   probe after the first measures one request round trip rather than DNS +
//!   TCP + TLS every time. The client is rebuilt whenever the target origin or
//!   the proxy configuration changes, so it never carries a stale route or
//!   stale credentials (the hazard [`crate::proxy_config::managed_client`]
//!   warns about for clients cached in struct fields).
//!
//! Any HTTP answer counts as a measurement: the probe sends no credentials, so
//! a provider answering 401 / 404 / 405 is exactly as reachable as one
//! answering 200. Only a transport failure is a failure.

use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use sysinfo::Networks;
use tokio::sync::Mutex;

use crate::proxy_config::{self, ProxyRouteSummary};

/// One interface's cumulative counters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceCounters {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

/// Cumulative counters over every counted interface, plus the breakdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCounters {
    /// Sum of `interfaces[].rx_bytes`.
    pub rx_bytes: u64,
    /// Sum of `interfaces[].tx_bytes`.
    pub tx_bytes: u64,
    /// Counted interfaces, busiest (by total bytes) first.
    pub interfaces: Vec<InterfaceCounters>,
    /// Wall-clock milliseconds when the counters were read, so the caller's
    /// rate is computed over the real interval rather than its timer's.
    pub at_ms: u64,
}

/// Short BSD/Linux interface families that are not a physical link of their
/// own: loopback, tunnels, PPP, Apple's peer-to-peer / access-point / 6to4
/// interfaces. Matched only as `<family><digits>` (`lo0`, `utun3`, `ap1`), so
/// a Windows name that merely starts with the letters ("Local Area
/// Connection") still counts.
const SKIPPED_FAMILIES: &[&str] = &[
    "lo", "utun", "tun", "tap", "wg", "ipsec", "ppp", "gif", "stf", "awdl", "llw", "anpi", "ap",
    "bridge", "vmnet", "vboxnet", "virbr", "docker",
];

/// Prefixes that name a virtual interface whatever follows them: container
/// veth pairs, Docker networks, overlay VPNs, Windows tunnel adapters.
const SKIPPED_PREFIXES: &[&str] = &[
    "veth",
    "br-",
    "zt",
    "tailscale",
    "isatap",
    "teredo",
    "vethernet",
];

/// Substrings that mark a virtual interface on Windows, where names are
/// descriptive ("Loopback Pseudo-Interface 1", "VirtualBox Host-Only").
const SKIPPED_SUBSTRINGS: &[&str] = &["loopback", "pseudo-interface", "virtual", "vpn"];

fn is_family_member(name: &str, family: &str) -> bool {
    name.strip_prefix(family)
        .is_some_and(|rest| rest.chars().all(|c| c.is_ascii_digit()))
}

/// Whether `name` is an interface whose bytes reach the network and are not
/// already counted on another interface.
pub fn is_counted_interface(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    if SKIPPED_FAMILIES
        .iter()
        .any(|family| is_family_member(&lower, family))
    {
        return false;
    }
    if SKIPPED_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        return false;
    }
    !SKIPPED_SUBSTRINGS
        .iter()
        .any(|needle| lower.contains(needle))
}

/// Fold raw `(name, rx, tx)` triples into [`NetworkCounters`], keeping only the
/// counted interfaces. Pure, so the filter and the sums are testable without
/// the host's real interfaces.
pub fn summarize_counters<I, S>(raw: I, at_ms: u64) -> NetworkCounters
where
    I: IntoIterator<Item = (S, u64, u64)>,
    S: Into<String>,
{
    let mut interfaces: Vec<InterfaceCounters> = raw
        .into_iter()
        .map(|(name, rx_bytes, tx_bytes)| InterfaceCounters {
            name: name.into(),
            rx_bytes,
            tx_bytes,
        })
        .filter(|iface| is_counted_interface(&iface.name))
        .collect();
    interfaces.sort_by(|a, b| {
        (b.rx_bytes.saturating_add(b.tx_bytes))
            .cmp(&a.rx_bytes.saturating_add(a.tx_bytes))
            .then_with(|| a.name.cmp(&b.name))
    });
    let rx_bytes = interfaces
        .iter()
        .fold(0u64, |acc, iface| acc.saturating_add(iface.rx_bytes));
    let tx_bytes = interfaces
        .iter()
        .fold(0u64, |acc, iface| acc.saturating_add(iface.tx_bytes));
    NetworkCounters {
        rx_bytes,
        tx_bytes,
        interfaces,
        at_ms,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read the machine's cumulative interface counters right now.
pub fn read_interface_counters() -> NetworkCounters {
    let networks = Networks::new_with_refreshed_list();
    summarize_counters(
        networks.iter().map(|(name, data)| {
            (
                name.clone(),
                data.total_received(),
                data.total_transmitted(),
            )
        }),
        now_ms(),
    )
}

/// Upper bound on one probe. A slower answer is reported as a timeout: on a
/// status bar a number past this is no more useful than "unreachable".
pub const DEFAULT_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// One latency measurement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencySample {
    /// `true` when an HTTP answer arrived (any status).
    pub ok: bool,
    /// Round trip of the measured request, in milliseconds. On a reused
    /// connection this is one request; on a fresh one it is the warm request
    /// that follows the connection setup (see `connect_ms`).
    pub latency_ms: Option<u64>,
    /// Total time of the request that opened a new connection (DNS + TCP +
    /// TLS + request), when this probe had to open one.
    pub connect_ms: Option<u64>,
    /// HTTP status of the measured answer.
    pub status: Option<u16>,
    /// Host the probe went to, for the UI's "to api.example.com" line.
    pub host: String,
    /// Direct or through which proxy.
    pub route: Option<ProxyRouteSummary>,
    /// Short transport error, when `ok` is false.
    pub error: Option<String>,
    pub at_ms: u64,
}

struct CachedClient {
    key: String,
    client: reqwest::Client,
}

/// A latency prober that keeps its connection between probes.
#[derive(Default)]
pub struct LatencyProbe {
    cached: Mutex<Option<CachedClient>>,
}

/// The process-wide prober the desktop commands share.
pub fn shared_latency_probe() -> &'static LatencyProbe {
    static PROBE: std::sync::OnceLock<LatencyProbe> = std::sync::OnceLock::new();
    PROBE.get_or_init(LatencyProbe::default)
}

/// Origin of `url` (`scheme://host:port`), or `None` for a URL with no host.
fn origin_of(url: &reqwest::Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
        None => format!("{}://{}", url.scheme(), host),
    })
}

/// Cache key: the target origin plus a digest of the live proxy config, so a
/// changed route *or* changed credentials both force a fresh client without
/// keeping the credentials themselves in the key.
fn client_key(origin: &str, config_json: &str) -> String {
    let digest = Sha256::digest(config_json.as_bytes());
    format!("{origin}#{}", hex::encode(digest))
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

impl LatencyProbe {
    /// Time one `HEAD` against `url` through the live proxy policy.
    pub async fn probe(&self, url: &str, timeout: Duration) -> LatencySample {
        let at_ms = now_ms();
        let failure =
            |host: String, route: Option<ProxyRouteSummary>, error: String| LatencySample {
                ok: false,
                latency_ms: None,
                connect_ms: None,
                status: None,
                host,
                route,
                error: Some(error),
                at_ms,
            };

        let parsed = match reqwest::Url::parse(url) {
            Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => parsed,
            Ok(_) => return failure(String::new(), None, "unsupported URL scheme".into()),
            Err(error) => return failure(String::new(), None, format!("invalid URL: {error}")),
        };
        let host = parsed.host_str().unwrap_or_default().to_string();
        let Some(origin) = origin_of(&parsed) else {
            return failure(host, None, "URL has no host".into());
        };
        let config = match proxy_config::current() {
            Ok(config) => config,
            Err(error) => return failure(host, None, error.to_string()),
        };
        let config_json = serde_json::to_string(&config).unwrap_or_default();
        let key = client_key(&origin, &config_json);

        let mut cached = self.cached.lock().await;
        let mut route = None;
        let fresh = cached.as_ref().map(|c| c.key != key).unwrap_or(true);
        if fresh {
            proxy_config::ensure_crypto_provider();
            let builder = reqwest::Client::builder()
                .timeout(timeout)
                .pool_idle_timeout(Duration::from_secs(120))
                .pool_max_idle_per_host(1);
            let (builder, summary) = match proxy_config::apply_reqwest_policy(builder, url) {
                Ok(applied) => applied,
                Err(error) => return failure(host, None, error.to_string()),
            };
            let client = match builder.build() {
                Ok(client) => client,
                Err(error) => {
                    return failure(host, Some(summary), format!("client build failed: {error}"))
                }
            };
            route = Some(summary);
            *cached = Some(CachedClient { key, client });
        } else if let Ok((_, summary)) =
            proxy_config::apply_reqwest_policy(reqwest::Client::builder(), url)
        {
            route = Some(summary);
        }
        let client = cached
            .as_ref()
            .map(|c| c.client.clone())
            .expect("client cached above");
        drop(cached);

        let send = |client: reqwest::Client| {
            let url = parsed.clone();
            async move {
                let started = Instant::now();
                let result = client.head(url).send().await;
                (elapsed_ms(started), result)
            }
        };

        let (first_ms, first) = send(client.clone()).await;
        let first = match first {
            Ok(response) => response,
            Err(error) => {
                // A dead pooled connection or a changed network: drop the
                // client so the next probe starts clean.
                *self.cached.lock().await = None;
                return LatencySample {
                    latency_ms: None,
                    ..failure(host, route, error.without_url().to_string())
                };
            }
        };
        if !fresh {
            return LatencySample {
                ok: true,
                latency_ms: Some(first_ms),
                connect_ms: None,
                status: Some(first.status().as_u16()),
                host,
                route,
                error: None,
                at_ms,
            };
        }

        // The first request on a new client paid for the connection. Measure
        // once more on the now-open connection for the round trip itself.
        let status = first.status().as_u16();
        drop(first);
        let (warm_ms, warm) = send(client).await;
        match warm {
            Ok(response) => LatencySample {
                ok: true,
                latency_ms: Some(warm_ms),
                connect_ms: Some(first_ms),
                status: Some(response.status().as_u16()),
                host,
                route,
                error: None,
                at_ms,
            },
            // The setup request answered, so the endpoint is reachable; report
            // what was measured rather than a failure.
            Err(_) => LatencySample {
                ok: true,
                latency_ms: Some(first_ms),
                connect_ms: Some(first_ms),
                status: Some(status),
                host,
                route,
                error: None,
                at_ms,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_physical_interfaces_only() {
        for name in [
            "en0",
            "en1",
            "eth0",
            "wlan0",
            "wlp2s0",
            "Wi-Fi",
            "Ethernet",
            "enp3s0",
            // Starts with "lo" / "ap" letters but is a real adapter.
            "Local Area Connection",
            "apple-wifi",
        ] {
            assert!(is_counted_interface(name), "{name} should count");
        }
        for name in [
            "lo",
            "lo0",
            "utun3",
            "tun0",
            "wg0",
            "awdl0",
            "llw0",
            "bridge0",
            "docker0",
            "veth12ab",
            "br-1a2b",
            "vmnet8",
            "tailscale0",
            "Loopback Pseudo-Interface 1",
            "vEthernet (WSL)",
            "VirtualBox Host-Only Network",
            "",
        ] {
            assert!(!is_counted_interface(name), "{name:?} should be skipped");
        }
    }

    #[test]
    fn sums_counted_interfaces_and_orders_busiest_first() {
        let counters = summarize_counters(
            vec![
                ("lo0", 9_000, 9_000),
                ("en1", 10, 5),
                ("en0", 1_000, 200),
                ("utun2", 800, 100),
            ],
            42,
        );
        assert_eq!(counters.rx_bytes, 1_010);
        assert_eq!(counters.tx_bytes, 205);
        assert_eq!(counters.at_ms, 42);
        let names: Vec<_> = counters
            .interfaces
            .iter()
            .map(|i| i.name.as_str())
            .collect();
        assert_eq!(names, ["en0", "en1"]);
    }

    #[test]
    fn saturates_instead_of_overflowing() {
        let counters = summarize_counters(vec![("en0", u64::MAX, 1), ("en1", 5, u64::MAX)], 0);
        assert_eq!(counters.rx_bytes, u64::MAX);
        assert_eq!(counters.tx_bytes, u64::MAX);
    }

    #[test]
    fn reads_the_hosts_counters_without_panicking() {
        let counters = read_interface_counters();
        assert!(counters.at_ms > 0);
        assert!(counters
            .interfaces
            .iter()
            .all(|i| is_counted_interface(&i.name)));
    }

    #[test]
    fn cache_key_changes_with_origin_and_config_but_hides_the_config() {
        let a = client_key("https://api.example.com", r#"{"password":"hunter2"}"#);
        let b = client_key("https://api.example.com", r#"{"password":"other"}"#);
        let c = client_key("https://api.other.com", r#"{"password":"hunter2"}"#);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert!(!a.contains("hunter2"));
        assert_eq!(
            a,
            client_key("https://api.example.com", r#"{"password":"hunter2"}"#)
        );
    }

    #[test]
    fn origin_keeps_explicit_ports() {
        let url = reqwest::Url::parse("http://localhost:11434/v1").unwrap();
        assert_eq!(origin_of(&url).as_deref(), Some("http://localhost:11434"));
        let url = reqwest::Url::parse("https://api.example.com/v1").unwrap();
        assert_eq!(origin_of(&url).as_deref(), Some("https://api.example.com"));
    }

    #[tokio::test]
    async fn rejects_non_http_urls_without_touching_the_network() {
        let probe = LatencyProbe::default();
        let sample = probe
            .probe("ftp://example.com", Duration::from_secs(1))
            .await;
        assert!(!sample.ok);
        assert_eq!(sample.error.as_deref(), Some("unsupported URL scheme"));
        let sample = probe.probe("not a url", Duration::from_secs(1)).await;
        assert!(!sample.ok);
        assert!(sample.error.unwrap().starts_with("invalid URL"));
    }

    #[tokio::test]
    async fn measures_a_warm_round_trip_and_reuses_the_connection() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let _guard = proxy_config::NETWORK_ENV_TEST.lock().await;
        proxy_config::apply_current(proxy_config::ProxyConfig::default())
            .expect("direct policy applies");
        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let probe = LatencyProbe::default();
        let url = format!("{}/v1", server.uri());

        let first = probe.probe(&url, Duration::from_secs(5)).await;
        assert!(first.ok, "{first:?}");
        // Any answer is a measurement — the probe carries no credentials.
        assert_eq!(first.status, Some(404));
        assert!(first.latency_ms.is_some());
        assert!(
            first.connect_ms.is_some(),
            "a fresh client reports its setup"
        );
        assert_eq!(first.host, "127.0.0.1");

        let second = probe.probe(&url, Duration::from_secs(5)).await;
        assert!(second.ok);
        assert!(
            second.connect_ms.is_none(),
            "the pooled connection is reused"
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn reports_an_unreachable_endpoint_as_a_failure() {
        let _guard = proxy_config::NETWORK_ENV_TEST.lock().await;
        proxy_config::apply_current(proxy_config::ProxyConfig::default())
            .expect("direct policy applies");
        let probe = LatencyProbe::default();
        // Port 9 (discard) on loopback: nothing listens there.
        let sample = probe
            .probe("http://127.0.0.1:9/", Duration::from_secs(2))
            .await;
        assert!(!sample.ok);
        assert!(sample.latency_ms.is_none());
        assert!(sample.error.is_some());
    }
}
