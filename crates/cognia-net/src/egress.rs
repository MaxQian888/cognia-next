//! Pure egress-policy primitives shared by every Cognia egress filter.
//!
//! Two filters enforce host allowlists with these functions: the ADR-0028
//! per-command filtering proxy (`cognia-automation::sandbox::net_proxy`) and the
//! per-tenant sandbox egress proxy (ADR-0185). They live here, below both, so a
//! bypass fixed once is fixed everywhere. Nothing in this module does I/O.
//!
//! Beyond the allowlist matchers this module owns the one list of cloud
//! metadata endpoints that no configuration may ever except (ADR-0182), and a
//! small CIDR type for validating operator-declared internal exceptions.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

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

/// Cloud instance-metadata endpoints. A route to one of these hands an
/// untrusted process the node's cloud credentials, so no egress exception — not
/// even an operator's baseline-level one — may ever cover them.
///
/// - `169.254.0.0/16`: the link-local range holding AWS/GCP/Azure/Tencent
///   (`169.254.0.23`) metadata.
/// - `100.100.100.200/32`: Alibaba Cloud ECS metadata (inside CGNAT 100.64/10).
/// - `100.96.0.96/32`: Volcengine ECS metadata (inside CGNAT 100.64/10).
/// - `fd00:ec2::254/128`: the AWS IPv6 metadata endpoint.
pub const METADATA_CIDRS: [&str; 4] = [
    "169.254.0.0/16",
    "100.100.100.200/32",
    "100.96.0.96/32",
    "fd00:ec2::254/128",
];

/// An IP network in CIDR form (`10.0.0.0/8`, `fd00::/8`, or a bare address as a
/// single-host network).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IpCidr {
    network: IpAddr,
    prefix: u8,
}

impl IpCidr {
    /// Parse `addr/prefix` or a bare address. The network address is
    /// normalised (host bits cleared), so `10.1.2.3/8` and `10.0.0.0/8` are
    /// the same network. IPv4-mapped IPv6 input is judged as IPv4.
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        let (addr, prefix) = match value.split_once('/') {
            Some((addr, prefix)) => (addr, Some(prefix.parse::<u8>().ok()?)),
            None => (value, None),
        };
        let mut ip: IpAddr = addr.parse().ok()?;
        let mut prefix = prefix;
        if let IpAddr::V6(v6) = ip {
            if let Some(v4) = v6.to_ipv4_mapped() {
                ip = IpAddr::V4(v4);
                // `::ffff:0:0/96` is the mapped space, so a mapped prefix
                // shorter than 96 describes more than IPv4 and has no v4 form.
                prefix = Some(match prefix {
                    Some(p) => p.checked_sub(96)?,
                    None => 32,
                });
            }
        }
        let max = if ip.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(max);
        if prefix > max {
            return None;
        }
        Some(Self {
            network: mask(ip, prefix),
            prefix,
        })
    }

    pub fn network(&self) -> IpAddr {
        self.network
    }

    pub fn prefix(&self) -> u8 {
        self.prefix
    }

    /// Whether `ip` lies inside this network. IPv4-mapped IPv6 addresses are
    /// compared as IPv4, for the same reason [`is_forbidden_dest_ip`] does.
    pub fn contains(&self, ip: &IpAddr) -> bool {
        let ip = unmap(*ip);
        if ip.is_ipv4() != self.network.is_ipv4() {
            return false;
        }
        mask(ip, self.prefix) == self.network
    }

    /// Whether the two networks share at least one address.
    pub fn overlaps(&self, other: &IpCidr) -> bool {
        if self.network.is_ipv4() != other.network.is_ipv4() {
            return false;
        }
        let shorter = self.prefix.min(other.prefix);
        mask(self.network, shorter) == mask(other.network, shorter)
    }
}

fn unmap(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        other => other,
    }
}

fn mask(ip: IpAddr, prefix: u8) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => {
            let bits = u32::from(v4);
            let masked = if prefix == 0 {
                0
            } else {
                bits & (u32::MAX << (32 - u32::from(prefix)))
            };
            IpAddr::V4(Ipv4Addr::from(masked))
        }
        IpAddr::V6(v6) => {
            let bits = u128::from(v6);
            let masked = if prefix == 0 {
                0
            } else {
                bits & (u128::MAX << (128 - u32::from(prefix)))
            };
            IpAddr::V6(Ipv6Addr::from(masked))
        }
    }
}

/// True when `network` overlaps any cloud metadata endpoint
/// ([`METADATA_CIDRS`]). Used to refuse an egress exception before it is ever
/// stored, not merely at dial time.
pub fn overlaps_metadata(network: &IpCidr) -> bool {
    METADATA_CIDRS
        .iter()
        .filter_map(|cidr| IpCidr::parse(cidr))
        .any(|metadata| metadata.overlaps(network))
}

/// True when `ip` is a cloud metadata endpoint.
pub fn is_metadata_ip(ip: &IpAddr) -> bool {
    METADATA_CIDRS
        .iter()
        .filter_map(|cidr| IpCidr::parse(cidr))
        .any(|metadata| metadata.contains(ip))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn cidr_parses_and_normalises_the_network() {
        let net = IpCidr::parse("10.1.2.3/8").unwrap();
        assert_eq!(net.network(), "10.0.0.0".parse::<IpAddr>().unwrap());
        assert_eq!(net.prefix(), 8);
        assert_eq!(IpCidr::parse("10.0.0.0/8"), Some(net));
        let host = IpCidr::parse("192.0.2.7").unwrap();
        assert_eq!(host.prefix(), 32);
        assert_eq!(IpCidr::parse("fd00::/8").unwrap().prefix(), 8);
    }

    #[test]
    fn cidr_rejects_malformed_input() {
        for bad in [
            "",
            "10.0.0.0/33",
            "fd00::/129",
            "not-an-ip/8",
            "10.0.0.0/x",
            "10.0.0/8",
        ] {
            assert!(IpCidr::parse(bad).is_none(), "{bad:?} must not parse");
        }
    }

    #[test]
    fn cidr_contains_and_overlaps() {
        let net = IpCidr::parse("10.20.0.0/16").unwrap();
        assert!(net.contains(&"10.20.99.1".parse().unwrap()));
        assert!(!net.contains(&"10.21.0.1".parse().unwrap()));
        assert!(!net.contains(&"fd00::1".parse().unwrap()));
        assert!(net.overlaps(&IpCidr::parse("10.0.0.0/8").unwrap()));
        assert!(net.overlaps(&IpCidr::parse("10.20.5.0/24").unwrap()));
        assert!(!net.overlaps(&IpCidr::parse("10.21.0.0/16").unwrap()));
        assert!(!net.overlaps(&IpCidr::parse("fd00::/8").unwrap()));
    }

    #[test]
    fn ipv4_mapped_addresses_are_judged_as_ipv4() {
        let net = IpCidr::parse("100.100.100.200/32").unwrap();
        assert!(net.contains(&"::ffff:100.100.100.200".parse().unwrap()));
        assert_eq!(
            IpCidr::parse("::ffff:10.0.0.0/104"),
            IpCidr::parse("10.0.0.0/8")
        );
    }

    #[test]
    fn every_cloud_metadata_endpoint_is_recognised() {
        for ip in [
            "169.254.169.254", // AWS / GCP / Azure
            "169.254.0.23",    // Tencent Cloud
            "100.100.100.200", // Alibaba Cloud
            "100.96.0.96",     // Volcengine
            "fd00:ec2::254",   // AWS IPv6
            "::ffff:169.254.169.254",
        ] {
            assert!(
                is_metadata_ip(&ip.parse().unwrap()),
                "{ip} is a metadata endpoint"
            );
        }
        assert!(!is_metadata_ip(&"100.100.2.136".parse().unwrap()));
        assert!(!is_metadata_ip(&"8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn an_exception_covering_a_metadata_endpoint_is_detected() {
        // The whole CGNAT range contains Alibaba's and Volcengine's endpoints.
        assert!(overlaps_metadata(&IpCidr::parse("100.64.0.0/10").unwrap()));
        assert!(overlaps_metadata(
            &IpCidr::parse("169.254.169.254").unwrap()
        ));
        assert!(overlaps_metadata(&IpCidr::parse("0.0.0.0/0").unwrap()));
        // A single internal mirror address next to the endpoint is fine.
        assert!(!overlaps_metadata(
            &IpCidr::parse("100.100.2.136/32").unwrap()
        ));
        assert!(!overlaps_metadata(&IpCidr::parse("10.0.0.0/8").unwrap()));
    }
}
