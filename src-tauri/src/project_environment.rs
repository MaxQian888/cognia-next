use crate::sandbox::types::{NetworkPolicy, SandboxCommand, SandboxPolicy};
use crate::shell::{shell_exec_with_env, ShellResult};
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

const DEFAULT_KEYRING_NAMESPACE: &str = "project-environment";
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 5 * 60;

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
    let require_sandbox = host == ExecutionHost::Cloud
        || policy.require_sandbox.unwrap_or(false)
        || policy
            .required_runtime_capabilities
            .iter()
            .any(|capability| capability == "sandbox");
    let mode = policy.network.unwrap_or_else(|| {
        if !policy.allowed_domains.is_empty() {
            EnvironmentNetworkMode::Allowlist
        } else if host == ExecutionHost::Cloud {
            EnvironmentNetworkMode::Off
        } else {
            EnvironmentNetworkMode::On
        }
    });
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

    let effective = effective_policy(policy, host);
    let mut result = if !effective.require_sandbox {
        shell_exec_with_env(script, cwd, timeout_secs, environment)?
    } else {
        let cwd = PathBuf::from(cwd);
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
            readable: vec![cwd],
            network: sandbox_network(effective.network),
            max_cpu_seconds: timeout.min(u32::MAX as u64) as u32,
            max_memory_mb: 2048,
        };
        match crate::sandbox::run_confined(command, sandbox_policy).await {
            Ok(result) => ShellResult {
                stdout: result.stdout,
                stderr: result.stderr,
                exit_code: Some(result.exit_code),
                timed_out: result.timed_out,
                stdout_truncated: false,
                stderr_truncated: false,
            },
            Err(crate::sandbox::types::SandboxError::Timeout { .. }) => ShellResult {
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
#[tauri::command]
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
