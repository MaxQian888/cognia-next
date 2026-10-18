//! Host-neutral companion command execution (ADR-0196 P8).
pub mod codeserver_host;
pub mod command_services;
pub mod headless;
pub mod mcp_oauth;
pub mod pair_invitation;
pub mod project_environment;
pub mod shell;
pub mod sidecar_runtime;

pub mod managed_desktop_release;
pub mod managed_desktop_operator;
pub mod managed_desktops;

pub mod delivery_admission;

pub mod managed_desktop_handoff;
pub mod managed_desktop_results;

pub mod managed_desktop_handoff_operator;

pub mod remote_desktops;
