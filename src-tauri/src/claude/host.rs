//! `SidecarHost` — the host abstraction behind the Claude sidecar supervisor
//! (ADR-0059 W4, slice R6).
//!
//! `sidecar::spawn` historically took a raw `tauri::AppHandle`, coupling the
//! supervisor to the WebView shell in exactly three ways: script resolution
//! (`resource_dir`), provider-env injection (`app.try_state::<ApiKeyState>`),
//! and event emission (`app.emit`). This trait collapses all three:
//!
//! - [`TauriSidecarHost`] — the desktop app, byte-identical to the old flow.
//! - [`HeadlessSidecarHost`] — the `cognia-server` binary. The script comes
//!   from `COGNIA_SIDECAR_SCRIPT`; events publish into the companion
//!   [`EventBus`], riding `/ws/v1/events` to every connected client with the
//!   **unchanged** channel names and payloads.
//!
//! # Permission forwarding is load-bearing
//!
//! `handle_permission_request` forwards un-blocked `permission_request`
//! events through [`SidecarHost::emit`]. On the desktop that reaches the
//! approval store via the WebView listener; headless it MUST reach the
//! EventBus (and thus the phone / brain over `/ws/v1/events`) — otherwise
//! every gated tool call deadlocks waiting for an approval nobody saw.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio::process::Command;

use crate::api_key::ApiKeyState;
use crate::companion_api::event_bus::EventBus;

/// Host-specific pieces of the sidecar supervisor. Everything else (spawn
/// lock, epochs, backoff, reader loop, hooks) is shared.
#[async_trait]
pub trait SidecarHost: Send + Sync + 'static {
    /// Absolute path to `claude-host.mjs` for this host.
    fn resolve_script(&self) -> Result<PathBuf, String>;

    /// Deliver a sidecar event (`claude://message`, `a2ui://dispatch`) to
    /// whoever hosts the UI. Fire-and-forget: implementations log failures.
    fn emit(&self, channel: &str, payload: &Value);

    /// Inject host-resolved provider credentials into the child's env.
    /// Auth precedence (both hosts): OAuth bearer → API key; base URL is
    /// orthogonal and forwarded whenever set.
    async fn inject_env(&self, cmd: &mut Command);

    /// `"tauri"` | `"headless"` — for logs.
    fn kind(&self) -> &'static str;
}

/// Shared provider-env injection over an [`ApiKeyState`]. Auth precedence:
///
/// 1. OAuth bearer (`CLAUDE_CODE_OAUTH_TOKEN`) — the SDK reads this var and
///    sends `Authorization: Bearer …` + the `oauth-2025-04-20` beta header.
///    `ANTHROPIC_API_KEY` is removed so mixed modes (undefined SDK behavior)
///    can't happen.
/// 2. `ANTHROPIC_API_KEY` — legacy + CCSwitch flow.
///
/// `ANTHROPIC_BASE_URL` is forwarded whenever set.
pub(crate) async fn inject_provider_env(api_keys: &ApiKeyState, cmd: &mut Command) {
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

// ---------------------------------------------------------------------------
// Desktop host
// ---------------------------------------------------------------------------

/// Desktop host: resource-dir script, Tauri-managed [`ApiKeyState`], events
/// via `AppHandle::emit` — today's behavior, unchanged.
pub struct TauriSidecarHost(pub tauri::AppHandle);

#[async_trait]
impl SidecarHost for TauriSidecarHost {
    fn resolve_script(&self) -> Result<PathBuf, String> {
        super::sidecar::resolve_sidecar_script(&self.0)
    }

    fn emit(&self, channel: &str, payload: &Value) {
        use tauri::Emitter;
        if let Err(e) = self.0.emit(channel, payload) {
            log::error!("failed to emit {channel}: {e}");
        }
    }

    async fn inject_env(&self, cmd: &mut Command) {
        use tauri::Manager;
        if let Some(api_key_state) = self.0.try_state::<ApiKeyState>() {
            inject_provider_env(&api_key_state, cmd).await;
        }
    }

    fn kind(&self) -> &'static str {
        "tauri"
    }
}

// ---------------------------------------------------------------------------
// Headless host
// ---------------------------------------------------------------------------

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
    }

    fn kind(&self) -> &'static str {
        "headless"
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use parking_lot::Mutex;

    /// Records emissions; used by sidecar/commands tests that need a host
    /// without a WebView or an EventBus.
    #[derive(Default)]
    pub struct RecordingSidecarHost {
        pub emitted: Mutex<Vec<(String, Value)>>,
        pub script: Option<PathBuf>,
    }

    impl RecordingSidecarHost {
        pub fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        pub fn with_script(script: PathBuf) -> Arc<Self> {
            Arc::new(Self {
                emitted: Mutex::new(Vec::new()),
                script: Some(script),
            })
        }

        pub fn events(&self) -> Vec<(String, Value)> {
            self.emitted.lock().clone()
        }
    }

    #[async_trait]
    impl SidecarHost for RecordingSidecarHost {
        fn resolve_script(&self) -> Result<PathBuf, String> {
            self.script
                .clone()
                .ok_or_else(|| "recording host has no script".to_string())
        }

        fn emit(&self, channel: &str, payload: &Value) {
            self.emitted
                .lock()
                .push((channel.to_string(), payload.clone()));
        }

        async fn inject_env(&self, _cmd: &mut Command) {}

        fn kind(&self) -> &'static str {
            "recording"
        }
    }
}

#[cfg(test)]
mod tests {
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
        keys.set_provider(Some("sk-moon".into()), Some("https://api.moonshot.cn/anthropic".into()))
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
        assert!(envs.iter().any(|(k, v)| k == "ANTHROPIC_CUSTOM_HEADER_anthropic-beta"
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
            crate::companion_api::event_bus::SubscribeResult::Ok { receiver, .. } => receiver,
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
        let err = host.resolve_script().expect_err("missing script must error");
        assert!(err.contains("COGNIA_SIDECAR_SCRIPT"));

        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("claude-host.mjs");
        std::fs::write(&script, "// stub").expect("write stub");
        let host = HeadlessSidecarHost::new(script.clone(), EventBus::new(), ApiKeyState::new());
        assert_eq!(host.resolve_script().expect("resolves"), script);
    }

    #[test]
    fn from_env_reads_the_documented_var() {
        // Env mutation: use a unique value and restore after. Serialized by
        // being the only test that touches this var.
        let prev = std::env::var(SIDECAR_SCRIPT_ENV).ok();
        std::env::set_var(SIDECAR_SCRIPT_ENV, "X:/somewhere/claude-host.mjs");
        let host = HeadlessSidecarHost::from_env(EventBus::new(), ApiKeyState::new())
            .expect("from_env with var set");
        assert_eq!(
            host.script,
            PathBuf::from("X:/somewhere/claude-host.mjs")
        );
        match prev {
            Some(v) => std::env::set_var(SIDECAR_SCRIPT_ENV, v),
            None => std::env::remove_var(SIDECAR_SCRIPT_ENV),
        }
    }
}
