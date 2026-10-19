//! Install, repair, re-pair and uninstall a full headless Cognia Host on a
//! machine the desktop reaches through a remote shell (ADR-0235 §1).
//!
//! The crate adds only two things: the [`shell::RemoteShell`] seam an adapter
//! implements (the VS Code tunnel helper first, an SSH client later), and the
//! consent-gated [`session::Session`] that drives the existing owners in order:
//!
//! - release selection and verification: `cognia_update_catalog`
//!   ([`release`]), exactly as self-update does it;
//! - remote verification and staging: `cognia-server stage`, which wraps
//!   `InstallHome::stage_archive`;
//! - the service: `cognia-server service install|status --json|uninstall
//!   --scope user`, which keeps an existing master key;
//! - the tunnel ingress switch: `cognia-server tunnel-ingress enable`;
//! - pairing: `cognia-server pair --json`.
//!
//! It never writes unit files, never parses free-form text, and never models
//! the machine as a server-ops deployment target.
//!
//! **Dormant until its adapter lands.** No `RemoteShell` implementation ships
//! in this crate yet, and nothing in the app calls it: the VS Code tunnel
//! adapter arrives with the `services/devtunnel-helper` package, and the
//! desktop surface with the Devices UI (ADR-0235 P4/P5), behind a flag that is
//! off by default. `tests::the_crate_ships_no_adapter_yet` pins that.

pub mod probe;
pub mod release;
pub mod session;
pub mod shell;

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod tests {
    #[test]
    fn the_crate_ships_no_adapter_yet() {
        // When an adapter lands, wire it to a caller in the same change and
        // replace this pin with that wiring's test.
        for source in [
            include_str!("shell.rs"),
            include_str!("probe.rs"),
            include_str!("release.rs"),
            include_str!("session.rs"),
        ] {
            assert!(!source.contains("impl RemoteShell for"));
        }
    }
}
