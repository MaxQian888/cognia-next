//! Canonical Headless request and response contract authority.

use std::{collections::HashMap, fmt};

use serde::Deserialize;
use serde_json::Value;

pub const EMBEDDED_CATALOG_BYTES: &[u8] =
    include_bytes!("../../cognia-cli/assets/host-command-catalog.json");

/// Device-plane (`/api/_rpc`) request schemas for the commands whose shape
/// differs from the service plane (`/internal/_rpc`).
///
/// `prepare_remote_args` passes service-scope arguments through untouched but
/// rewrites device-scope arguments from workspace-relative coordinates into
/// real paths, so a command like `git_clone` has two equally correct request
/// shapes. Validating both planes against the service catalog rejected every
/// device request with 422 before dispatch — 63 of 64 `git_*` commands were
/// unreachable from every companion transport.
pub const EMBEDDED_DEVICE_PLANE_OVERRIDES_BYTES: &[u8] =
    include_bytes!("../assets/device-plane-overrides.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    catalog_hash: String,
    commands: Vec<CatalogCommand>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCommand {
    name: String,
    input_schema: Value,
    output_schema: Value,
}

struct CommandContract {
    input: jsonschema::Validator,
    output: jsonschema::Validator,
}

impl fmt::Debug for CommandContract {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CommandContract { .. }")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractDirection {
    Input,
    Output,
}

impl fmt::Display for ContractDirection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Input => "input",
            Self::Output => "output",
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ContractLoadError {
    #[error("Headless catalog is invalid: {0}")]
    Catalog(#[from] serde_json::Error),
    #[error("Headless {direction} schema for `{command}` cannot compile: {detail}")]
    Schema {
        command: String,
        direction: ContractDirection,
        detail: String,
    },
    #[error("Headless catalog contains duplicate command `{0}`")]
    DuplicateCommand(String),
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ContractViolation {
    #[error("Headless command `{command}` has no contract")]
    UnknownCommand { command: String },
    #[error("Headless command `{command}` violates its {direction} contract")]
    Invalid {
        command: String,
        direction: ContractDirection,
        violations: Vec<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePlaneOverrides {
    commands: HashMap<String, DevicePlaneOverride>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePlaneOverride {
    input_schema: Value,
}

/// Which plane a request arrived on. The two accept genuinely different
/// argument shapes for the same command, so validation must know which.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractPlane {
    /// `/internal/_rpc` — service token; arguments reach the arm untouched.
    Service,
    /// `/api/_rpc` and the WebRTC/A2A/ACP adapters — a paired device, whose
    /// arguments `prepare_remote_args` rewrites before the arm sees them.
    Device,
}

#[derive(Debug)]
pub struct HeadlessContract {
    schema_version: u32,
    catalog_hash: String,
    commands: HashMap<String, CommandContract>,
    /// Device-plane input validators, keyed by command. Only populated for
    /// commands whose device shape differs; everything else falls back to the
    /// service validator, so the two planes stay identical by default.
    device_inputs: HashMap<String, jsonschema::Validator>,
}

impl HeadlessContract {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ContractLoadError> {
        let catalog: Catalog = serde_json::from_slice(bytes)?;
        let mut commands = HashMap::with_capacity(catalog.commands.len());
        for command in catalog.commands {
            let input = compile_schema(
                &command.name,
                ContractDirection::Input,
                &command.input_schema,
            )?;
            let output = compile_schema(
                &command.name,
                ContractDirection::Output,
                &command.output_schema,
            )?;
            if commands
                .insert(command.name.clone(), CommandContract { input, output })
                .is_some()
            {
                return Err(ContractLoadError::DuplicateCommand(command.name));
            }
        }
        Ok(Self {
            schema_version: catalog.schema_version,
            catalog_hash: catalog.catalog_hash,
            commands,
            device_inputs: HashMap::new(),
        })
    }

    /// Layer the device-plane request schemas on top of a service-plane
    /// catalog. Commands absent from the overrides keep one shared validator.
    pub fn with_device_plane_overrides(mut self, bytes: &[u8]) -> Result<Self, ContractLoadError> {
        let overrides: DevicePlaneOverrides = serde_json::from_slice(bytes)?;
        for (command, entry) in overrides.commands {
            let validator =
                compile_schema(&command, ContractDirection::Input, &entry.input_schema)?;
            self.device_inputs.insert(command, validator);
        }
        Ok(self)
    }

    pub fn embedded() -> Result<Self, ContractLoadError> {
        Self::from_bytes(EMBEDDED_CATALOG_BYTES)?
            .with_device_plane_overrides(EMBEDDED_DEVICE_PLANE_OVERRIDES_BYTES)
    }

    /// How many commands carry a device-specific request shape.
    pub fn device_override_count(&self) -> usize {
        self.device_inputs.len()
    }

    pub fn schema_version(&self) -> u32 {
        self.schema_version
    }

    pub fn catalog_hash(&self) -> &str {
        &self.catalog_hash
    }

    pub fn command_count(&self) -> usize {
        self.commands.len()
    }

    /// Validate against the service plane. Kept as the default so existing
    /// callers (and `cognia-cli`, which talks to `/internal/_rpc`) are correct
    /// without change.
    pub fn validate_input(&self, command: &str, value: &Value) -> Result<(), ContractViolation> {
        self.validate_input_on(ContractPlane::Service, command, value)
    }

    /// Validate a request against the plane it actually arrived on.
    pub fn validate_input_on(
        &self,
        plane: ContractPlane,
        command: &str,
        value: &Value,
    ) -> Result<(), ContractViolation> {
        if plane == ContractPlane::Device {
            if let Some(validator) = self.device_inputs.get(command) {
                return Self::collect(command, ContractDirection::Input, validator, value);
            }
        }
        self.validate(command, ContractDirection::Input, value)
    }

    pub fn validate_output(&self, command: &str, value: &Value) -> Result<(), ContractViolation> {
        self.validate(command, ContractDirection::Output, value)
    }

    fn validate(
        &self,
        command: &str,
        direction: ContractDirection,
        value: &Value,
    ) -> Result<(), ContractViolation> {
        let contract =
            self.commands
                .get(command)
                .ok_or_else(|| ContractViolation::UnknownCommand {
                    command: command.to_string(),
                })?;
        let validator = match direction {
            ContractDirection::Input => &contract.input,
            ContractDirection::Output => &contract.output,
        };
        Self::collect(command, direction, validator, value)
    }

    fn collect(
        command: &str,
        direction: ContractDirection,
        validator: &jsonschema::Validator,
        value: &Value,
    ) -> Result<(), ContractViolation> {
        let violations = validator
            .iter_errors(value)
            .take(20)
            .map(|error| {
                format!(
                    "instance path `{}` violates schema path `{}`",
                    error.instance_path(),
                    error.schema_path()
                )
            })
            .collect::<Vec<_>>();
        if violations.is_empty() {
            Ok(())
        } else {
            Err(ContractViolation::Invalid {
                command: command.to_string(),
                direction,
                violations,
            })
        }
    }
}

fn compile_schema(
    command: &str,
    direction: ContractDirection,
    schema: &Value,
) -> Result<jsonschema::Validator, ContractLoadError> {
    jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(schema)
        .map_err(|error| ContractLoadError::Schema {
            command: command.to_string(),
            direction,
            detail: error.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "catalogHash": "known-hash",
            "commands": [{
                "name": "session_get",
                "inputSchema": {
                    "type": "object",
                    "required": ["sessionId"],
                    "properties": { "sessionId": { "type": "string", "minLength": 1 } },
                    "additionalProperties": false
                },
                "outputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": { "id": { "type": "string" } },
                    "additionalProperties": false
                }
            }]
        }))
        .expect("fixture")
    }

    #[test]
    fn validates_requests_and_responses_through_the_same_interface() {
        let contract = HeadlessContract::from_bytes(&fixture()).expect("contract");

        assert!(contract
            .validate_input("session_get", &json!({ "sessionId": "session-a" }))
            .is_ok());
        assert!(contract
            .validate_input("session_get", &json!({ "sessionId": "", "extra": true }))
            .is_err());
        assert!(contract
            .validate_output("session_get", &json!({ "id": "session-a" }))
            .is_ok());
        assert!(contract
            .validate_output("session_get", &json!({ "sessionId": "session-a" }))
            .is_err());
    }

    #[test]
    fn exposes_the_catalog_identity_and_rejects_unknown_commands() {
        let contract = HeadlessContract::from_bytes(&fixture()).expect("contract");

        assert_eq!(contract.schema_version(), 1);
        assert_eq!(contract.catalog_hash(), "known-hash");
        assert_eq!(contract.command_count(), 1);
        assert!(contract.validate_input("missing", &json!({})).is_err());
    }
}
