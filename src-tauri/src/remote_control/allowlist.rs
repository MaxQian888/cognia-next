//! Tiny IPv4 CIDR matcher. The remote-control inbound listener binds to
//! 127.0.0.1 only, so the allowlist is mostly a defence-in-depth check that
//! keeps off-loopback callers (which the OS could in theory route via raw
//! socket tricks) from reaching our endpoints.
//!
//! Supported syntax:
//!   - bare IPv4: `192.168.1.1`
//!   - IPv4 CIDR: `127.0.0.1/32`, `10.0.0.0/8`, `0.0.0.0/0`
//!
//! Anything else (IPv6, DNS, garbage) is rejected at parse time.

use std::net::Ipv4Addr;

pub struct ParsedAllowlist {
    entries: Vec<(Ipv4Addr, u8)>,
}

impl ParsedAllowlist {
    pub fn parse(raw: &[String]) -> Result<Self, String> {
        let mut entries = Vec::with_capacity(raw.len());
        for entry in raw {
            entries.push(parse_cidr(entry).map_err(|e| format!("invalid allowlist entry '{entry}': {e}"))?);
        }
        Ok(Self { entries })
    }

    pub fn contains(&self, addr: Ipv4Addr) -> bool {
        for (network, prefix) in &self.entries {
            if matches_cidr(addr, *network, *prefix) {
                return true;
            }
        }
        false
    }
}

fn parse_cidr(raw: &str) -> Result<(Ipv4Addr, u8), String> {
    let trimmed = raw.trim();
    let (addr_part, prefix) = match trimmed.split_once('/') {
        Some((a, p)) => {
            let p: u8 = p.parse().map_err(|_| "prefix is not a number")?;
            if p > 32 {
                return Err("prefix > 32".into());
            }
            (a, p)
        }
        None => (trimmed, 32),
    };
    let addr: Ipv4Addr = addr_part.parse().map_err(|_| "address is not IPv4")?;
    Ok((addr, prefix))
}

fn matches_cidr(addr: Ipv4Addr, network: Ipv4Addr, prefix: u8) -> bool {
    if prefix == 0 {
        return true;
    }
    let mask: u32 = (!0u32) << (32 - prefix as u32);
    let a = u32::from(addr) & mask;
    let n = u32::from(network) & mask;
    a == n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_default() {
        let list = ParsedAllowlist::parse(&["127.0.0.1/32".to_string()]).unwrap();
        assert!(list.contains(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!list.contains(Ipv4Addr::new(127, 0, 0, 2)));
        assert!(!list.contains(Ipv4Addr::new(10, 0, 0, 1)));
    }

    #[test]
    fn bare_ip_treated_as_slash_32() {
        let list = ParsedAllowlist::parse(&["192.168.1.1".to_string()]).unwrap();
        assert!(list.contains(Ipv4Addr::new(192, 168, 1, 1)));
        assert!(!list.contains(Ipv4Addr::new(192, 168, 1, 2)));
    }

    #[test]
    fn slash_eight_covers_octet() {
        let list = ParsedAllowlist::parse(&["10.0.0.0/8".to_string()]).unwrap();
        assert!(list.contains(Ipv4Addr::new(10, 0, 0, 1)));
        assert!(list.contains(Ipv4Addr::new(10, 255, 255, 254)));
        assert!(!list.contains(Ipv4Addr::new(11, 0, 0, 1)));
    }

    #[test]
    fn slash_zero_is_open() {
        let list = ParsedAllowlist::parse(&["0.0.0.0/0".to_string()]).unwrap();
        assert!(list.contains(Ipv4Addr::new(8, 8, 8, 8)));
    }

    #[test]
    fn rejects_garbage() {
        assert!(ParsedAllowlist::parse(&["bogus".to_string()]).is_err());
        assert!(ParsedAllowlist::parse(&["10.0.0.1/33".to_string()]).is_err());
        assert!(ParsedAllowlist::parse(&["10.0.0.1/abc".to_string()]).is_err());
    }

    #[test]
    fn empty_list_denies_everything() {
        let list = ParsedAllowlist::parse(&[]).unwrap();
        assert!(!list.contains(Ipv4Addr::new(127, 0, 0, 1)));
    }
}
