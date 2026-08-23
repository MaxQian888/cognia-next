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
// The domain-match and request-parse logic is pure and unit-tested on every
// host; the async server is exercised by the Linux/macOS integration tests.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Match a single allowlist pattern against a host. Supports an exact match
/// and a leading-`*.` wildcard. `*.example.com` matches `a.example.com` and
/// `a.b.example.com` but NOT the bare `example.com` (matches srt semantics);
/// an IP literal never matches a wildcard pattern.
pub fn matches_domain_pattern(pattern: &str, host: &str) -> bool {
    let pattern = pattern.trim().to_ascii_lowercase();
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if pattern.is_empty() || host.is_empty() {
        return false;
    }
    if let Some(suffix) = pattern.strip_prefix("*.") {
        if suffix.is_empty() || host.parse::<std::net::IpAddr>().is_ok() {
            return false;
        }
        return host.ends_with(&format!(".{suffix}"));
    }
    pattern == host
}

/// Validate the CONNECT authority before it is matched against the allowlist
/// or handed to the resolver. This closes the parser/resolver **differential**
/// bypass class — the bug that defeated Claude Code's network allowlist twice
/// (CVE-2025-66479 + the SOCKS5 null-byte follow-up): a host carrying an
/// embedded `\0` / CR / LF / `%` / other non-DNS byte can be matched as one
/// string by a lenient allowlist check yet resolve to a *different* target by
/// `getaddrinfo`. We accept only a syntactically valid DNS name or an IP
/// literal, so the string the allowlist sees is exactly the string the
/// resolver sees.
pub fn is_valid_hostname(host: &str) -> bool {
    // IP literals are always syntactically safe (the wildcard matcher already
    // refuses to treat them as domains).
    if host.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    // Accept a single trailing dot (FQDN form) but require non-empty labels.
    let core = host.strip_suffix('.').unwrap_or(host);
    if core.is_empty() {
        return false;
    }
    core.split('.').all(|label| {
        let bytes = label.as_bytes();
        !bytes.is_empty()
            && bytes.len() <= 63
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
            && bytes[0] != b'-'
            && bytes[bytes.len() - 1] != b'-'
    })
}

/// True when `host` is a syntactically valid authority AND matches any
/// allowlist pattern. The validity gate runs first so a malformed host can
/// never be allowed, regardless of allowlist contents.
pub fn is_host_allowed(host: &str, allowlist: &[String]) -> bool {
    if !is_valid_hostname(host) {
        return false;
    }
    allowlist.iter().any(|p| matches_domain_pattern(p, host))
}

/// True when an IPv4 address is in the carrier-grade-NAT shared range
/// 100.64.0.0/10 (RFC 6598) — not a public destination.
fn is_cgnat_v4(v4: &Ipv4Addr) -> bool {
    let o = v4.octets();
    o[0] == 100 && (o[1] & 0xc0) == 64
}

fn is_forbidden_v4(v4: &Ipv4Addr) -> bool {
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local() // 169.254.0.0/16 — incl. the cloud metadata IP.
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_multicast()
        || v4.is_documentation()
        || is_cgnat_v4(v4)
}

/// fc00::/7 — IPv6 unique-local addresses (the RFC 4193 private range).
fn is_ula_v6(v6: &Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xfe00) == 0xfc00
}

/// fe80::/10 — IPv6 link-local addresses.
fn is_link_local_v6(v6: &Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xffc0) == 0xfe80
}

/// True when `ip` is NOT a public-routable unicast destination — loopback,
/// link-local (incl. the 169.254.169.254 cloud-metadata endpoint), private /
/// ULA, unspecified, broadcast, multicast, documentation, or CGNAT. The
/// filtering proxy refuses to tunnel to any such address so an allowlisted
/// hostname that resolves (or rebinds) to an internal target cannot become an
/// SSRF primitive against the host's own network.
pub fn is_forbidden_dest_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_v4(v4),
        IpAddr::V6(v6) => {
            // An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) must be judged by
            // its embedded v4 rules, or `::ffff:127.0.0.1` would slip through.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_forbidden_v4(&mapped);
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || is_ula_v6(v6)
                || is_link_local_v6(v6)
        }
    }
}

/// Resolve `host:port` and return the first PUBLIC socket address. Returns
/// `None` when the name does not resolve or every resolved address is a
/// forbidden (internal) destination — the caller then refuses the tunnel.
async fn resolve_public_addr(host: &str, port: u16) -> Option<SocketAddr> {
    let addrs = tokio::net::lookup_host((host, port)).await.ok()?;
    addrs.into_iter().find(|a| !is_forbidden_dest_ip(&a.ip()))
}

/// Parse a CONNECT request line — `CONNECT host:port HTTP/1.1` — into
/// `(host, port)`. Returns `None` for any other method or a malformed
/// authority.
pub fn parse_connect_target(line: &str) -> Option<(String, u16)> {
    let mut parts = line.split_whitespace();
    if !parts.next()?.eq_ignore_ascii_case("CONNECT") {
        return None;
    }
    let authority = parts.next()?;
    let (host, port) = authority.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port))
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

    #[test]
    fn exact_pattern_matches_only_itself() {
        assert!(matches_domain_pattern("api.github.com", "api.github.com"));
        assert!(!matches_domain_pattern("api.github.com", "evil.com"));
        assert!(!matches_domain_pattern(
            "api.github.com",
            "x.api.github.com"
        ));
    }

    #[test]
    fn wildcard_matches_subdomains_not_the_apex() {
        assert!(matches_domain_pattern("*.example.com", "a.example.com"));
        assert!(matches_domain_pattern("*.example.com", "a.b.example.com"));
        assert!(!matches_domain_pattern("*.example.com", "example.com"));
        assert!(!matches_domain_pattern("*.example.com", "notexample.com"));
    }

    #[test]
    fn wildcard_never_matches_ip_literals() {
        assert!(!matches_domain_pattern("*.example.com", "10.0.0.1"));
        assert!(!matches_domain_pattern("*.0.0.1", "10.0.0.1"));
    }

    #[test]
    fn matching_is_case_insensitive_and_trims_trailing_dot() {
        assert!(matches_domain_pattern("API.GitHub.com", "api.github.com."));
    }

    #[test]
    fn empty_inputs_never_match() {
        assert!(!matches_domain_pattern("", "x"));
        assert!(!matches_domain_pattern("x", ""));
        assert!(!matches_domain_pattern("*.", "a.b"));
    }

    #[test]
    fn is_host_allowed_checks_every_pattern() {
        let allow = vec!["api.github.com".to_string(), "*.anthropic.com".to_string()];
        assert!(is_host_allowed("api.github.com", &allow));
        assert!(is_host_allowed("api.anthropic.com", &allow));
        assert!(!is_host_allowed("evil.com", &allow));
    }

    #[test]
    fn valid_hostname_accepts_dns_names_and_ip_literals() {
        assert!(is_valid_hostname("api.github.com"));
        assert!(is_valid_hostname("a-b.example.co.uk"));
        assert!(is_valid_hostname("example.com.")); // FQDN trailing dot
        assert!(is_valid_hostname("10.0.0.1"));
        assert!(is_valid_hostname("::1"));
    }

    #[test]
    fn valid_hostname_rejects_differential_bypass_payloads() {
        // Embedded NUL / CR / LF / percent / space / underscore — the
        // parser-vs-resolver differential class.
        assert!(!is_valid_hostname("api.github.com\u{0}.evil.com"));
        assert!(!is_valid_hostname("api.github.com\r\nHost: evil.com"));
        assert!(!is_valid_hostname("api.github.com%2e.evil.com"));
        assert!(!is_valid_hostname("bad host.com"));
        assert!(!is_valid_hostname("under_score.com"));
        assert!(!is_valid_hostname("-leadingdash.com"));
        assert!(!is_valid_hostname("trailingdash-.com"));
        assert!(!is_valid_hostname("a..b.com")); // empty label
        assert!(!is_valid_hostname(""));
        // Over-long: 64-char label / >253 total.
        assert!(!is_valid_hostname(&format!("{}.com", "a".repeat(64))));
        assert!(!is_valid_hostname(&format!("{}.com", "a.".repeat(200))));
    }

    #[test]
    fn allowlist_never_allows_a_malformed_host_even_if_it_would_pattern_match() {
        // A crafted host that string-contains an allowed name but carries a NUL
        // must be refused — the validity gate runs before pattern matching.
        let allow = vec!["api.github.com".to_string()];
        assert!(!is_host_allowed("api.github.com\u{0}", &allow));
        assert!(!is_host_allowed("api.github.com\r\n", &allow));
    }

    #[test]
    fn forbidden_dest_ip_rejects_internal_and_metadata_targets() {
        use std::str::FromStr;
        for s in [
            "127.0.0.1",        // loopback
            "10.0.0.5",         // RFC1918
            "172.16.3.4",       // RFC1918
            "192.168.1.1",      // RFC1918
            "169.254.169.254",  // cloud metadata (link-local)
            "0.0.0.0",          // unspecified
            "255.255.255.255",  // broadcast
            "100.100.0.1",      // CGNAT 100.64/10
            "::1",              // IPv6 loopback
            "fe80::1",          // IPv6 link-local
            "fc00::1",          // IPv6 ULA
            "::ffff:127.0.0.1", // IPv4-mapped loopback
            "::ffff:10.0.0.1",  // IPv4-mapped RFC1918
        ] {
            let ip = IpAddr::from_str(s).unwrap();
            assert!(is_forbidden_dest_ip(&ip), "{s} should be forbidden");
        }
    }

    #[test]
    fn forbidden_dest_ip_allows_public_targets() {
        use std::str::FromStr;
        for s in ["140.82.112.3", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            let ip = IpAddr::from_str(s).unwrap();
            assert!(!is_forbidden_dest_ip(&ip), "{s} should be allowed");
        }
    }

    #[test]
    fn parse_connect_extracts_host_and_port() {
        assert_eq!(
            parse_connect_target("CONNECT api.github.com:443 HTTP/1.1"),
            Some(("api.github.com".to_string(), 443))
        );
        assert_eq!(
            parse_connect_target("connect example.com:80 HTTP/1.0"),
            Some(("example.com".to_string(), 80))
        );
    }

    #[test]
    fn parse_connect_rejects_non_connect_and_malformed() {
        assert_eq!(parse_connect_target("GET / HTTP/1.1"), None);
        assert_eq!(parse_connect_target("CONNECT noport HTTP/1.1"), None);
        assert_eq!(parse_connect_target("CONNECT :443 HTTP/1.1"), None);
        assert_eq!(parse_connect_target("CONNECT host:notaport HTTP/1.1"), None);
    }
}
