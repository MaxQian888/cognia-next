//! Install, repair, re-pair and uninstall a full headless Cognia Host on a
//! machine the desktop reaches through a remote shell (ADR-0235 §1).
//!
//! The crate adds the [`shell::RemoteShell`] seam an adapter implements, and
//! the consent-gated [`session::Session`] that drives the existing owners in
//! order:
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
//! **Adapters.** [`ssh::SshShell`] reaches a machine through a saved SSH
//! profile (P6). The VS Code tunnel adapter arrives with the
//! `services/devtunnel-helper` package once spike S2 has run.
//!
//! **Caller.** [`desktop::InstallerSessions`] is the desktop's registry of open
//! sessions and `commands` (feature `tauri-host`) its Tauri shells, registered
//! in `src-tauri`. The Devices UI that calls them (P5) is behind the
//! `NEXT_PUBLIC_COGNIA_HOST_INSTALLER` build flag, off by default;
//! `tests::the_desktop_registers_the_commands` pins the registration.

#[cfg(feature = "tauri-host")]
pub mod commands;
pub mod desktop;
pub mod probe;
pub mod release;
pub mod session;
pub mod shell;
pub mod ssh;

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod tests {
    /// Every command shell, as the desktop's `generate_handler!` names it.
    const COMMANDS: [&str; 6] = [
        "host_installer_ssh_open",
        "host_installer_inspect",
        "host_installer_install",
        "host_installer_pair",
        "host_installer_uninstall",
        "host_installer_close",
    ];

    #[test]
    fn the_desktop_registers_the_commands() {
        let commands = include_str!("commands.rs");
        let app = include_str!("../../../src-tauri/src/lib.rs");
        for command in COMMANDS {
            assert!(
                commands.contains(&format!("pub async fn {command}"))
                    || commands.contains(&format!("pub fn {command}")),
                "{command} is not a command shell"
            );
            assert!(
                app.contains(&format!("cognia_host_installer::commands::{command},")),
                "{command} is not registered in src-tauri"
            );
        }
        assert!(app.contains(".manage(cognia_host_installer::desktop::InstallerSessions::new())"));
    }
}
