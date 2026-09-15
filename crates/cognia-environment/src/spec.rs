//! The EnvironmentSpec wire type (ADR-0182).
//!
//! Mirrors `types/sandbox/environment-spec.ts` field for field. The brain
//! resolves one of these once per sandbox acquisition; this crate re-validates
//! it at admission and recomputes its digest. The digest is SHA-256 over the
//! RFC 8785 canonical JSON of the spec with `specDigest` and `explain` removed,
//! so the TypeScript resolver and this crate produce the same hex string for
//! the same content — `protocol/environment-spec-fixtures.json` pins that.
//!
//! Every optional field is omitted rather than written as `null`, exactly as
//! the TypeScript side omits `undefined`; a `null` would change the canonical
//! bytes and therefore the digest.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::image::{validate_digest, PinnedImage};

/// Isolation tiers, weakest first. `Ord` is the strength order, so
/// `max(a, b)` is the stricter of two requirements.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum IsolationTier {
    /// A plain container: shared kernel, seccomp/pids/no-new-privileges.
    Container,
    /// A user-space kernel (runsc).
    Gvisor,
    /// A per-sandbox virtual machine (Kata, Firecracker, serverless pods).
    Vm,
}

impl IsolationTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Container => "container",
            Self::Gvisor => "gvisor",
            Self::Vm => "vm",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxLifecycleKind {
    /// One sandbox per workspace, suspended when idle, volume kept.
    Persistent,
    /// One sandbox per run, destroyed at run end.
    Ephemeral,
}

/// Egress posture. The wire value for "open" is `on`, the value
/// `ProjectEnvironmentPolicy.network` already persists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum EgressTier {
    Off,
    Allowlist,
    On,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DeclarationFile {
    WorkspaceJson,
    Devcontainer,
}

/// Where the spec came from, in precedence order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum EnvironmentSource {
    #[serde(rename_all = "camelCase")]
    ProjectSetting { catalog_entry_id: String },
    #[serde(rename_all = "camelCase")]
    RepoDeclaration {
        file: DeclarationFile,
        path: String,
        remote: String,
        commit_sha: String,
        declaration_digest: String,
        /// The approval this declaration was admitted under: a server-side
        /// approval id on a shared Host, `device:<approval key>` on a desktop.
        approval_ref: String,
    },
    #[serde(rename_all = "camelCase")]
    DeploymentDefault { catalog_entry_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct SpecImage {
    pub registry: String,
    pub repository: String,
    pub digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_entry_id: Option<String>,
    /// Content-hash key of the environment build that produced this image
    /// (ADR-0186); absent for catalog images.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_key: Option<String>,
}

impl SpecImage {
    pub fn pinned(&self) -> PinnedImage {
        PinnedImage {
            registry: self.registry.clone(),
            repository: self.repository.clone(),
            digest: self.digest.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct SpecBundle {
    /// `sha256:` digest of the agent bundle image (ADR-0183).
    pub digest: String,
    pub release_tag: String,
    /// True when the project pinned this bundle instead of following the
    /// release's current one.
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct IsolationRequirement {
    pub minimum: IsolationTier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DeclaredUserSource {
    RemoteUser,
    ContainerUser,
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct DeclaredUser {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    pub from: DeclaredUserSource,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct SpecUser {
    /// Absent when neither the declaration nor the image names a user; the
    /// tier default then applies (ADR-0183).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared: Option<DeclaredUser>,
}

/// One command. `Parallel` may not nest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum CommandSpec {
    /// Run through `/bin/sh -c`.
    Shell { command: String },
    /// Exec directly, no shell.
    Argv { argv: Vec<String> },
    /// Named commands run concurrently; all must succeed.
    Parallel {
        commands: BTreeMap<String, CommandSpec>,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct LifecycleCommands {
    /// First create.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_create: Option<CommandSpec>,
    /// First create, after `onCreate`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_content: Option<CommandSpec>,
    /// First create, after `updateContent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_create: Option<CommandSpec>,
    /// Every start and resume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_start: Option<CommandSpec>,
    /// Every session attach.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_attach: Option<CommandSpec>,
}

impl LifecycleCommands {
    fn entries(&self) -> [(&'static str, Option<&CommandSpec>); 5] {
        [
            ("onCreate", self.on_create.as_ref()),
            ("updateContent", self.update_content.as_ref()),
            ("postCreate", self.post_create.as_ref()),
            ("postStart", self.post_start.as_ref()),
            ("postAttach", self.post_attach.as_ref()),
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct ForwardPort {
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct EgressSpec {
    pub tier: EgressTier,
    /// Baseline egress preset ids (package registries, git hosts).
    pub preset_ids: Vec<String>,
    /// Project-declared domains that passed approval.
    pub approved_domains: Vec<String>,
}

/// The resolved, immutable description of one sandbox's environment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct EnvironmentSpec {
    /// Always `1`.
    pub version: u8,
    /// Lowercase hex SHA-256; see the module header.
    pub spec_digest: String,
    pub project_id: String,
    pub source: EnvironmentSource,
    pub image: SpecImage,
    pub bundle: SpecBundle,
    pub isolation: IsolationRequirement,
    pub size_class_id: String,
    pub lifecycle: SandboxLifecycleKind,
    pub user: SpecUser,
    pub container_env: BTreeMap<String, String>,
    pub lifecycle_commands: LifecycleCommands,
    pub forward_ports: Vec<ForwardPort>,
    pub egress: EgressSpec,
    pub browser_sidecar: bool,
    /// ADR-0147 digest of the workspace.json whose setup/actions run inside
    /// the sandbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_config_digest: Option<String>,
    /// Human-readable resolution trace. Excluded from the digest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explain: Option<Value>,
}

/// Limits shared with the TypeScript validator.
pub mod limits {
    pub const MAX_ID_LEN: usize = 256;
    pub const MAX_ENV_ENTRIES: usize = 256;
    pub const MAX_ENV_VALUE_BYTES: usize = 32 * 1024;
    pub const MAX_SHELL_COMMAND_BYTES: usize = 64 * 1024;
    pub const MAX_ARGV_ENTRIES: usize = 256;
    pub const MAX_ARGV_ENTRY_BYTES: usize = 32 * 1024;
    pub const MAX_PARALLEL_COMMANDS: usize = 16;
    pub const MAX_FORWARD_PORTS: usize = 64;
    pub const MAX_PORT_LABEL_LEN: usize = 128;
    pub const MAX_EGRESS_DOMAINS: usize = 256;
    pub const MAX_EGRESS_PRESETS: usize = 64;
    /// Environment variables with this prefix belong to the supervisor.
    pub const RESERVED_ENV_PREFIX: &str = "COGNIA_";
}

/// Why a spec is structurally invalid. `field` is a JSON pointer-ish path the
/// UI can show next to the refusal.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code} at {field}: {message}")]
pub struct SpecError {
    pub code: &'static str,
    pub field: String,
    pub message: String,
}

impl SpecError {
    fn new(code: &'static str, field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            field: field.into(),
            message: message.into(),
        }
    }
}

impl EnvironmentSpec {
    /// Structural validation. Policy (catalog membership, floors, approvals)
    /// is `policy::admit`'s job; this only answers "is this a well-formed
    /// spec".
    pub fn validate(&self) -> Result<(), SpecError> {
        if self.version != 1 {
            return Err(SpecError::new(
                "spec_version_unsupported",
                "version",
                format!("version {} is not supported", self.version),
            ));
        }
        validate_hex64(&self.spec_digest, "specDigest")?;
        validate_id(&self.project_id, "projectId")?;
        validate_source(&self.source)?;

        self.image
            .pinned()
            .validate()
            .map_err(|error| SpecError::new("spec_image_invalid", "image", error.to_string()))?;
        if let Some(entry) = &self.image.catalog_entry_id {
            validate_catalog_id(entry, "image.catalogEntryId")?;
        }
        if let Some(key) = &self.image.build_key {
            validate_hex64(key, "image.buildKey")?;
        }

        validate_digest(&self.bundle.digest).map_err(|error| {
            SpecError::new("spec_bundle_invalid", "bundle.digest", error.to_string())
        })?;
        if self.bundle.release_tag.trim().is_empty() || self.bundle.release_tag.len() > 128 {
            return Err(SpecError::new(
                "spec_bundle_invalid",
                "bundle.releaseTag",
                "release tag must be 1-128 characters",
            ));
        }

        validate_slug(&self.size_class_id, "sizeClassId")?;

        if let Some(user) = &self.user.declared {
            if user.name.is_none() && user.uid.is_none() {
                return Err(SpecError::new(
                    "spec_user_invalid",
                    "user.declared",
                    "a declared user needs a name or a uid",
                ));
            }
            if let Some(name) = &user.name {
                if !is_valid_user_name(name) {
                    return Err(SpecError::new(
                        "spec_user_invalid",
                        "user.declared.name",
                        format!("{name:?} is not a valid user name"),
                    ));
                }
            }
            if let Some(uid) = user.uid {
                if uid > i32::MAX as u32 {
                    return Err(SpecError::new(
                        "spec_user_invalid",
                        "user.declared.uid",
                        "uid is out of range",
                    ));
                }
            }
        }

        validate_env(&self.container_env)?;

        for (name, command) in self.lifecycle_commands.entries() {
            if let Some(command) = command {
                validate_command(command, &format!("lifecycleCommands.{name}"), true)?;
            }
        }

        if self.forward_ports.len() > limits::MAX_FORWARD_PORTS {
            return Err(SpecError::new(
                "spec_ports_invalid",
                "forwardPorts",
                format!("at most {} forwarded ports", limits::MAX_FORWARD_PORTS),
            ));
        }
        let mut ports = BTreeSet::new();
        for (index, port) in self.forward_ports.iter().enumerate() {
            let field = format!("forwardPorts[{index}]");
            if port.port == 0 || !ports.insert(port.port) {
                return Err(SpecError::new(
                    "spec_ports_invalid",
                    field,
                    "ports must be 1-65535 and unique",
                ));
            }
            if let Some(label) = &port.label {
                if label.is_empty() || label.chars().count() > limits::MAX_PORT_LABEL_LEN {
                    return Err(SpecError::new(
                        "spec_ports_invalid",
                        format!("{field}.label"),
                        "label must be 1-128 characters",
                    ));
                }
            }
        }

        validate_egress(&self.egress)?;

        if let Some(digest) = &self.workspace_config_digest {
            validate_hex64(digest, "workspaceConfigDigest")?;
        }
        Ok(())
    }

    /// The digest this spec's content hashes to, independent of the
    /// `specDigest` it carries.
    pub fn compute_digest(&self) -> Result<String, SpecError> {
        let mut value = serde_json::to_value(self)
            .map_err(|error| SpecError::new("spec_digest_failed", "spec", error.to_string()))?;
        if let Value::Object(map) = &mut value {
            map.remove("specDigest");
            map.remove("explain");
        }
        let canonical = cognia_canonical_json::canonicalize(&value)
            .map_err(|error| SpecError::new("spec_digest_failed", "spec", error.to_string()))?;
        Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
    }

    /// `validate` plus "the carried digest matches the content".
    pub fn validate_with_digest(&self) -> Result<(), SpecError> {
        self.validate()?;
        let computed = self.compute_digest()?;
        if computed != self.spec_digest {
            return Err(SpecError::new(
                "spec_digest_mismatch",
                "specDigest",
                "the spec digest does not match its content",
            ));
        }
        Ok(())
    }
}

fn validate_source(source: &EnvironmentSource) -> Result<(), SpecError> {
    match source {
        EnvironmentSource::ProjectSetting { catalog_entry_id }
        | EnvironmentSource::DeploymentDefault { catalog_entry_id } => {
            validate_catalog_id(catalog_entry_id, "source.catalogEntryId")
        }
        EnvironmentSource::RepoDeclaration {
            path,
            remote,
            commit_sha,
            declaration_digest,
            approval_ref,
            ..
        } => {
            validate_relative_path(path, "source.path")?;
            if remote.trim().is_empty() || remote.len() > 2048 {
                return Err(SpecError::new(
                    "spec_source_invalid",
                    "source.remote",
                    "remote must be 1-2048 characters",
                ));
            }
            let sha_ok = matches!(commit_sha.len(), 40 | 64)
                && commit_sha.bytes().all(|b| b.is_ascii_hexdigit());
            if !sha_ok {
                return Err(SpecError::new(
                    "spec_source_invalid",
                    "source.commitSha",
                    "commit must be a full SHA-1 or SHA-256 object id",
                ));
            }
            validate_hex64(declaration_digest, "source.declarationDigest")?;
            validate_id(approval_ref, "source.approvalRef")
        }
    }
}

fn validate_command(
    command: &CommandSpec,
    field: &str,
    allow_parallel: bool,
) -> Result<(), SpecError> {
    match command {
        CommandSpec::Shell { command } => {
            if command.trim().is_empty()
                || command.len() > limits::MAX_SHELL_COMMAND_BYTES
                || command.contains('\0')
            {
                return Err(SpecError::new(
                    "spec_command_invalid",
                    field,
                    "shell command must be non-empty, at most 64 KiB and contain no NUL",
                ));
            }
        }
        CommandSpec::Argv { argv } => {
            if argv.is_empty()
                || argv.len() > limits::MAX_ARGV_ENTRIES
                || argv[0].trim().is_empty()
                || argv
                    .iter()
                    .any(|arg| arg.len() > limits::MAX_ARGV_ENTRY_BYTES || arg.contains('\0'))
            {
                return Err(SpecError::new(
                    "spec_command_invalid",
                    field,
                    "argv must be 1-256 NUL-free entries of at most 32 KiB with a program",
                ));
            }
        }
        CommandSpec::Parallel { commands } => {
            if !allow_parallel {
                return Err(SpecError::new(
                    "spec_command_invalid",
                    field,
                    "parallel commands cannot nest",
                ));
            }
            if commands.is_empty() || commands.len() > limits::MAX_PARALLEL_COMMANDS {
                return Err(SpecError::new(
                    "spec_command_invalid",
                    field,
                    "parallel commands need 1-16 entries",
                ));
            }
            for (name, inner) in commands {
                if !is_valid_command_name(name) {
                    return Err(SpecError::new(
                        "spec_command_invalid",
                        format!("{field}.{name}"),
                        "command names are 1-64 of [A-Za-z0-9._-]",
                    ));
                }
                validate_command(inner, &format!("{field}.{name}"), false)?;
            }
        }
    }
    Ok(())
}

fn validate_env(env: &BTreeMap<String, String>) -> Result<(), SpecError> {
    if env.len() > limits::MAX_ENV_ENTRIES {
        return Err(SpecError::new(
            "spec_env_invalid",
            "containerEnv",
            format!("at most {} variables", limits::MAX_ENV_ENTRIES),
        ));
    }
    for (name, value) in env {
        let field = format!("containerEnv.{name}");
        if !is_valid_env_name(name) {
            return Err(SpecError::new(
                "spec_env_invalid",
                field,
                "variable names are [A-Za-z_][A-Za-z0-9_]*",
            ));
        }
        if name.starts_with(limits::RESERVED_ENV_PREFIX) {
            return Err(SpecError::new(
                "spec_env_reserved",
                field,
                "COGNIA_* variables are reserved for the supervisor",
            ));
        }
        if value.len() > limits::MAX_ENV_VALUE_BYTES || value.contains('\0') {
            return Err(SpecError::new(
                "spec_env_invalid",
                field,
                "values are at most 32 KiB and contain no NUL",
            ));
        }
    }
    Ok(())
}

fn validate_egress(egress: &EgressSpec) -> Result<(), SpecError> {
    if egress.preset_ids.len() > limits::MAX_EGRESS_PRESETS {
        return Err(SpecError::new(
            "spec_egress_invalid",
            "egress.presetIds",
            "too many presets",
        ));
    }
    let mut seen = BTreeSet::new();
    for (index, preset) in egress.preset_ids.iter().enumerate() {
        validate_slug(preset, &format!("egress.presetIds[{index}]"))?;
        if !seen.insert(preset) {
            return Err(SpecError::new(
                "spec_egress_invalid",
                format!("egress.presetIds[{index}]"),
                "duplicate preset",
            ));
        }
    }
    if egress.approved_domains.len() > limits::MAX_EGRESS_DOMAINS {
        return Err(SpecError::new(
            "spec_egress_invalid",
            "egress.approvedDomains",
            "too many domains",
        ));
    }
    let mut seen = BTreeSet::new();
    for (index, domain) in egress.approved_domains.iter().enumerate() {
        let field = format!("egress.approvedDomains[{index}]");
        if !is_valid_domain_pattern(domain) {
            return Err(SpecError::new(
                "spec_egress_invalid",
                field,
                format!("{domain:?} is not a domain or *.domain pattern"),
            ));
        }
        if !seen.insert(domain.to_ascii_lowercase()) {
            return Err(SpecError::new(
                "spec_egress_invalid",
                field,
                "duplicate domain",
            ));
        }
    }
    if egress.tier == EgressTier::Off && !egress.approved_domains.is_empty() {
        return Err(SpecError::new(
            "spec_egress_invalid",
            "egress.approvedDomains",
            "egress is off, so no domains may be listed",
        ));
    }
    Ok(())
}

/// A domain allowlist entry: an exact DNS name or a `*.` wildcard over one.
/// IP literals are refused here — internal addresses are baseline exceptions,
/// never project declarations.
pub fn is_valid_domain_pattern(pattern: &str) -> bool {
    let host = pattern.strip_prefix("*.").unwrap_or(pattern);
    !host.is_empty()
        && host.contains('.')
        && host.parse::<std::net::IpAddr>().is_err()
        && !host.ends_with('.')
        && cognia_net::egress::is_valid_hostname(host)
}

pub(crate) fn validate_hex64(value: &str, field: &str) -> Result<(), SpecError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(SpecError::new(
            "spec_digest_invalid",
            field,
            "expected 64 lowercase hex digits",
        ))
    }
}

pub(crate) fn validate_id(value: &str, field: &str) -> Result<(), SpecError> {
    if value.trim().is_empty()
        || value.len() > limits::MAX_ID_LEN
        || value.chars().any(char::is_control)
    {
        Err(SpecError::new(
            "spec_id_invalid",
            field,
            "ids are 1-256 characters with no control characters",
        ))
    } else {
        Ok(())
    }
}

/// Catalog entry ids: `[a-z0-9][a-z0-9._-]{0,63}`.
pub fn is_valid_catalog_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

pub(crate) fn validate_catalog_id(value: &str, field: &str) -> Result<(), SpecError> {
    if is_valid_catalog_id(value) {
        Ok(())
    } else {
        Err(SpecError::new(
            "spec_id_invalid",
            field,
            "catalog ids are [a-z0-9][a-z0-9._-]{0,63}",
        ))
    }
}

/// Slugs (size classes, presets): `[a-z0-9][a-z0-9-]{0,62}`.
pub fn is_valid_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

pub(crate) fn validate_slug(value: &str, field: &str) -> Result<(), SpecError> {
    if is_valid_slug(value) {
        Ok(())
    } else {
        Err(SpecError::new(
            "spec_id_invalid",
            field,
            "expected [a-z0-9][a-z0-9-]{0,62}",
        ))
    }
}

fn validate_relative_path(path: &str, field: &str) -> Result<(), SpecError> {
    let normalized = path.replace('\\', "/");
    let bad = normalized.is_empty()
        || normalized.len() > 1024
        || normalized.starts_with('/')
        || normalized
            .split('/')
            .any(|segment| segment == ".." || segment.is_empty())
        || normalized.contains('\0');
    if bad {
        Err(SpecError::new(
            "spec_source_invalid",
            field,
            "path must be a confined relative path",
        ))
    } else {
        Ok(())
    }
}

pub fn is_valid_env_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 256
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

/// POSIX-portable user names: `[a-z_][a-z0-9_-]{0,31}`.
pub fn is_valid_user_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && (bytes[0].is_ascii_lowercase() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}

fn is_valid_command_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const IMAGE_DIGEST: &str =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    pub(crate) const BUNDLE_DIGEST: &str =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222";

    pub(crate) fn sample_spec() -> EnvironmentSpec {
        let mut spec = EnvironmentSpec {
            version: 1,
            spec_digest: String::new(),
            project_id: "proj-1".into(),
            source: EnvironmentSource::ProjectSetting {
                catalog_entry_id: "python-312".into(),
            },
            image: SpecImage {
                registry: "ghcr.io".into(),
                repository: "acme/python".into(),
                digest: IMAGE_DIGEST.into(),
                catalog_entry_id: Some("python-312".into()),
                build_key: None,
            },
            bundle: SpecBundle {
                digest: BUNDLE_DIGEST.into(),
                release_tag: "v1.0.0".into(),
                pinned: false,
            },
            isolation: IsolationRequirement {
                minimum: IsolationTier::Gvisor,
            },
            size_class_id: "medium".into(),
            lifecycle: SandboxLifecycleKind::Persistent,
            user: SpecUser::default(),
            container_env: BTreeMap::from([(
                "PIP_INDEX_URL".into(),
                "https://pypi.org/simple".into(),
            )]),
            lifecycle_commands: LifecycleCommands {
                post_create: Some(CommandSpec::Shell {
                    command: "pip install -r requirements.txt".into(),
                }),
                ..LifecycleCommands::default()
            },
            forward_ports: vec![ForwardPort {
                port: 8000,
                label: Some("api".into()),
            }],
            egress: EgressSpec {
                tier: EgressTier::Allowlist,
                preset_ids: vec!["pypi".into()],
                approved_domains: vec!["files.pythonhosted.org".into()],
            },
            browser_sidecar: false,
            workspace_config_digest: None,
            explain: None,
        };
        spec.spec_digest = spec.compute_digest().unwrap();
        spec
    }

    #[test]
    fn a_sample_spec_validates_with_its_digest() {
        sample_spec().validate_with_digest().unwrap();
    }

    #[test]
    fn the_digest_ignores_the_carried_digest_and_the_explain_trace() {
        let spec = sample_spec();
        let mut explained = spec.clone();
        explained.explain = Some(serde_json::json!({ "steps": ["project setting"] }));
        explained.spec_digest = "f".repeat(64);
        assert_eq!(
            spec.compute_digest().unwrap(),
            explained.compute_digest().unwrap()
        );
    }

    #[test]
    fn any_content_change_changes_the_digest() {
        let spec = sample_spec();
        let mut changed = spec.clone();
        changed.container_env.insert("EXTRA".into(), "1".into());
        assert_ne!(
            spec.compute_digest().unwrap(),
            changed.compute_digest().unwrap()
        );

        let mut changed = spec.clone();
        changed.isolation.minimum = IsolationTier::Vm;
        assert_ne!(
            spec.compute_digest().unwrap(),
            changed.compute_digest().unwrap()
        );
    }

    #[test]
    fn optional_fields_are_omitted_not_null() {
        let value = serde_json::to_value(sample_spec()).unwrap();
        let object = value.as_object().unwrap();
        assert!(!object.contains_key("workspaceConfigDigest"));
        assert!(!object.contains_key("explain"));
        assert!(!value["image"].as_object().unwrap().contains_key("buildKey"));
        assert!(!value["user"].as_object().unwrap().contains_key("declared"));
    }

    #[test]
    fn wire_names_match_the_typescript_mirror() {
        let value = serde_json::to_value(sample_spec()).unwrap();
        assert_eq!(value["source"]["kind"], "project-setting");
        assert_eq!(value["source"]["catalogEntryId"], "python-312");
        assert_eq!(value["isolation"]["minimum"], "gvisor");
        assert_eq!(value["lifecycle"], "persistent");
        assert_eq!(value["lifecycleCommands"]["postCreate"]["kind"], "shell");
        assert_eq!(value["egress"]["tier"], "allowlist");
        assert_eq!(value["egress"]["presetIds"][0], "pypi");
        assert_eq!(value["browserSidecar"], false);
    }

    #[test]
    fn unknown_fields_are_refused_on_the_way_in() {
        let mut value = serde_json::to_value(sample_spec()).unwrap();
        value["privileged"] = Value::Bool(true);
        assert!(serde_json::from_value::<EnvironmentSpec>(value).is_err());
    }

    #[test]
    fn a_tampered_digest_is_a_mismatch() {
        let mut spec = sample_spec();
        spec.forward_ports.push(ForwardPort {
            port: 9000,
            label: None,
        });
        assert_eq!(
            spec.validate_with_digest().unwrap_err().code,
            "spec_digest_mismatch"
        );
    }

    #[test]
    fn isolation_tiers_order_by_strength() {
        assert!(IsolationTier::Container < IsolationTier::Gvisor);
        assert!(IsolationTier::Gvisor < IsolationTier::Vm);
        assert_eq!(
            IsolationTier::Container.max(IsolationTier::Vm),
            IsolationTier::Vm
        );
    }

    fn refusal(mutate: impl FnOnce(&mut EnvironmentSpec)) -> &'static str {
        let mut spec = sample_spec();
        mutate(&mut spec);
        spec.validate().expect_err("mutation must be refused").code
    }

    #[test]
    fn structural_refusals_carry_stable_codes() {
        assert_eq!(refusal(|s| s.version = 2), "spec_version_unsupported");
        assert_eq!(
            refusal(|s| s.image.digest = "sha256:abc".into()),
            "spec_image_invalid"
        );
        assert_eq!(
            refusal(|s| s.bundle.release_tag = " ".into()),
            "spec_bundle_invalid"
        );
        assert_eq!(
            refusal(|s| s.size_class_id = "Medium".into()),
            "spec_id_invalid"
        );
        assert_eq!(
            refusal(|s| {
                s.container_env.insert("COGNIA_TOKEN".into(), "x".into());
            }),
            "spec_env_reserved"
        );
        assert_eq!(
            refusal(|s| {
                s.container_env.insert("1BAD".into(), "x".into());
            }),
            "spec_env_invalid"
        );
        assert_eq!(
            refusal(|s| s.forward_ports.push(ForwardPort {
                port: 8000,
                label: None
            })),
            "spec_ports_invalid"
        );
        assert_eq!(
            refusal(|s| s.egress.approved_domains.push("10.0.0.1".into())),
            "spec_egress_invalid"
        );
        assert_eq!(
            refusal(|s| s.egress.tier = EgressTier::Off),
            "spec_egress_invalid"
        );
        assert_eq!(
            refusal(|s| {
                s.user.declared = Some(DeclaredUser {
                    name: None,
                    uid: None,
                    from: DeclaredUserSource::Image,
                })
            }),
            "spec_user_invalid"
        );
        assert_eq!(
            refusal(|s| {
                s.lifecycle_commands.post_start = Some(CommandSpec::Argv { argv: vec![] })
            }),
            "spec_command_invalid"
        );
    }

    #[test]
    fn parallel_commands_cannot_nest() {
        let inner = CommandSpec::Parallel {
            commands: BTreeMap::from([(
                "a".into(),
                CommandSpec::Shell {
                    command: "true".into(),
                },
            )]),
        };
        let outer = CommandSpec::Parallel {
            commands: BTreeMap::from([("nested".into(), inner)]),
        };
        assert_eq!(
            refusal(|s| s.lifecycle_commands.on_create = Some(outer)),
            "spec_command_invalid"
        );
    }

    #[test]
    fn repo_declarations_need_a_full_commit_and_a_confined_path() {
        let declaration = |path: &str, sha: &str| EnvironmentSource::RepoDeclaration {
            file: DeclarationFile::Devcontainer,
            path: path.into(),
            remote: "https://github.com/acme/app".into(),
            commit_sha: sha.into(),
            declaration_digest: "a".repeat(64),
            approval_ref: "approval-1".into(),
        };
        let sha = "0123456789abcdef0123456789abcdef01234567";
        assert!(refusal_or_ok(declaration(".devcontainer/devcontainer.json", sha)).is_ok());
        assert_eq!(
            refusal_or_ok(declaration("../outside.json", sha)).unwrap_err(),
            "spec_source_invalid"
        );
        assert_eq!(
            refusal_or_ok(declaration(".devcontainer.json", "abc123")).unwrap_err(),
            "spec_source_invalid"
        );
    }

    fn refusal_or_ok(source: EnvironmentSource) -> Result<(), &'static str> {
        let mut spec = sample_spec();
        spec.source = source;
        spec.validate().map_err(|error| error.code)
    }

    #[test]
    fn domain_patterns_accept_names_and_wildcards_only() {
        for ok in ["pypi.org", "*.npmjs.org", "registry.npmmirror.com"] {
            assert!(is_valid_domain_pattern(ok), "{ok}");
        }
        for bad in [
            "",
            "*.",
            "localhost",
            "10.0.0.1",
            "::1",
            "bad_host.com",
            "a..b.com",
            "evil.com.",
        ] {
            assert!(!is_valid_domain_pattern(bad), "{bad}");
        }
    }

    /// `protocol/environment-spec-fixtures.json` was produced by the
    /// TypeScript canonicalizer; `lib/project-environment` asserts the same
    /// file. A difference here means the two sides would disagree on a digest.
    #[test]
    fn protocol_fixtures_match_the_typescript_digests() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../protocol/environment-spec-fixtures.json"
        ))
        .unwrap();
        let cases = fixtures["cases"].as_array().unwrap();
        assert!(cases.len() >= 3, "fixture file lost its cases");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let spec: EnvironmentSpec = serde_json::from_value(case["spec"].clone())
                .unwrap_or_else(|error| panic!("{name}: {error}"));

            spec.validate_with_digest()
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(spec.compute_digest().unwrap(), case["specDigest"], "{name}");

            let mut body = serde_json::to_value(&spec).unwrap();
            assert_eq!(
                body, case["spec"],
                "{name}: serialization must round-trip exactly"
            );
            body.as_object_mut().unwrap().remove("specDigest");
            body.as_object_mut().unwrap().remove("explain");
            assert_eq!(
                cognia_canonical_json::canonicalize(&body).unwrap(),
                case["canonical"].as_str().unwrap(),
                "{name}: canonical bytes"
            );

            assert_eq!(
                crate::approval::runtime_fields_digest(&spec).unwrap(),
                case["runtimeFieldsDigest"],
                "{name}"
            );
        }
    }

    #[test]
    fn closed_object_attributes_are_paired_correctly() {
        let violations = cognia_problem::wire_schema::closed_object_pairing_violations(
            "spec.rs",
            include_str!("spec.rs"),
        );
        assert!(violations.is_empty(), "{violations:#?}");
    }
}
