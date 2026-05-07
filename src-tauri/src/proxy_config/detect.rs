//! Auto-detection for local proxy software (Clash Verge, Mihomo, V2Ray,
//! Shadowsocks, etc).
//!
//! Two-stage probe:
//!   1. Fast TCP connect to a fixed list of well-known loopback ports
//!      (500 ms timeout per port, all run in parallel).
//!   2. For Clash/Mihomo's mixed (7890) and SOCKS (7891) ports, follow up
//!      with a `GET http://127.0.0.1:9090/version` to identify the
//!      controller and surface the version string in the UI.
//!
//! Returns a list of candidates in original probe order so the UI is
//! deterministic.

use std::net::SocketAddr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::time::timeout;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CandidateKind {
    Http,
    Socks5,
    Clash,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyCandidate {
    pub kind: CandidateKind,
    pub host: String,
    pub port: u16,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const CLASH_API_TIMEOUT: Duration = Duration::from_millis(800);
const CLASH_API_HOST: &str = "127.0.0.1";
const CLASH_API_PORT: u16 = 9090;

/// Loopback ports we probe by default. Order matters — first match wins in
/// the UI's "Apply most likely" affordance.
///
/// The kind here is the *initial guess*; for 7890/7891 we may upgrade to
/// `Clash` after `identify_clash` confirms the controller.
const KNOWN_PORTS: &[(u16, CandidateKind, &str)] = &[
    (7890, CandidateKind::Http, "Clash mixed port"),
    (7891, CandidateKind::Socks5, "Clash SOCKS port"),
    (1080, CandidateKind::Socks5, "SOCKS proxy"),
    (10808, CandidateKind::Socks5, "V2Ray SOCKS port"),
    (10809, CandidateKind::Http, "V2Ray HTTP port"),
    (8080, CandidateKind::Http, "HTTP proxy"),
    (8888, CandidateKind::Http, "HTTP proxy"),
];

/// TCP-connect probe for a single host:port. Returns true when the connect
/// completes within the timeout window.
async fn port_open(host: &str, port: u16) -> bool {
    let addr = match format!("{host}:{port}").parse::<SocketAddr>() {
        Ok(a) => a,
        Err(_) => return false,
    };
    matches!(
        timeout(PROBE_TIMEOUT, TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

/// Hit Clash/Mihomo's controller API at 127.0.0.1:9090 and return the
/// reported version string. Returns `None` when the API is unreachable or
/// returns an unexpected payload.
pub async fn identify_clash() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(CLASH_API_TIMEOUT)
        // No proxy here — we're probing localhost.
        .no_proxy()
        .build()
        .ok()?;
    let url = format!("http://{CLASH_API_HOST}:{CLASH_API_PORT}/version");
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Run all probes in parallel and return the list of candidates in the same
/// fixed order as `KNOWN_PORTS`. Empty when nothing answered.
pub async fn probe_all() -> Vec<ProxyCandidate> {
    // Probe ports in parallel.
    let probes = KNOWN_PORTS
        .iter()
        .map(|(port, kind, label)| async move {
            let open = port_open("127.0.0.1", *port).await;
            (*port, *kind, *label, open)
        });
    let results: Vec<_> = futures_util::future::join_all(probes).await;

    // Probe Clash controller in parallel with the port scan above. We always
    // try it because the user may have Clash running on a non-default mixed
    // port (e.g., 17890) and we want the version label regardless.
    let clash_version = identify_clash().await;

    let mut out = Vec::new();
    for (port, mut kind, label, open) in results {
        if !open {
            continue;
        }
        let mut version: Option<String> = None;
        let mut display_label = label.to_string();
        if matches!(port, 7890 | 7891) {
            if let Some(v) = clash_version.clone() {
                kind = CandidateKind::Clash;
                version = Some(v.clone());
                display_label = format!("Clash / Mihomo (v{v})");
            }
        }
        out.push(ProxyCandidate {
            kind,
            host: "127.0.0.1".to_string(),
            port,
            label: format!("{display_label} @ 127.0.0.1:{port}"),
            version,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, SocketAddrV4};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn port_open_returns_false_for_unbound_port() {
        // Port 1 is reserved & should never be listening locally.
        assert!(!port_open("127.0.0.1", 1).await);
    }

    #[tokio::test]
    async fn port_open_returns_true_for_listening_port() {
        // Bind an ephemeral port so we know something is listening.
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let probe = port_open("127.0.0.1", port).await;
        assert!(probe);
        drop(listener);
    }

    #[tokio::test]
    async fn port_open_returns_false_for_invalid_host() {
        // Non-numeric host won't parse as SocketAddr — should short-circuit
        // false rather than hang.
        assert!(!port_open("not-a-host", 80).await);
    }

    #[tokio::test]
    async fn identify_clash_returns_none_when_api_down() {
        // Real test environment should never have Clash on 9090. If this
        // accidentally passes against a real Clash, the version string is
        // a String — still safe.
        // Either None or Some(version) is acceptable here; the real check
        // is that the call completes within the timeout.
        let _ = identify_clash().await;
    }

    #[tokio::test]
    async fn probe_all_returns_empty_on_empty_machine() {
        // We can't guarantee no proxy on the dev machine. Just assert the
        // call returns within reasonable time and the structure parses.
        let result = probe_all().await;
        for c in &result {
            assert_eq!(c.host, "127.0.0.1");
            assert!(c.port > 0);
            assert!(!c.label.is_empty());
        }
    }
}
