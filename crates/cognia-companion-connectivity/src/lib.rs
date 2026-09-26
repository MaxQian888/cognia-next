//! How a paired device reaches the desktop companion (ADR-0196 P4).
//!
//! These are the transport leaves: nothing here reads companion state, so
//! the companion core, the desktop app and the headless server all build on
//! them. The desktop re-exports each module at its old
//! `companion_api::<module>` path.
//!
//! - [`tls`] — the listener's self-signed certificate and SPKI fingerprint.
//! - [`mdns`] / [`mesh`] — LAN discovery and mesh-VPN addresses.
//! - [`tunnel`] / [`tunnel_config`] — the cloudflared quick and named tunnel.
//! - [`reachability_config`] / [`signaling_config`] — the persisted
//!   listener and relay settings.
//! - [`signaling`] — the WebRTC peer, envelope crypto, DataChannel framing,
//!   relay carrier and the registration store (ADR-0021, ADR-0170).

pub mod mdns;
pub mod mesh;
pub mod reachability_config;
pub mod signaling;
pub mod signaling_config;
pub mod tls;
pub mod tunnel;
pub mod tunnel_config;

/// The WebRTC stack these modules are written against, so callers name the
/// same version.
pub use webrtc;

/// Default companion API port.  Configurable via `companion_server_start`.
/// Used by M2.8 settings UI.
///
/// 27890 — deliberately outside the 789x range: 7890/7891 are the Clash
/// mixed/SOCKS defaults (see `proxy_config::detect::KNOWN_PORTS`), so binding
/// there collides with FlClash/Clash Verge on developer machines.
pub const DEFAULT_PORT: u16 = 27890;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_port_avoids_known_proxy_ports() {
        assert_eq!(DEFAULT_PORT, 27890);
        // Guard against regressing back into the Clash/V2Ray default range —
        // every entry in proxy_config's known-port probe list is off-limits.
        for (port, _, _) in cognia_net::proxy_config::detect::KNOWN_PORTS {
            assert_ne!(
                DEFAULT_PORT, *port,
                "DEFAULT_PORT collides with a known proxy port"
            );
        }
    }
}
