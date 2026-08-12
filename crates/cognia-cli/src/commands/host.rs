//! Agent-first client for the loopback-only Headless service plane.

mod skills_installer;

use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Result;
use comfy_table::{presets::UTF8_FULL, Table};
use native_tls::{Certificate, TlsConnector};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tungstenite::{client_tls_with_config, Connector, Message};
use url::{Host, Url};
use uuid::Uuid;

use crate::cli::{
    HostCallFormat, HostCommand, HostListFormat, HostSchemaFormat, HostSkillKind, HostSkillsCommand,
};
use crate::ui::RuntimeUi;

const CATALOG_BYTES: &[u8] = cognia_headless_contract::EMBEDDED_CATALOG_BYTES;
static HEADLESS_CONTRACT: OnceLock<Result<cognia_headless_contract::HeadlessContract, String>> =
    OnceLock::new();
const HOST_SKILL: &str = include_str!("../../assets/skills/cognia-host/SKILL.md");
const HOST_OUTPUT_REFERENCE: &str =
    include_str!("../../assets/skills/cognia-host/references/output-contract.md");
const HOST_SESSIONS_SKILL: &str = include_str!("../../assets/skills/cognia-host-sessions/SKILL.md");
const HOST_AGENTS_SKILL: &str = include_str!("../../assets/skills/cognia-host-agents/SKILL.md");
const HOST_TASKS_SKILL: &str = include_str!("../../assets/skills/cognia-host-tasks/SKILL.md");
const HOST_AUTOMATION_SKILL: &str =
    include_str!("../../assets/skills/cognia-host-automation/SKILL.md");
const HOST_CONNECTORS_SKILL: &str =
    include_str!("../../assets/skills/cognia-host-connectors/SKILL.md");
const HOST_EXTENSIONS_SKILL: &str =
    include_str!("../../assets/skills/cognia-host-extensions/SKILL.md");
const HOST_KNOWLEDGE_SKILL: &str =
    include_str!("../../assets/skills/cognia-host-knowledge/SKILL.md");
const HOST_DEVELOPMENT_SKILL: &str =
    include_str!("../../assets/skills/cognia-host-development/SKILL.md");
const HOST_SYSTEM_SKILL: &str = include_str!("../../assets/skills/cognia-host-system/SKILL.md");
const HOST_OBSERVE_SKILL: &str = include_str!("../../assets/skills/cognia-host-observe/SKILL.md");
const HOST_SAFE_GIT_SKILL: &str = include_str!("../../assets/skills/cognia-host-safe-git/SKILL.md");
const HOST_AGENT_INCIDENT_SKILL: &str =
    include_str!("../../assets/skills/cognia-host-agent-incident/SKILL.md");
const HOST_BACKUP_RECOVERY_SKILL: &str =
    include_str!("../../assets/skills/cognia-host-backup-recovery/SKILL.md");
const HOST_EXTENSION_ROLLOUT_SKILL: &str =
    include_str!("../../assets/skills/cognia-host-extension-rollout/SKILL.md");
const HOST_CONNECTOR_DELIVERY_SKILL: &str =
    include_str!("../../assets/skills/cognia-host-connector-delivery/SKILL.md");
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const EVENT_READ_TIMEOUT: Duration = Duration::from_secs(40);

#[derive(Debug)]
pub(crate) struct HostExit {
    pub(crate) code: i32,
}

impl fmt::Display for HostExit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "host command failed with exit code {}", self.code)
    }
}

impl std::error::Error for HostExit {}

#[derive(Debug, Clone)]
pub(crate) struct HostConfig {
    pub(crate) server_url: String,
    pub(crate) data_dir: Option<PathBuf>,
    pub(crate) ca_cert: Option<PathBuf>,
    pub(crate) server_bin: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostCatalog {
    schema_version: u32,
    catalog_hash: String,
    categories: Vec<HostCatalogCategory>,
    resources: Vec<HostCatalogResource>,
    commands: Vec<HostCatalogCommand>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostCatalogCategory {
    id: String,
    title: String,
    description: String,
    skill: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostCatalogResource {
    id: String,
    title: String,
    category: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostCatalogCommand {
    name: String,
    category: String,
    resource: String,
    target: String,
    operation: String,
    capability: String,
    risk: String,
    approval: String,
    idempotency: String,
    summary: String,
    description: String,
    input_schema_source: String,
    input_schema: Value,
    output_schema_source: Option<String>,
    output_schema: Option<Value>,
    output_typed: bool,
}

#[derive(Debug)]
struct ResolvedConfig {
    base_url: Url,
    data_dir: PathBuf,
    ca_cert: PathBuf,
    server_bin: Option<PathBuf>,
}

#[derive(Debug)]
struct HostFailure {
    error_type: &'static str,
    code: String,
    message: String,
    retryable: bool,
    http_status: Option<u16>,
    details: Value,
    exit_code: i32,
}

impl HostFailure {
    fn new(error_type: &'static str, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            error_type,
            code: code.into(),
            message: message.into(),
            retryable: false,
            http_status: None,
            details: json!({}),
            exit_code: 1,
        }
    }

    fn validation(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new("validation", code, message).with_exit(2)
    }

    fn configuration(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new("configuration", code, message).with_exit(2)
    }

    fn authentication(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new("authentication", code, message).with_exit(3)
    }

    fn transport(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new("transport", code, message)
            .with_exit(5)
            .retryable()
    }

    fn with_exit(mut self, exit_code: i32) -> Self {
        self.exit_code = exit_code;
        self
    }

    fn with_status(mut self, status: u16) -> Self {
        self.http_status = Some(status);
        self
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }
}

#[derive(Debug)]
struct HttpOutcome {
    status: u16,
    body: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputValidation {
    status: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    violations: Vec<String>,
}

pub(crate) fn run(command: HostCommand, config: HostConfig, ui: &mut RuntimeUi) -> Result<()> {
    let catalog = load_catalog().map_err(|failure| emit_failure("catalog", None, failure))?;
    match command {
        HostCommand::Categories { format } => run_categories(&catalog, format)
            .map_err(|failure| emit_failure("categories", None, failure)),
        HostCommand::Resources { category, format } => {
            run_resources(&catalog, category.as_deref(), format)
                .map_err(|failure| emit_failure("resources", None, failure))
        }
        HostCommand::Commands {
            query,
            target,
            operation,
            risk,
            approval,
            capability,
            category,
            resource,
            format,
        } => run_commands(
            &catalog,
            query.as_deref(),
            target.as_deref(),
            operation.as_deref(),
            risk.as_deref(),
            approval.as_deref(),
            capability.as_deref(),
            category.as_deref(),
            resource.as_deref(),
            format,
        )
        .map_err(|failure| emit_failure("commands", None, failure)),
        HostCommand::Schema {
            rpc_command,
            format,
        } => run_schema(&catalog, &rpc_command, format)
            .map_err(|failure| emit_failure("schema", Some(&rpc_command), failure)),
        HostCommand::Call {
            rpc_command,
            data,
            idempotency_key,
            dry_run,
            no_wait,
            strict_output,
            timeout_seconds,
            format,
        } => {
            let result = run_call(
                &catalog,
                &config,
                &rpc_command,
                data.as_deref(),
                idempotency_key.as_deref(),
                dry_run,
                no_wait,
                strict_output,
                timeout_seconds,
                format,
                ui,
            );
            result.map_err(|failure| emit_failure("call", Some(&rpc_command), failure))
        }
        HostCommand::Doctor { offline, format } => run_doctor(&catalog, &config, offline, format)
            .map_err(|failure| emit_failure("doctor", None, failure)),
        HostCommand::Events {
            since,
            events,
            max_events,
        } => run_events(&config, since, &events, max_events)
            .map_err(|failure| emit_failure("events", None, failure)),
        HostCommand::Skills { command } => {
            let action = if matches!(&command, HostSkillsCommand::Install { .. }) {
                "skills_install"
            } else {
                "skills"
            };
            run_skills(command).map_err(|failure| emit_failure(action, None, failure))
        }
    }
}

fn emit_failure(action: &str, rpc_command: Option<&str>, failure: HostFailure) -> anyhow::Error {
    let mut envelope = json!({
        "schemaVersion": 1,
        "ok": false,
        "action": action,
        "error": {
            "type": failure.error_type,
            "code": failure.code,
            "message": failure.message,
            "retryable": failure.retryable,
            "httpStatus": failure.http_status,
            "details": failure.details,
        }
    });
    if let Some(command) = rpc_command {
        envelope["rpcCommand"] = Value::String(command.to_string());
    }
    eprintln!(
        "{}",
        serde_json::to_string_pretty(&envelope).unwrap_or_else(|_| envelope.to_string())
    );
    HostExit {
        code: failure.exit_code,
    }
    .into()
}

fn load_catalog() -> std::result::Result<HostCatalog, HostFailure> {
    let catalog: HostCatalog = serde_json::from_slice(CATALOG_BYTES).map_err(|error| {
        HostFailure::configuration(
            "invalid_embedded_catalog",
            format!("embedded Headless command catalog is invalid: {error}"),
        )
    })?;
    if catalog.schema_version != 1
        || catalog.catalog_hash.len() != 64
        || catalog.categories.is_empty()
        || catalog.resources.is_empty()
    {
        return Err(HostFailure::configuration(
            "unsupported_catalog",
            "embedded Headless command catalog has an unsupported version",
        ));
    }
    Ok(catalog)
}

fn run_categories(
    catalog: &HostCatalog,
    format: HostListFormat,
) -> std::result::Result<(), HostFailure> {
    let categories: Vec<Value> = catalog
        .categories
        .iter()
        .map(|category| {
            let commands: Vec<_> = catalog
                .commands
                .iter()
                .filter(|command| command.category == category.id)
                .collect();
            let count = |field: fn(&HostCatalogCommand) -> &str, value: &str| {
                commands
                    .iter()
                    .filter(|command| field(command) == value)
                    .count()
            };
            json!({
                "id": category.id,
                "title": category.title,
                "description": category.description,
                "skill": category.skill,
                "commandCount": commands.len(),
                "operationCounts": {
                    "read": count(|command| &command.operation, "read"),
                    "write": count(|command| &command.operation, "write"),
                    "sideEffect": count(|command| &command.operation, "side-effect"),
                },
                "riskCounts": {
                    "low": count(|command| &command.risk, "low"),
                    "high": count(|command| &command.risk, "high"),
                    "critical": count(|command| &command.risk, "critical"),
                },
            })
        })
        .collect();
    match format {
        HostListFormat::Json => print_json(&json!({
            "schemaVersion": 1,
            "ok": true,
            "action": "categories",
            "catalogHash": catalog.catalog_hash,
            "count": categories.len(),
            "categories": categories,
        })),
        HostListFormat::Table => {
            let mut table = Table::new();
            table.load_style(UTF8_FULL).set_header([
                "CATEGORY", "COMMANDS", "READ", "WRITE", "HIGH", "CRITICAL", "SKILL",
            ]);
            for category in categories {
                table.add_row([
                    category["id"].as_str().unwrap_or(""),
                    &category["commandCount"].to_string(),
                    &category["operationCounts"]["read"].to_string(),
                    &category["operationCounts"]["write"].to_string(),
                    &category["riskCounts"]["high"].to_string(),
                    &category["riskCounts"]["critical"].to_string(),
                    category["skill"].as_str().unwrap_or(""),
                ]);
            }
            println!("{table}");
            Ok(())
        }
    }
}

fn validate_category(catalog: &HostCatalog, category: Option<&str>) -> Result<(), HostFailure> {
    if category.is_some_and(|value| !catalog.categories.iter().any(|item| item.id == value)) {
        return Err(HostFailure::validation(
            "invalid_filter",
            format!(
                "invalid --category; expected one of {}",
                catalog
                    .categories
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    Ok(())
}

fn run_resources(
    catalog: &HostCatalog,
    category: Option<&str>,
    format: HostListFormat,
) -> Result<(), HostFailure> {
    validate_category(catalog, category)?;
    let resources: Vec<Value> = catalog
        .resources
        .iter()
        .filter(|resource| category.is_none_or(|value| resource.category == value))
        .map(|resource| {
            let commands: Vec<_> = catalog
                .commands
                .iter()
                .filter(|command| command.resource == resource.id)
                .collect();
            json!({
                "id": resource.id,
                "title": resource.title,
                "category": resource.category,
                "commandCount": commands.len(),
                "highRiskCount": commands.iter().filter(|command| command.risk == "high").count(),
                "criticalRiskCount": commands.iter().filter(|command| command.risk == "critical").count(),
                "sampleCommands": commands.iter().take(5).map(|command| command.name.as_str()).collect::<Vec<_>>(),
            })
        })
        .collect();
    match format {
        HostListFormat::Json => print_json(&json!({
            "schemaVersion": 1,
            "ok": true,
            "action": "resources",
            "catalogHash": catalog.catalog_hash,
            "count": resources.len(),
            "resources": resources,
        })),
        HostListFormat::Table => {
            let mut table = Table::new();
            table.load_style(UTF8_FULL).set_header([
                "RESOURCE", "CATEGORY", "COMMANDS", "HIGH", "CRITICAL", "EXAMPLES",
            ]);
            for resource in resources {
                let samples = resource["sampleCommands"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ");
                table.add_row([
                    resource["id"].as_str().unwrap_or(""),
                    resource["category"].as_str().unwrap_or(""),
                    &resource["commandCount"].to_string(),
                    &resource["highRiskCount"].to_string(),
                    &resource["criticalRiskCount"].to_string(),
                    &samples,
                ]);
            }
            println!("{table}");
            Ok(())
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_commands(
    catalog: &HostCatalog,
    query: Option<&str>,
    target: Option<&str>,
    operation: Option<&str>,
    risk: Option<&str>,
    approval: Option<&str>,
    capability: Option<&str>,
    category: Option<&str>,
    resource: Option<&str>,
    format: HostListFormat,
) -> std::result::Result<(), HostFailure> {
    validate_filter(
        target,
        &["execution", "host-admin", "service", "client"],
        "target",
    )?;
    validate_category(catalog, category)?;
    if resource.is_some_and(|value| !catalog.resources.iter().any(|item| item.id == value)) {
        return Err(HostFailure::validation(
            "invalid_filter",
            format!(
                "invalid --resource; expected one of {}",
                catalog
                    .resources
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    validate_filter(operation, &["read", "write", "side-effect"], "operation")?;
    validate_filter(risk, &["low", "high", "critical"], "risk")?;
    validate_filter(
        approval,
        &["none", "interactive", "signed-policy"],
        "approval",
    )?;
    let query = query.map(str::to_lowercase);
    let commands: Vec<&HostCatalogCommand> = catalog
        .commands
        .iter()
        .filter(|command| {
            query.as_ref().is_none_or(|needle| {
                command.name.to_lowercase().contains(needle)
                    || command.capability.to_lowercase().contains(needle)
                    || command.summary.to_lowercase().contains(needle)
            }) && target.is_none_or(|value| command.target == value)
                && operation.is_none_or(|value| command.operation == value)
                && risk.is_none_or(|value| command.risk == value)
                && approval.is_none_or(|value| command.approval == value)
                && capability.is_none_or(|value| command.capability == value)
                && category.is_none_or(|value| command.category == value)
                && resource.is_none_or(|value| command.resource == value)
        })
        .collect();

    match format {
        HostListFormat::Json => print_json(&json!({
            "schemaVersion": 1,
            "ok": true,
            "action": "commands",
            "catalogHash": catalog.catalog_hash,
            "count": commands.len(),
            "commands": commands,
        })),
        HostListFormat::Table => {
            let mut table = Table::new();
            table.load_style(UTF8_FULL).set_header([
                "COMMAND",
                "CATEGORY",
                "RESOURCE",
                "TARGET",
                "OPERATION",
                "RISK",
                "APPROVAL",
                "CAPABILITY",
            ]);
            for command in commands {
                table.add_row([
                    &command.name,
                    &command.category,
                    &command.resource,
                    &command.target,
                    &command.operation,
                    &command.risk,
                    &command.approval,
                    &command.capability,
                ]);
            }
            println!("{table}");
            Ok(())
        }
    }
}

fn validate_filter(
    value: Option<&str>,
    allowed: &[&str],
    name: &str,
) -> std::result::Result<(), HostFailure> {
    if value.is_some_and(|value| !allowed.contains(&value)) {
        return Err(HostFailure::validation(
            "invalid_filter",
            format!("invalid --{name}; expected one of {}", allowed.join(", ")),
        ));
    }
    Ok(())
}

fn find_command<'a>(
    catalog: &'a HostCatalog,
    name: &str,
) -> std::result::Result<&'a HostCatalogCommand, HostFailure> {
    catalog
        .commands
        .iter()
        .find(|command| command.name == name)
        .ok_or_else(|| {
            let suggestions: Vec<&str> = catalog
                .commands
                .iter()
                .filter(|command| command.name.contains(name) || name.contains(&command.name))
                .take(5)
                .map(|command| command.name.as_str())
                .collect();
            HostFailure::validation(
                "unknown_command",
                format!("Headless RPC command `{name}` is not in the embedded catalog"),
            )
            .with_details(json!({ "suggestions": suggestions }))
        })
}

fn run_schema(
    catalog: &HostCatalog,
    name: &str,
    format: HostSchemaFormat,
) -> std::result::Result<(), HostFailure> {
    let command = find_command(catalog, name)?;
    match format {
        HostSchemaFormat::Json => print_json(&json!({
            "schemaVersion": 1,
            "ok": true,
            "action": "schema",
            "rpcCommand": name,
            "inputSchema": command.input_schema,
            "inputSchemaSource": command.input_schema_source,
            "outputSchema": command.output_schema,
            "outputSchemaSource": command.output_schema_source,
            "outputTyped": command.output_typed,
            "meta": {
                "category": command.category,
                "resource": command.resource,
                "target": command.target,
                "operation": command.operation,
                "capability": command.capability,
                "risk": command.risk,
                "approval": command.approval,
                "idempotency": command.idempotency,
            }
        })),
        HostSchemaFormat::Human => {
            println!("{}", command.name);
            println!("  {}", command.description);
            println!("  category: {}", command.category);
            println!("  resource: {}", command.resource);
            println!("  target: {}", command.target);
            println!("  operation: {}", command.operation);
            println!("  risk: {} ({})", command.risk, command.approval);
            println!("  capability: {}", command.capability);
            println!("  idempotency: {}", command.idempotency);
            println!(
                "  output contract: {}",
                command.output_schema_source.as_deref().unwrap_or("untyped")
            );
            println!(
                "  output: {}",
                if command.output_typed {
                    "typed JSON (outputTyped=true)"
                } else {
                    "opaque JSON (outputTyped=false)"
                }
            );
            println!(
                "\n{}",
                serde_json::to_string_pretty(&command.input_schema).map_err(|error| {
                    HostFailure::new("server", "serialize_schema", error.to_string())
                })?
            );
            Ok(())
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_call(
    catalog: &HostCatalog,
    config: &HostConfig,
    name: &str,
    data: Option<&str>,
    explicit_idempotency_key: Option<&str>,
    dry_run: bool,
    no_wait: bool,
    strict_output: bool,
    timeout_seconds: u64,
    format: HostCallFormat,
    ui: &mut RuntimeUi,
) -> std::result::Result<(), HostFailure> {
    let command = find_command(catalog, name)?;
    let body_bytes = read_data(data)?;
    let body: Value = serde_json::from_slice(&body_bytes).map_err(|error| {
        HostFailure::validation(
            "invalid_json",
            format!("request body is not valid UTF-8 JSON: {error}"),
        )
    })?;
    validate_body(command, &body)?;
    let idempotency_key = resolve_idempotency_key(command, explicit_idempotency_key)?;

    if dry_run {
        let body_hash = hex::encode(Sha256::digest(&body_bytes));
        return print_json(&json!({
            "schemaVersion": 1,
            "ok": true,
            "action": "call",
            "rpcCommand": name,
            "state": "dry-run",
            "request": {
                "method": "POST",
                "path": format!("/internal/_rpc/{name}"),
                "bodyBytes": body_bytes.len(),
                "bodySha256": body_hash,
                "bodyShape": redact_values(&body),
            },
            "meta": {
                "category": command.category,
                "resource": command.resource,
                "risk": command.risk,
                "approval": command.approval,
                "confirmationRequired": command.risk != "low",
                "idempotency": command.idempotency,
                "idempotencyKeyGenerated": command.idempotency == "required" && explicit_idempotency_key.is_none(),
                "outputTyped": command.output_typed,
            }
        }));
    }

    require_confirmation(command, ui)?;
    let resolved = resolve_config(config)?;
    let agent = build_agent(&resolved)?;
    let token = resolve_service_token(&resolved)?;
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    let mut delay = Duration::from_millis(250);
    let mut last_operation_id = None;
    let mut poll_operation = false;

    loop {
        let outcome = if poll_operation {
            let operation_id = last_operation_id.as_deref().ok_or_else(|| {
                HostFailure::new(
                    "server",
                    "missing_operation_id",
                    "the Headless server accepted an operation without an operation id",
                )
                .with_exit(6)
            })?;
            match poll_operation_with_retry(&agent, &resolved, &token, operation_id) {
                Ok(outcome) => outcome,
                Err(error) if error.http_status == Some(404) => post_rpc_with_retry(
                    &agent,
                    &resolved,
                    &token,
                    name,
                    &body,
                    idempotency_key.as_deref(),
                )?,
                Err(error) => return Err(error),
            }
        } else {
            post_rpc_with_retry(
                &agent,
                &resolved,
                &token,
                name,
                &body,
                idempotency_key.as_deref(),
            )?
        };
        if outcome.status == 202 {
            last_operation_id = outcome
                .body
                .get("operationId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(last_operation_id);
            poll_operation = last_operation_id.is_some();
            if no_wait {
                return print_call_success(
                    name,
                    command,
                    "accepted",
                    outcome.body,
                    idempotency_key.as_deref(),
                    last_operation_id.as_deref(),
                    None,
                    format,
                );
            }
            if Instant::now() >= deadline {
                return Err(HostFailure::new(
                    "timeout",
                    "operation_timeout",
                    "the durable operation is still running after the requested timeout",
                )
                .with_exit(5)
                .retryable()
                .with_details(json!({
                    "operationId": last_operation_id,
                    "idempotencyKey": idempotency_key,
                })));
            }
            thread::sleep(delay.min(deadline.saturating_duration_since(Instant::now())));
            delay = (delay * 2).min(Duration::from_secs(2));
            continue;
        }
        let output_validation = validate_completed_output(command, &outcome.body, strict_output)?;
        if output_validation.status == "invalid" {
            eprintln!(
                "warning: Headless command `{name}` returned data that violates its output contract: {}",
                output_validation.violations.join("; ")
            );
        }
        return print_call_success(
            name,
            command,
            "completed",
            outcome.body,
            idempotency_key.as_deref(),
            last_operation_id.as_deref(),
            Some(&output_validation),
            format,
        );
    }
}

fn read_data(data: Option<&str>) -> std::result::Result<Vec<u8>, HostFailure> {
    let mut bytes = match data {
        None => b"{}".to_vec(),
        Some("-") => read_limited(io::stdin().lock(), "stdin")?,
        Some(value) if value.starts_with('@') => {
            let path = &value[1..];
            if path.is_empty() {
                return Err(HostFailure::validation(
                    "invalid_data_source",
                    "--data @file requires a non-empty file path",
                ));
            }
            let file = fs::File::open(path).map_err(|error| {
                HostFailure::validation(
                    "data_file_unreadable",
                    format!("cannot open request body file: {error}"),
                )
            })?;
            read_limited(file, "request body file")?
        }
        Some(value) => value.as_bytes().to_vec(),
    };
    if bytes.len() > MAX_REQUEST_BYTES {
        bytes.clear();
        return Err(HostFailure::validation(
            "request_body_too_large",
            format!("request body exceeds the {MAX_REQUEST_BYTES}-byte Headless limit"),
        ));
    }
    Ok(bytes)
}

fn read_limited(reader: impl Read, source: &str) -> std::result::Result<Vec<u8>, HostFailure> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            HostFailure::validation(
                "data_read_failed",
                format!("failed to read {source}: {error}"),
            )
        })?;
    Ok(bytes)
}

fn validate_body(
    command: &HostCatalogCommand,
    body: &Value,
) -> std::result::Result<(), HostFailure> {
    match shared_contract()?.validate_input(&command.name, body) {
        Ok(()) => Ok(()),
        Err(error) => {
            let violations = contract_violations(error)?;
            Err(HostFailure::validation(
                "invalid_request_body",
                format!(
                    "request body does not match the `{}` input schema",
                    command.name
                ),
            )
            .with_details(json!({ "violations": violations })))
        }
    }
}

fn validate_completed_output(
    command: &HostCatalogCommand,
    body: &Value,
    strict: bool,
) -> std::result::Result<OutputValidation, HostFailure> {
    if !command.output_typed {
        return Ok(OutputValidation {
            status: "untyped",
            violations: Vec::new(),
        });
    }
    let violations = match shared_contract()?.validate_output(&command.name, body) {
        Ok(()) => {
            return Ok(OutputValidation {
                status: "valid",
                violations: Vec::new(),
            })
        }
        Err(error) => contract_violations(error)?,
    };
    if strict {
        return Err(HostFailure::new(
            "contract",
            "invalid_server_output",
            format!(
                "Headless command `{}` returned data that violates its output contract",
                command.name
            ),
        )
        .with_exit(6)
        .with_details(json!({ "violations": violations })));
    }
    Ok(OutputValidation {
        status: "invalid",
        violations,
    })
}

fn shared_contract(
) -> std::result::Result<&'static cognia_headless_contract::HeadlessContract, HostFailure> {
    match HEADLESS_CONTRACT.get_or_init(|| {
        cognia_headless_contract::HeadlessContract::embedded().map_err(|error| error.to_string())
    }) {
        Ok(contract) => Ok(contract),
        Err(error) => Err(HostFailure::configuration(
            "invalid_embedded_catalog",
            format!("embedded Headless contract cannot compile: {error}"),
        )),
    }
}

fn contract_violations(
    error: cognia_headless_contract::ContractViolation,
) -> std::result::Result<Vec<String>, HostFailure> {
    match error {
        cognia_headless_contract::ContractViolation::Invalid { violations, .. } => Ok(violations),
        cognia_headless_contract::ContractViolation::UnknownCommand { command } => {
            Err(HostFailure::configuration(
                "missing_embedded_schema",
                format!("embedded Headless catalog has no contract for `{command}`"),
            ))
        }
    }
}

fn resolve_idempotency_key(
    command: &HostCatalogCommand,
    explicit: Option<&str>,
) -> std::result::Result<Option<String>, HostFailure> {
    if command.idempotency != "required" {
        if explicit.is_some() {
            return Err(HostFailure::validation(
                "idempotency_key_forbidden",
                "this structurally idempotent command does not accept --idempotency-key",
            ));
        }
        return Ok(None);
    }
    let value = explicit
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    Uuid::parse_str(&value).map_err(|_| {
        HostFailure::validation(
            "invalid_idempotency_key",
            "--idempotency-key must be a UUID",
        )
    })?;
    Ok(Some(value))
}

fn require_confirmation(
    command: &HostCatalogCommand,
    ui: &mut RuntimeUi,
) -> std::result::Result<(), HostFailure> {
    if command.risk == "low" || ui.flags.yes {
        return Ok(());
    }
    let prompt = format!(
        "Execute {}-risk Headless command `{}`?",
        command.risk, command.name
    );
    match ui.prompter().confirm(&prompt, false, "--yes") {
        Ok(true) => Ok(()),
        Ok(false) => Err(HostFailure::new(
            "confirmation",
            "confirmation_declined",
            "the operation was not sent because confirmation was declined",
        )
        .with_exit(4)),
        Err(_) => Err(HostFailure::new(
            "confirmation",
            "confirmation_required",
            "this high-risk operation requires an interactive confirmation or user-approved --yes",
        )
        .with_exit(4)),
    }
}

fn redact_values(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), redact_values(value)))
                .collect(),
        ),
        Value::Array(values) => {
            Value::Array(values.first().map(redact_values).into_iter().collect())
        }
        Value::String(_) => json!("<redacted:string>"),
        Value::Number(_) => json!("<redacted:number>"),
        Value::Bool(_) => json!("<redacted:boolean>"),
        Value::Null => Value::Null,
    }
}

fn resolve_config(config: &HostConfig) -> std::result::Result<ResolvedConfig, HostFailure> {
    let base_url = validate_server_url(&config.server_url)?;
    let data_dir = config.data_dir.clone().unwrap_or_else(default_data_dir);
    let ca_cert = config
        .ca_cert
        .clone()
        .unwrap_or_else(|| data_dir.join("cognia").join("companion").join("tls.pem"));
    Ok(ResolvedConfig {
        base_url,
        data_dir,
        ca_cert,
        server_bin: config.server_bin.clone(),
    })
}

fn validate_server_url(value: &str) -> std::result::Result<Url, HostFailure> {
    let url = Url::parse(value).map_err(|error| {
        HostFailure::configuration(
            "invalid_server_url",
            format!("COGNIA server URL is invalid: {error}"),
        )
    })?;
    if url.scheme() != "https" {
        return Err(HostFailure::configuration(
            "https_required",
            "Headless server URL must use https",
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(HostFailure::configuration(
            "invalid_server_url",
            "Headless server URL must be an origin without credentials, path, query, or fragment",
        ));
    }
    let loopback = match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if !loopback {
        return Err(HostFailure::configuration(
            "loopback_required",
            "Headless service tokens may only be used with a literal loopback host",
        ));
    }
    if matches!(url.host(), Some(Host::Domain(_))) {
        let port = url.port_or_known_default().unwrap_or(443);
        let addresses: Vec<_> = (url.host_str().unwrap_or("localhost"), port)
            .to_socket_addrs()
            .map_err(|_| {
                HostFailure::configuration(
                    "loopback_resolution_failed",
                    "localhost could not be resolved",
                )
            })?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|address| !address.ip().is_loopback()) {
            return Err(HostFailure::configuration(
                "loopback_resolution_failed",
                "localhost must resolve exclusively to loopback addresses",
            ));
        }
    }
    Ok(url)
}

fn default_data_dir() -> PathBuf {
    directories::BaseDirs::new()
        .map(|dirs| dirs.data_dir().join("cognia-server"))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn build_tls_connector(path: &Path) -> std::result::Result<TlsConnector, HostFailure> {
    let pem = fs::read(path).map_err(|error| {
        HostFailure::configuration(
            "ca_cert_unreadable",
            format!("cannot read Headless CA certificate: {error}"),
        )
    })?;
    let certificate = Certificate::from_pem(&pem).map_err(|error| {
        HostFailure::configuration(
            "invalid_ca_cert",
            format!("Headless CA certificate is not valid PEM: {error}"),
        )
    })?;
    let mut builder = TlsConnector::builder();
    builder.add_root_certificate(certificate);
    builder.build().map_err(|error| {
        HostFailure::configuration(
            "tls_configuration_failed",
            format!("cannot construct TLS trust configuration: {error}"),
        )
    })
}

fn build_agent(resolved: &ResolvedConfig) -> std::result::Result<ureq::Agent, HostFailure> {
    let pem = fs::read(&resolved.ca_cert).map_err(|error| {
        HostFailure::configuration(
            "ca_cert_unreadable",
            format!("cannot read Headless CA certificate: {error}"),
        )
    })?;
    let certificate = ureq::tls::Certificate::from_pem(&pem).map_err(|error| {
        HostFailure::configuration(
            "invalid_ca_cert",
            format!("Headless CA certificate is not valid PEM: {error}"),
        )
    })?;
    let tls_config = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::Specific(Arc::new(vec![certificate])))
        .build();
    Ok(ureq::Agent::config_builder()
        .tls_config(tls_config)
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_global(Some(Duration::from_secs(30)))
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent(concat!("cognia/", env!("CARGO_PKG_VERSION")))
        .build()
        .new_agent())
}

fn resolve_service_token(resolved: &ResolvedConfig) -> std::result::Result<String, HostFailure> {
    if let Some(value) = std::env::var_os("COGNIA_SERVICE_TOKEN") {
        let token = value.into_string().map_err(|_| {
            HostFailure::authentication(
                "invalid_service_token",
                "COGNIA_SERVICE_TOKEN is not valid UTF-8",
            )
        })?;
        return validate_service_token(token, "COGNIA_SERVICE_TOKEN");
    }
    let binary = resolve_server_binary(resolved);
    let output = Command::new(&binary)
        .arg("issue-service-token")
        .env("COGNIA_DATA_DIR", &resolved.data_dir)
        .output()
        .map_err(|_| {
            HostFailure::authentication(
                "token_issuer_unavailable",
                "could not execute cognia-server to issue a local service token",
            )
        })?;
    if !output.status.success() {
        return Err(HostFailure::authentication(
            "token_issuance_failed",
            "cognia-server could not issue a service token for the selected data directory",
        ));
    }
    let token = String::from_utf8(output.stdout).map_err(|_| {
        HostFailure::authentication(
            "invalid_issued_token",
            "cognia-server returned a non-UTF-8 service token",
        )
    })?;
    validate_service_token(token, "cognia-server")
}

fn validate_service_token(value: String, source: &str) -> std::result::Result<String, HostFailure> {
    let token = value.trim().to_string();
    if token.is_empty() || token.lines().count() != 1 {
        let code = if source == "COGNIA_SERVICE_TOKEN" {
            "invalid_service_token"
        } else {
            "invalid_issued_token"
        };
        return Err(HostFailure::authentication(
            code,
            format!("{source} did not provide one non-empty service token"),
        ));
    }
    Ok(token)
}

fn resolve_server_binary(resolved: &ResolvedConfig) -> PathBuf {
    if let Some(path) = &resolved.server_bin {
        return path.clone();
    }
    if let Ok(current) = std::env::current_exe() {
        let sibling = current.with_file_name(if cfg!(windows) {
            "cognia-server.exe"
        } else {
            "cognia-server"
        });
        if sibling.is_file() {
            return sibling;
        }
    }
    PathBuf::from("cognia-server")
}

fn executable_available(path: &Path) -> bool {
    if path.is_file() {
        return true;
    }
    if path.components().count() != 1 {
        return false;
    }
    std::env::var_os("PATH").is_some_and(|search_path| {
        std::env::split_paths(&search_path).any(|directory| directory.join(path).is_file())
    })
}

fn post_rpc_with_retry(
    agent: &ureq::Agent,
    resolved: &ResolvedConfig,
    token: &str,
    name: &str,
    body: &Value,
    idempotency_key: Option<&str>,
) -> std::result::Result<HttpOutcome, HostFailure> {
    let endpoint = resolved
        .base_url
        .join(&format!("internal/_rpc/{name}"))
        .map_err(|_| HostFailure::configuration("invalid_rpc_url", "cannot build RPC URL"))?;
    for attempt in 0..3 {
        let mut request = agent
            .post(endpoint.as_str())
            .header("Authorization", format!("Bearer {token}"))
            .content_type("application/json");
        if let Some(key) = idempotency_key {
            request = request.header("Idempotency-Key", key);
        }
        match request.send_json(body.clone()) {
            Ok(response) if response.status().is_success() => return parse_response(response),
            Ok(response) => {
                return Err(server_failure(response.status().as_u16(), response));
            }
            Err(_) if attempt < 2 => thread::sleep(Duration::from_millis(100 * (attempt + 1))),
            Err(_) => {
                return Err(HostFailure::transport(
                    "rpc_transport_failed",
                    "could not connect to the loopback Headless server after three attempts",
                ))
            }
        }
    }
    unreachable!()
}

fn poll_operation_with_retry(
    agent: &ureq::Agent,
    resolved: &ResolvedConfig,
    token: &str,
    operation_id: &str,
) -> std::result::Result<HttpOutcome, HostFailure> {
    Uuid::parse_str(operation_id).map_err(|_| {
        HostFailure::new(
            "server",
            "invalid_operation_id",
            "the Headless server returned a non-UUID operation id",
        )
        .with_exit(6)
    })?;
    let endpoint = resolved
        .base_url
        .join(&format!("internal/operations/{operation_id}"))
        .map_err(|_| {
            HostFailure::configuration("invalid_operation_url", "cannot build operation URL")
        })?;
    for attempt in 0..3 {
        match agent
            .get(endpoint.as_str())
            .header("Authorization", format!("Bearer {token}"))
            .call()
        {
            Ok(response) if response.status().is_success() => {
                return parse_operation_response(parse_response(response)?);
            }
            Ok(response) => {
                return Err(server_failure(response.status().as_u16(), response));
            }
            Err(_) if attempt < 2 => thread::sleep(Duration::from_millis(100 * (attempt + 1))),
            Err(_) => {
                return Err(HostFailure::transport(
                    "operation_poll_failed",
                    "could not poll the durable Headless operation after three attempts",
                ))
            }
        }
    }
    unreachable!()
}

fn parse_operation_response(outcome: HttpOutcome) -> std::result::Result<HttpOutcome, HostFailure> {
    let operation_status = outcome
        .body
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostFailure::new(
                "server",
                "invalid_operation_response",
                "the Headless operation response has no status",
            )
            .with_status(outcome.status)
            .with_exit(6)
        })?;
    match operation_status {
        "queued" | "running" | "waiting_input" | "cancelling" | "recovering" => Ok(HttpOutcome {
            status: 202,
            body: outcome.body,
        }),
        "succeeded" => {
            let receipt = outcome.body.get("receipt").ok_or_else(|| {
                HostFailure::new(
                    "server",
                    "missing_operation_receipt",
                    "the completed Headless operation has no receipt",
                )
                .with_exit(6)
            })?;
            let body = receipt
                .get("result")
                .cloned()
                .or_else(|| receipt.get("body").cloned())
                .ok_or_else(|| {
                    HostFailure::new(
                        "server",
                        "invalid_operation_receipt",
                        "the completed Headless operation receipt has no result",
                    )
                    .with_exit(6)
                })?;
            Ok(HttpOutcome { status: 200, body })
        }
        "failed" => {
            let receipt = outcome.body.get("receipt").ok_or_else(|| {
                HostFailure::new(
                    "server",
                    "missing_operation_receipt",
                    "the failed Headless operation has no receipt",
                )
                .with_exit(6)
            })?;
            let status = receipt
                .get("httpStatus")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(500);
            let detail = receipt
                .get("error")
                .or_else(|| receipt.get("body").and_then(|body| body.get("error")))
                .unwrap_or(receipt);
            Err(server_failure_from_detail(status, detail))
        }
        _ => Err(HostFailure::new(
            "server",
            "unknown_operation_status",
            "the Headless operation returned an unknown status",
        )
        .with_status(outcome.status)
        .with_exit(6)),
    }
}

fn parse_response(
    mut response: ureq::http::Response<ureq::Body>,
) -> std::result::Result<HttpOutcome, HostFailure> {
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|_| {
        HostFailure::new(
            "server",
            "response_read_failed",
            "the Headless server response could not be read",
        )
        .with_exit(6)
    })?;
    let body = serde_json::from_str(&body).map_err(|_| {
        HostFailure::new(
            "server",
            "invalid_server_json",
            "the Headless server returned a non-JSON response",
        )
        .with_status(status)
        .with_exit(6)
    })?;
    Ok(HttpOutcome { status, body })
}

fn server_failure(status: u16, mut response: ureq::http::Response<ureq::Body>) -> HostFailure {
    let body = response
        .body_mut()
        .read_to_string()
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .unwrap_or_else(|| json!({}));
    let detail = body.get("error").unwrap_or(&body);
    server_failure_from_detail(status, detail)
}

fn server_failure_from_detail(status: u16, detail: &Value) -> HostFailure {
    let code = detail
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("headless_rpc_failed");
    let message = detail
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("the Headless server rejected the RPC request");
    let retryable = detail
        .get("retryable")
        .and_then(Value::as_bool)
        .unwrap_or(status >= 500);
    let mut failure_type = "server";
    let mut exit = 6;
    if status == 401 {
        failure_type = "authentication";
        exit = 3;
    }
    HostFailure::new(failure_type, code, message)
        .with_status(status)
        .with_exit(exit)
        .with_details(detail.get("details").cloned().unwrap_or_else(|| json!({})))
        .with_retryable(retryable)
}

impl HostFailure {
    fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }
}

#[allow(clippy::too_many_arguments)]
fn print_call_success(
    name: &str,
    command: &HostCatalogCommand,
    state: &str,
    data: Value,
    idempotency_key: Option<&str>,
    operation_id: Option<&str>,
    output_validation: Option<&OutputValidation>,
    format: HostCallFormat,
) -> std::result::Result<(), HostFailure> {
    match format {
        HostCallFormat::Raw => print_json(&data),
        HostCallFormat::Json => print_json(&json!({
            "schemaVersion": 1,
            "ok": true,
            "action": "call",
            "rpcCommand": name,
            "state": state,
            "data": data,
            "meta": {
                "category": command.category,
                "resource": command.resource,
                "risk": command.risk,
                "approval": command.approval,
                "outputTyped": command.output_typed,
                "outputValidation": output_validation,
                "idempotencyKey": idempotency_key,
                "operationId": operation_id,
            }
        })),
    }
}

fn run_doctor(
    catalog: &HostCatalog,
    config: &HostConfig,
    offline: bool,
    format: HostSchemaFormat,
) -> std::result::Result<(), HostFailure> {
    let resolved = resolve_config(config)?;
    let credential_source = if let Some(token) = std::env::var_os("COGNIA_SERVICE_TOKEN") {
        let valid = token
            .into_string()
            .ok()
            .and_then(|token| validate_service_token(token, "COGNIA_SERVICE_TOKEN").ok())
            .is_some();
        json!({"name":"credential-source","status":if valid{"ok"}else{"fail"},"detail":"env"})
    } else {
        let issuer = resolve_server_binary(&resolved);
        json!({"name":"credential-source","status":if executable_available(&issuer){"ok"}else{"fail"},"detail":"issued"})
    };
    let mut checks = vec![
        json!({"name":"catalog","status":"ok","detail":format!("{} commands, {}", catalog.commands.len(), catalog.catalog_hash)}),
        json!({"name":"server-url","status":"ok","detail":resolved.base_url.origin().ascii_serialization()}),
        json!({"name":"data-dir","status":if resolved.data_dir.is_dir(){"ok"}else{"fail"},"detail":resolved.data_dir.display().to_string()}),
        json!({"name":"ca-cert","status":if resolved.ca_cert.is_file(){"ok"}else{"fail"},"detail":resolved.ca_cert.display().to_string()}),
        credential_source,
    ];
    if !offline {
        let agent = build_agent(&resolved)?;
        checks.push(probe_json(&agent, &resolved, "healthz", Some(catalog))?);
        checks.push(probe_json(&agent, &resolved, "readyz", None)?);
        let token = resolve_service_token(&resolved)?;
        let safe = find_command(catalog, "host_capabilities")?;
        validate_body(safe, &json!({}))?;
        post_rpc_with_retry(
            &agent,
            &resolved,
            &token,
            "host_capabilities",
            &json!({}),
            None,
        )?;
        checks.push(json!({"name":"authenticated-rpc","status":"ok","detail":"host_capabilities"}));
    }
    let ok = checks
        .iter()
        .all(|check| check.get("status").and_then(Value::as_str) != Some("fail"));
    if !ok {
        return Err(HostFailure::configuration(
            "doctor_failed",
            "one or more local Headless checks failed",
        )
        .with_details(json!({"checks": checks})));
    }
    match format {
        HostSchemaFormat::Json => print_json(&json!({
            "schemaVersion":1,"ok":true,"action":"doctor","offline":offline,"checks":checks
        })),
        HostSchemaFormat::Human => {
            for check in checks {
                println!(
                    "[{:<4}] {}: {}",
                    check["status"].as_str().unwrap_or("?"),
                    check["name"].as_str().unwrap_or("check"),
                    check["detail"].as_str().unwrap_or("")
                );
            }
            Ok(())
        }
    }
}

fn probe_json(
    agent: &ureq::Agent,
    resolved: &ResolvedConfig,
    path: &str,
    expected_contract: Option<&HostCatalog>,
) -> std::result::Result<Value, HostFailure> {
    let url = resolved
        .base_url
        .join(path)
        .map_err(|_| HostFailure::configuration("invalid_probe_url", "cannot build probe URL"))?;
    match agent.get(url.as_str()).call() {
        Ok(mut response) if response.status().is_success() => {
            let status = response.status().as_u16();
            let body: Value = response.body_mut().read_json().map_err(|_| {
                HostFailure::new(
                    "server",
                    "invalid_probe_response",
                    format!("/{path} returned invalid JSON"),
                )
                .with_exit(6)
            })?;
            if let Some(catalog) = expected_contract {
                validate_server_contract_identity(&body, catalog)?;
            }
            Ok(json!({"name":path,"status":"ok","detail":format!("HTTP {status}")}))
        }
        Ok(response) => Err(HostFailure::new(
            "server",
            "probe_failed",
            format!("/{path} returned HTTP {}", response.status().as_u16()),
        )
        .with_status(response.status().as_u16())
        .with_exit(6)),
        Err(_) => Err(HostFailure::transport(
            "probe_transport_failed",
            format!("could not reach /{path}"),
        )),
    }
}

fn validate_server_contract_identity(
    body: &Value,
    catalog: &HostCatalog,
) -> std::result::Result<(), HostFailure> {
    let identity = body.get("headlessContract").and_then(Value::as_object);
    let server_hash = identity
        .and_then(|value| value.get("catalogHash"))
        .and_then(Value::as_str);
    let server_version = identity
        .and_then(|value| value.get("schemaVersion"))
        .and_then(Value::as_u64);
    if server_hash == Some(catalog.catalog_hash.as_str())
        && server_version == Some(u64::from(catalog.schema_version))
    {
        return Ok(());
    }
    Err(HostFailure::new(
        "server",
        "headless_contract_mismatch",
        "the CLI catalog does not match the running Headless server",
    )
    .with_exit(6)
    .with_details(json!({
        "clientCatalogHash": catalog.catalog_hash,
        "clientSchemaVersion": catalog.schema_version,
        "serverCatalogHash": server_hash,
        "serverSchemaVersion": server_version,
    })))
}

fn run_events(
    config: &HostConfig,
    since: Option<u64>,
    event_filters: &[String],
    max_events: Option<u64>,
) -> std::result::Result<(), HostFailure> {
    if max_events == Some(0) {
        return Ok(());
    }
    let resolved = resolve_config(config)?;
    let connector = build_tls_connector(&resolved.ca_cert)?;
    let token = resolve_service_token(&resolved)?;
    let stop = Arc::new(AtomicBool::new(false));
    let signal_stop = stop.clone();
    ctrlc::set_handler(move || signal_stop.store(true, Ordering::SeqCst)).map_err(|_| {
        HostFailure::configuration("signal_handler_failed", "could not install Ctrl+C handler")
    })?;
    let filters: HashSet<&str> = event_filters.iter().map(String::as_str).collect();
    let mut cursor = since;
    let mut emitted = 0_u64;
    let mut failures = 0_u8;
    while !stop.load(Ordering::SeqCst) {
        match stream_events_once(
            &resolved,
            &token,
            connector.clone(),
            cursor,
            &filters,
            max_events.map(|max| max.saturating_sub(emitted)),
            &stop,
        ) {
            Ok(StreamResult::Stopped) => return Ok(()),
            Ok(StreamResult::LimitReached { last_seq, count }) => {
                cursor = last_seq.or(cursor);
                emitted += count;
                if max_events.is_some_and(|max| emitted >= max) {
                    return Ok(());
                }
                failures = 0;
            }
            Ok(StreamResult::Disconnected { last_seq, count }) => {
                cursor = last_seq.or(cursor);
                emitted += count;
                failures = if count > 0 { 1 } else { failures + 1 };
            }
            Err(failure) if failure.error_type == "resync" => return Err(failure),
            Err(_) => failures += 1,
        }
        if failures >= 3 {
            return Err(HostFailure::transport(
                "event_reconnect_exhausted",
                "the Headless event stream failed three consecutive times",
            )
            .with_details(json!({"cursor": cursor})));
        }
        thread::sleep(Duration::from_millis(250 * u64::from(failures.max(1))));
    }
    Ok(())
}

enum StreamResult {
    Stopped,
    LimitReached { last_seq: Option<u64>, count: u64 },
    Disconnected { last_seq: Option<u64>, count: u64 },
}

fn stream_events_once(
    resolved: &ResolvedConfig,
    token: &str,
    connector: TlsConnector,
    since: Option<u64>,
    filters: &HashSet<&str>,
    remaining: Option<u64>,
    stop: &AtomicBool,
) -> std::result::Result<StreamResult, HostFailure> {
    let host = resolved.base_url.host_str().ok_or_else(|| {
        HostFailure::configuration("invalid_server_url", "server host is missing")
    })?;
    let port = resolved.base_url.port_or_known_default().unwrap_or(443);
    let stream = connect_loopback(host, port)?;
    stream.set_read_timeout(Some(EVENT_READ_TIMEOUT)).ok();
    let mut ws_url = resolved.base_url.clone();
    ws_url.set_scheme("wss").ok();
    ws_url.set_path("/internal/events");
    {
        let mut query = ws_url.query_pairs_mut();
        query.append_pair("token", token);
        if let Some(cursor) = since {
            query.append_pair("since", &cursor.to_string());
        }
    }
    let (mut socket, _) = client_tls_with_config(
        ws_url.as_str(),
        stream,
        None,
        Some(Connector::NativeTls(connector)),
    )
    .map_err(|_| {
        HostFailure::transport(
            "event_handshake_failed",
            "Headless event TLS/WebSocket handshake failed",
        )
    })?;
    let mut last_seq = since;
    let mut count = 0_u64;
    while !stop.load(Ordering::SeqCst) {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let frame: Value = serde_json::from_str(&text).map_err(|_| {
                    HostFailure::new(
                        "server",
                        "invalid_event_frame",
                        "Headless events returned invalid JSON",
                    )
                    .with_exit(6)
                })?;
                match frame.get("type").and_then(Value::as_str) {
                    Some("ping") => {
                        socket
                            .send(Message::Text(r#"{"type":"pong"}"#.into()))
                            .map_err(|_| {
                                HostFailure::transport(
                                    "event_pong_failed",
                                    "could not reply to event heartbeat",
                                )
                            })?;
                    }
                    Some("resync_required") => {
                        return Err(
                            HostFailure::new(
                                "resync",
                                "resync_required",
                                "the event cursor is outside retention; refresh authoritative state through RPC",
                            )
                            .with_exit(6)
                            .with_details(json!({
                                "cursor": frame.get("cursor").cloned().unwrap_or(Value::Null),
                                "lastSeen": last_seq,
                            })),
                        );
                    }
                    Some(event_type) => {
                        if let Some(seq) = frame.get("seq").and_then(Value::as_u64) {
                            last_seq = Some(seq);
                        }
                        if filters.is_empty() || filters.contains(event_type) {
                            println!(
                                "{}",
                                serde_json::to_string(&frame).unwrap_or_else(|_| frame.to_string())
                            );
                            count += 1;
                            if remaining.is_some_and(|limit| count >= limit) {
                                return Ok(StreamResult::LimitReached { last_seq, count });
                            }
                        }
                    }
                    None => {}
                }
            }
            Ok(Message::Ping(data)) => {
                socket.send(Message::Pong(data)).ok();
            }
            Ok(Message::Close(_)) => {
                return Ok(StreamResult::Disconnected { last_seq, count });
            }
            Ok(_) => {}
            Err(_) => return Ok(StreamResult::Disconnected { last_seq, count }),
        }
    }
    let _ = socket.close(None);
    Ok(StreamResult::Stopped)
}

fn connect_loopback(host: &str, port: u16) -> std::result::Result<TcpStream, HostFailure> {
    let addresses = (host, port).to_socket_addrs().map_err(|_| {
        HostFailure::transport(
            "event_connect_failed",
            "loopback host could not be resolved",
        )
    })?;
    for address in addresses.filter(|address| address.ip().is_loopback()) {
        if let Ok(stream) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            return Ok(stream);
        }
    }
    Err(HostFailure::transport(
        "event_connect_failed",
        "could not connect to Headless events on a loopback address",
    ))
}

struct EmbeddedSkill {
    name: &'static str,
    kind: &'static str,
    category: Option<&'static str>,
    content: &'static str,
    references: &'static [(&'static str, &'static str)],
}

const EMBEDDED_SKILLS: &[EmbeddedSkill] = &[
    EmbeddedSkill {
        name: "cognia-host",
        kind: "core",
        category: None,
        content: HOST_SKILL,
        references: &[("references/output-contract.md", HOST_OUTPUT_REFERENCE)],
    },
    EmbeddedSkill {
        name: "cognia-host-sessions",
        kind: "domain",
        category: Some("sessions"),
        content: HOST_SESSIONS_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-agents",
        kind: "domain",
        category: Some("agents"),
        content: HOST_AGENTS_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-tasks",
        kind: "domain",
        category: Some("tasks"),
        content: HOST_TASKS_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-automation",
        kind: "domain",
        category: Some("automation"),
        content: HOST_AUTOMATION_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-connectors",
        kind: "domain",
        category: Some("connectors"),
        content: HOST_CONNECTORS_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-extensions",
        kind: "domain",
        category: Some("extensions"),
        content: HOST_EXTENSIONS_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-knowledge",
        kind: "domain",
        category: Some("knowledge"),
        content: HOST_KNOWLEDGE_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-development",
        kind: "domain",
        category: Some("development"),
        content: HOST_DEVELOPMENT_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-system",
        kind: "domain",
        category: Some("system"),
        content: HOST_SYSTEM_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-observe",
        kind: "workflow",
        category: None,
        content: HOST_OBSERVE_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-safe-git",
        kind: "workflow",
        category: Some("development"),
        content: HOST_SAFE_GIT_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-agent-incident",
        kind: "workflow",
        category: Some("agents"),
        content: HOST_AGENT_INCIDENT_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-backup-recovery",
        kind: "workflow",
        category: Some("system"),
        content: HOST_BACKUP_RECOVERY_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-extension-rollout",
        kind: "workflow",
        category: Some("extensions"),
        content: HOST_EXTENSION_ROLLOUT_SKILL,
        references: &[],
    },
    EmbeddedSkill {
        name: "cognia-host-connector-delivery",
        kind: "workflow",
        category: Some("connectors"),
        content: HOST_CONNECTOR_DELIVERY_SKILL,
        references: &[],
    },
];

fn embedded_skill_description(
    skill: &EmbeddedSkill,
) -> std::result::Result<&'static str, HostFailure> {
    let mut lines = skill.content.lines();
    if lines.next() != Some("---") {
        return Err(HostFailure::validation(
            "invalid_embedded_skill",
            format!("embedded skill {} has no YAML frontmatter", skill.name),
        ));
    }
    for line in lines {
        if line == "---" {
            break;
        }
        if let Some(description) = line.strip_prefix("description: ") {
            if !description.is_empty() {
                return Ok(description);
            }
        }
    }
    Err(HostFailure::validation(
        "invalid_embedded_skill",
        format!("embedded skill {} has no description", skill.name),
    ))
}

fn skill_kind_value(kind: HostSkillKind) -> &'static str {
    match kind {
        HostSkillKind::Core => "core",
        HostSkillKind::Domain => "domain",
        HostSkillKind::Workflow => "workflow",
    }
}

fn run_skills(command: HostSkillsCommand) -> std::result::Result<(), HostFailure> {
    match command {
        HostSkillsCommand::Install { scope } => {
            let output = skills_installer::install_embedded_skills(scope)?;
            print_json(&output)
        }
        HostSkillsCommand::List { category, kind } => {
            if category.as_ref().is_some_and(|category| {
                !EMBEDDED_SKILLS
                    .iter()
                    .any(|skill| skill.category == Some(category.as_str()))
            }) {
                return Err(HostFailure::validation(
                    "unknown_skill_category",
                    "the requested host skill category is not embedded",
                ));
            }
            let skills: Vec<_> = EMBEDDED_SKILLS
                .iter()
                .filter(|skill| {
                    category
                        .as_deref()
                        .is_none_or(|category| skill.category == Some(category))
                        && kind.is_none_or(|kind| skill.kind == skill_kind_value(kind))
                })
                .map(|skill| {
                    let files: Vec<_> = std::iter::once("SKILL.md")
                        .chain(skill.references.iter().map(|(path, _)| *path))
                        .collect();
                    Ok(json!({
                        "name": skill.name,
                        "kind": skill.kind,
                        "category": skill.category,
                        "description": embedded_skill_description(skill)?,
                        "contentHash": skills_installer::skill_content_hash(skill),
                        "files": files,
                    }))
                })
                .collect::<std::result::Result<_, HostFailure>>()?;
            print_json(&json!({
                "schemaVersion":1,
                "ok":true,
                "action":"skills",
                "bundleVersion": env!("CARGO_PKG_VERSION"),
                "count": skills.len(),
                "skills": skills,
            }))
        }
        HostSkillsCommand::Read { skill, path } => {
            let skill = EMBEDDED_SKILLS
                .iter()
                .find(|candidate| candidate.name == skill)
                .ok_or_else(|| {
                    HostFailure::validation(
                        "unknown_skill",
                        "the requested skill is not embedded; run `cognia host skills list`",
                    )
                })?;
            let path = path.as_deref().unwrap_or("SKILL.md");
            let content = if path == "SKILL.md" {
                skill.content
            } else {
                skill
                    .references
                    .iter()
                    .find_map(|(candidate, content)| (*candidate == path).then_some(*content))
                    .ok_or_else(|| {
                        HostFailure::validation(
                            "skill_path_forbidden",
                            "the requested path is not in the embedded skill allowlist",
                        )
                    })?
            };
            print!("{content}");
            if !content.ends_with('\n') {
                println!();
            }
            Ok(())
        }
    }
}

fn print_json(value: &Value) -> std::result::Result<(), HostFailure> {
    let output = serde_json::to_string_pretty(value).map_err(|error| {
        HostFailure::new("server", "json_serialization_failed", error.to_string())
    })?;
    println!("{output}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::runtime::{ColorMode, UiFlags};
    use crate::ui::RuntimeUi;
    use native_tls::{Identity, TlsAcceptor};
    use openssl::asn1::Asn1Time;
    use openssl::bn::{BigNum, MsbOption};
    use openssl::hash::MessageDigest;
    use openssl::pkey::PKey;
    use openssl::rsa::Rsa;
    use openssl::x509::extension::{
        BasicConstraints, ExtendedKeyUsage, KeyUsage, SubjectAlternativeName,
    };
    use openssl::x509::{X509NameBuilder, X509};
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::mpsc::{self, Receiver};
    use std::sync::Mutex;
    use std::thread::JoinHandle;
    use tempfile::TempDir;

    static TLS_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct TlsTestServer {
        resolved: ResolvedConfig,
        requests: Receiver<String>,
        handle: JoinHandle<()>,
        _temp_dir: TempDir,
    }

    fn spawn_tls_server(responses: Vec<(u16, &'static str)>) -> TlsTestServer {
        let (cert_pem, key_pem) = localhost_certificate();
        let identity = Identity::from_pkcs8(&cert_pem, &key_pem).expect("TLS identity");
        let acceptor = TlsAcceptor::new(identity).expect("TLS acceptor");
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let port = listener.local_addr().expect("listener address").port();
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let ca_cert = temp_dir.path().join("tls.pem");
        fs::write(&ca_cert, &cert_pem).expect("write CA certificate");
        let (request_tx, requests) = mpsc::channel();
        let handle = thread::spawn(move || {
            for (status, body) in responses {
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                let Ok(mut stream) = acceptor.accept(stream) else {
                    continue;
                };
                let Ok(request) = read_http_request(&mut stream) else {
                    continue;
                };
                let _ = request_tx.send(request);
                let reason = match status {
                    200 => "OK",
                    202 => "Accepted",
                    409 => "Conflict",
                    _ => "Error",
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        TlsTestServer {
            resolved: ResolvedConfig {
                base_url: Url::parse(&format!("https://localhost:{port}/")).expect("base URL"),
                data_dir: temp_dir.path().to_path_buf(),
                ca_cert,
                server_bin: None,
            },
            requests,
            handle,
            _temp_dir: temp_dir,
        }
    }

    fn localhost_certificate() -> (Vec<u8>, Vec<u8>) {
        let key = PKey::from_rsa(Rsa::generate(2048).expect("RSA key")).expect("private key");
        let mut name = X509NameBuilder::new().expect("X.509 name");
        name.append_entry_by_text("CN", "localhost")
            .expect("common name");
        let name = name.build();
        let mut serial = BigNum::new().expect("serial");
        serial
            .rand(128, MsbOption::MAYBE_ZERO, false)
            .expect("random serial");
        let serial = serial.to_asn1_integer().expect("ASN.1 serial");
        let mut certificate = X509::builder().expect("X.509 builder");
        certificate.set_version(2).expect("X.509 version");
        certificate
            .set_serial_number(&serial)
            .expect("X.509 serial");
        certificate.set_subject_name(&name).expect("X.509 subject");
        certificate.set_issuer_name(&name).expect("X.509 issuer");
        certificate.set_pubkey(&key).expect("X.509 public key");
        certificate
            .set_not_before(&Asn1Time::days_from_now(0).expect("not before"))
            .expect("X.509 not before");
        certificate
            .set_not_after(&Asn1Time::days_from_now(1).expect("not after"))
            .expect("X.509 not after");
        certificate
            .append_extension(
                BasicConstraints::new()
                    .critical()
                    .ca()
                    .build()
                    .expect("CA extension"),
            )
            .expect("X.509 CA extension");
        certificate
            .append_extension(
                KeyUsage::new()
                    .digital_signature()
                    .key_encipherment()
                    .key_cert_sign()
                    .build()
                    .expect("key usage extension"),
            )
            .expect("X.509 key usage extension");
        certificate
            .append_extension(
                ExtendedKeyUsage::new()
                    .server_auth()
                    .build()
                    .expect("extended key usage extension"),
            )
            .expect("X.509 extended key usage extension");
        let san = SubjectAlternativeName::new()
            .dns("localhost")
            .build(&certificate.x509v3_context(None, None))
            .expect("SAN extension");
        certificate
            .append_extension(san)
            .expect("X.509 SAN extension");
        certificate
            .sign(&key, MessageDigest::sha256())
            .expect("sign certificate");
        (
            certificate.build().to_pem().expect("certificate PEM"),
            key.private_key_to_pem_pkcs8().expect("private key PEM"),
        )
    }

    fn read_http_request(stream: &mut impl Read) -> io::Result<String> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 2048];
        loop {
            let read = stream.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        String::from_utf8(request)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    fn catalog() -> HostCatalog {
        load_catalog().expect("catalog")
    }

    #[test]
    fn embedded_catalog_contains_concrete_commands() {
        let catalog = catalog();
        assert!(catalog.commands.len() > 400);
        assert_eq!(catalog.categories.len(), 9);
        assert!(catalog.resources.len() > catalog.categories.len());
        let command = find_command(&catalog, "session_list").unwrap();
        assert_eq!(command.category, "sessions");
        assert_eq!(command.resource, "session");
        assert!(command.output_typed);
        assert_eq!(command.output_schema_source.as_deref(), Some("contract"));
        assert_eq!(command.output_schema.as_ref().unwrap()["type"], "object");
        assert_eq!(command.input_schema["type"], "object");
    }

    #[test]
    fn server_contract_identity_must_match_the_embedded_catalog() {
        let catalog = catalog();
        validate_server_contract_identity(
            &json!({
                "headlessContract": {
                    "catalogHash": catalog.catalog_hash.clone(),
                    "schemaVersion": catalog.schema_version,
                }
            }),
            &catalog,
        )
        .expect("matching identity");

        let failure = validate_server_contract_identity(
            &json!({"headlessContract":{"catalogHash":"stale","schemaVersion":1}}),
            &catalog,
        )
        .expect_err("stale server must fail doctor");
        assert_eq!(failure.code, "headless_contract_mismatch");
    }

    #[test]
    fn every_category_has_commands_and_an_embedded_skill() {
        let catalog = catalog();
        for category in &catalog.categories {
            assert!(
                catalog
                    .commands
                    .iter()
                    .any(|command| command.category == category.id),
                "empty category: {}",
                category.id
            );
            assert!(
                EMBEDDED_SKILLS
                    .iter()
                    .any(|skill| skill.name == category.skill
                        && skill.category == Some(&category.id)),
                "missing skill: {}",
                category.skill
            );
        }
    }

    #[test]
    fn every_command_resource_exists_in_the_same_category() {
        let catalog = catalog();
        let mut resource_ids = HashSet::new();
        for resource in &catalog.resources {
            assert!(
                resource_ids.insert(&resource.id),
                "duplicate resource: {}",
                resource.id
            );
            assert!(
                catalog
                    .categories
                    .iter()
                    .any(|category| category.id == resource.category),
                "unknown resource category: {}",
                resource.category
            );
            assert!(
                catalog
                    .commands
                    .iter()
                    .any(|command| command.resource == resource.id),
                "empty resource: {}",
                resource.id
            );
        }
        for command in &catalog.commands {
            let resource = catalog
                .resources
                .iter()
                .find(|resource| resource.id == command.resource)
                .unwrap_or_else(|| panic!("missing resource for {}", command.name));
            assert_eq!(resource.category, command.category, "{}", command.name);
        }
    }

    #[test]
    fn embedded_workflow_skills_keep_the_core_safety_contract() {
        let workflows: Vec<_> = EMBEDDED_SKILLS
            .iter()
            .filter(|skill| skill.kind == "workflow")
            .collect();
        assert_eq!(workflows.len(), 6);
        for skill in workflows {
            assert!(
                skill
                    .content
                    .contains("`cognia host skills read cognia-host`"),
                "{}",
                skill.name
            );
            assert!(skill.content.contains("schema"), "{}", skill.name);
            assert!(
                skill.content.contains("Never add `--yes`"),
                "{}",
                skill.name
            );
            assert!(skill.content.contains("idempotency"), "{}", skill.name);
        }
    }

    #[test]
    fn server_url_rejects_remote_and_non_https_origins() {
        assert!(validate_server_url("https://127.0.0.1:27890").is_ok());
        assert!(validate_server_url("http://127.0.0.1:27890").is_err());
        assert!(validate_server_url("https://example.com:27890").is_err());
        assert!(validate_server_url("https://localhost:27890/path").is_err());
    }

    #[test]
    fn generated_schema_accepts_valid_agent_task_comment() {
        let catalog = catalog();
        let command = find_command(&catalog, "agent_task_comment").unwrap();
        assert!(validate_body(
            command,
            &json!({"agentId":"agent-a","taskId":"task-a","text":"hello"})
        )
        .is_ok());
        assert!(validate_body(
            command,
            &json!({"agentId":"agent-a","taskId":"task-a","text":"hello","extra":true})
        )
        .is_err());
    }

    #[test]
    fn output_validation_reports_valid_invalid_and_untyped_results() {
        let catalog = catalog();
        let command = find_command(&catalog, "session_list").unwrap();

        assert_eq!(
            validate_completed_output(command, &json!({"rows": [], "total": 1}), false)
                .unwrap()
                .status,
            "valid"
        );
        let invalid =
            validate_completed_output(command, &json!({"rows": [], "total": -1}), false).unwrap();
        assert_eq!(invalid.status, "invalid");
        assert!(!invalid.violations.is_empty());
    }

    #[test]
    fn strict_output_validation_rejects_contract_violations() {
        let catalog = catalog();
        let command = find_command(&catalog, "session_list").unwrap();

        let failure = validate_completed_output(command, &json!({}), true).unwrap_err();
        assert_eq!(failure.error_type, "contract");
        assert_eq!(failure.code, "invalid_server_output");
        assert_eq!(failure.exit_code, 6);
        assert!(failure.details["violations"].as_array().unwrap().len() <= 20);
    }

    #[test]
    fn standard_uri_and_date_time_formats_are_enforced() {
        let catalog = catalog();
        let uri_command = find_command(&catalog, "connectors_ws_open").unwrap();
        assert!(validate_body(uri_command, &json!({"url":"wss://localhost/socket"})).is_ok());
        assert!(validate_body(uri_command, &json!({"url":"not a uri"})).is_err());

        let date_command = find_command(&catalog, "plugin_permission_grant").unwrap();
        let base = json!({"pluginId":"plugin","permission":"network","grantedBy":"user"});
        assert!(validate_body(date_command, &base).is_ok());
        let mut invalid = base;
        invalid["expiresAt"] = json!("not a timestamp");
        assert!(validate_body(date_command, &invalid).is_err());
    }

    #[test]
    fn dry_run_redacts_every_scalar_value() {
        let redacted = redact_values(&json!({
            "token":"secret-value",
            "count":42,
            "enabled":true,
            "items":[{"password":"hidden"}]
        }));
        let rendered = redacted.to_string();
        assert!(!rendered.contains("secret-value"));
        assert!(!rendered.contains("hidden"));
        assert!(!rendered.contains("42"));
        assert!(rendered.contains("token"));
    }

    #[test]
    fn structural_commands_reject_explicit_idempotency_keys() {
        let catalog = catalog();
        let command = find_command(&catalog, "session_list").unwrap();
        assert!(resolve_idempotency_key(command, Some(&Uuid::new_v4().to_string())).is_err());
    }

    #[test]
    fn required_commands_generate_uuid_keys() {
        let catalog = catalog();
        let command = catalog
            .commands
            .iter()
            .find(|command| command.idempotency == "required")
            .unwrap();
        let key = resolve_idempotency_key(command, None).unwrap().unwrap();
        assert!(Uuid::parse_str(&key).is_ok());
    }

    #[test]
    fn low_risk_commands_do_not_prompt() {
        let catalog = catalog();
        let command = catalog
            .commands
            .iter()
            .find(|command| command.risk == "low")
            .unwrap();
        let mut ui = RuntimeUi::new(UiFlags {
            color: ColorMode::Never,
            ..UiFlags::default()
        });
        assert!(require_confirmation(command, &mut ui).is_ok());
    }

    #[test]
    fn high_risk_noninteractive_calls_require_confirmation() {
        let catalog = catalog();
        let command = catalog
            .commands
            .iter()
            .find(|command| command.risk == "high")
            .unwrap();
        let mut ui = RuntimeUi::new(UiFlags {
            color: ColorMode::Never,
            ..UiFlags::default()
        });
        let error = require_confirmation(command, &mut ui).unwrap_err();
        assert_eq!(error.error_type, "confirmation");
        assert_eq!(error.exit_code, 4);
    }

    #[test]
    fn skill_reader_uses_an_explicit_allowlist() {
        assert!(run_skills(HostSkillsCommand::Read {
            skill: "cognia-host".into(),
            path: Some("../secret".into()),
        })
        .is_err());
    }

    #[test]
    fn request_body_files_enforce_the_exact_headless_byte_limit() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let valid_path = temp_dir.path().join("valid.json");
        let oversized_path = temp_dir.path().join("oversized.json");
        let mut valid = vec![b' '; MAX_REQUEST_BYTES - 2];
        valid.extend_from_slice(b"{}");
        fs::write(&valid_path, &valid).expect("valid body");
        fs::write(&oversized_path, [valid, vec![b' ']].concat()).expect("oversized body");

        assert_eq!(
            read_data(Some(&format!("@{}", valid_path.display())))
                .expect("body at byte limit")
                .len(),
            MAX_REQUEST_BYTES
        );
        let error = read_data(Some(&format!("@{}", oversized_path.display())))
            .expect_err("oversized request");
        assert_eq!(error.code, "request_body_too_large");
    }

    #[test]
    fn service_tokens_must_be_a_single_non_empty_line() {
        assert_eq!(
            validate_service_token(" token \n".into(), "COGNIA_SERVICE_TOKEN").unwrap(),
            "token"
        );
        assert!(validate_service_token(" \n".into(), "COGNIA_SERVICE_TOKEN").is_err());
        assert!(validate_service_token("one\ntwo".into(), "COGNIA_SERVICE_TOKEN").is_err());
    }

    #[test]
    fn trusted_tls_rpc_sends_auth_body_and_idempotency_headers() {
        let _guard = TLS_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let server = spawn_tls_server(vec![(200, r#"{"items":[]}"#)]);
        let agent = build_agent(&server.resolved).expect("trusted TLS agent");
        let key = Uuid::new_v4().to_string();
        let outcome = post_rpc_with_retry(
            &agent,
            &server.resolved,
            "service-token",
            "session_list",
            &json!({"limit": 10}),
            Some(&key),
        )
        .expect("RPC response");

        assert_eq!(outcome.status, 200);
        assert_eq!(outcome.body, json!({"items": []}));
        let request = server.requests.recv().expect("captured request");
        assert!(request.starts_with("POST /internal/_rpc/session_list HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer service-token"));
        assert!(request
            .to_ascii_lowercase()
            .contains(&format!("idempotency-key: {key}").to_ascii_lowercase()));
        assert!(request.ends_with(r#"{"limit":10}"#));
        server.handle.join().expect("TLS server");
    }

    #[test]
    fn accepted_rpc_is_completed_through_the_operation_route() {
        let _guard = TLS_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let server = spawn_tls_server(vec![
            (202, r#"{"operationId":"operation-1","status":"running"}"#),
            (
                200,
                r#"{"operationId":"operation-1","status":"succeeded","receipt":{"httpStatus":200,"result":{"done":true}},"createdAt":1,"updatedAt":2}"#,
            ),
        ]);
        let agent = build_agent(&server.resolved).expect("trusted TLS agent");
        let key = Uuid::new_v4().to_string();
        let body = json!({"name": "same-body"});

        let accepted = post_rpc_with_retry(
            &agent,
            &server.resolved,
            "service-token",
            "test_command",
            &body,
            Some(&key),
        )
        .expect("accepted response");
        let completed = poll_operation_with_retry(
            &agent,
            &server.resolved,
            "service-token",
            "00000000-0000-4000-8000-000000000001",
        )
        .expect("completed operation");

        assert_eq!(accepted.status, 202);
        assert_eq!(accepted.body["operationId"], "operation-1");
        assert_eq!(completed.status, 200);
        let first = server.requests.recv().expect("first request");
        let second = server.requests.recv().expect("operation poll");
        assert!(first.starts_with("POST /internal/_rpc/test_command HTTP/1.1"));
        assert!(second
            .starts_with("GET /internal/operations/00000000-0000-4000-8000-000000000001 HTTP/1.1"));
        server.handle.join().expect("TLS server");
    }

    #[test]
    fn server_json_errors_are_normalized_without_transport_retries() {
        let _guard = TLS_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let server = spawn_tls_server(vec![(
            409,
            r#"{"code":"idempotency_conflict","message":"body mismatch"}"#,
        )]);
        let agent = build_agent(&server.resolved).expect("trusted TLS agent");
        let error = post_rpc_with_retry(
            &agent,
            &server.resolved,
            "service-token",
            "test_command",
            &json!({}),
            Some(&Uuid::new_v4().to_string()),
        )
        .expect_err("server rejection");

        assert_eq!(error.error_type, "server");
        assert_eq!(error.code, "idempotency_conflict");
        assert_eq!(error.message, "body mismatch");
        assert_eq!(error.http_status, Some(409));
        assert!(!error.retryable);
        assert!(server.requests.recv().is_ok());
        server.handle.join().expect("TLS server");
    }

    #[test]
    fn tls_hostname_mismatch_is_a_transport_failure() {
        let _guard = TLS_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut server = spawn_tls_server(vec![(200, r#"{}"#), (200, r#"{}"#), (200, r#"{}"#)]);
        let port = server.resolved.base_url.port().expect("port");
        server.resolved.base_url =
            Url::parse(&format!("https://127.0.0.1:{port}/")).expect("mismatched URL");
        let agent = build_agent(&server.resolved).expect("TLS agent");
        let error = post_rpc_with_retry(
            &agent,
            &server.resolved,
            "service-token",
            "test_command",
            &json!({}),
            None,
        )
        .expect_err("hostname mismatch");

        assert_eq!(error.error_type, "transport");
        assert_eq!(error.code, "rpc_transport_failed");
        server.handle.join().expect("TLS server");
    }

    #[test]
    fn untrusted_ca_is_a_transport_failure() {
        let _guard = TLS_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let server = spawn_tls_server(vec![(200, r#"{}"#), (200, r#"{}"#), (200, r#"{}"#)]);
        let (wrong_ca, _) = localhost_certificate();
        fs::write(&server.resolved.ca_cert, wrong_ca).expect("wrong CA");
        let agent = build_agent(&server.resolved).expect("TLS agent");
        let error = post_rpc_with_retry(
            &agent,
            &server.resolved,
            "service-token",
            "test_command",
            &json!({}),
            None,
        )
        .expect_err("untrusted CA");

        assert_eq!(error.error_type, "transport");
        assert_eq!(error.code, "rpc_transport_failed");
        server.handle.join().expect("TLS server");
    }
}
