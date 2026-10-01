//! Shared sidecar adapters used by the companion RPC and server.
use async_trait::async_trait;
use cognia_companion::event_bus::EventBus;
use cognia_secrets::api_key::ApiKeyState;
pub use cognia_sidecar::host::SidecarHost;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::Command;

/// Shared provider-env injection over an [`ApiKeyState`]. Auth precedence:
///
/// 1. OAuth bearer (`CLAUDE_CODE_OAUTH_TOKEN`) — the SDK reads this var and
///    sends `Authorization: Bearer …` + the `oauth-2025-04-20` beta header.
///    `ANTHROPIC_API_KEY` is removed so mixed modes (undefined SDK behavior)
///    can't happen.
/// 2. `ANTHROPIC_API_KEY` — legacy + CCSwitch flow.
///
/// `ANTHROPIC_BASE_URL` is forwarded whenever set.
pub async fn inject_provider_env(api_keys: &ApiKeyState, cmd: &mut Command) {
    if let Some(token) = api_keys.get_oauth_bearer().await {
        cmd.env("CLAUDE_CODE_OAUTH_TOKEN", token);
        cmd.env_remove("ANTHROPIC_API_KEY");
    } else if let Some(key) = api_keys.get().await {
        cmd.env("ANTHROPIC_API_KEY", key);
    }
    if let Some(url) = api_keys.get_base_url().await {
        cmd.env("ANTHROPIC_BASE_URL", url);
    }
    // Forward any relay-required headers (e.g. `anthropic-beta: context-1m-…`
    // for the 1M window) as `ANTHROPIC_CUSTOM_HEADER_*`, the shape the Claude
    // Agent SDK reads. Mirrors the subscription module's header injection.
    for (name, value) in api_keys.get_custom_headers().await {
        cmd.env(format!("ANTHROPIC_CUSTOM_HEADER_{name}"), value);
    }
}

/// Headless host for `cognia-server`: script from `COGNIA_SIDECAR_SCRIPT`,
/// its own [`ApiKeyState`] (fed by the `claude_set_*` RPC arms, R7), events
/// into the companion [`EventBus`].
pub struct HeadlessSidecarHost {
    script: PathBuf,
    event_bus: Arc<EventBus>,
    api_keys: ApiKeyState,
}

/// Env var naming the sidecar entry script in headless installs. Set by
/// `Dockerfile.cognia-server` (`/app/brain/sidecar/claude-host.mjs`).
pub const SIDECAR_SCRIPT_ENV: &str = "COGNIA_SIDECAR_SCRIPT";

impl HeadlessSidecarHost {
    pub fn new(script: PathBuf, event_bus: Arc<EventBus>, api_keys: ApiKeyState) -> Self {
        Self {
            script,
            event_bus,
            api_keys,
        }
    }

    /// Resolve the script from `COGNIA_SIDECAR_SCRIPT`. There is no
    /// resource-dir fallback headless — a missing script is a deployment
    /// error that must surface at boot, not at first send.
    pub fn from_env(event_bus: Arc<EventBus>, api_keys: ApiKeyState) -> Result<Self, String> {
        let raw = std::env::var(SIDECAR_SCRIPT_ENV)
            .map_err(|_| format!("{SIDECAR_SCRIPT_ENV} is not set (headless sidecar script)"))?;
        let script = PathBuf::from(raw);
        Ok(Self::new(script, event_bus, api_keys))
    }
}

#[async_trait]
impl SidecarHost for HeadlessSidecarHost {
    fn resolve_script(&self) -> Result<PathBuf, String> {
        if self.script.exists() {
            Ok(self.script.clone())
        } else {
            Err(format!(
                "headless sidecar script not found at {} (check {SIDECAR_SCRIPT_ENV})",
                self.script.display()
            ))
        }
    }

    fn emit(&self, channel: &str, payload: &Value) {
        // Unchanged channel names + payloads: `/ws/v1/events` subscribers
        // (phones, the brain) receive exactly what the desktop WebView would.
        // This includes `permission_request` events — see the module docs.
        self.event_bus.publish(channel.to_string(), payload.clone());
    }

    async fn inject_env(&self, cmd: &mut Command) {
        inject_provider_env(&self.api_keys, cmd).await;
        inject_runtime_env(cmd).await;
    }

    fn is_disabled(&self) -> bool {
        cognia_observability::recovery_runtime::is_subsystem_disabled(
            cognia_observability::recovery::RecoverySubsystem::Sidecar,
        )
    }

    fn report_failure(&self) {
        report_sidecar_failure();
    }

    async fn dispatch_host_rpc(&self, method: &str, params: &Value) -> Result<Value, String> {
        dispatch_runtime_rpc(method, params).await
    }

    fn kind(&self) -> &'static str {
        "headless"
    }
}

pub fn report_sidecar_failure() {
    use cognia_observability::recovery::{ChildAction, RecoverySubsystem};

    match cognia_observability::recovery_runtime::report_child_failure(RecoverySubsystem::Sidecar) {
        Some(ChildAction::Restart { attempt, .. }) => {
            log::warn!("recovery: sidecar death {attempt} of 3 before the subsystem is held back");
        }
        Some(ChildAction::Disable { .. }) => {
            log::error!(
                "recovery: sidecar restart budget exhausted; holding the subsystem back \
                 and entering the diagnostics shell"
            );
        }
        // Recovery is not running (headless tests, no data dir). `CrashBackoff`
        // still paces respawns, so supervision degrades rather than stops.
        None => {}
    }
}

pub async fn inject_runtime_env(cmd: &mut Command) {
    match cognia_observability::telemetry::sidecar_env() {
        Ok(env) => {
            for (key, value) in env {
                cmd.env(key, value);
            }
        }
        Err(error) => log::warn!("sidecar telemetry configuration unavailable: {error}"),
    }
    match cognia_sidecar::langfuse::sidecar_env_for_current_account_async().await {
        Ok(env) => {
            for (key, value) in env {
                cmd.env(key, value);
            }
        }
        Err(error) => log::warn!("sidecar Langfuse configuration unavailable: {error}"),
    }
}

pub async fn dispatch_runtime_rpc(method: &str, params: &Value) -> Result<Value, String> {
    // Private child IPC only: no companion RPC or renderer command dispatches
    // these methods. The trusted tool-host manager supplies its own listener.
    if method.starts_with("sandbox.toolHost.") {
        return dispatch_tool_host_bridge(method, params).await;
    }
    // Session-store calls are routed FIRST and never reach the jobs dispatcher:
    // that one opens with `require_supervisor()?`, so on a host without
    // background jobs every session-store call would fail with a message about
    // jobs — a confusing way to learn that transcript mirroring is unavailable.
    if cognia_agent_state::agent_session_store::is_session_store_method(method) {
        cognia_agent_state::agent_session_store::dispatch_host_rpc(method, params).await
    } else {
        cognia_jobs::host::dispatch_host_rpc(method, params).await
    }
}

async fn dispatch_tool_host_bridge(method: &str, params: &Value) -> Result<Value, String> {
    let runtime = cognia_companion::environment_pool::installed()
        .and_then(|pool| pool.runtime)
        .ok_or("Sandbox runtime is unavailable")?;
    match method {
        "sandbox.toolHost.open" | "sandbox.toolHost.register" => {
            let mut request =
                serde_json::from_value::<cognia_sandbox_pool::runtime::ToolHostService>(
                    params.clone(),
                )
                .map_err(|_| "Invalid private tool-host bridge request")?;
            let origin = request.origin_device_id.clone();
            request.authorization = Some(std::sync::Arc::new(move || {
                origin
                    .as_deref()
                    .is_none_or(cognia_companion::workspace_access::device_can_control)
            }));
            if method.ends_with(".register") {
                let id = runtime
                    .register_tool_host(request)
                    .await
                    .map_err(|error| error.to_string())?;
                return Ok(serde_json::json!({"bridgeId": id}));
            }
            let bridge = runtime
                .open_tool_host(request)
                .await
                .map_err(|error| error.to_string())?;
            serde_json::to_value(bridge).map_err(|error| error.to_string())
        }
        "sandbox.toolHost.renew" | "sandbox.toolHost.close" => {
            let object = params.as_object().ok_or("Invalid private bridge control")?;
            if object.len() != 1 {
                return Err("Invalid private bridge control".into());
            }
            let id = object
                .get("bridgeId")
                .and_then(Value::as_str)
                .filter(|id| id.len() == 36)
                .ok_or("Invalid bridge identity")?;
            if method.ends_with(".renew") {
                Ok(serde_json::json!({"active":runtime.renew_tool_host(id)}))
            } else {
                runtime.close_tool_host(id);
                Ok(serde_json::json!({"closed":true}))
            }
        }
        _ => Err("Unsupported private tool-host bridge method".into()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn private_bridge_payload_cannot_choose_an_address_or_supply_host_authority() {
        let request = serde_json::json!({"agentId":"agent","ownerSessionId":"chat","originDeviceId":null,"leaseId":"renderer-tool-host-fixture","generation":1,"port":12345});
        assert!(
            serde_json::from_value::<cognia_sandbox_pool::runtime::ToolHostService>(
                request.clone()
            )
            .unwrap()
            .authorization
            .is_none()
        );
        for key in ["url", "host", "authorization"] {
            let mut forged = request.clone();
            forged[key] = serde_json::json!("127.0.0.1:22");
            assert!(
                serde_json::from_value::<cognia_sandbox_pool::runtime::ToolHostService>(forged)
                    .is_err()
            );
        }
    }
    #[test]
    fn host_rpc_routes_session_store_before_the_jobs_dispatcher() {
        assert!(
            cognia_agent_state::agent_session_store::is_session_store_method("sessionStore.append")
        );
        assert!(
            cognia_agent_state::agent_session_store::is_session_store_method(
                "sessionStore.listSessions"
            )
        );
        assert!(!cognia_agent_state::agent_session_store::is_session_store_method("jobs.spawn"));
        assert!(
            !cognia_agent_state::agent_session_store::is_session_store_method("jobs.sessionStore")
        );
    }

    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn inject_provider_env_prefers_oauth_and_strips_api_key() {
        let keys = ApiKeyState::new();
        keys.set(Some("sk-test".into())).await;
        keys.set_oauth_bearer(Some("oat-1".into())).await;
        keys.set_provider(Some("sk-test".into()), Some("https://proxy.test".into()))
            .await;

        let mut cmd = Command::new("node");
        inject_provider_env(&keys, &mut cmd).await;
        let std_cmd = cmd.as_std();
        let envs: Vec<(String, Option<String>)> = std_cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.map(|v| v.to_string_lossy().to_string()),
                )
            })
            .collect();
        assert!(envs
            .iter()
            .any(|(k, v)| k == "CLAUDE_CODE_OAUTH_TOKEN" && v.as_deref() == Some("oat-1")));
        // API key explicitly removed (None marks env_remove).
        assert!(envs
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_API_KEY" && v.is_none()));
        assert!(envs
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_BASE_URL" && v.as_deref() == Some("https://proxy.test")));
    }

    #[tokio::test]
    async fn inject_provider_env_falls_back_to_api_key() {
        let keys = ApiKeyState::new();
        keys.set(Some("sk-test".into())).await;

        let mut cmd = Command::new("node");
        inject_provider_env(&keys, &mut cmd).await;
        let envs: Vec<(String, Option<String>)> = cmd
            .as_std()
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.map(|v| v.to_string_lossy().to_string()),
                )
            })
            .collect();
        assert!(envs
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_API_KEY" && v.as_deref() == Some("sk-test")));
        assert!(!envs.iter().any(|(k, _)| k == "CLAUDE_CODE_OAUTH_TOKEN"));
    }

    #[tokio::test]
    async fn inject_provider_env_forwards_custom_headers() {
        let keys = ApiKeyState::new();
        keys.set_provider(
            Some("sk-moon".into()),
            Some("https://api.moonshot.cn/anthropic".into()),
        )
        .await;
        keys.set_custom_headers(vec![(
            "anthropic-beta".into(),
            "context-1m-2025-08-07".into(),
        )])
        .await;

        let mut cmd = Command::new("node");
        inject_provider_env(&keys, &mut cmd).await;
        let envs: Vec<(String, Option<String>)> = cmd
            .as_std()
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.map(|v| v.to_string_lossy().to_string()),
                )
            })
            .collect();
        assert!(envs
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_CUSTOM_HEADER_anthropic-beta"
                && v.as_deref() == Some("context-1m-2025-08-07")));
    }

    #[tokio::test]
    async fn headless_host_emits_into_the_event_bus() {
        let bus = EventBus::new();
        let host = HeadlessSidecarHost::new(
            PathBuf::from("does-not-matter.mjs"),
            Arc::clone(&bus),
            ApiKeyState::new(),
        );

        let now_ms = 0;
        let sub = bus.subscribe(None, now_ms);
        let mut rx = match sub {
            cognia_companion::event_bus::SubscribeResult::Ok { receiver, .. } => receiver,
            _ => panic!("subscribe failed"),
        };

        host.emit("claude://message", &json!({ "type": "ready" }));
        let frame = rx.try_recv().expect("frame published");
        assert_eq!(frame.event_type, "claude://message");
        assert_eq!(frame.payload["type"], "ready");
        assert_eq!(host.kind(), "headless");
    }

    #[tokio::test]
    async fn headless_resolve_script_requires_an_existing_file() {
        let host = HeadlessSidecarHost::new(
            PathBuf::from("Z:/definitely/not/here/claude-host.mjs"),
            EventBus::new(),
            ApiKeyState::new(),
        );
        let err = host
            .resolve_script()
            .expect_err("missing script must error");
        assert!(err.contains("COGNIA_SIDECAR_SCRIPT"));

        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("claude-host.mjs");
        std::fs::write(&script, "// stub").expect("write stub");
        let host = HeadlessSidecarHost::new(script.clone(), EventBus::new(), ApiKeyState::new());
        assert_eq!(host.resolve_script().expect("resolves"), script);
    }

    #[test]
    fn headless_host_keeps_the_explicit_path_node_contract() {
        let host = HeadlessSidecarHost::new(
            PathBuf::from("does-not-matter.mjs"),
            EventBus::new(),
            ApiKeyState::new(),
        );

        assert_eq!(
            host.resolve_node_executable().expect("headless node"),
            PathBuf::from("node")
        );
    }

    #[test]
    fn from_env_reads_the_documented_var() {
        // Env mutation: use a unique value and restore after. Serialized by
        // being the only test that touches this var.
        let prev = std::env::var(SIDECAR_SCRIPT_ENV).ok();
        std::env::set_var(SIDECAR_SCRIPT_ENV, "X:/somewhere/claude-host.mjs");
        let host = HeadlessSidecarHost::from_env(EventBus::new(), ApiKeyState::new())
            .expect("from_env with var set");
        assert_eq!(host.script, PathBuf::from("X:/somewhere/claude-host.mjs"));
        match prev {
            Some(v) => std::env::set_var(SIDECAR_SCRIPT_ENV, v),
            None => std::env::remove_var(SIDECAR_SCRIPT_ENV),
        }
    }
}
