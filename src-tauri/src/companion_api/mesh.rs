//! Overlay-network ("mesh VPN") detection for the connectivity settings.
//!
//! Tailscale and ZeroTier are the two ways a phone or a second machine ends
//! up on the Host's "LAN" without being in the same building. They are not
//! part of this app, and this module does not manage them: it only answers
//! whether one is installed on this machine and, if it is up, which address
//! it gave the Host. The settings surface uses that to (a) offer the mesh
//! address as the one the pairing invitation advertises, so a device on the
//! same tailnet pairs over the plain HTTPS/WebSocket tier from anywhere, and
//! (b) point at the install page when nothing is there.
//!
//! Detection is by address and interface name, not by talking to a daemon.
//! Tailscale hands out `100.64.0.0/10` (CGNAT, RFC 6598) and
//! `fd7a:115c:a1e0::/48`. ZeroTier names its interfaces `zt*` (Linux, BSD),
//! `feth*` (macOS) or "ZeroTier One [...]" (Windows). A daemon that is
//! installed but down shows up as `installed: true` with no addresses, which
//! is exactly the state the settings copy needs to name.

use std::net::IpAddr;
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MeshProvider {
    Tailscale,
    Zerotier,
}

/// Every provider this module can name, in the order the UI lists them.
pub const PROVIDERS: [MeshProvider; 2] = [MeshProvider::Tailscale, MeshProvider::Zerotier];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshAddress {
    pub interface: String,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshNetwork {
    pub provider: MeshProvider,
    /// The provider's client binary was found on this machine.
    pub installed: bool,
    /// Addresses the provider's interface currently carries. Empty when the
    /// daemon is down or the machine is not joined to a network.
    pub addresses: Vec<MeshAddress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshStatus {
    pub networks: Vec<MeshNetwork>,
}

/// Tailscale's IPv4 range is the CGNAT block, `100.64.0.0/10`.
fn is_tailscale_v4(octets: [u8; 4]) -> bool {
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

/// Tailscale's IPv6 range, `fd7a:115c:a1e0::/48`.
fn is_tailscale_v6(segments: [u16; 8]) -> bool {
    segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0
}

/// Which provider, if any, an interface + address pair belongs to. Pure.
pub fn classify(interface: &str, address: IpAddr) -> Option<MeshProvider> {
    let lower = interface.to_ascii_lowercase();
    // Name first: ZeroTier hands out arbitrary ranges, so its interface is the
    // only tell, and a `zt*` interface carrying a CGNAT address is ZeroTier.
    if lower.starts_with("zt") || lower.starts_with("feth") || lower.contains("zerotier") {
        return Some(MeshProvider::Zerotier);
    }
    if lower.starts_with("tailscale") {
        return Some(MeshProvider::Tailscale);
    }
    match address {
        IpAddr::V4(v4) if is_tailscale_v4(v4.octets()) => Some(MeshProvider::Tailscale),
        IpAddr::V6(v6) if is_tailscale_v6(v6.segments()) => Some(MeshProvider::Tailscale),
        _ => None,
    }
}

/// Group a machine's interfaces by provider. Pure. The order of `PROVIDERS`
/// is kept so the UI is stable across polls.
pub fn group(
    interfaces: &[(String, IpAddr)],
    installed: impl Fn(MeshProvider) -> bool,
) -> MeshStatus {
    let networks = PROVIDERS
        .iter()
        .map(|&provider| MeshNetwork {
            provider,
            installed: installed(provider),
            addresses: interfaces
                .iter()
                .filter(|(name, address)| classify(name, *address) == Some(provider))
                .map(|(name, address)| MeshAddress {
                    interface: name.clone(),
                    address: address.to_string(),
                })
                .collect(),
        })
        .collect();
    MeshStatus { networks }
}

/// Where each provider's client binary lives when it is installed the usual
/// way, beyond `PATH`: the macOS app bundles and the Windows installers do
/// not put their CLI on `PATH`.
fn well_known_binaries(provider: MeshProvider) -> &'static [&'static str] {
    match provider {
        MeshProvider::Tailscale => &[
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/usr/bin/tailscale",
            "/usr/local/bin/tailscale",
            "C:\\Program Files\\Tailscale\\tailscale.exe",
        ],
        MeshProvider::Zerotier => &[
            "/usr/sbin/zerotier-cli",
            "/usr/local/bin/zerotier-cli",
            "/Library/Application Support/ZeroTier/One/zerotier-cli",
            "C:\\ProgramData\\ZeroTier\\One\\zerotier-one_x64.exe",
        ],
    }
}

fn path_binary_names(provider: MeshProvider) -> &'static [&'static str] {
    match provider {
        MeshProvider::Tailscale => &["tailscale", "tailscale.exe"],
        MeshProvider::Zerotier => &["zerotier-cli", "zerotier-cli.exe"],
    }
}

/// Whether the provider's client is on this machine. Checks `PATH` and the
/// well-known install locations. Never runs the binary.
pub fn is_installed(provider: MeshProvider, path_var: Option<&std::ffi::OsStr>) -> bool {
    let on_path = path_var.is_some_and(|path_var| {
        std::env::split_paths(path_var)
            .filter(|dir| !dir.as_os_str().is_empty())
            .any(|dir| {
                path_binary_names(provider)
                    .iter()
                    .any(|name| dir.join(name).is_file())
            })
    });
    on_path
        || well_known_binaries(provider)
            .iter()
            .any(|p| Path::new(p).is_file())
}

/// The live answer for this machine.
pub fn detect() -> MeshStatus {
    let interfaces: Vec<(String, IpAddr)> = match local_ip_address::list_afinet_netifas() {
        Ok(list) => list,
        Err(error) => {
            log::warn!("mesh detect: could not enumerate interfaces: {error}");
            Vec::new()
        }
    };
    let path_var = std::env::var_os("PATH");
    group(&interfaces, |provider| {
        is_installed(provider, path_var.as_deref())
    })
}

/// The first usable mesh address, for the settings surface's "advertise this
/// instead" offer. IPv4 first: an IPv6 literal in a base URL needs brackets
/// and a phone on the same tailnet always has the v4 one.
pub fn preferred_address(status: &MeshStatus) -> Option<(MeshProvider, String)> {
    let pick = |v4: bool| {
        status.networks.iter().find_map(|network| {
            network
                .addresses
                .iter()
                .find(|address| address.address.contains(':') != v4)
                .map(|address| (network.provider, address.address.clone()))
        })
    };
    pick(true).or_else(|| pick(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn classifies_tailscale_by_cgnat_range_and_zerotier_by_interface_name() {
        assert_eq!(
            classify("utun4", IpAddr::V4(Ipv4Addr::new(100, 101, 2, 3))),
            Some(MeshProvider::Tailscale)
        );
        assert_eq!(
            classify("tailscale0", IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))),
            Some(MeshProvider::Tailscale)
        );
        assert_eq!(
            classify(
                "utun4",
                IpAddr::V6(Ipv6Addr::new(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 1))
            ),
            Some(MeshProvider::Tailscale)
        );
        assert_eq!(
            classify("zt5u4uptm3", IpAddr::V4(Ipv4Addr::new(10, 147, 17, 5))),
            Some(MeshProvider::Zerotier)
        );
        assert_eq!(
            classify("feth4593", IpAddr::V4(Ipv4Addr::new(192, 168, 191, 5))),
            Some(MeshProvider::Zerotier)
        );
        assert_eq!(
            classify(
                "ZeroTier One [a1b2c3]",
                IpAddr::V4(Ipv4Addr::new(10, 1, 1, 1))
            ),
            Some(MeshProvider::Zerotier)
        );
        // A plain LAN address on a plain interface is nobody's mesh.
        assert_eq!(
            classify("en0", IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10))),
            None
        );
        // 100.128.x.x is outside /10 (second octet must be 64..=127).
        assert_eq!(
            classify("en0", IpAddr::V4(Ipv4Addr::new(100, 128, 0, 1))),
            None
        );
        // A ZeroTier interface that happens to carry a CGNAT address is ZeroTier.
        assert_eq!(
            classify("ztabc", IpAddr::V4(Ipv4Addr::new(100, 70, 0, 1))),
            Some(MeshProvider::Zerotier)
        );
    }

    #[test]
    fn groups_every_provider_in_stable_order_even_when_absent() {
        let interfaces = vec![
            (
                "en0".to_string(),
                IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)),
            ),
            (
                "utun4".to_string(),
                IpAddr::V4(Ipv4Addr::new(100, 101, 2, 3)),
            ),
        ];
        let status = group(&interfaces, |provider| provider == MeshProvider::Tailscale);
        assert_eq!(status.networks.len(), 2);
        assert_eq!(status.networks[0].provider, MeshProvider::Tailscale);
        assert!(status.networks[0].installed);
        assert_eq!(status.networks[0].addresses[0].address, "100.101.2.3");
        assert_eq!(status.networks[1].provider, MeshProvider::Zerotier);
        assert!(!status.networks[1].installed);
        assert!(status.networks[1].addresses.is_empty());
    }

    #[test]
    fn preferred_address_takes_ipv4_before_ipv6_and_none_when_empty() {
        let interfaces = vec![
            (
                "utun4".to_string(),
                IpAddr::V6(Ipv6Addr::new(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 1)),
            ),
            (
                "utun4".to_string(),
                IpAddr::V4(Ipv4Addr::new(100, 101, 2, 3)),
            ),
        ];
        let status = group(&interfaces, |_| true);
        assert_eq!(
            preferred_address(&status),
            Some((MeshProvider::Tailscale, "100.101.2.3".to_string()))
        );
        assert_eq!(preferred_address(&group(&[], |_| false)), None);
    }

    #[test]
    fn is_installed_finds_a_binary_on_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = if cfg!(windows) {
            "tailscale.exe"
        } else {
            "tailscale"
        };
        std::fs::write(dir.path().join(name), b"").expect("write");
        assert!(is_installed(
            MeshProvider::Tailscale,
            Some(dir.path().as_os_str())
        ));
        // The negative case is only assertable when the machine running the
        // tests has no Tailscale at a well-known location.
        if !well_known_binaries(MeshProvider::Tailscale)
            .iter()
            .any(|p| Path::new(p).is_file())
        {
            assert!(!is_installed(
                MeshProvider::Tailscale,
                Some(std::ffi::OsStr::new(""))
            ));
        }
    }

    #[test]
    fn serializes_with_the_renderer_vocabulary() {
        let status = group(
            &[(
                "utun4".to_string(),
                IpAddr::V4(Ipv4Addr::new(100, 101, 2, 3)),
            )],
            |_| false,
        );
        let json = serde_json::to_string(&status).expect("json");
        assert!(json.contains("\"provider\":\"tailscale\""));
        assert!(json.contains("\"provider\":\"zerotier\""));
        assert!(json.contains("\"installed\":false"));
        assert!(json.contains("\"interface\":\"utun4\""));
    }
}
