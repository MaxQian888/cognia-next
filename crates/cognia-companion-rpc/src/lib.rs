//! Host-neutral companion command execution (ADR-0196 P8).
pub mod codeserver_host;
pub mod command_services;
pub mod deployment_id;
pub mod gateway_host;
pub mod headless;
pub mod mcp_oauth;
pub mod pair_invitation;
pub mod project_environment;
pub mod provider_admin;
pub mod rpc;
pub mod rpc_host;
pub mod shell;
pub mod skill_transactions;
pub mod sidecar_runtime;

pub mod managed_desktop_release;
pub mod managed_desktop_operator;
pub mod managed_desktops;

pub mod delivery_admission;

pub mod managed_desktop_handoff;
pub mod managed_desktop_results;

pub mod managed_desktop_handoff_operator;

pub mod remote_desktops;
