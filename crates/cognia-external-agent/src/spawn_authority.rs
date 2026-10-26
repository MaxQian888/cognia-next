//! Server-owned origin context; it never crosses the caller's spawn payload.
use std::future::Future;

/// Identity stamped by Host admission, never accepted as caller authority.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacementBinding {
    pub org_id: String,
    pub workspace_id: String,
    pub actor_user_id: String,
    pub run_id: String,
}

impl PlacementBinding {
    /// A private tmpfs mount, removed with its sandbox. Length-prefixed
    /// identity prevents ambiguous concatenations and path traversal.
    pub fn scratch_path(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut digest = Sha256::new();
        for id in [&self.org_id, &self.workspace_id, &self.actor_user_id, &self.run_id] {
            digest.update((id.len() as u64).to_be_bytes());
            digest.update(id.as_bytes());
        }
        format!("/scratch/{}", hex::encode(digest.finalize()))
    }
}

/// A standing decision carried in process memory from admission to dispatch.
/// Deliberately not deserializable: renderer args cannot grant mount or
/// credential permissions. Later commands obtain a fresh standing decision.
#[derive(Clone, Debug)]
pub struct ExecutionAdmission {
    pub binding: PlacementBinding,
    pub actions: Vec<String>,
}

impl ExecutionAdmission {
    pub fn has(&self, action: &str) -> bool {
        self.actions.iter().any(|value| value == action)
    }

    pub fn workspace_read_only(&self) -> Result<bool, &'static str> {
        if !self.has("execution.request") { return Err("execution_request_forbidden"); }
        if self.has("workspace.write") { return Ok(false); }
        if self.has("workspace.read") { return Ok(true); }
        Err("workspace_read_forbidden")
    }

    pub fn authorize_credentials<'a>(&self, names: impl IntoIterator<Item = &'a str>) -> Result<(), &'static str> {
        self.authorize_inputs(names, std::iter::empty(), false)
    }

    pub fn authorize_inputs<'a>(&self, names: impl IntoIterator<Item = &'a str>, args: impl IntoIterator<Item = &'a str>, config_files: bool) -> Result<(), &'static str> {
        if CredentialDelivery::for_inputs(names, args, config_files) != CredentialDelivery::None && !self.has("credential.use") {
            return Err("credential_use_forbidden");
        }
        Ok(())
    }
}

tokio::task_local! { static EXECUTION_ADMISSION: Option<ExecutionAdmission>; }
pub async fn with_execution_admission<T>(admission: Option<ExecutionAdmission>, future: impl Future<Output = T>) -> T {
    EXECUTION_ADMISSION.scope(admission, future).await
}
pub fn execution_admission() -> Option<ExecutionAdmission> {
    EXECUTION_ADMISSION.try_with(Clone::clone).ok().flatten()
}

/// How credentials reach a sandbox. A process receiving an injected
/// credential can read it: `credential.use` without `credential.read` is
/// promised only for Brokered delivery (Rule 7).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialDelivery {
    #[serde(alias = "gateway-lease")]
    Brokered,
    InjectedEnv,
    None,
}

/// The same name filter used to redact process inspection. This classifies
/// explicit spawn environment values; it does not inspect secret values.
pub fn credential_env_name(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    ["TOKEN", "PASSWORD", "SECRET", "API_KEY"].iter().any(|part| name.contains(part))
}

impl CredentialDelivery {
    pub fn for_env<'a>(names: impl IntoIterator<Item = &'a str>) -> Self {
        Self::for_inputs(names, std::iter::empty(), false)
    }

    /// Conservative multi-tenant classification shared by admission and reports.
    /// Structured env payloads, config/auth file selectors, JSON CLI payloads,
    /// credential/config CLI options and lifecycle-written configuration can
    /// carry secrets without secret-looking env names. Their presence requires
    /// credential.use; parsing provider-specific schemas would miss new fields.
    pub fn for_inputs<'a>(names: impl IntoIterator<Item = &'a str>, args: impl IntoIterator<Item = &'a str>, config_files: bool) -> Self {
        if config_files || args.into_iter().any(|arg| {
            let option = arg.split('=').next().unwrap_or(arg).to_ascii_lowercase();
            let normalized: String = option.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
            (arg.starts_with('-') && (matches!(option.as_str(), "-c" | "-e")
                || ["apikey", "token", "password", "secret", "credential", "auth", "config", "settings", "header", "envfile", "profile"]
                    .iter().any(|part| normalized.contains(part))))
                || arg.trim_start().starts_with('{') || arg.trim_start().starts_with('[')
                || (arg.contains('=') && (credential_env_name(arg.split('=').next().unwrap_or(arg)) || normalized.contains("apikey")))
        }) { return Self::InjectedEnv; }
        let mut brokered = false;
        for name in names {
            if matches!(name, "COGNIA_GATEWAY_TASK_CONFIG" | "COGNIA_GATEWAY_TOKEN") {
                brokered = true;
            } else if credential_env_name(name) || {
                let name = name.to_ascii_uppercase();
                name.contains("CONFIG") || name.ends_with("_JSON") || name.contains("CREDENTIAL")
                    || name.ends_with("_AUTH") || matches!(name.as_str(), "COGNIA_DEVIN_MCP_SERVERS"
                        | "COGNIA_GATEWAY_RUNTIME_ENV" | "CODEX_HOME" | "GEMINI_HOME" | "GROK_HOME"
                        | "KIMI_CODE_HOME" | "CLINE_DIR" | "PI_CODING_AGENT_DIR")
            } {
                return Self::InjectedEnv;
            }
        }
        if brokered { Self::Brokered } else { Self::None }
    }
}

tokio::task_local! { static REMOTE_ORIGIN: String; }
/// Authenticated Host listener, never reconstructed from renderer environment values.
#[derive(Clone)]
pub struct GatewayAuthority {
    pub port: u16,
    pub device_id: Option<String>,
    pub task_id: String,
    /// Host-admitted immutable source; never decoded from the spawn payload.
    pub delivery_source: Option<DeliverySource>,
    pub authorized: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
}
/// Durable source authority issued by the Host before remote execution.
/// Origin references are owner-admitted labels, not credentials or authority.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliverySource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<PlacementBinding>,
    pub version: u32,
    pub id: String,
    pub owner_account_id: String,
    pub host_id: String,
    pub task_id: String,
    pub device_id: String,
    pub conversation_id: String,
    pub coding_run_id: String,
    pub origin_run_ref: String,
    pub repository_url: String,
    pub base_ref: String,
    pub branch: String,
    pub credential_ref: Option<String>,
}

/// Declared during the original authenticated operation, never at handoff.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliverySourceDeclaration {
    pub conversation_id: String,
    pub origin_run_ref: String,
}
pub const DELIVERY_SOURCE_ENV: &str = "COGNIA_DELIVERY_SOURCE";

tokio::task_local! { static GATEWAY: Option<GatewayAuthority>; }
pub async fn with_gateway<T>(
    authority: Option<GatewayAuthority>,
    future: impl Future<Output = T>,
) -> T {
    GATEWAY.scope(authority, future).await
}
pub fn gateway() -> Option<GatewayAuthority> {
    GATEWAY.try_with(Clone::clone).ok().flatten()
}

pub async fn with_remote_origin<T>(device_id: &str, future: impl Future<Output = T>) -> T {
    REMOTE_ORIGIN.scope(device_id.to_owned(), future).await
}

pub fn current_origin() -> Option<String> {
    REMOTE_ORIGIN.try_with(Clone::clone).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p4_review_structured_credential_channels_share_admission_and_report_classification() {
        let mut decision = ExecutionAdmission { binding: PlacementBinding { org_id: "o".into(), workspace_id: "w".into(), actor_user_id: "u".into(), run_id: "r".into() }, actions: vec!["execution.request".into(), "workspace.read".into()] };
        for name in ["OPENCODE_CONFIG_CONTENT", "PROVIDER_CONFIG_CONTENT", "AGENT_CONFIG_JSON", "JSON_CONFIG",
            "COGNIA_DEVIN_MCP_SERVERS", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_SHARED_CREDENTIALS_FILE",
            "CLAUDE_CONFIG_DIR", "CODEX_HOME", "COGNIA_GATEWAY_RUNTIME_ENV"] {
            assert_eq!(CredentialDelivery::for_env([name]), CredentialDelivery::InjectedEnv, "{name}");
            assert_eq!(decision.authorize_credentials([name]), Err("credential_use_forbidden"), "{name}");
        }
        for args in [vec!["--api-key=fixture"], vec!["--token", "fixture"], vec!["--config", "/workspace/provider.json"],
            vec!["-c", "provider.apiKey=fixture"], vec!["--header", "Authorization: Bearer fixture"], vec![r#"{"provider":{"options":{"apiKey":"fixture"}}}"#]] {
            assert_eq!(CredentialDelivery::for_inputs([], args.iter().copied(), false), CredentialDelivery::InjectedEnv);
            assert_eq!(decision.authorize_inputs([], args.iter().copied(), false), Err("credential_use_forbidden"));
        }
        assert_eq!(decision.authorize_inputs([], [], true), Err("credential_use_forbidden"));
        decision.actions.push("credential.use".into());
        assert_eq!(decision.authorize_inputs(["OPENCODE_CONFIG_CONTENT"], ["--config=auth.json"], true), Ok(()));
    }

    #[test]
    fn p4_execution_admission_requires_execution_mount_and_credential_standing() {
        let mut admission = ExecutionAdmission {
            binding: PlacementBinding { org_id: "org_a".into(), workspace_id: "w".into(), actor_user_id: "usr_a".into(), run_id: "run".into() },
            actions: vec!["workspace.read".into()],
        };
        assert_eq!(admission.workspace_read_only(), Err("execution_request_forbidden"));
        admission.actions.push("execution.request".into());
        assert_eq!(admission.workspace_read_only(), Ok(true));
        assert_eq!(admission.authorize_credentials(["API_KEY"]), Err("credential_use_forbidden"));
        assert_eq!(admission.authorize_credentials(["PATH"]), Ok(()));
        admission.actions.extend(["workspace.write".into(), "credential.use".into()]);
        assert_eq!(admission.workspace_read_only(), Ok(false));
        assert_eq!(admission.authorize_credentials(["API_KEY"]), Ok(()));
    }

    #[test]
    fn p4_credential_delivery_labels_plain_injection_and_reads_legacy_gateway_leases() {
        assert_eq!(CredentialDelivery::for_env(["PATH"]), CredentialDelivery::None);
        assert_eq!(CredentialDelivery::for_env(["COGNIA_GATEWAY_TOKEN"]), CredentialDelivery::Brokered);
        for name in ["api_key", "MY_TOKEN", "DB_PASSWORD", "service_SECRET"] {
            assert_eq!(CredentialDelivery::for_env([name]), CredentialDelivery::InjectedEnv);
            assert_eq!(CredentialDelivery::for_env(["COGNIA_GATEWAY_TOKEN", name]), CredentialDelivery::InjectedEnv);
        }
        let legacy: CredentialDelivery = serde_json::from_str("\"gateway-lease\"").unwrap();
        assert_eq!(legacy, CredentialDelivery::Brokered);
        assert_eq!(serde_json::to_string(&legacy).unwrap(), "\"brokered\"");
        for mode in [CredentialDelivery::Brokered, CredentialDelivery::InjectedEnv, CredentialDelivery::None] {
            assert_eq!(serde_json::from_value::<CredentialDelivery>(serde_json::to_value(mode).unwrap()).unwrap(), mode);
        }
    }

    #[tokio::test]
    async fn p4_private_scratch_is_actor_task_scoped_and_authority_does_not_leak() {
        let a = PlacementBinding { org_id: "org_a".into(), workspace_id: "w".into(), actor_user_id: "usr_a".into(), run_id: "task".into() };
        let b = PlacementBinding { actor_user_id: "usr_b".into(), ..a.clone() };
        let c = PlacementBinding { run_id: "another-task".into(), ..a.clone() };
        assert_ne!(a.scratch_path(), b.scratch_path());
        assert_ne!(a.scratch_path(), c.scratch_path());
        assert_eq!(a.scratch_path().len(), "/scratch/".len() + 64);
        assert!(execution_admission().is_none());
        with_execution_admission(Some(ExecutionAdmission { binding: a.clone(), actions: vec![] }), async {
            assert_eq!(execution_admission().unwrap().binding, a);
            assert!(tokio::spawn(async { execution_admission() }).await.unwrap().is_none());
        }).await;
        assert!(execution_admission().is_none());
    }

    #[tokio::test]
    async fn origin_is_scoped_and_not_inherited_by_unrelated_tasks() {
        assert_eq!(current_origin(), None);
        with_remote_origin("device-a", async {
            assert_eq!(current_origin().as_deref(), Some("device-a"));
            assert_eq!(
                tokio::spawn(async { current_origin() }).await.unwrap(),
                None
            );
        })
        .await;
        assert_eq!(current_origin(), None);
    }
}
