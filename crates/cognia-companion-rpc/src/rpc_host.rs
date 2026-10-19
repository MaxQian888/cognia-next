//! `RpcHost`: the host seam the companion RPC families dispatch through
//! (ADR-0196 P5.3, landed with P8).
//!
//! A family arm reaches host-owned state through these typed accessors, never
//! through a Tauri `AppHandle`, so a family can live in this Tauri-free crate
//! and run unchanged on the desktop and in `cognia-server`. Two hosts
//! implement it:
//!
//! - the headless registry, `Arc<HeadlessServices>`, in this module;
//! - the desktop's `DispatchHost` in `app_lib::companion_api::dispatch_host`,
//!   whose headless arm delegates here, so neither host's answer is written
//!   twice.
//!
//! An accessor that only one host can answer says so in its own doc comment;
//! the other host answers it with the error or `None` the family maps to its
//! historical reply.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use cognia_codeserver::profile::IdeProfile;
use cognia_codeserver::remote::RemoteCodeServerStatus;
use cognia_companion::event_bus::EventBus;
use cognia_external_agent::exec_backend::{AgentEventEmitter, ExecBackend};
use cognia_external_agent::presets::SpawnPolicy;
use cognia_external_agent::process::ExternalAgentSpawnConfig;
use cognia_terminal::host::HostSessionInfo;
use cognia_terminal::host_client::TerminalHostStatus;
use cognia_terminal::terminal_host_service::TerminalHostSettings;

use crate::headless::{ApiKeyState, ConnectorsState, HeadlessServices};
use crate::sidecar_runtime::SidecarHost;
use cognia_sidecar::supervisor::SidecarState;

/// Where a host publishes `ocr://download-progress` frames.
pub type OcrProgressEmitter = Arc<dyn Fn(cognia_ocr::DownloadProgressEvent) + Send + Sync>;

/// The computer-use runtime a host runs (ADR-0020), and where its kill switch
/// announces itself. Only the desktop has one.
pub struct HostAutomation<'a> {
    pub state: &'a cognia_automation::automation::commands::AutomationState,
    pub events: Arc<dyn cognia_automation::automation::host::AutomationEventSink>,
}

/// The process hosting a companion RPC dispatch, seen through what the
/// families need from it.
#[async_trait]
pub trait RpcHost: Send + Sync {
    /// `"tauri"` | `"headless"`, for logs and error strings.
    fn kind(&self) -> &'static str;

    /// An owned handle on this same host, for work that outlives the call
    /// (a blocking-pool task, an event sink).
    fn to_shared(&self) -> Arc<dyn RpcHost>;

    /// The data directory owned by the execution host.
    fn data_dir(&self) -> Result<PathBuf, String>;

    /// The headless services registry, when this host is headless.
    fn headless(&self) -> Option<&Arc<HeadlessServices>>;

    /// The desktop's resource dir, where a terminal host this starts finds its
    /// shell-integration scripts; `None` on the headless server.
    fn resource_dir(&self) -> Option<PathBuf>;

    // ── Pro IDE (ADR-0088) ──────────────────────────────────────────────────

    /// Resolve `root` to the canonical workspace whose live workbench this
    /// caller may drive. The desktop has already canonicalized the root
    /// against the active project; the headless host additionally records
    /// which devices may drive an instance.
    async fn ide_canonical_root(&self, root: &str, device_id: &str) -> Result<String, String>;

    /// Start (or reuse) a workbench for `root`. `via_relay` is false for a
    /// caller on this machine's loopback plane, which needs neither a relay id
    /// nor the owner's approval.
    async fn ide_ensure(
        &self,
        root: &str,
        profile: IdeProfile,
        device_id: &str,
        via_relay: bool,
    ) -> Result<RemoteCodeServerStatus, String>;

    /// Whether a workbench is serving `root`, and under which profile.
    async fn ide_status(
        &self,
        root: &str,
        device_id: &str,
    ) -> Result<RemoteCodeServerStatus, String>;

    /// Stop the workbench serving `root`. `true` when one was running.
    async fn ide_stop(&self, root: &str) -> bool;

    /// Stop every workbench this host owns.
    async fn ide_stop_all(&self);

    /// The workbench's loopback port for `root`. Only ever disclosed to a
    /// caller on the loopback plane, which the arm enforces.
    async fn ide_loopback_port(&self, root: &str, device_id: &str) -> Option<u16>;

    /// Open a project-relative file through code-server's own CLI bridge.
    async fn ide_open_file(
        &self,
        root: &str,
        device_id: &str,
        path: &str,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<(), String>;

    async fn ide_read_user_settings(&self, profile: IdeProfile) -> Result<String, String>;

    async fn ide_write_user_settings(
        &self,
        contents: String,
        profile: IdeProfile,
    ) -> Result<(), String>;

    async fn ide_read_runtime_args(&self, profile: IdeProfile) -> Result<String, String>;

    async fn ide_write_runtime_args(
        &self,
        contents: String,
        profile: IdeProfile,
    ) -> Result<(), String>;

    // ── Sidecar, provider env, MCP ──────────────────────────────────────────

    /// The sidecar supervisor state for this host.
    fn sidecar_state(&self) -> SidecarState;

    /// The provider-env store for this host.
    fn api_keys(&self) -> ApiKeyState;

    /// Snapshot the embedded MCP server status from the process that owns it.
    fn mcp_server_status(&self) -> cognia_mcp_server::types::McpServerStatus;

    /// The sidecar host seam for this host: what `sidecar::spawn` needs.
    fn sidecar_host(&self) -> Arc<dyn SidecarHost>;

    // ── Durable terminal host (host-neutral) ────────────────────────────────

    /// Snapshot durable host-owned terminal sessions visible to the caller.
    async fn terminal_list_all(&self, device_id: &str) -> Result<Vec<HostSessionInfo>, String> {
        #[cfg(any(test, feature = "test-support"))]
        if let Some(services) = self.headless() {
            return Ok(services.terminal_sessions_for_tests.read().await.clone());
        }
        let resource_dir = self.resource_dir();
        cognia_terminal::host_client::terminal_host_remote_list(resource_dir.as_deref(), device_id)
            .await
    }

    async fn terminal_list_for_project(
        &self,
        device_id: &str,
        project_id: &str,
    ) -> Result<Vec<HostSessionInfo>, String> {
        Ok(self
            .terminal_list_all(device_id)
            .await?
            .into_iter()
            .filter(|session| session.project_id.as_deref() == Some(project_id))
            .collect())
    }

    /// Terminate a durable host-owned terminal after taking its controller
    /// lease on behalf of the authenticated device.
    async fn terminal_kill(&self, device_id: &str, session_id: &str) -> Result<(), String> {
        let resource_dir = self.resource_dir();
        cognia_terminal::host_client::terminal_host_remote_kill(
            resource_dir.as_deref(),
            device_id,
            session_id,
        )
        .await
    }

    /// The terminal host's own settings, as the file on disk has them. They
    /// live next to the terminal host, not in host state, so both hosts answer
    /// identically.
    async fn terminal_host_status(&self) -> Result<TerminalHostStatus, String> {
        cognia_terminal::host_client::terminal_host_remote_status().await
    }

    /// Apply terminal-host settings on behalf of an authenticated administrator.
    async fn terminal_host_configure(
        &self,
        settings: TerminalHostSettings,
    ) -> Result<TerminalHostStatus, String> {
        let resource_dir = self.resource_dir();
        cognia_terminal::host_client::terminal_host_remote_configure(
            resource_dir.as_deref(),
            settings,
        )
        .await
    }

    /// Run one SFTP operation on the terminal host (ADR-0162). The host
    /// refuses the frame unless the connection is local, so this call is the
    /// only door and the RPC layer above it is the only gate.
    async fn terminal_host_sftp(&self, payload: Value) -> Result<Value, String> {
        let resource_dir = self.resource_dir();
        cognia_terminal::host_client::terminal_host_sftp(resource_dir.as_deref(), payload).await
    }

    /// Install a paired device's terminal profiles on the host.
    async fn terminal_host_sync_profiles(
        &self,
        device_id: &str,
        profiles: Vec<Value>,
    ) -> Result<usize, String> {
        let resource_dir = self.resource_dir();
        cognia_terminal::host_client::terminal_host_remote_sync_profiles(
            resource_dir.as_deref(),
            device_id,
            profiles,
        )
        .await
    }

    // ── External-agent execution plane ──────────────────────────────────────

    /// The process/exec backend that owns external agents on this host.
    fn exec_backend(&self) -> Arc<dyn ExecBackend>;

    /// Where agent lifecycle events are published for this host.
    fn agent_event_emitter(&self) -> Arc<dyn AgentEventEmitter>;

    /// The spawn policy this host applies to a REMOTE spawn request: the
    /// strict `SpawnPolicy` on both hosts, never the desktop's laxer local
    /// validation.
    fn remote_spawn_policy(&self) -> Result<SpawnPolicy, String>;

    /// Apply this host's OS confinement to an already policy-validated spawn.
    /// `backend` is the one the spawn will go to, fetched once by the caller.
    fn harden_spawn_config(
        &self,
        config: ExternalAgentSpawnConfig,
        backend: &dyn ExecBackend,
    ) -> Result<ExternalAgentSpawnConfig, String>;

    // ── Plugin runtimes, connectors, OCR ────────────────────────────────────

    /// Native plugin install/permission/snapshot service this host owns.
    fn plugin_runtime(&self) -> &cognia_plugin_runtime::PluginRuntimeState;

    /// VS Code extension sidecar registry.
    fn vscode_plugins(&self) -> &cognia_plugin_runtime::vscode::VscodeExtensionState;

    /// Connector adapter registry + the single-owner runtime lease.
    fn connectors_state(&self) -> &ConnectorsState;

    /// Native OCR backend registry this host owns (an owned clone).
    async fn ocr_registry(&self) -> cognia_ocr::NativeOcrRegistry;

    /// Where `ocr://download-progress` is published.
    fn ocr_progress_emitter(&self) -> OcrProgressEmitter;

    /// Publish a host-originated event on `topic`. The topic must be
    /// catalogued in `event_channels::EVENT_CHANNELS`, or it reaches no remote
    /// client at all.
    fn publish_host_event(&self, topic: &str, payload: Value);

    /// The `cognia` data root inside [`Self::data_dir`]: a subdirectory on the
    /// desktop, the data dir itself on a headless host.
    fn cognia_data_dir(&self) -> Result<PathBuf, String>;

    // ── Host-owned state the families address directly ──────────────────────

    /// The workflow runtime (scheduler mirror, waitpoints, integration
    /// ingress). `None` while the desktop has not managed it yet.
    fn workflow_state(&self) -> Option<&cognia_scheduling::workflow::WorkflowState>;

    /// The embedded MCP server this host owns.
    fn mcp_server(&self) -> &cognia_mcp_server::McpServerState;

    /// The MCP sidecar script this host launches, when it ships one.
    fn mcp_sidecar_path(&self) -> Option<PathBuf>;

    /// Where the MCP server's orchestration proxy publishes exec events.
    fn mcp_orchestration_sink(
        &self,
    ) -> cognia_mcp_server::orchestration_proxy::OrchestrationEventSink;

    /// The computer-use runtime, which only the desktop runs.
    fn automation(&self) -> Option<HostAutomation<'_>>;

    /// What the embedded MCP server needs to drive computer use, on a host
    /// built with it (`cognia-mcp-server/desktop-automation`).
    fn mcp_automation_binding(&self) -> Option<cognia_mcp_server::AutomationBinding>;

    /// The desktop's companion server lifecycle (bind mode, tunnel, ports).
    /// `None` on a headless host, whose listener is configured at boot.
    fn companion_server(&self) -> Option<&cognia_companion::CompanionServerState>;

    /// The version this host reports to a pairing client.
    fn app_version(&self) -> String;

    /// The LLM gateway this host owns. `None` before the desktop has
    /// initialised it.
    fn gateway(&self) -> Option<&cognia_gateway::GatewayState>;

    /// Where a gateway this host starts publishes its request log.
    fn gateway_event_host(
        &self,
        event_bus: Arc<EventBus>,
    ) -> Arc<dyn cognia_gateway::host::GatewayHost>;

    /// The sidecar tree whose Pi permission extension this host verifies.
    fn pi_sidecar_dir(&self) -> Option<PathBuf>;

    /// The Codex App control host. Only the desktop drives the Codex App.
    fn codex_app_host(&self) -> Option<Box<dyn cognia_codex_app::CodexAppHost + '_>>;
}

/// The [`AgentEventEmitter`] that publishes agent lifecycle events on the
/// companion EventBus, which a remote client reads through `/ws/events`.
pub struct BusAgentEmitter(pub Arc<EventBus>);

impl AgentEventEmitter for BusAgentEmitter {
    fn emit(&self, channel: &str, payload: Value) {
        self.0.publish(channel.to_string(), payload);
    }
}

/// A headless host has no renderer: orchestration exec events go to the
/// connected brain over the socket bridge.
pub fn headless_orchestration_event_sink(
) -> cognia_mcp_server::orchestration_proxy::OrchestrationEventSink {
    use cognia_companion::bridge_transport::BridgeTransport;

    Arc::new(move |event| {
        let payload = serde_json::to_value(event).map_err(|error| error.to_string())?;
        let bridge = cognia_companion::ws_bridge::socket_bridge_transport()
            .ok_or_else(|| "headless Brain bridge is disconnected".to_string())?;
        bridge.emit(cognia_mcp_server::orchestration_proxy::EXEC_EVENT, payload)
    })
}

/// Whether a headless spawn runs in this host's own process table, where a
/// private state root can be resolved (by `ExternalAgentProcessManager`).
fn state_key_reaches_host_process_table(
    config: &ExternalAgentSpawnConfig,
    backend_kind: &str,
) -> bool {
    config.sandbox.is_none() && backend_kind == "local-process"
}

#[async_trait]
impl RpcHost for Arc<HeadlessServices> {
    fn kind(&self) -> &'static str {
        "headless"
    }

    fn to_shared(&self) -> Arc<dyn RpcHost> {
        Arc::new(Arc::clone(self))
    }

    fn data_dir(&self) -> Result<PathBuf, String> {
        Ok(self.data_dir.clone())
    }

    fn headless(&self) -> Option<&Arc<HeadlessServices>> {
        Some(self)
    }

    fn resource_dir(&self) -> Option<PathBuf> {
        None
    }

    async fn ide_canonical_root(&self, root: &str, device_id: &str) -> Result<String, String> {
        self.code_server.authorize_agent_root(root, device_id).await
    }

    async fn ide_ensure(
        &self,
        root: &str,
        profile: IdeProfile,
        device_id: &str,
        _via_relay: bool,
    ) -> Result<RemoteCodeServerStatus, String> {
        // A headless instance is device-scoped already, so a relay needs no
        // separate owner approval here.
        self.code_server.ensure(root, profile, device_id).await
    }

    async fn ide_status(
        &self,
        root: &str,
        device_id: &str,
    ) -> Result<RemoteCodeServerStatus, String> {
        self.code_server.status(root, device_id).await
    }

    async fn ide_stop(&self, root: &str) -> bool {
        self.code_server.stop(root).await
    }

    async fn ide_stop_all(&self) {
        self.code_server.stop_all().await
    }

    async fn ide_loopback_port(&self, root: &str, device_id: &str) -> Option<u16> {
        self.code_server.loopback_port(root, device_id).await
    }

    async fn ide_open_file(
        &self,
        root: &str,
        device_id: &str,
        path: &str,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<(), String> {
        self.code_server
            .open_file(root, device_id, path, line, column)
            .await
    }

    async fn ide_read_user_settings(&self, profile: IdeProfile) -> Result<String, String> {
        self.code_server.read_user_settings(profile).await
    }

    async fn ide_write_user_settings(
        &self,
        contents: String,
        profile: IdeProfile,
    ) -> Result<(), String> {
        self.code_server
            .write_user_settings(contents, profile)
            .await
    }

    async fn ide_read_runtime_args(&self, profile: IdeProfile) -> Result<String, String> {
        self.code_server.read_runtime_args(profile).await
    }

    async fn ide_write_runtime_args(
        &self,
        contents: String,
        profile: IdeProfile,
    ) -> Result<(), String> {
        self.code_server.write_runtime_args(contents, profile).await
    }

    fn sidecar_state(&self) -> SidecarState {
        self.sidecar.clone()
    }

    fn api_keys(&self) -> ApiKeyState {
        self.api_keys.clone()
    }

    fn mcp_server_status(&self) -> cognia_mcp_server::types::McpServerStatus {
        self.mcp_server.status()
    }

    fn sidecar_host(&self) -> Arc<dyn SidecarHost> {
        Arc::clone(&self.sidecar_host)
    }

    fn exec_backend(&self) -> Arc<dyn ExecBackend> {
        Arc::clone(&self.exec)
    }

    fn agent_event_emitter(&self) -> Arc<dyn AgentEventEmitter> {
        Arc::new(BusAgentEmitter(Arc::clone(&self.event_bus)))
    }

    fn remote_spawn_policy(&self) -> Result<SpawnPolicy, String> {
        Ok(self.spawn_policy.clone())
    }

    /// The headless container relies on the `ExecBackend` it was configured
    /// with (local / bollard / kube) for isolation, so there is nothing to
    /// wrap. `COGNIA_AGENT_STATE_KEY` (ADR-0216) names a private state root on
    /// this host; a launch confined anywhere but this host's process table
    /// cannot see it, so the key is dropped there.
    fn harden_spawn_config(
        &self,
        mut config: ExternalAgentSpawnConfig,
        backend: &dyn ExecBackend,
    ) -> Result<ExternalAgentSpawnConfig, String> {
        if !state_key_reaches_host_process_table(&config, backend.kind()) {
            cognia_external_agent::state_isolation::strip_state_key(&mut config);
        }
        Ok(config)
    }

    fn plugin_runtime(&self) -> &cognia_plugin_runtime::PluginRuntimeState {
        self.plugin_runtime.as_ref()
    }

    fn vscode_plugins(&self) -> &cognia_plugin_runtime::vscode::VscodeExtensionState {
        self.vscode_plugins.as_ref()
    }

    fn connectors_state(&self) -> &ConnectorsState {
        &self.connectors
    }

    async fn ocr_registry(&self) -> cognia_ocr::NativeOcrRegistry {
        HeadlessServices::ocr_registry(self).await.clone()
    }

    fn ocr_progress_emitter(&self) -> OcrProgressEmitter {
        let bus = Arc::clone(&self.event_bus);
        Arc::new(move |event| {
            // A progress frame that will not serialize is dropped, not fatal;
            // the download itself is unaffected.
            if let Ok(payload) = serde_json::to_value(event) {
                bus.publish("ocr://download-progress".to_string(), payload);
            }
        })
    }

    /// A headless host has no Tauri runtime, so it publishes straight to the
    /// bus a remote client reads through `/ws/events`.
    fn publish_host_event(&self, topic: &str, payload: Value) {
        self.event_bus.publish(topic.to_string(), payload);
    }

    fn cognia_data_dir(&self) -> Result<PathBuf, String> {
        Ok(self.data_dir.clone())
    }

    fn workflow_state(&self) -> Option<&cognia_scheduling::workflow::WorkflowState> {
        Some(self.workflow.as_ref())
    }

    fn mcp_server(&self) -> &cognia_mcp_server::McpServerState {
        self.mcp_server.as_ref()
    }

    fn mcp_sidecar_path(&self) -> Option<PathBuf> {
        Some(crate::headless::resolve_mcp_sidecar_path())
    }

    fn mcp_orchestration_sink(
        &self,
    ) -> cognia_mcp_server::orchestration_proxy::OrchestrationEventSink {
        headless_orchestration_event_sink()
    }

    fn automation(&self) -> Option<HostAutomation<'_>> {
        None
    }

    fn mcp_automation_binding(&self) -> Option<cognia_mcp_server::AutomationBinding> {
        None
    }

    fn companion_server(&self) -> Option<&cognia_companion::CompanionServerState> {
        None
    }

    fn app_version(&self) -> String {
        // Synced with the app's version by `version:sync`.
        env!("CARGO_PKG_VERSION").to_string()
    }

    fn gateway(&self) -> Option<&cognia_gateway::GatewayState> {
        Some(self.gateway.as_ref())
    }

    fn gateway_event_host(
        &self,
        event_bus: Arc<EventBus>,
    ) -> Arc<dyn cognia_gateway::host::GatewayHost> {
        Arc::new(crate::gateway_host::HeadlessGatewayHost { event_bus })
    }

    fn pi_sidecar_dir(&self) -> Option<PathBuf> {
        cognia_sidecar::pi_extension::headless_sidecar_dir()
    }

    fn codex_app_host(&self) -> Option<Box<dyn cognia_codex_app::CodexAppHost + '_>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> Arc<HeadlessServices> {
        HeadlessServices::stub_for_tests()
    }

    fn spawn_config(placed: bool) -> ExternalAgentSpawnConfig {
        use cognia_external_agent::sandbox_routing_backend::SandboxPlacement;
        ExternalAgentSpawnConfig {
            id: "agent-1".into(),
            command: "codex".into(),
            args: vec!["acp".into()],
            cwd: None,
            env: Default::default(),
            framing: Default::default(),
            sandbox_policy: Default::default(),
            sandbox: placed.then(|| SandboxPlacement::Container {
                hosted_tool_host_lease_ids: Vec::new(),
                provider: None,
                workspace: None,
                spec: serde_json::json!({ "projectId": "prj1" }),
                isolation_mandatory: false,
            }),
        }
    }

    #[test]
    fn the_headless_host_is_object_safe_and_names_itself() {
        let host = host();
        let dyn_host: &dyn RpcHost = &host;
        assert_eq!(dyn_host.kind(), "headless");
        assert!(Arc::ptr_eq(dyn_host.headless().expect("headless"), &host));
        assert_eq!(dyn_host.data_dir().expect("data dir"), host.data_dir);
        assert_eq!(dyn_host.resource_dir(), None);
    }

    /// The headless registry owns every piece of host state a family
    /// addresses, and has none of the desktop-only runtimes.
    #[test]
    fn the_headless_accessors_hand_back_the_registry_s_own_instances() {
        let host = host();
        let dyn_host: &dyn RpcHost = &host;
        assert_eq!(dyn_host.cognia_data_dir().expect("data dir"), host.data_dir);
        assert!(std::ptr::eq(
            dyn_host.workflow_state().expect("workflow"),
            host.workflow.as_ref()
        ));
        assert!(std::ptr::eq(
            dyn_host.mcp_server(),
            host.mcp_server.as_ref()
        ));
        assert!(std::ptr::eq(
            dyn_host.gateway().expect("gateway"),
            host.gateway.as_ref()
        ));
        assert_eq!(
            dyn_host.mcp_sidecar_path(),
            Some(crate::headless::resolve_mcp_sidecar_path())
        );
        assert_eq!(dyn_host.app_version(), env!("CARGO_PKG_VERSION"));
        assert!(dyn_host.automation().is_none());
        assert!(dyn_host.mcp_automation_binding().is_none());
        assert!(dyn_host.companion_server().is_none());
        assert!(dyn_host.codex_app_host().is_none());
    }

    #[test]
    fn a_headless_gateway_publishes_on_the_bus_it_is_given() {
        let host = host();
        let bus = EventBus::new();
        assert!(host
            .gateway_event_host(Arc::clone(&bus))
            .emit("gateway://request-log", serde_json::json!({})));
        assert_eq!(bus.high_water_seq(), 1);
    }

    /// ADR-0216. A state key only means something where this host's process
    /// table runs the child; a container never sees the host's login roots.
    #[test]
    fn a_state_key_reaches_only_a_local_process_table() {
        assert!(state_key_reaches_host_process_table(
            &spawn_config(false),
            "local-process"
        ));
        assert!(!state_key_reaches_host_process_table(
            &spawn_config(true),
            "local-process"
        ));
        for kind in ["container", "workspace-runtime", "workspace-routing"] {
            assert!(!state_key_reaches_host_process_table(
                &spawn_config(false),
                kind
            ));
        }
    }

    #[test]
    fn a_headless_host_drops_a_state_key_it_cannot_honour() {
        let host = host();
        let mut config = spawn_config(true);
        config.env.insert(
            cognia_external_agent::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "cfg".into(),
        );
        let hardened = host
            .harden_spawn_config(config, host.exec_backend().as_ref())
            .expect("nothing to wrap");
        assert!(!hardened
            .env
            .contains_key(cognia_external_agent::state_isolation::AGENT_STATE_KEY_ENV));
    }

    /// The headless host confines through its `ExecBackend`, so a placed spawn
    /// reaches it byte for byte, including the placement the router reads.
    #[test]
    fn a_headless_host_hardens_a_placed_spawn_by_leaving_it_alone() {
        let host = host();
        let config = spawn_config(true);
        let hardened = host
            .harden_spawn_config(config.clone(), host.exec_backend().as_ref())
            .expect("nothing to wrap");
        assert_eq!(hardened.command, config.command);
        assert_eq!(hardened.args, config.args);
        assert!(hardened.sandbox.is_some());
    }

    #[test]
    fn host_events_and_agent_events_reach_the_bus() {
        let host = host();
        host.publish_host_event("host://probe", serde_json::json!({ "n": 1 }));
        host.agent_event_emitter()
            .emit("agent://probe", serde_json::json!({ "n": 2 }));
        let cognia_companion::event_bus::SubscribeResult::Ok { replay, .. } = host
            .event_bus
            .subscribe(Some(0), chrono::Utc::now().timestamp_millis())
        else {
            panic!("the bus replays what it retained");
        };
        let topics: Vec<_> = replay
            .iter()
            .map(|frame| frame.event_type.as_str())
            .collect();
        assert_eq!(topics, ["host://probe", "agent://probe"]);
    }

    #[tokio::test]
    async fn the_terminal_list_reads_the_test_registry_on_a_headless_host() {
        let host = host();
        assert!(host
            .terminal_list_all("dev-1")
            .await
            .expect("list")
            .is_empty());
        assert!(host
            .terminal_list_for_project("dev-1", "prj1")
            .await
            .expect("list")
            .is_empty());
    }
}
