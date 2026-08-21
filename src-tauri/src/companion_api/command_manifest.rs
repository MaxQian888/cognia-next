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

static HEADLESS_CONTRACT: Lazy<Result<cognia_headless_contract::HeadlessContract, String>> =
    Lazy::new(|| {
        cognia_headless_contract::HeadlessContract::embedded().map_err(|error| error.to_string())
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

pub fn headless_contract(
) -> Result<&'static cognia_headless_contract::HeadlessContract, &'static str> {
    match &*HEADLESS_CONTRACT {
        Ok(contract) => Ok(contract),
        Err(error) => Err(error.as_str()),
    }
}

pub fn headless_contract_enforced() -> bool {
    !std::env::var("COGNIA_HEADLESS_CONTRACT_ENFORCEMENT")
        .is_ok_and(|value| value.eq_ignore_ascii_case("off"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_manifest_is_complete_and_validated() {
        // No literal total. This assertion was `1063`, then `1066`, and went
        // stale again the moment 59 previously-untriaged commands got the
        // descriptors they had always needed — which is the same lesson
        // `embedded_headless_contract_matches_the_generated_inventory` records
        // two tests down: a hardcoded inventory count goes red on every
        // legitimate addition, and a permanently-red test teaches people to
        // ignore it. What the count was ever standing in for is asserted
        // directly instead.
        assert_eq!(command_names().len(), commands().len());
        assert_eq!(DESCRIPTORS.len(), commands().len());
        assert!(!commands().is_empty());

        // Uniqueness is enforced by `MANIFEST` at load time, so it needs no
        // assertion here — but the length equalities above only prove the maps
        // are the same SIZE. This proves every name actually resolves.
        let unresolvable: Vec<&str> = command_names()
            .iter()
            .copied()
            .filter(|name| descriptor(name).is_none())
            .collect();
        assert!(
            unresolvable.is_empty(),
            "descriptors that do not resolve by name: {unresolvable:?}"
        );

        // The invariant the test name claims: every dispatchable command has a
        // descriptor. Without it a command can enter `KNOWN_COMMANDS`
        // undescribed and nothing notices.
        let undescribed: Vec<&str> = super::super::rpc::known_commands()
            .iter()
            .copied()
            .filter(|name| descriptor(name).is_none())
            .collect();
        assert!(
            undescribed.is_empty(),
            "dispatchable commands with no descriptor: {undescribed:?}"
        );
    }

    #[test]
    fn service_commands_are_internal_only() {
        let command = descriptor("secret_store_get").expect("descriptor");
        assert_eq!(command.target, CommandTarget::Service);
        assert_eq!(command.transports, vec![CommandTransport::Internal]);
    }

    #[test]
    fn embedded_headless_contract_matches_the_generated_inventory() {
        let contract = headless_contract().expect("embedded Headless contract");
        assert_eq!(contract.schema_version(), 1);
        assert_eq!(contract.catalog_hash().len(), 64);
        // Bound to the dispatch allowlist rather than a literal. This assertion
        // was `490` against a 493-command catalog and had been failing in CI;
        // a hardcoded inventory count goes stale on every command added, and a
        // permanently-red test teaches people to ignore it. The real invariant
        // is that the embedded contract covers exactly what dispatch accepts —
        // a command outside it is unvalidatable, one inside it undispatchable.
        assert_eq!(
            contract.command_count(),
            super::super::rpc::known_commands().len()
        );
        assert!(contract
            .validate_input(
                "browser_session_ensure",
                &serde_json::json!({
                    "chatSessionId": "chat-a",
                    "workspaceId": "workspace-a",
                    "userEnabled": true,
                }),
            )
            .is_ok());
        assert!(contract
            .validate_input(
                "browser_session_ensure",
                &serde_json::json!({
                    "chatSessionId": "chat-a",
                    "workspaceId": "workspace-a",
                    "userEnabled": true,
                    "unexpected": "secret-value",
                }),
            )
            .is_err());
    }

    /// Output contracts are hand-written, and the only gate over them
    /// (`check-rpc-semantic-parity`) ratchets how *opaque* they are, not
    /// whether their root type matches what the arm emits — `LegacyRecord`
    /// (object) and `LegacyList` (array) grade identically. So a
    /// collection-returning arm declared as a record passed every gate and
    /// then rejected its own result at runtime with a 500
    /// `contract_output_violation`.
    ///
    /// `integration_ingress_poll` shipped exactly that way. It returns
    /// `Vec<SpoolDelivery>`, which serializes to `[]` on an empty spool, and
    /// `{"type":"object"}` refuses an array — so the headless brain's
    /// Integration ingress runtime failed to install on *every* boot, whether
    /// or not any Integration account existed.
    ///
    /// The values below are serialized from the real types the arms hand to
    /// `to_json`, not hand-copied JSON literals: a literal stops proving
    /// anything the moment a struct gains a field.
    #[test]
    fn output_contracts_accept_what_the_dispatch_arms_actually_serialize() {
        let contract = headless_contract().expect("embedded Headless contract");

        // `integration_ingress_poll` → `Vec<SpoolDelivery>`.
        contract
            .validate_output("integration_ingress_poll", &serde_json::json!([]))
            .expect("an empty ingress spool is the common case, not an error");
        let delivery = crate::workflow::integration_spool::SpoolDelivery {
            route_id: "route-a".to_string(),
            delivery_id: "delivery-a".to_string(),
            event_type: None,
            headers: std::collections::BTreeMap::from([(
                "x-github-event".to_string(),
                "push".to_string(),
            )]),
            body: "{}".to_string(),
            received_at: "2026-08-20T00:00:00Z".to_string(),
            attempts: 0,
        };
        contract
            .validate_output(
                "integration_ingress_poll",
                &serde_json::to_value(vec![delivery]).expect("serialize spool delivery"),
            )
            .expect("a spooled delivery must satisfy its own output contract");
        assert!(
            contract
                .validate_output("integration_ingress_poll", &serde_json::json!({}))
                .is_err(),
            "the record shape this command used to declare must stay rejected"
        );

        // `plugin_get_capabilities` → `Vec<PluginApiCapability>`, straight from
        // the production capability table.
        contract
            .validate_output(
                "plugin_get_capabilities",
                &serde_json::to_value(
                    crate::plugin_api::api_bridge::plugin_get_capabilities_for_host(false),
                )
                .expect("serialize capability table"),
            )
            .expect("the advertised capability table must satisfy its output contract");

        // `plugin_runtime_snapshot` → one snapshot, not a list.
        let snapshot = crate::plugin_api::PluginRuntimeSnapshot {
            plugin_id: "cognia.demo".to_string(),
            version: "1.0.0".to_string(),
            status: "active".to_string(),
            last_error: None,
            loaded_at: None,
            install_path: "/tmp/cognia.demo".to_string(),
        };
        contract
            .validate_output(
                "plugin_runtime_snapshot",
                &serde_json::to_value(snapshot).expect("serialize runtime snapshot"),
            )
            .expect("one plugin snapshot must satisfy its output contract");

        // `task_workspace_settle` → `Vec<ResourceChange>`.
        contract
            .validate_output("task_workspace_settle", &serde_json::json!([]))
            .expect("settling a run with no changed resources is not an error");
        assert!(
            contract
                .validate_output("task_workspace_settle", &serde_json::json!({}))
                .is_err(),
            "the record shape this command used to declare must stay rejected"
        );
    }
}
