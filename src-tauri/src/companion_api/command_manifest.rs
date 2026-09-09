//! The command contract this host was compiled against (ADR-0175).
//!
//! `protocol/companion-commands.json` is the contract. `generated/known_commands.rs`
//! is that contract rendered into Rust by `scripts/build/gen-companion-api.mjs`,
//! and this module is the only reader of the table. Runtime routing and
//! authorization consult it rather than maintaining another command-name or
//! classification list, and nothing parses the JSON at runtime: the
//! `#[cfg(test)]` check at the bottom holds the table row for row against the
//! protocol file it was rendered from, so drift fails a test instead of a boot.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[path = "generated/known_commands.rs"]
pub mod known_commands;

pub use known_commands::{CATALOG_HASH, CONTRACT_VERSION};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandTarget {
    Client,
    Execution,
    HostAdmin,
    Service,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandOperation {
    Read,
    Write,
    SideEffect,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandRisk {
    Low,
    High,
    Critical,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandApproval {
    None,
    Interactive,
    SignedPolicy,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandIdempotency {
    Structural,
    Required,
    Forbidden,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CommandTransport {
    Http,
    Websocket,
    Webrtc,
    Internal,
}

/// How a command pages (ADR-0175). `PageToken` is `pageSize`/`pageToken` in
/// and `{items, nextPageToken}` out. `ByteRange` is `offset`/`length` on a
/// read or write of raw bytes.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandPagination {
    None,
    PageToken,
    ByteRange,
}

/// One row of the generated table. Every field is a `'static` borrow so the
/// whole contract is a compile-time constant.
#[derive(Clone, Copy, Debug)]
pub struct WireCommand {
    /// The name on the wire.
    pub name: &'static str,
    /// The Rust dispatch literal. Equal to `name` until the rename cut.
    pub arm: &'static str,
    /// Declared resource path in `protocol/companion-resources.json`.
    pub resource: &'static str,
    /// Vocabulary verb, optionally qualified, from `protocol/companion-verbs.json`.
    pub verb: &'static str,
    pub target: CommandTarget,
    pub operation: CommandOperation,
    pub capability: &'static str,
    pub risk: CommandRisk,
    pub approval: CommandApproval,
    pub idempotency: CommandIdempotency,
    pub transports: &'static [CommandTransport],
    pub input_schema: &'static str,
    pub output_schema: &'static str,
    pub pagination: CommandPagination,
    pub long_running: bool,
}

/// The owned view of a row. Consumers hold `&'static CommandDescriptor`. The
/// field names and their JSON spelling are exactly those of the protocol
/// file, which is what lets the parity test compare the two directly and lets
/// the discovery endpoint serialize a descriptor as the contract wrote it.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandDescriptor {
    pub name: String,
    pub resource: String,
    pub verb: String,
    pub arm: String,
    pub target: CommandTarget,
    pub operation: CommandOperation,
    pub capability: String,
    pub risk: CommandRisk,
    pub approval: CommandApproval,
    pub idempotency: CommandIdempotency,
    pub transports: Vec<CommandTransport>,
    pub pagination: CommandPagination,
    pub long_running: bool,
    pub input_schema: String,
    pub output_schema: String,
}

impl From<&WireCommand> for CommandDescriptor {
    fn from(command: &WireCommand) -> Self {
        Self {
            name: command.name.to_string(),
            resource: command.resource.to_string(),
            verb: command.verb.to_string(),
            arm: command.arm.to_string(),
            target: command.target,
            operation: command.operation,
            capability: command.capability.to_string(),
            risk: command.risk,
            approval: command.approval,
            idempotency: command.idempotency,
            transports: command.transports.to_vec(),
            pagination: command.pagination,
            long_running: command.long_running,
            input_schema: command.input_schema.to_string(),
            output_schema: command.output_schema.to_string(),
        }
    }
}

/// The protocol file's shape. Only the parity test reads it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(test), allow(dead_code))]
struct CommandManifest {
    /// One version for the whole command contract (ADR-0175). It moves when a
    /// client compiled against the previous contract could send something the
    /// host now refuses or mis-parse something it now returns. A new command
    /// or optional field only moves the catalog hash.
    contract_version: u32,
    commands: Vec<CommandDescriptor>,
}

static COMMANDS: Lazy<Vec<CommandDescriptor>> = Lazy::new(|| {
    let commands: Vec<CommandDescriptor> = known_commands::WIRE_COMMANDS
        .iter()
        .map(CommandDescriptor::from)
        .collect();

    // The policy invariants the generator and the manifest gate enforce over
    // the protocol file, asserted again over what was actually compiled in.
    let mut names = std::collections::HashSet::with_capacity(commands.len());
    for descriptor in &commands {
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
    commands
});

static COMMAND_NAMES: Lazy<Vec<&'static str>> = Lazy::new(|| {
    COMMANDS
        .iter()
        .map(|descriptor| descriptor.name.as_str())
        .collect()
});

/// The names the dispatcher answers, in contract order: every descriptor whose
/// target is not `client`. This is the allowlist ADR-0013 made the security
/// perimeter. It is now read from the contract instead of typed a second time.
static REMOTE_COMMAND_NAMES: Lazy<Vec<&'static str>> = Lazy::new(|| {
    COMMANDS
        .iter()
        .filter(|descriptor| descriptor.target != CommandTarget::Client)
        .map(|descriptor| descriptor.name.as_str())
        .collect()
});

static DESCRIPTORS: Lazy<HashMap<&'static str, &'static CommandDescriptor>> = Lazy::new(|| {
    COMMANDS
        .iter()
        .map(|descriptor| (descriptor.name.as_str(), descriptor))
        .collect()
});

static WIRE_INDEX: Lazy<HashMap<&'static str, &'static WireCommand>> = Lazy::new(|| {
    known_commands::WIRE_COMMANDS
        .iter()
        .map(|command| (command.name, command))
        .collect()
});

static RENAME_INDEX: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    known_commands::RENAMED_COMMANDS
        .iter()
        .map(|(from, to)| (*from, *to))
        .collect()
});

static HEADLESS_CONTRACT: Lazy<Result<cognia_headless_contract::HeadlessContract, String>> =
    Lazy::new(|| {
        cognia_headless_contract::HeadlessContract::embedded().map_err(|error| error.to_string())
    });

pub fn commands() -> &'static [CommandDescriptor] {
    &COMMANDS
}

pub fn command_names() -> &'static [&'static str] {
    &COMMAND_NAMES
}

/// Every name the shared dispatcher accepts, in contract order.
pub fn remote_command_names() -> &'static [&'static str] {
    &REMOTE_COMMAND_NAMES
}

pub fn descriptor(name: &str) -> Option<&'static CommandDescriptor> {
    DESCRIPTORS.get(name).copied()
}

/// The generated row for a live wire name.
pub fn wire_command(name: &str) -> Option<&'static WireCommand> {
    WIRE_INDEX.get(name).copied()
}

/// The replacement for a wire name this contract no longer serves.
///
/// Answers only for names that are absent from the table. While a renamed
/// command is still served under its old name (every entry, until the ADR-0175
/// rename cut lands), the old name is a live command and dispatches normally.
/// After the cut the host answers it with 410 `command_renamed` and this
/// replacement in `details.replacement`.
pub fn renamed_to(name: &str) -> Option<&'static str> {
    if WIRE_INDEX.contains_key(name) {
        return None;
    }
    RENAME_INDEX.get(name).copied()
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

    fn protocol_manifest() -> CommandManifest {
        serde_json::from_str(include_str!("../../../protocol/companion-commands.json"))
            .expect("protocol/companion-commands.json must parse as the contract shape")
    }

    /// The generated table is the protocol file, row for row and field for
    /// field. This is the whole reason the host can stop parsing JSON at boot:
    /// a table that lags the contract fails here, not in a device's hands.
    #[test]
    fn generated_table_matches_protocol_contract() {
        let manifest = protocol_manifest();
        assert_eq!(
            manifest.contract_version, CONTRACT_VERSION,
            "run pnpm companion-api:gen: the generated CONTRACT_VERSION lags the contract"
        );
        assert_eq!(
            commands().len(),
            manifest.commands.len(),
            "run pnpm companion-api:gen: the generated table has a different row count"
        );
        for (generated, declared) in commands().iter().zip(&manifest.commands) {
            assert_eq!(
                generated, declared,
                "run pnpm companion-api:gen: {} differs from the contract",
                declared.name
            );
        }
    }

    #[test]
    fn shared_manifest_is_complete_and_validated() {
        // No literal total. This assertion was `1063`, then `1066`, and went
        // stale again the moment 59 previously-untriaged commands got the
        // descriptors they had always needed. A hardcoded inventory count goes
        // red on every legitimate addition, and a permanently-red test teaches
        // people to ignore it. What the count was ever standing in for is
        // asserted directly instead.
        assert_eq!(command_names().len(), commands().len());
        assert_eq!(DESCRIPTORS.len(), commands().len());
        assert_eq!(WIRE_INDEX.len(), commands().len());
        assert!(!commands().is_empty());

        // Uniqueness is enforced when the table is built, so it needs no
        // assertion here. The length equalities above only prove the maps are
        // the same SIZE. This proves every name actually resolves.
        let unresolvable: Vec<&str> = command_names()
            .iter()
            .copied()
            .filter(|name| descriptor(name).is_none() || wire_command(name).is_none())
            .collect();
        assert!(
            unresolvable.is_empty(),
            "descriptors that do not resolve by name: {unresolvable:?}"
        );

        // The remote set is exactly the non-client descriptors, in order, and
        // the dispatcher reads its allowlist from here.
        let expected: Vec<&str> = commands()
            .iter()
            .filter(|descriptor| descriptor.target != CommandTarget::Client)
            .map(|descriptor| descriptor.name.as_str())
            .collect();
        assert_eq!(remote_command_names(), expected.as_slice());
        assert_eq!(super::super::rpc::known_commands(), expected.as_slice());
        assert!(remote_command_names()
            .iter()
            .all(|name| descriptor(name).is_some()));
    }

    #[test]
    fn service_commands_are_internal_only() {
        let command = descriptor("secret_store_get").expect("descriptor");
        assert_eq!(command.target, CommandTarget::Service);
        assert_eq!(command.transports, vec![CommandTransport::Internal]);
    }

    /// The rename table is populated now and dormant on purpose: until the
    /// ADR-0175 rename cut, every old name is still a live command, so
    /// `renamed_to` must answer `None` for all of them and the 410 path must
    /// never fire. This pins both halves of that so the dormancy is explicit,
    /// and it holds the table to the sorted, duplicate-free shape the renderer
    /// promises so the cut can switch to a binary search without surprises.
    #[test]
    fn rename_table_is_sorted_unique_and_dormant_until_the_cut() {
        let table = known_commands::RENAMED_COMMANDS;
        assert!(
            !table.is_empty(),
            "the rename table is rendered from the contract"
        );
        for pair in table.windows(2) {
            assert!(
                pair[0].0 < pair[1].0,
                "rename table is not sorted by old name at {:?} / {:?}",
                pair[0].0,
                pair[1].0
            );
        }
        for (from, to) in table {
            assert!(
                to.contains('.'),
                "{from}: the replacement {to} is not a dotted wire name"
            );
            assert_eq!(
                renamed_to(from),
                None,
                "{from} is still served under its old name, so it is not renamed yet"
            );
        }
        assert_eq!(renamed_to("no_such_command_ever"), None);
    }

    #[test]
    fn embedded_headless_contract_matches_the_generated_inventory() {
        let contract = headless_contract().expect("embedded Headless contract");
        // One version and one hash. The catalog the Brain validates against,
        // the table the host dispatches from, and the identity the bridge
        // handshake compares are all rendered from the same contract in the
        // same generator run, so they must agree or the run was partial.
        assert_eq!(contract.schema_version(), CONTRACT_VERSION);
        assert_eq!(contract.catalog_hash(), CATALOG_HASH);
        assert_eq!(contract.catalog_hash().len(), 64);
        // Bound to the dispatch allowlist rather than a literal. This assertion
        // was `490` against a 493-command catalog and had been failing in CI.
        // A hardcoded inventory count goes stale on every command added, and a
        // permanently-red test teaches people to ignore it. The real invariant
        // is that the embedded contract covers exactly what dispatch accepts:
        // a command outside it is unvalidatable, one inside it undispatchable.
        assert_eq!(contract.command_count(), remote_command_names().len());
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
    /// whether their root type matches what the arm emits. `LegacyRecord`
    /// (object) and `LegacyList` (array) grade identically. So a
    /// collection-returning arm declared as a record passed every gate and
    /// then rejected its own result at runtime with a 500
    /// `contract_output_violation`.
    ///
    /// `integration_ingress_poll` shipped exactly that way. It returns
    /// `Vec<SpoolDelivery>`, which serializes to `[]` on an empty spool, and
    /// `{"type":"object"}` refuses an array. So the headless brain's
    /// Integration ingress runtime failed to install on *every* boot, whether
    /// or not any Integration account existed.
    ///
    /// The values below are serialized from the real types the arms hand to
    /// `to_json`, not hand-copied JSON literals: a literal stops proving
    /// anything the moment a struct gains a field.
    #[test]
    fn output_contracts_accept_what_the_dispatch_arms_actually_serialize() {
        let contract = headless_contract().expect("embedded Headless contract");

        // `integration_ingress_poll` returns `Vec<SpoolDelivery>`.
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

        // `plugin_get_capabilities` returns `Vec<PluginApiCapability>`, straight
        // from the production capability table.
        contract
            .validate_output(
                "plugin_get_capabilities",
                &serde_json::to_value(
                    crate::plugin_api::api_bridge::plugin_get_capabilities_for_host(false),
                )
                .expect("serialize capability table"),
            )
            .expect("the advertised capability table must satisfy its output contract");

        // `plugin_runtime_snapshot` returns one snapshot, not a list.
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

        // `task_workspace_settle` returns `Vec<ResourceChange>`.
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
