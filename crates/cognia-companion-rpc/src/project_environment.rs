use crate::shell::{shell_exec_with_env_timeout_cap, ShellResult};
use cognia_exec_sandbox::types::{NetworkPolicy, SandboxCommand, SandboxPolicy};
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

const DEFAULT_KEYRING_NAMESPACE: &str = "project-environment";
const DEFAULT_TIMEOUT_SECS: u64 = 30;
// Bootstrap may use up to one hour plus five seconds for cleanup.
const MAX_TIMEOUT_SECS: u64 = 60 * 60 + 5;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentKeyringReference {
    pub variable: String,
    pub keyring_ref: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum EnvironmentScript {
    Legacy(String),
    Structured {
        default: String,
        #[serde(default, rename = "byOs")]
        by_os: BTreeMap<String, String>,
    },
}

impl EnvironmentScript {
    fn resolve_for(&self, os: &str) -> String {
        match self {
            Self::Legacy(script) => script.trim().to_string(),
            Self::Structured { default, by_os } => by_os
                .get(os)
                .map(String::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(default)
                .trim()
                .to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentNetworkMode {
    Off,
    Allowlist,
    #[default]
    On,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentPolicy {
    #[serde(default)]
    pub required_runtime_capabilities: Vec<String>,
    #[serde(default)]
    pub allowed_domains: Vec<String>,
    pub require_sandbox: Option<bool>,
    pub network: Option<EnvironmentNetworkMode>,
    #[serde(rename = "cacheKey")]
    pub _cache_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionHost {
    Local,
    Cloud,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EffectiveEnvironmentPolicy {
    require_sandbox: bool,
    network: EnvironmentNetworkPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum EnvironmentNetworkPolicy {
    Off,
    Allowlist { hosts: Vec<String> },
    On,
}

fn effective_policy(
    policy: Option<EnvironmentPolicy>,
    host: ExecutionHost,
) -> EffectiveEnvironmentPolicy {
    let policy = policy.unwrap_or_default();
    let mode = policy.network.unwrap_or_else(|| {
        if !policy.allowed_domains.is_empty() {
            EnvironmentNetworkMode::Allowlist
        } else if host == ExecutionHost::Cloud {
            EnvironmentNetworkMode::Off
        } else {
            EnvironmentNetworkMode::On
        }
    });
    let require_sandbox = host == ExecutionHost::Cloud
        || policy.require_sandbox.unwrap_or(false)
        || mode != EnvironmentNetworkMode::On
        || !policy.allowed_domains.is_empty()
        || policy
            .required_runtime_capabilities
            .iter()
            .any(|capability| capability == "sandbox");
    let network = match mode {
        EnvironmentNetworkMode::Off => EnvironmentNetworkPolicy::Off,
        EnvironmentNetworkMode::Allowlist if policy.allowed_domains.is_empty() => {
            EnvironmentNetworkPolicy::Off
        }
        EnvironmentNetworkMode::Allowlist => EnvironmentNetworkPolicy::Allowlist {
            hosts: policy.allowed_domains,
        },
        EnvironmentNetworkMode::On => EnvironmentNetworkPolicy::On,
    };
    EffectiveEnvironmentPolicy {
        require_sandbox,
        network,
    }
}

fn valid_environment_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit())
        })
}

fn resolve_keyring_ref(value: &str) -> (&str, &str) {
    value
        .split_once(':')
        .filter(|(namespace, credential)| !namespace.is_empty() && !credential.is_empty())
        .unwrap_or((DEFAULT_KEYRING_NAMESPACE, value))
}

fn redact(mut value: String, secrets: &[String]) -> String {
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        value = value.replace(secret, "[REDACTED]");
    }
    value
}

fn shell_argv(script: String) -> Vec<String> {
    if cfg!(target_os = "windows") {
        vec!["cmd".into(), "/C".into(), script]
    } else {
        vec!["sh".into(), "-c".into(), script]
    }
}

fn sandbox_network(policy: EnvironmentNetworkPolicy) -> NetworkPolicy {
    match policy {
        EnvironmentNetworkPolicy::Off => NetworkPolicy::Off,
        EnvironmentNetworkPolicy::Allowlist { hosts } => NetworkPolicy::Allowlist { hosts },
        EnvironmentNetworkPolicy::On => NetworkPolicy::On,
    }
}

/// Packaged sidecars are beside the host executable; development helpers
/// live in the same workspace target tree. Existing caller PATH comes last.
fn bootstrap_search_path(inherited: Option<std::ffi::OsString>) -> std::ffi::OsString {
    let mut paths = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            paths.push(parent.to_path_buf());
        }
    }
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        paths.push(root.join("target/debug"));
        paths.push(root.join("target/release"));
    }
    if let Some(inherited) = inherited {
        paths.extend(std::env::split_paths(&inherited));
    }
    std::env::join_paths(paths).unwrap_or_default()
}

fn bootstrap_executable(
    cwd: &std::path::Path,
    variables: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    if !variables.contains_key("COGNIA_BOOTSTRAP_CONFIG") {
        return None;
    }
    let binary = variables
        .get("COGNIA_BOOTSTRAP_BINARY")
        .map(String::as_str)
        .unwrap_or("cognia-bootstrap");
    let name = std::path::Path::new(binary);
    let candidates = if name.is_absolute() {
        vec![name.to_path_buf()]
    } else if name.components().count() > 1 {
        vec![cwd.join(name)]
    } else {
        std::env::split_paths(variables.get("PATH").map(String::as_str).unwrap_or(""))
            .map(|root| root.join(name))
            .collect()
    };
    candidates
        .into_iter()
        .find_map(|candidate| candidate.canonicalize().ok().filter(|path| path.is_file()))
}

async fn execute_on_host(
    script: EnvironmentScript,
    cwd: String,
    variables: BTreeMap<String, String>,
    keyring_references: Vec<EnvironmentKeyringReference>,
    policy: Option<EnvironmentPolicy>,
    timeout_secs: Option<u64>,
    host: ExecutionHost,
) -> Result<ShellResult, String> {
    let script = script.resolve_for(std::env::consts::OS);
    if script.is_empty() {
        return Err(format!(
            "project environment has no script for host OS: {}",
            std::env::consts::OS
        ));
    }

    let mut environment = BTreeMap::new();
    for (name, value) in variables {
        if !valid_environment_name(&name) {
            return Err(format!("invalid environment variable name: {name}"));
        }
        environment.insert(name, value);
    }
    let mut secrets = Vec::new();
    for reference in keyring_references {
        if !valid_environment_name(&reference.variable) {
            return Err(format!(
                "invalid environment variable name: {}",
                reference.variable
            ));
        }
        if environment.contains_key(&reference.variable) {
            return Err(format!(
                "environment variable cannot be plain and keyring-backed: {}",
                reference.variable
            ));
        }
        let (namespace, credential) = resolve_keyring_ref(&reference.keyring_ref);
        let secret = cognia_connectors::keyring::get(namespace, credential)?
            .ok_or_else(|| format!("missing keyring reference: {}", reference.keyring_ref))?;
        environment.insert(reference.variable, secret.clone());
        secrets.push(secret);
    }

    if environment.contains_key("COGNIA_BOOTSTRAP_CONFIG") {
        let inherited = environment
            .remove("PATH")
            .map(std::ffi::OsString::from)
            .or_else(|| std::env::var_os("PATH"));
        environment.insert(
            "PATH".into(),
            bootstrap_search_path(inherited).to_string_lossy().into(),
        );
    }
    let effective = effective_policy(policy, host);
    let mut result = if !effective.require_sandbox {
        tokio::task::spawn_blocking(move || {
            shell_exec_with_env_timeout_cap(
                script,
                cwd,
                timeout_secs,
                environment,
                MAX_TIMEOUT_SECS,
            )
        })
        .await
        .map_err(|error| format!("project environment worker failed: {error}"))??
    } else {
        let cwd = PathBuf::from(cwd);
        let mut readable = vec![cwd.clone()];
        if let Some(binary) = bootstrap_executable(&cwd, &environment) {
            readable.push(binary);
        }
        let timeout = timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS);
        let command = SandboxCommand {
            argv: shell_argv(script),
            cwd: cwd.clone(),
            env: environment,
            stdin: None,
            timeout: Duration::from_secs(timeout),
        };
        let sandbox_policy = SandboxPolicy::Bash {
            writable: vec![cwd.clone()],
            readable,
            network: sandbox_network(effective.network),
            max_cpu_seconds: timeout.min(u32::MAX as u64) as u32,
            max_memory_mb: 2048,
            max_processes: cognia_exec_sandbox::policy::BASH_DEFAULT_MAX_PROCESSES,
        };
        match cognia_exec_sandbox::run_confined(command, sandbox_policy).await {
            Ok(result) => ShellResult {
                stdout: result.stdout,
                stderr: result.stderr,
                exit_code: Some(result.exit_code),
                timed_out: result.timed_out,
                stdout_truncated: false,
                stderr_truncated: false,
            },
            Err(cognia_exec_sandbox::types::SandboxError::Timeout { .. }) => ShellResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                timed_out: true,
                stdout_truncated: false,
                stderr_truncated: false,
            },
            Err(error) => return Err(error.to_string()),
        }
    };
    result.stdout = redact(result.stdout, &secrets);
    result.stderr = redact(result.stderr, &secrets);
    Ok(result)
}

/// Executes a project environment on the local desktop host. The shared
/// implementation also backs Companion/headless RPC; secret values never
/// cross the renderer or remote transport boundary.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn project_environment_execute(
    script: EnvironmentScript,
    cwd: String,
    variables: BTreeMap<String, String>,
    keyring_references: Vec<EnvironmentKeyringReference>,
    policy: Option<EnvironmentPolicy>,
    timeout_secs: Option<u64>,
) -> Result<ShellResult, String> {
    execute_on_host(
        script,
        cwd,
        variables,
        keyring_references,
        policy,
        timeout_secs,
        ExecutionHost::Local,
    )
    .await
}

pub async fn project_environment_execute_cloud(
    script: EnvironmentScript,
    cwd: String,
    variables: BTreeMap<String, String>,
    keyring_references: Vec<EnvironmentKeyringReference>,
    policy: Option<EnvironmentPolicy>,
    timeout_secs: Option<u64>,
) -> Result<ShellResult, String> {
    execute_on_host(
        script,
        cwd,
        variables,
        keyring_references,
        policy,
        timeout_secs,
        ExecutionHost::Cloud,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_sandbox_resolves_only_the_selected_executable() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("bootstrap with spaces");
        std::fs::write(&binary, "binary").unwrap();
        let mut variables = BTreeMap::from([
            ("COGNIA_BOOTSTRAP_CONFIG".into(), "{}".into()),
            (
                "COGNIA_BOOTSTRAP_BINARY".into(),
                "bootstrap with spaces".into(),
            ),
            ("PATH".into(), dir.path().to_string_lossy().into()),
        ]);
        assert_eq!(
            bootstrap_executable(dir.path(), &variables),
            Some(binary.canonicalize().unwrap())
        );
        variables.remove("COGNIA_BOOTSTRAP_CONFIG");
        assert!(bootstrap_executable(dir.path(), &variables).is_none());
    }

    #[test]
    fn bootstrap_path_preserves_caller_search_path() {
        let inherited = PathBuf::from("/custom/bin");
        let path = bootstrap_search_path(Some(inherited.clone().into_os_string()));
        let parts: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(parts.last(), Some(&inherited));
        assert!(MAX_TIMEOUT_SECS >= 600 + 5);
    }

    #[test]
    fn selects_script_for_the_execution_host() {
        let script = EnvironmentScript::Structured {
            default: "portable".into(),
            by_os: BTreeMap::from([
                ("macos".into(), "mac".into()),
                ("linux".into(), "linux".into()),
            ]),
        };
        assert_eq!(script.resolve_for("macos"), "mac");
        assert_eq!(script.resolve_for("windows"), "portable");
    }

    #[test]
    fn cloud_policy_is_sandboxed_and_network_off_by_default() {
        let policy = effective_policy(None, ExecutionHost::Cloud);
        assert!(policy.require_sandbox);
        assert_eq!(policy.network, EnvironmentNetworkPolicy::Off);
    }

    #[test]
    fn cloud_policy_reuses_the_existing_allowlist_shape() {
        let policy = effective_policy(
            Some(EnvironmentPolicy {
                allowed_domains: vec!["api.example.com".into()],
                ..EnvironmentPolicy::default()
            }),
            ExecutionHost::Cloud,
        );
        assert!(policy.require_sandbox);
        assert_eq!(
            policy.network,
            EnvironmentNetworkPolicy::Allowlist {
                hosts: vec!["api.example.com".into()]
            }
        );
    }

    #[test]
    fn local_network_restrictions_always_require_the_sandbox() {
        let network_off = effective_policy(
            Some(EnvironmentPolicy {
                network: Some(EnvironmentNetworkMode::Off),
                require_sandbox: Some(false),
                ..EnvironmentPolicy::default()
            }),
            ExecutionHost::Local,
        );
        assert!(network_off.require_sandbox);
        assert_eq!(network_off.network, EnvironmentNetworkPolicy::Off);

        let allowlist = effective_policy(
            Some(EnvironmentPolicy {
                allowed_domains: vec!["api.example.com".into()],
                require_sandbox: Some(false),
                ..EnvironmentPolicy::default()
            }),
            ExecutionHost::Local,
        );
        assert!(allowlist.require_sandbox);
        assert_eq!(
            allowlist.network,
            EnvironmentNetworkPolicy::Allowlist {
                hosts: vec!["api.example.com".into()]
            }
        );
    }

    #[test]
    fn validates_names_and_redacts_every_secret_occurrence() {
        assert!(valid_environment_name("API_TOKEN"));
        assert!(!valid_environment_name("1TOKEN"));
        assert!(!valid_environment_name("BAD-NAME"));
        assert_eq!(
            redact("token=secret and secret again".into(), &["secret".into()]),
            "token=[REDACTED] and [REDACTED] again"
        );
    }

    #[test]
    fn supports_namespaced_and_default_keyring_references() {
        assert_eq!(resolve_keyring_ref("adapter:token"), ("adapter", "token"));
        assert_eq!(
            resolve_keyring_ref("token"),
            (DEFAULT_KEYRING_NAMESPACE, "token")
        );
    }
}
