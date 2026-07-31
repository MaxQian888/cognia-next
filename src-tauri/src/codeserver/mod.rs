//! Optional desktop "Pro IDE" mode: an on-demand, embedded `code-server`
//! (browser VS Code) that augments — never replaces — the Monaco editor.
//!
//! - `download` — fetch + SHA-256-verify + extract the pinned code-server
//!   standalone tarball from GitHub Releases into app-data.
//! - `process` — spawn code-server bound to a loopback port, health-poll it,
//!   and manage one instance per project root (`CodeServerState`).
//! - `commands` — the Tauri IPC surface.
//!
//! Desktop-only in effect: `download::resolve_platform` errors on hosts with no
//! prebuilt binary (Windows, exotic arch); the frontend gates the toggle via
//! `codeserver_supported`.

pub mod agent_channel;
mod broker_protocol;
pub mod commands;
pub mod content_bridge;
pub mod download;
pub mod process;
pub mod profile;
pub mod proxy;
pub mod relay;
pub mod remote;
pub mod webview;

pub use process::CodeServerState;

pub const MANAGED_IDE_KILL_SWITCH_ENV: &str = "COGNIA_MANAGED_IDE_KILL_SWITCH";

pub fn managed_platform_enabled() -> bool {
    managed_platform_enabled_from(std::env::var(MANAGED_IDE_KILL_SWITCH_ENV).ok().as_deref())
}

fn managed_platform_enabled_from(value: Option<&str>) -> bool {
    !value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_platform_kill_switch_accepts_explicit_truthy_values_only() {
        assert!(!managed_platform_enabled_from(Some("1")));
        assert!(!managed_platform_enabled_from(Some(" TRUE ")));
        assert!(!managed_platform_enabled_from(Some("yes")));
        assert!(managed_platform_enabled_from(None));
        assert!(managed_platform_enabled_from(Some("0")));
        assert!(managed_platform_enabled_from(Some("false")));
    }
}
