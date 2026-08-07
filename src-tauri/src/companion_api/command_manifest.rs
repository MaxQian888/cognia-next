//! Shared command protocol loaded from `protocol/companion-commands.json`.
//!
//! The JSON document is consumed by both Rust and TypeScript. Runtime routing
//! and authorization must consult this module rather than maintaining another
//! command-name or classification list.

use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandTarget {
    Client,
    Execution,
    HostAdmin,
    Service,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandOperation {
    Read,
    Write,
    SideEffect,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandRisk {
    Low,
    High,
    Critical,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandApproval {
    None,
    Interactive,
    SignedPolicy,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandIdempotency {
    Structural,
    Required,
    Forbidden,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CommandTransport {
    Http,
    Websocket,
    Webrtc,
    Internal,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDescriptor {
    pub name: String,
    pub target: CommandTarget,
    pub operation: CommandOperation,
    pub capability: String,
    pub risk: CommandRisk,
    pub approval: CommandApproval,
    pub idempotency: CommandIdempotency,
    pub transports: Vec<CommandTransport>,
    pub input_schema: String,
    pub output_schema: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandManifest {
    schema_version: u32,
    commands: Vec<CommandDescriptor>,
}

static MANIFEST: Lazy<CommandManifest> = Lazy::new(|| {
    let manifest: CommandManifest =
        serde_json::from_str(include_str!("../../../protocol/companion-commands.json"))
            .expect("protocol/companion-commands.json must be valid");
    assert_eq!(
        manifest.schema_version, 2,
        "unsupported companion command manifest schema"
    );

    let mut names = std::collections::HashSet::with_capacity(manifest.commands.len());
    for descriptor in &manifest.commands {
        assert!(
            names.insert(descriptor.name.as_str()),
            "duplicate companion command descriptor: {}",
            descriptor.name
        );
        assert!(
            !descriptor.capability.is_empty(),
            "command {} has no capability",
            descriptor.name
        );
        assert!(
            !(descriptor.operation != CommandOperation::Read
                && descriptor.idempotency == CommandIdempotency::Structural),
            "mutation {} cannot use structural idempotency",
            descriptor.name
        );
        assert!(
            !(descriptor.target == CommandTarget::Service
                && descriptor.transports.iter().any(|transport| {
                    matches!(
                        transport,
                        CommandTransport::Http
                            | CommandTransport::Websocket
                            | CommandTransport::Webrtc
                    )
                })),
            "service command {} cannot be device-transportable",
            descriptor.name
        );
    }
    manifest
});

static COMMAND_NAMES: Lazy<Vec<&'static str>> = Lazy::new(|| {
    MANIFEST
        .commands
        .iter()
        .map(|descriptor| descriptor.name.as_str())
        .collect()
});

static DESCRIPTORS: Lazy<HashMap<&'static str, &'static CommandDescriptor>> = Lazy::new(|| {
    MANIFEST
        .commands
        .iter()
        .map(|descriptor| (descriptor.name.as_str(), descriptor))
        .collect()
});

pub fn commands() -> &'static [CommandDescriptor] {
    &MANIFEST.commands
}

pub fn command_names() -> &'static [&'static str] {
    &COMMAND_NAMES
}

pub fn descriptor(name: &str) -> Option<&'static CommandDescriptor> {
    DESCRIPTORS.get(name).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_manifest_is_complete_and_validated() {
        assert_eq!(commands().len(), 1026);
        assert_eq!(command_names().len(), commands().len());
        assert_eq!(DESCRIPTORS.len(), commands().len());
    }

    #[test]
    fn service_commands_are_internal_only() {
        let command = descriptor("keyring_secret_get").expect("descriptor");
        assert_eq!(command.target, CommandTarget::Service);
        assert_eq!(command.transports, vec![CommandTransport::Internal]);
    }
}
