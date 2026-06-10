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

/// True when `host` matches any allowlist pattern.
pub fn is_host_allowed(host: &str, allowlist: &[String]) -> bool {
    allowlist.iter().any(|p| matches_domain_pattern(p, host))
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

    if !is_host_allowed(&host, allow) {
        let _ = client
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            .await;
        return Ok(());
    }

    let mut upstream = match TcpStream::connect((host.as_str(), port)).await {
        Ok(s) => s,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_pattern_matches_only_itself() {
        assert!(matches_domain_pattern("api.github.com", "api.github.com"));
        assert!(!matches_domain_pattern("api.github.com", "evil.com"));
        assert!(!matches_domain_pattern("api.github.com", "x.api.github.com"));
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
