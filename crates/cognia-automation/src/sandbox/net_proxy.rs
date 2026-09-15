// ADR-0028 Phase 3 — host-side filtering proxy for sandbox network allowlists.
//
// When a sandboxed command opts into `NetworkPolicy::Allowlist { hosts }`, the
// dispatcher starts one of these on `127.0.0.1:<ephemeral>` and injects
// `HTTP(S)_PROXY` / `ALL_PROXY` into the command env. The proxy speaks HTTP
// CONNECT (HTTPS tunnelling — the dominant case for git / package managers /
// API calls) and only forwards to hosts that match the allowlist; everything
// else gets a `403`.
//
// Enforcement model differs per platform (see the backends):
//   * macOS — the SBPL profile denies all network except `localhost:<port>`,
//     so the kernel blocks any connection that tries to skip the proxy. The
//     allowlist is kernel-enforced.
//   * Linux — the command shares the host network and is routed via the proxy
//     env. The proxy enforces the allowlist for proxy-respecting clients;
//     true kernel enforcement needs a netns + unix-socket bridge (tracked as
//     a follow-up). Documented honestly rather than silently weaker.
//
// The domain-match and request-parse logic is pure and lives in
// `cognia_net::egress` (shared with the sandbox egress proxy, ADR-0185), where
// it is unit-tested on every host; the async server is exercised by the
// Linux/macOS integration tests.

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub use cognia_net::egress::{
    is_forbidden_dest_ip, is_host_allowed, is_valid_hostname, matches_domain_pattern,
    parse_connect_target,
};

/// Resolve `host:port` and return the first PUBLIC socket address. Returns
/// `None` when the name does not resolve or every resolved address is a
/// forbidden (internal) destination — the caller then refuses the tunnel.
async fn resolve_public_addr(host: &str, port: u16) -> Option<SocketAddr> {
    let addrs = tokio::net::lookup_host((host, port)).await.ok()?;
    addrs.into_iter().find(|a| !is_forbidden_dest_ip(&a.ip()))
}

/// A running filtering proxy. Aborts its accept loop on drop, so the dispatcher
/// can keep it alive for exactly the duration of one sandboxed command.
pub struct FilteringProxy {
    port: u16,
    handle: tokio::task::JoinHandle<()>,
}

impl FilteringProxy {
    /// Bind an ephemeral loopback port and start accepting CONNECT requests
    /// filtered against `allowlist`.
    pub async fn start(allowlist: Vec<String>) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let allow = Arc::new(allowlist);
        let handle = tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                let allow = Arc::clone(&allow);
                tokio::spawn(async move {
                    let _ = handle_connect(&mut client, &allow).await;
                });
            }
        });
        Ok(Self { port, handle })
    }

    /// The loopback port to point `HTTP(S)_PROXY` / SBPL at.
    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for FilteringProxy {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Maximum CONNECT request header size we'll buffer before giving up.
const MAX_HEADER_BYTES: usize = 16 * 1024;

async fn handle_connect(client: &mut TcpStream, allow: &[String]) -> std::io::Result<()> {
    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let mut tmp = [0u8; 1024];
    loop {
        let n = client.read(&mut tmp).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > MAX_HEADER_BYTES {
            let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
            return Ok(());
        }
    }

    let head = String::from_utf8_lossy(&buf);
    let first_line = head.lines().next().unwrap_or("");
    let Some((host, port)) = parse_connect_target(first_line) else {
        let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return Ok(());
    };

    // Reject a malformed authority (embedded NUL / CR / LF / non-DNS bytes)
    // with a 400 before it ever reaches the allowlist or the resolver — closes
    // the parser/resolver differential bypass class.
    if !is_valid_hostname(&host) {
        let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return Ok(());
    }

    if !is_host_allowed(&host, allow) {
        let _ = client
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            .await;
        return Ok(());
    }

    // Resolve once and pin the connection to a PUBLIC address. This closes the
    // SSRF / DNS-rebinding class: an allowlisted name (or an IP-literal CONNECT
    // target) that resolves to loopback / link-local / RFC1918 / the cloud
    // metadata endpoint (169.254.169.254) is refused before any byte flows, and
    // we connect to the exact vetted address rather than re-resolving.
    let Some(addr) = resolve_public_addr(&host, port).await else {
        let _ = client
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            .await;
        return Ok(());
    };

    let mut upstream = match dial_upstream(&host, port, addr).await {
        Ok(stream) => stream,
        Err(_) => {
            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
            return Ok(());
        }
    };

    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    // Tunnel bytes both ways until either side closes. Reuses tokio's
    // bidirectional copy (same primitive `proxy_config/wsproxy.rs` relies on).
    let _ = tokio::io::copy_bidirectional(client, &mut upstream).await;
    Ok(())
}

/// Open the upstream leg — through the Host's configured proxy when there is
/// one, direct otherwise.
///
/// Without this the sandbox was a proxy hole: a user on a corporate network
/// configures Off/Manual/Auto in Settings, every other outbound path obeys it,
/// and then an allowlisted sandboxed command dials the public internet
/// directly from this loopback forwarder. On a network that only permits
/// egress through the proxy the command simply failed; on one that does not,
/// it silently escaped the policy.
///
/// Two properties are deliberately kept:
///
///   - **Fail-closed on an unusable policy.** A blocked or uninitialized
///     runtime policy is an error, not a fallback to direct.
///   - **The SSRF pin still runs first.** `resolve_public_addr` has already
///     refused loopback / link-local / RFC1918 / `169.254.169.254`. On the
///     direct leg we connect to that exact vetted address. On the proxied leg
///     the proxy must resolve the name itself (that is what a CONNECT tunnel
///     is), so the vetted address is used as an admission check rather than as
///     the dial target — a name that re-resolves between our check and the
///     proxy's is a residual rebinding window that only the proxy can close.
async fn dial_upstream(
    host: &str,
    port: u16,
    vetted: SocketAddr,
) -> std::io::Result<cognia_net::proxy_config::wsproxy::ProxyStream> {
    use cognia_net::proxy_config::{self, ProxyRouteSummary};

    let config = proxy_config::current().map_err(std::io::Error::other)?;
    let target = format!("https://{host}:{port}");
    let route = config.route_for(&target).map_err(std::io::Error::other)?;

    match route {
        ProxyRouteSummary::Direct { .. } => {
            let stream = TcpStream::connect(vetted).await?;
            Ok(Box::new(stream))
        }
        ProxyRouteSummary::Proxy { .. } => {
            proxy_config::wsproxy::connect_via_proxy(&config, host, port)
                .await
                .map_err(std::io::Error::other)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The upstream leg must obey the Host proxy policy.
    ///
    /// One test, not several: the policy is process-wide, so separate tests in
    /// the same binary would race each other's `apply`/`block`.
    #[tokio::test]
    async fn upstream_dial_follows_the_host_proxy_policy() {
        use cognia_net::proxy_config::{
            apply_current, block_current, ProxyConfig, ProxyError, ProxyErrorCode, ProxyMode,
            ProxyProtocol,
        };

        // A real listener stands in for the vetted public address on the
        // direct leg; nothing ever connects to it on the proxied leg.
        let origin = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let vetted = origin.local_addr().unwrap();

        // 1. A blocked policy fails closed — never a silent direct dial.
        block_current(ProxyError::new(
            ProxyErrorCode::ProxyCredentialUnavailable,
            "test",
        ));
        assert!(dial_upstream("api.github.com", 443, vetted).await.is_err());

        // 2. Proxy off → direct, to the exact address `resolve_public_addr`
        //    vetted rather than a re-resolution of the name.
        apply_current(ProxyConfig::default()).unwrap();
        assert!(dial_upstream("api.github.com", 443, vetted).await.is_ok());

        // 3. Proxy on → the direct dial must NOT happen. Pointing the config at
        //    a closed port proves it: a direct fallback would reach `vetted`
        //    and succeed, so an error here is the assertion.
        let closed = {
            let probe = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let port = probe.local_addr().unwrap().port();
            drop(probe);
            port
        };
        apply_current(ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port: closed,
            bypass: vec![],
            ..ProxyConfig::default()
        })
        .unwrap();
        assert!(
            dial_upstream("api.github.com", 443, vetted).await.is_err(),
            "an active proxy must not fall back to a direct dial"
        );

        // 4. A bypassed host still goes direct, so a loopback or intranet
        //    target keeps working while the proxy is on.
        apply_current(ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port: closed,
            bypass: vec!["api.github.com".to_string()],
            ..ProxyConfig::default()
        })
        .unwrap();
        assert!(dial_upstream("api.github.com", 443, vetted).await.is_ok());

        apply_current(ProxyConfig::default()).unwrap();
    }
}
