//! The environment an agent starts with inside a user image (ADR-0183).
//!
//! The container's environment is the image's `ENV` merged with what the
//! driver set. Which is which cannot be told apart from inside, so the driver
//! lists the names it set in [`PROVIDED_ENV_VAR`]. The rules then mirror
//! `buildChildEnv` in `cli/src/x/agent-launcher.ts`:
//!
//! 1. start from the container environment;
//! 2. drop everything addressed to the supervisor (`COGNIA_SANDBOXD_*`);
//! 3. drop ambient provider credentials the driver did not provide — an image
//!    that bakes in `OPENAI_API_KEY` must not route the agent around the
//!    gateway;
//! 4. add what the injected tree needs: `PATH` entries, a CA bundle for an
//!    image without one, and `HOME`/`USER`/`LOGNAME` for the target user.
//!
//! The image's `PATH` stays first. Project work run through the agent's shell
//! should use the project's own `node`, `python` and `git`; the agent's own
//! entry point and its shims are addressed by absolute path under `/cognia`,
//! so they never depend on lookup order.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::layout::{InjectedLayout, Libc, PROVIDED_ENV_VAR, SANDBOXD_ENV_PREFIX};
use crate::passwd::ResolvedUser;

/// Kept identical to `AMBIENT_CREDENTIAL_ENV` in `cli/src/x/agent-launcher.ts`
/// (a test here reads that file).
pub const AMBIENT_CREDENTIAL_ENV: [&str; 13] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
    "COGNIA_GATEWAY_KEY",
];

/// Docker's default `PATH` for a container whose image sets none.
pub const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

pub const RUNTIME_CONFIG_COUNT: &str = "COGNIA_SANDBOXD_RUNTIME_CONFIG_COUNT";
pub const RUNTIME_CONFIG_CHUNK_PREFIX: &str = "COGNIA_SANDBOXD_RUNTIME_CONFIG_";
const CONFIG_CHUNK_BYTES: usize = 32 * 1024;
const MAX_CONFIG_BYTES: usize = 32 * 1024 * 1024;
const MAX_VALUE_BYTES: usize = 32 * 1024;
pub const DEFAULT_LIFECYCLE_TIMEOUT_MS: u64 = 600_000;

/// Wire-only runtime input shared with the driver. Kept here rather than in
/// cognia-environment so the static supervisor never links a network stack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeConfigV1 {
    pub version: u32,
    #[serde(default)]
    pub container_env: BTreeMap<String, String>,
    #[serde(default)]
    pub remote_env: BTreeMap<String, Option<String>>,
    #[serde(default)]
    pub spawn_env: BTreeMap<String, String>,
    #[serde(default)]
    pub lifecycle_commands: RuntimeLifecycleCommands,
    #[serde(default)]
    pub lifecycle_phases: Vec<LifecyclePhase>,
    #[serde(default = "default_lifecycle_timeout")]
    pub lifecycle_timeout_ms: u64,
    #[serde(default = "default_workspace_folder")]
    pub workspace_folder: String,
}

fn default_lifecycle_timeout() -> u64 {
    DEFAULT_LIFECYCLE_TIMEOUT_MS
}
fn default_workspace_folder() -> String {
    "/workspace".into()
}

impl Default for RuntimeConfigV1 {
    fn default() -> Self {
        Self {
            version: 1,
            container_env: BTreeMap::new(),
            remote_env: BTreeMap::new(),
            spawn_env: BTreeMap::new(),
            lifecycle_commands: RuntimeLifecycleCommands::default(),
            lifecycle_phases: Vec::new(),
            lifecycle_timeout_ms: default_lifecycle_timeout(),
            workspace_folder: default_workspace_folder(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RuntimeCommand {
    Shell {
        command: String,
    },
    Argv {
        argv: Vec<String>,
    },
    Parallel {
        commands: BTreeMap<String, RuntimeCommand>,
    },
    Sequence {
        commands: Vec<RuntimeCommand>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LifecyclePhase {
    OnCreate,
    UpdateContent,
    PostCreate,
    PostStart,
    PostAttach,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeLifecycleCommands {
    pub on_create: Option<RuntimeCommand>,
    pub update_content: Option<RuntimeCommand>,
    pub post_create: Option<RuntimeCommand>,
    pub post_start: Option<RuntimeCommand>,
    pub post_attach: Option<RuntimeCommand>,
}

impl RuntimeLifecycleCommands {
    pub fn get(&self, phase: LifecyclePhase) -> Option<&RuntimeCommand> {
        match phase {
            LifecyclePhase::OnCreate => self.on_create.as_ref(),
            LifecyclePhase::UpdateContent => self.update_content.as_ref(),
            LifecyclePhase::PostCreate => self.post_create.as_ref(),
            LifecyclePhase::PostStart => self.post_start.as_ref(),
            LifecyclePhase::PostAttach => self.post_attach.as_ref(),
        }
    }
}

/// Errors intentionally contain no input values: runtime configuration may
/// carry a task lease or a secret in an environment variable.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid sandbox runtime configuration: {0}")]
pub struct RuntimeConfigError(pub &'static str);

fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn validate_environment<'a>(
    entries: impl Iterator<Item = (&'a String, Option<&'a str>)>,
    allow_reserved: bool,
) -> Result<(), RuntimeConfigError> {
    let mut count = 0;
    for (name, value) in entries {
        count += 1;
        if count > 256
            || !valid_env_name(name)
            || (!allow_reserved && name.starts_with("COGNIA_"))
            || name.starts_with(SANDBOXD_ENV_PREFIX)
            || value.is_some_and(|v| v.len() > MAX_VALUE_BYTES || v.contains('\0'))
        {
            return Err(RuntimeConfigError(
                "environment name, size or reserved prefix",
            ));
        }
    }
    Ok(())
}

fn validate_runtime_command(
    command: &RuntimeCommand,
    depth: usize,
    count: &mut usize,
) -> Result<(), RuntimeConfigError> {
    *count += 1;
    if depth > 8 || *count > 256 {
        return Err(RuntimeConfigError(
            "command tree exceeds depth 8 or 256 nodes",
        ));
    }
    let valid = match command {
        RuntimeCommand::Shell { command } => {
            !command.trim().is_empty() && command.len() <= 64 * 1024 && !command.contains('\0')
        }
        RuntimeCommand::Argv { argv } => {
            !argv.is_empty()
                && argv.len() <= 256
                && !argv[0].trim().is_empty()
                && argv
                    .iter()
                    .all(|arg| arg.len() <= MAX_VALUE_BYTES && !arg.contains('\0'))
        }
        RuntimeCommand::Parallel { commands } => {
            if commands.is_empty() || commands.len() > 16 {
                return Err(RuntimeConfigError("parallel command shape"));
            }
            for (name, command) in commands {
                if name.is_empty()
                    || name.len() > 64
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
                {
                    return Err(RuntimeConfigError("parallel command name"));
                }
                validate_runtime_command(command, depth + 1, count)?;
            }
            true
        }
        RuntimeCommand::Sequence { commands } => {
            if commands.is_empty() || commands.len() > 256 {
                return Err(RuntimeConfigError("sequence command shape"));
            }
            for command in commands {
                validate_runtime_command(command, depth + 1, count)?;
            }
            true
        }
    };
    if valid {
        Ok(())
    } else {
        Err(RuntimeConfigError("command shape or size"))
    }
}

impl RuntimeConfigV1 {
    pub fn validate(&self) -> Result<(), RuntimeConfigError> {
        if self.version != 1 {
            return Err(RuntimeConfigError("unsupported version"));
        }
        validate_environment(
            self.container_env
                .iter()
                .map(|(k, v)| (k, Some(v.as_str()))),
            false,
        )?;
        validate_environment(
            self.remote_env.iter().map(|(k, v)| (k, v.as_deref())),
            false,
        )?;
        validate_environment(
            self.spawn_env.iter().map(|(k, v)| (k, Some(v.as_str()))),
            true,
        )?;
        if !(1_000..=3_600_000).contains(&self.lifecycle_timeout_ms) {
            return Err(RuntimeConfigError("lifecycle timeout outside limits"));
        }
        let folder = &self.workspace_folder;
        if !(folder == "/workspace" || folder.starts_with("/workspace/"))
            || folder.len() > 4096
            || folder.contains('\0')
            || folder.split('/').any(|part| matches!(part, "." | ".."))
        {
            return Err(RuntimeConfigError("workspace folder outside workspace"));
        }
        if self.lifecycle_phases.windows(2).any(|p| p[0] >= p[1]) {
            return Err(RuntimeConfigError(
                "lifecycle phases must be unique and ordered",
            ));
        }
        for phase in [
            LifecyclePhase::OnCreate,
            LifecyclePhase::UpdateContent,
            LifecyclePhase::PostCreate,
            LifecyclePhase::PostStart,
            LifecyclePhase::PostAttach,
        ] {
            if let Some(command) = self.lifecycle_commands.get(phase) {
                validate_runtime_command(command, 0, &mut 0)?;
            }
        }
        Ok(())
    }
}

pub fn encode_runtime_config_env(
    config: &RuntimeConfigV1,
) -> Result<Vec<String>, RuntimeConfigError> {
    config.validate()?;
    let json = serde_json::to_string(config).map_err(|_| RuntimeConfigError("cannot encode"))?;
    if json.len() > MAX_CONFIG_BYTES {
        return Err(RuntimeConfigError("document too large"));
    }
    let mut entries = Vec::new();
    let mut rest = json.as_str();
    while !rest.is_empty() {
        let mut end = rest.len().min(CONFIG_CHUNK_BYTES);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        entries.push(format!(
            "{RUNTIME_CONFIG_CHUNK_PREFIX}{}={}",
            entries.len(),
            &rest[..end]
        ));
        rest = &rest[end..];
    }
    entries.push(format!("{RUNTIME_CONFIG_COUNT}={}", entries.len()));
    Ok(entries)
}

pub fn decode_runtime_config_env(
    parent: &BTreeMap<String, String>,
) -> Result<Option<RuntimeConfigV1>, RuntimeConfigError> {
    let Some(count) = parent.get(RUNTIME_CONFIG_COUNT) else {
        return Ok(None);
    };
    let count: usize = count
        .parse()
        .map_err(|_| RuntimeConfigError("invalid chunk count"))?;
    if count == 0 || count > MAX_CONFIG_BYTES / CONFIG_CHUNK_BYTES + 1 {
        return Err(RuntimeConfigError("invalid chunk count"));
    }
    let mut json = String::new();
    for index in 0..count {
        let chunk = parent
            .get(&format!("{RUNTIME_CONFIG_CHUNK_PREFIX}{index}"))
            .ok_or(RuntimeConfigError("missing chunk"))?;
        if chunk.len() > CONFIG_CHUNK_BYTES || json.len() + chunk.len() > MAX_CONFIG_BYTES {
            return Err(RuntimeConfigError("document too large"));
        }
        json.push_str(chunk);
    }
    parse_runtime_config(json.as_bytes()).map(Some)
}

fn parse_runtime_config(bytes: &[u8]) -> Result<RuntimeConfigV1, RuntimeConfigError> {
    let config: RuntimeConfigV1 =
        serde_json::from_slice(bytes).map_err(|_| RuntimeConfigError("invalid document"))?;
    config.validate()?;
    Ok(config)
}

pub fn read_runtime_config(path: &Path) -> Result<RuntimeConfigV1, RuntimeConfigError> {
    let file = std::fs::File::open(path).map_err(|_| RuntimeConfigError("cannot open document"))?;
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| RuntimeConfigError("cannot read document"))?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(RuntimeConfigError("document too large"));
    }
    parse_runtime_config(&bytes)
}

fn expand_environment(
    value: &str,
    snapshot: &BTreeMap<String, String>,
    folder: &str,
) -> Result<String, RuntimeConfigError> {
    let mut output = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.find("${") {
        output.push_str(&remaining[..start]);
        let tail = &remaining[start + 2..];
        let end = tail
            .find('}')
            .ok_or(RuntimeConfigError("unclosed environment substitution"))?;
        let expression = &tail[..end];
        if expression == "containerWorkspaceFolder" {
            output.push_str(folder);
        } else if let Some(expression) = expression.strip_prefix("containerEnv:") {
            let (name, default) = expression.split_once(':').unwrap_or((expression, ""));
            if !valid_env_name(name) || default.contains("${") {
                return Err(RuntimeConfigError("invalid environment substitution"));
            }
            output.push_str(snapshot.get(name).map(String::as_str).unwrap_or(default));
        } else {
            return Err(RuntimeConfigError("unsupported environment substitution"));
        }
        if output.len() > MAX_VALUE_BYTES {
            return Err(RuntimeConfigError("expanded environment value too large"));
        }
        remaining = &tail[end + 1..];
    }
    output.push_str(remaining);
    if output.len() > MAX_VALUE_BYTES || output.contains('\0') {
        return Err(RuntimeConfigError(
            "expanded environment value too large or invalid",
        ));
    }
    Ok(output)
}

/// Apply each layer once. Remote substitutions see the completed container
/// layer, never another remote override or a spawn secret.
pub fn build_runtime_child_env(
    input: &ChildEnvInput<'_>,
    config: &RuntimeConfigV1,
) -> Result<BTreeMap<String, String>, RuntimeConfigError> {
    config.validate()?;
    let mut container = input.parent.clone();
    container.retain(|name, _| !name.starts_with(SANDBOXD_ENV_PREFIX));
    for (name, value) in &config.container_env {
        container.insert(
            name.clone(),
            expand_environment(value, input.parent, &config.workspace_folder)?,
        );
    }
    let mut combined = container.clone();
    for (name, value) in &config.remote_env {
        match value {
            Some(value) => {
                combined.insert(
                    name.clone(),
                    expand_environment(value, &container, &config.workspace_folder)?,
                );
            }
            None => {
                combined.remove(name);
            }
        }
    }
    combined.extend(config.spawn_env.clone());
    for name in AMBIENT_CREDENTIAL_ENV {
        combined.remove(name);
    }
    let provided = config
        .container_env
        .keys()
        .chain(config.remote_env.keys())
        .chain(config.spawn_env.keys())
        .filter(|name| combined.contains_key(*name))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>()
        .join(",");
    combined.insert(PROVIDED_ENV_VAR.into(), provided);
    let mut env = build_child_env(&ChildEnvInput {
        parent: &combined,
        ..*input
    });
    // Defaults (HOME, USER, certificates) must not resurrect an explicit
    // remote deletion unless the higher-priority spawn layer provides it.
    for (name, value) in &config.remote_env {
        if value.is_none() && !config.spawn_env.contains_key(name) {
            env.remove(name);
        }
    }
    if env.len() > 1024
        || env
            .values()
            .any(|value| value.len() > MAX_VALUE_BYTES || value.contains('\0'))
    {
        return Err(RuntimeConfigError("effective environment outside limits"));
    }
    Ok(env)
}

pub struct ChildEnvInput<'a> {
    /// The supervisor's own environment.
    pub parent: &'a BTreeMap<String, String>,
    pub layout: &'a InjectedLayout,
    /// The probed libc; `None` leaves the libc tree off `PATH`.
    pub libc: Option<Libc>,
    /// The user the agent runs as; `None` keeps the supervisor's identity.
    pub user: Option<&'a ResolvedUser>,
    /// The CA store the probe found in the image, if any.
    pub image_ca_bundle: Option<&'a str>,
}

/// The names in [`PROVIDED_ENV_VAR`], trimmed, empty entries ignored.
pub fn provided_names(parent: &BTreeMap<String, String>) -> BTreeSet<String> {
    parent
        .get(PROVIDED_ENV_VAR)
        .map(|list| {
            list.split(',')
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn build_child_env(input: &ChildEnvInput<'_>) -> BTreeMap<String, String> {
    let provided = provided_names(input.parent);
    let mut env: BTreeMap<String, String> = input
        .parent
        .iter()
        .filter(|(name, _)| !name.starts_with(SANDBOXD_ENV_PREFIX))
        .filter(|(name, _)| {
            !AMBIENT_CREDENTIAL_ENV.contains(&name.as_str()) || provided.contains(name.as_str())
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();

    let mut path: Vec<String> = env
        .get("PATH")
        .filter(|value| !value.is_empty())
        .map(String::as_str)
        .unwrap_or(DEFAULT_PATH)
        .split(':')
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect();
    for dir in input.layout.path_dirs(input.libc) {
        let dir = dir.to_string_lossy().into_owned();
        if !path.contains(&dir) {
            path.push(dir);
        }
    }
    env.insert("PATH".into(), path.join(":"));

    // TLS for tools that do not carry their own roots (the static git build
    // in particular). An explicit setting, provided or from the image, wins.
    let ca = input
        .image_ca_bundle
        .map(str::to_string)
        .unwrap_or_else(|| input.layout.ca_bundle().to_string_lossy().into_owned());
    for name in ["SSL_CERT_FILE", "GIT_SSL_CAINFO"] {
        env.entry(name.into()).or_insert_with(|| ca.clone());
    }

    if let Some(user) = input.user {
        // Docker set HOME for the image's user, usually root; the agent is
        // someone else now, unless the driver chose a home on purpose.
        if !provided.contains("HOME") {
            env.insert(
                "HOME".into(),
                user.home.clone().unwrap_or_else(|| "/tmp".into()),
            );
        }
        for name in ["USER", "LOGNAME"] {
            if provided.contains(name) {
                continue;
            }
            match &user.name {
                Some(user_name) => {
                    env.insert(name.into(), user_name.clone());
                }
                None => {
                    env.remove(name);
                }
            }
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    fn node_user() -> ResolvedUser {
        ResolvedUser {
            name: Some("node".into()),
            uid: 1000,
            gid: 1000,
            groups: vec![1000],
            home: Some("/home/node".into()),
        }
    }

    #[test]
    fn strips_supervisor_variables_and_ambient_credentials_not_provided() {
        let parent = parent(&[
            ("PATH", "/usr/local/bin:/usr/bin:/bin"),
            ("OPENAI_API_KEY", "baked-into-image"),
            ("ANTHROPIC_BASE_URL", "http://gateway:27895"),
            ("ANTHROPIC_AUTH_TOKEN", "ticket"),
            (
                "COGNIA_SANDBOXD_PROVIDED_ENV",
                "ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,,",
            ),
            ("COGNIA_SANDBOXD_CLAIM_SECRET", "s3cret"),
            ("LANG", "C.UTF-8"),
        ]);
        let layout = InjectedLayout::default();
        let env = build_child_env(&ChildEnvInput {
            parent: &parent,
            layout: &layout,
            libc: Some(Libc::Glibc),
            user: None,
            image_ca_bundle: Some("/etc/ssl/certs/ca-certificates.crt"),
        });

        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert!(env.keys().all(|name| !name.starts_with("COGNIA_SANDBOXD_")));
        assert_eq!(env["ANTHROPIC_BASE_URL"], "http://gateway:27895");
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "ticket");
        assert_eq!(env["LANG"], "C.UTF-8");
        assert_eq!(
            env["PATH"],
            "/usr/local/bin:/usr/bin:/bin:/cognia/bin:/cognia/glibc/bin:/cognia/common/bin"
        );
        assert_eq!(env["SSL_CERT_FILE"], "/etc/ssl/certs/ca-certificates.crt");
        assert_eq!(env["GIT_SSL_CAINFO"], "/etc/ssl/certs/ca-certificates.crt");
        assert!(!env.contains_key("HOME"));
    }

    #[test]
    fn defaults_path_and_ca_and_keeps_explicit_settings() {
        let parent = parent(&[
            ("SSL_CERT_FILE", "/custom.pem"),
            ("PATH", "/cognia/bin:/bin"),
        ]);
        let layout = InjectedLayout::default();
        let env = build_child_env(&ChildEnvInput {
            parent: &parent,
            layout: &layout,
            libc: None,
            user: None,
            image_ca_bundle: None,
        });
        assert_eq!(env["PATH"], "/cognia/bin:/bin:/cognia/common/bin");
        assert_eq!(env["SSL_CERT_FILE"], "/custom.pem");
        assert_eq!(env["GIT_SSL_CAINFO"], "/cognia/certs/ca-bundle.pem");

        let empty = BTreeMap::new();
        let env = build_child_env(&ChildEnvInput {
            parent: &empty,
            layout: &layout,
            libc: Some(Libc::Musl),
            user: None,
            image_ca_bundle: None,
        });
        assert!(env["PATH"].starts_with(DEFAULT_PATH));
        assert!(env["PATH"].ends_with("/cognia/musl/bin:/cognia/common/bin"));
    }

    #[test]
    fn switches_identity_variables_to_the_target_user() {
        let parent = parent(&[("HOME", "/root"), ("USER", "root"), ("LOGNAME", "root")]);
        let layout = InjectedLayout::default();
        let user = node_user();
        let env = build_child_env(&ChildEnvInput {
            parent: &parent,
            layout: &layout,
            libc: None,
            user: Some(&user),
            image_ca_bundle: None,
        });
        assert_eq!(env["HOME"], "/home/node");
        assert_eq!(env["USER"], "node");
        assert_eq!(env["LOGNAME"], "node");

        let nameless = ResolvedUser {
            name: None,
            uid: 10001,
            gid: 10001,
            groups: vec![10001],
            home: None,
        };
        let env = build_child_env(&ChildEnvInput {
            parent: &parent,
            layout: &layout,
            libc: None,
            user: Some(&nameless),
            image_ca_bundle: None,
        });
        assert_eq!(env["HOME"], "/tmp");
        assert!(!env.contains_key("USER"));

        let chosen = self::parent(&[
            ("HOME", "/workspace/.agent-home"),
            ("COGNIA_SANDBOXD_PROVIDED_ENV", "HOME"),
        ]);
        let env = build_child_env(&ChildEnvInput {
            parent: &chosen,
            layout: &layout,
            libc: None,
            user: Some(&user),
            image_ca_bundle: None,
        });
        assert_eq!(env["HOME"], "/workspace/.agent-home");
    }

    #[test]
    fn the_credential_list_matches_the_cli_launcher() {
        let launcher = include_str!("../../../cli/src/x/agent-launcher.ts");
        let start = launcher
            .find("export const AMBIENT_CREDENTIAL_ENV")
            .expect("launcher still exports the list");
        let block = &launcher[start..];
        // Skip the `readonly string[]` annotation: the list starts after `= [`.
        let block = &block[block.find("= [").expect("list literal") + 3..];
        let block = &block[..block.find(']').expect("list is closed")];
        let names: Vec<&str> = block.split('"').skip(1).step_by(2).collect();
        assert_eq!(names, AMBIENT_CREDENTIAL_ENV);
    }

    fn runtime_env(
        parent: &BTreeMap<String, String>,
        runtime: &RuntimeConfigV1,
    ) -> Result<BTreeMap<String, String>, RuntimeConfigError> {
        build_runtime_child_env(
            &ChildEnvInput {
                parent,
                layout: &InjectedLayout::default(),
                libc: Some(Libc::Musl),
                user: Some(&node_user()),
                image_ca_bundle: None,
            },
            runtime,
        )
    }

    #[test]
    fn runtime_environment_keeps_image_container_remote_and_spawn_layers_distinct() {
        let image = parent(&[
            ("PATH", "/image/bin"),
            ("BASE", "image"),
            ("REMOVE", "baked"),
            ("OPENAI_API_KEY", "baked-secret"),
        ]);
        let runtime = RuntimeConfigV1 {
            container_env: parent(&[
                ("BASE", "container"),
                ("PATH", "${containerEnv:PATH}:/container/bin"),
            ]),
            remote_env: BTreeMap::from([
                ("BASE".into(), Some("remote".into())),
                ("FROM_CONTAINER".into(), Some("${containerEnv:BASE}".into())),
                (
                    "PATH".into(),
                    Some("${containerEnv:PATH}:/remote/bin".into()),
                ),
                (
                    "FALLBACK".into(),
                    Some(
                        "${containerEnv:ABSENT:http://fallback}:${containerWorkspaceFolder}".into(),
                    ),
                ),
                ("REMOVE".into(), None),
            ]),
            spawn_env: parent(&[
                ("BASE", "spawn"),
                ("OPENAI_API_KEY", "host-secret"),
                ("COGNIA_GATEWAY_TOKEN", "task-lease"),
            ]),
            workspace_folder: "/workspace/app".into(),
            ..RuntimeConfigV1::default()
        };
        let env = runtime_env(&image, &runtime).unwrap();
        assert_eq!(env["BASE"], "spawn");
        assert_eq!(env["FROM_CONTAINER"], "container");
        assert!(env["PATH"].starts_with("/image/bin:/container/bin:/remote/bin:"));
        assert_eq!(env["FALLBACK"], "http://fallback:/workspace/app");
        assert!(!env.contains_key("REMOVE"));
        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert_eq!(env["COGNIA_GATEWAY_TOKEN"], "task-lease");
        assert!(env.keys().all(|key| !key.starts_with(SANDBOXD_ENV_PREFIX)));
    }

    #[test]
    fn explicit_remote_unsets_are_not_resurrected_by_identity_or_tls_defaults() {
        let image = parent(&[
            ("HOME", "/root"),
            ("USER", "root"),
            ("SSL_CERT_FILE", "/image/certs"),
        ]);
        let mut config = RuntimeConfigV1::default();
        for key in ["HOME", "USER", "SSL_CERT_FILE"] {
            config.remote_env.insert(key.into(), None);
        }
        let env = runtime_env(&image, &config).unwrap();
        for key in ["HOME", "USER", "SSL_CERT_FILE"] {
            assert!(!env.contains_key(key));
        }
        config
            .spawn_env
            .insert("HOME".into(), "/workspace/task-home".into());
        assert_eq!(
            runtime_env(&image, &config).unwrap()["HOME"],
            "/workspace/task-home"
        );
    }

    #[test]
    fn malformed_or_oversized_substitutions_fail_without_disclosing_values() {
        let image = parent(&[("LARGE", &"x".repeat(MAX_VALUE_BYTES))]);
        for value in [
            "${containerEnv:1INVALID}",
            "${hostEnv:SECRET}",
            "${containerEnv:UNFINISHED",
            "${containerEnv:LARGE}overflow",
        ] {
            let mut config = RuntimeConfigV1::default();
            config
                .remote_env
                .insert("EXAMPLE".into(), Some(value.into()));
            let error = runtime_env(&image, &config).unwrap_err();
            assert!(!error.to_string().contains(value));
        }
        let mut config = RuntimeConfigV1::default();
        config
            .remote_env
            .insert("COGNIA_GATEWAY_TOKEN".into(), None);
        assert!(runtime_env(&BTreeMap::new(), &config).is_err());
    }

    #[test]
    fn chunked_runtime_handoff_roundtrips_unicode_and_refuses_missing_or_invalid_chunks() {
        let config = RuntimeConfigV1 {
            container_env: parent(&[("MULTIBYTE", &"😀".repeat(8192))]),
            ..RuntimeConfigV1::default()
        };
        let entries = encode_runtime_config_env(&config).unwrap();
        assert!(entries.len() >= 3);
        let mut encoded: BTreeMap<_, _> = entries
            .iter()
            .map(|entry| {
                let (key, value) = entry.split_once('=').unwrap();
                (key.to_string(), value.to_string())
            })
            .collect();
        assert_eq!(
            decode_runtime_config_env(&encoded).unwrap(),
            Some(config.clone())
        );
        encoded.remove(&format!("{RUNTIME_CONFIG_CHUNK_PREFIX}0"));
        assert!(decode_runtime_config_env(&encoded).is_err());
        encoded.insert(RUNTIME_CONFIG_COUNT.into(), "9999999".into());
        assert!(decode_runtime_config_env(&encoded).is_err());
        assert_eq!(decode_runtime_config_env(&BTreeMap::new()).unwrap(), None);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.json");
        std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        assert_eq!(read_runtime_config(&path).unwrap(), config);
        std::fs::write(&path, r#"{"version":"private-secret"}"#).unwrap();
        assert!(!read_runtime_config(&path)
            .unwrap_err()
            .to_string()
            .contains("private-secret"));
    }

    #[test]
    fn runtime_validates_commands_phase_order_timeout_and_workspace() {
        let mut config = RuntimeConfigV1 {
            lifecycle_phases: vec![LifecyclePhase::PostStart, LifecyclePhase::OnCreate],
            ..RuntimeConfigV1::default()
        };
        assert!(config.validate().is_err());
        config.lifecycle_phases = vec![LifecyclePhase::OnCreate];
        config.lifecycle_commands.on_create = Some(RuntimeCommand::Parallel {
            commands: BTreeMap::from([(
                "nested".into(),
                RuntimeCommand::Parallel {
                    commands: BTreeMap::new(),
                },
            )]),
        });
        assert!(config.validate().is_err());
        config.lifecycle_commands = RuntimeLifecycleCommands::default();
        config.lifecycle_timeout_ms = 999;
        assert!(config.validate().is_err());
        config.lifecycle_timeout_ms = 1_000;
        config.workspace_folder = "/workspace/../escape".into();
        assert!(config.validate().is_err());
    }

    #[test]
    fn sequence_wire_format_and_command_tree_limits_match_the_spec() {
        let leaf = RuntimeCommand::Shell {
            command: "true".into(),
        };
        let mut command = RuntimeCommand::Sequence {
            commands: vec![leaf.clone()],
        };
        let value = serde_json::to_value(&command).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"kind":"sequence", "commands":[{"kind":"shell", "command":"true"}]})
        );
        validate_runtime_command(&command, 0, &mut 0).unwrap();
        for _ in 0..8 {
            command = RuntimeCommand::Sequence {
                commands: vec![command],
            };
        }
        assert!(validate_runtime_command(&command, 0, &mut 0).is_err());
        for count in [0, 256] {
            let command = RuntimeCommand::Sequence {
                commands: vec![leaf.clone(); count],
            };
            assert!(validate_runtime_command(&command, 0, &mut 0).is_err());
        }
        let at_limit = RuntimeCommand::Sequence {
            commands: vec![leaf; 255],
        };
        validate_runtime_command(&at_limit, 0, &mut 0).unwrap();
    }
}
