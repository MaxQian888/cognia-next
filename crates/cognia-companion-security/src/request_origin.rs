//! Where a request to a host listener came from: the one answer every
//! loopback privilege reads.
//!
//! cloudflared connects to the same listener from loopback, so a socket peer
//! of `127.0.0.1` does not mean the caller sits on this machine. Every route
//! that grants something to loopback callers (operator endpoints, service
//! tokens, fleet hooks, single-user Owner invitations, the pre-auth rate-limit
//! exemption) asks [`request_origin`] instead of reading the peer itself.

use std::net::IpAddr;

// `reqwest` re-exports the `http` crate's `HeaderMap`, the same type axum
// hands its handlers, so this crate needs no direct `http` dependency.
use reqwest::header::HeaderMap;

/// Request provenance shared by loopback gates and pre-auth rate limiting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestOrigin {
    /// The socket peer is loopback and no tunnel marked the request.
    pub direct_loopback: bool,
    /// The address to rate-limit by: the tunnel's visitor address when the
    /// local proxy supplied exactly one valid one, otherwise the peer.
    pub client_ip: Option<IpAddr>,
}

/// Classify a request from its socket peer and headers. A missing peer is
/// never loopback, so a privilege cannot be reached without a verified one.
pub fn request_origin(peer: Option<IpAddr>, headers: &HeaderMap) -> RequestOrigin {
    let peer = peer.map(|ip| ip.to_canonical());
    let peer_is_loopback = peer.is_some_and(|ip| ip.is_loopback());
    // cloudflared connects to the same HTTPS listener from loopback. Header
    // presence removes local privileges even when the value is empty, invalid,
    // or itself loopback. CF-Ray also covers a removed visitor-IP header.
    let via_cloudflare = headers.contains_key("cf-connecting-ip") || headers.contains_key("cf-ray");
    // Only the local proxy may supply the rate-limit identity. A LAN client
    // must not rotate buckets by spoofing forwarding headers. Missing or
    // ambiguous IPs fall back to the peer bucket, never to an exemption.
    let forwarded_ip = if peer_is_loopback {
        let mut values = headers.get_all("cf-connecting-ip").iter();
        let ip = values
            .next()
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<IpAddr>().ok());
        ip.filter(|_| values.next().is_none())
            .map(|ip| ip.to_canonical())
    } else {
        None
    };
    RequestOrigin {
        direct_loopback: peer_is_loopback && !via_cloudflare,
        client_ip: forwarded_ip.or(peer),
    }
}

/// Whether a request may use a loopback-only privilege: its peer is loopback
/// and it did not arrive through a tunnel.
pub fn is_direct_loopback(peer: Option<IpAddr>, headers: &HeaderMap) -> bool {
    request_origin(peer, headers).direct_loopback
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn a_plain_loopback_peer_is_direct() {
        let headers = HeaderMap::new();
        assert!(is_direct_loopback(
            Some("127.0.0.1".parse().unwrap()),
            &headers
        ));
        assert!(is_direct_loopback(Some("::1".parse().unwrap()), &headers));
        // An IPv4-mapped loopback is loopback once canonicalized.
        assert!(is_direct_loopback(
            Some("::ffff:127.0.0.1".parse().unwrap()),
            &headers
        ));
    }

    #[test]
    fn a_lan_peer_or_an_unknown_peer_is_not_direct() {
        let headers = HeaderMap::new();
        assert!(!is_direct_loopback(
            Some("192.168.1.20".parse().unwrap()),
            &headers
        ));
        assert!(!is_direct_loopback(None, &headers));
    }

    #[test]
    fn any_tunnel_header_removes_loopback_even_when_empty_or_loopback() {
        let peer = Some("127.0.0.1".parse().unwrap());
        for (name, value) in [
            ("cf-ray", "test-ray-SJC"),
            ("cf-connecting-ip", ""),
            ("cf-connecting-ip", "127.0.0.1"),
            ("cf-connecting-ip", "not an address"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(name, HeaderValue::from_static(value));
            assert!(
                !is_direct_loopback(peer, &headers),
                "{name}: {value:?} kept loopback"
            );
        }
    }

    #[test]
    fn cloudflare_origin_rejects_ambiguous_ips_and_canonicalizes_addresses() {
        let peer = Some("127.0.0.1".parse().unwrap());
        for values in [
            vec![HeaderValue::from_static("198.51.100.1, 198.51.100.2")],
            vec![HeaderValue::from_bytes(&[0xff]).unwrap()],
            vec![
                HeaderValue::from_static("198.51.100.1"),
                HeaderValue::from_static("198.51.100.2"),
            ],
        ] {
            let mut headers = HeaderMap::new();
            for value in values {
                headers.append("cf-connecting-ip", value);
            }
            let origin = request_origin(peer, &headers);
            assert!(!origin.direct_loopback);
            assert_eq!(origin.client_ip, peer);
        }

        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", "::ffff:198.51.100.1".parse().unwrap());
        let origin = request_origin(peer, &headers);
        assert!(!origin.direct_loopback);
        assert_eq!(origin.client_ip, Some("198.51.100.1".parse().unwrap()));
        let unknown = request_origin(None, &headers);
        assert!(!unknown.direct_loopback);
        assert_eq!(unknown.client_ip, None);
    }

    #[test]
    fn a_lan_peer_cannot_choose_its_rate_limit_bucket() {
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());
        let peer: IpAddr = "192.168.1.20".parse().unwrap();
        assert_eq!(request_origin(Some(peer), &headers).client_ip, Some(peer));
    }
}
