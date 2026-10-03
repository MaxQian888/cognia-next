//! Headless services registry (ADR-0059 W4).
//!
//! When `cognia-server` runs without a Tauri runtime, the process-wide
//! services the RPC dispatch arms need are collected here instead of Tauri's
//! `app.state::<T>()`:
//!
//! - R7 (this slice): the sidecar supervisor (`SidecarState` +
//!   `HeadlessSidecarHost`) and the provider-env store (`ApiKeyState`) — the
//!   `claude_*` dispatch arms work headless.
//! - R8: the brain supervisor. R10: the exec backend. R12: connectors.
//!
//! Storage is the same module-global idiom as `companion_api`'s
//! `TLS_FINGERPRINT` / `data_plane::HEADLESS_STORE`: a process-wide slot
//! with install/read accessors, so the many `CompanionState` constructors
//! don't have to thread it.

pub use cognia_companion::backup;

use std::sync::Arc;

use parking_lot::RwLock;

use cognia_companion::event_bus::EventBus;
use cognia_sidecar::supervisor::SidecarState;

struct HeadlessWorkflowEmitter(Arc<EventBus>);

impl cognia_scheduling::workflow::TriggerEmitter for HeadlessWorkflowEmitter {
    fn emit(&self, event: cognia_scheduling::workflow::types::TriggerEvent) {
        if let Ok(payload) = serde_json::to_value(event) {
            self.0.publish("workflow:trigger".to_string(), payload);
        }
    }

    fn emit_integration_delivery_available(&self, route_id: &str, delivery_id: &str) {
        self.0.publish(
            "integration:delivery-available".to_string(),
            serde_json::json!({
                "routeId": route_id,
                "deliveryId": delivery_id,
            }),
        );
    }
}

pub const VSCODE_EXT_HOST_SCRIPT_ENV: &str = "COGNIA_VSCODE_EXT_HOST_SCRIPT";
pub const VSCODE_EXT_HOST_NODE_ENV: &str = "COGNIA_VSCODE_EXT_HOST_NODE";

fn resolve_vscode_ext_host_script() -> std::path::PathBuf {
    if let Some(explicit) = std::env::var_os(VSCODE_EXT_HOST_SCRIPT_ENV) {
        return explicit.into();
    }
    if let Some(brain_entry) = std::env::var_os("COGNIA_BRAIN_ENTRY") {
        let brain_entry = std::path::PathBuf::from(brain_entry);
        if let Some(parent) = brain_entry.parent() {
            return parent
                .join("sidecar")
                .join("vscode-ext-host")
                .join("dist")
                .join("host.js");
        }
    }
    std::env::current_dir()
        .unwrap_or_default()
        .join("sidecar")
        .join("vscode-ext-host")
        .join("dist")
        .join("host.js")
}

pub use crate::mcp_oauth::{resolve_mcp_sidecar_path, MCP_SIDECAR_PATH_ENV};

// Re-exports for the `cognia-server` binary (the `api_key` / `claude` /
// `secret_store` modules are crate-private; this module is the headless
// boot surface). The `pub use` also brings the names into scope here.
pub use crate::sidecar_runtime::{HeadlessSidecarHost, SidecarHost, SIDECAR_SCRIPT_ENV};
pub use cognia_connectors::state::ConnectorsState;
pub use cognia_external_agent::container_backend::exec_backend_from_env;
pub use cognia_external_agent::presets::SpawnPolicy;
pub use cognia_secrets::api_key::ApiKeyState;
pub use cognia_secrets::secret_store::{
    generate_master_key, init_headless as init_secret_store, parse_master_key,
    resolve_master_key_from_env, rotate_master_key, MASTER_KEY_ENV, MASTER_KEY_FILE_ENV,
};
pub use cognia_sidecar::supervisor::kill_sidecar;
pub use cognia_sidecar::supervisor::spawn as spawn_sidecar;

const ACCOUNT_CONTENT_KEY_SERVICE: &str = "com.cognia.account-content";

/// Resolve the stable DEK injected into the headless brain. The value lives in
/// the server's encrypted secret store, so rotating the store master key
/// re-wraps this key without changing the content-encryption identity.
pub fn get_or_create_account_content_key(local_account_id: &str) -> Result<String, String> {
    let local_account_id = local_account_id.trim();
    if local_account_id.is_empty() {
        return Err("account content key requires a non-empty account id".to_string());
    }
    if let Some(stored) =
        cognia_secrets::secret_store::get(ACCOUNT_CONTENT_KEY_SERVICE, local_account_id)?
    {
        parse_master_key(&stored)
            .map_err(|error| format!("stored account content key is invalid: {error}"))?;
        return Ok(stored);
    }

    let encoded = hex::encode(generate_master_key());
    cognia_secrets::secret_store::set(ACCOUNT_CONTENT_KEY_SERVICE, local_account_id, &encoded)?;
    Ok(encoded)
}

/// Service container for the headless (no-Tauri) host. The `cognia-server`
/// binary constructs one at boot (R8) and installs it process-wide; the
/// dispatch arms reach it through `DispatchHost::Headless`.
pub struct HeadlessServices {
    /// Canonical process-owned data directory. Host-side configuration and
    /// transactional staging must derive from this path rather than from a
    /// connected controller's filesystem.
    pub data_dir: std::path::PathBuf,
    /// Sidecar supervisor state — same struct Tauri manages on desktop.
    pub sidecar: SidecarState,
    /// The sidecar's host seam (script resolution, env injection, event
    /// emission into the EventBus).
    pub sidecar_host: Arc<dyn SidecarHost>,
    /// Provider-env store fed by the `claude_set_*` RPC arms.
    pub api_keys: ApiKeyState,
    /// Embedded MCP server lifecycle state. The status surface is host-neutral;
    /// future start/stop wiring can reuse this same process-owned instance.
    pub mcp_server: Arc<cognia_mcp_server::McpServerState>,
    /// Lazily initialized native OCR registry. Backend registration is async,
    /// so the headless container owns it behind a OnceCell rather than racing
    /// server boot with a detached initializer task.
    ocr_registry: tokio::sync::OnceCell<cognia_ocr::NativeOcrRegistry>,
    /// Native plugin install/snapshot/backup service shared by every companion
    /// RPC arm. The Node brain observes the same install directory.
    pub plugin_runtime: Arc<cognia_plugin_runtime::PluginRuntimeState>,
    /// Process-owned WASM Component host. This is the same state type Tauri
    /// manages; only its owner changes when there is no WebView.
    pub wasm_plugins: Arc<cognia_plugin_runtime::wasm::WasmPluginState>,
    /// Existing per-plugin Python subprocess host, owned by cognia-server when
    /// no Tauri state manager exists. Events are bridged onto `event_bus`.
    pub python_plugins: Arc<cognia_plugin_runtime::python::PythonRuntimeState>,
    /// Existing VS Code extension sidecar registry, configured with a
    /// server-owned host script and bridged onto the companion event bus.
    pub vscode_plugins: Arc<cognia_plugin_runtime::vscode::VscodeExtensionState>,
    /// Pinned code-server lifecycle and device-bound relay owned entirely by
    /// this remote host. The paired desktop cannot install or upgrade it.
    pub code_server: Arc<cognia_codeserver::remote::RemoteCodeServerState>,
    /// The companion event bus — every host-emitted event rides
    /// `/ws/v1/events` from here.
    pub event_bus: Arc<EventBus>,
    /// Execution plane for external agents (ADR-0059 R10). Local processes
    /// in Phase 1; `ExecBackend::Container` swaps in at T2 (R13).
    pub exec: Arc<dyn cognia_external_agent::exec_backend::ExecBackend>,
    /// Preset allowlist gating the RCE-grade `spawn_external_agent` RPC arm
    /// (ADR-0059 R11).
    pub spawn_policy: cognia_external_agent::presets::SpawnPolicy,
    /// Connector adapter registry backing the public `/connectors` webhook
    /// ingress on the front door (ADR-0059 F4/R12). Adapters are registered
    /// by the brain via the service-scope `connectors_register` arm.
    pub connectors: ConnectorsState,
    /// Host-neutral workflow timing, webhook ingress, and encrypted
    /// Integration spool. Desktop owns the same state through Tauri.
    pub workflow: Arc<cognia_scheduling::workflow::WorkflowState>,
    /// ADR-0090 Phase 1 — the headless Provider Profile Store (same-port
    /// SQLite mirror of the renderer's Dexie v121 tables). Feeds the Phase 2
    /// Gateway snapshot projection; secret-free by construction.
    pub profiles: Arc<dyn cognia_agent_state::provider_profiles::ProviderProfileStore>,
    /// ADR-0090 Phase 2 — the SAME Gateway crate/state the desktop manages,
    /// started by `cognia-server` when enabled. Snapshots come from the
    /// profile-store projection (authority: profile-store), not a renderer.
    pub gateway: Arc<cognia_gateway::GatewayState>,
    /// Hermetic terminal inventory used by headless dispatch tests. Production
    /// builds omit this seam and always reach the durable terminal host.
    #[cfg(any(test, feature = "test-support"))]
    pub terminal_sessions_for_tests:
        tokio::sync::RwLock<Vec<cognia_terminal::host::HostSessionInfo>>,
}

impl HeadlessServices {
    pub fn new(
        sidecar_host: Arc<dyn SidecarHost>,
        api_keys: ApiKeyState,
        event_bus: Arc<EventBus>,
        spawn_policy: cognia_external_agent::presets::SpawnPolicy,
        plugin_install_dir: std::path::PathBuf,
    ) -> Result<Arc<Self>, String> {
        Self::new_with_exec(
            sidecar_host,
            api_keys,
            event_bus,
            spawn_policy,
            cognia_external_agent::exec_backend::LocalProcessBackend::new(),
            plugin_install_dir,
        )
    }

    /// Like [`Self::new`] but with an explicit execution plane — the T2
    /// server boot passes the env-resolved backend
    /// ([`exec_backend_from_env`]) so `COGNIA_EXEC_BACKEND=container` routes
    /// external agents into per-workspace runner containers (R13).
    pub fn new_with_exec(
        sidecar_host: Arc<dyn SidecarHost>,
        api_keys: ApiKeyState,
        event_bus: Arc<EventBus>,
        spawn_policy: cognia_external_agent::presets::SpawnPolicy,
        exec: Arc<dyn cognia_external_agent::exec_backend::ExecBackend>,
        plugin_install_dir: std::path::PathBuf,
    ) -> Result<Arc<Self>, String> {
        let data_dir = plugin_install_dir
            .parent()
            .unwrap_or(plugin_install_dir.as_path())
            .to_path_buf();
        let workflow_dir = data_dir.join("cognia");
        std::fs::create_dir_all(&workflow_dir).map_err(|error| {
            format!(
                "create headless workflow directory {}: {error}",
                workflow_dir.display()
            )
        })?;
        let workflow_emitter = Arc::new(HeadlessWorkflowEmitter(Arc::clone(&event_bus)));
        let workflow_state_emitter: Arc<dyn cognia_scheduling::workflow::TriggerEmitter> =
            workflow_emitter.clone();
        let workflow = Arc::new(
            cognia_scheduling::workflow::WorkflowState::open(
                cognia_scheduling::workflow::default_mirror_path(&data_dir),
                workflow_state_emitter,
            )
            .map_err(|error| format!("open headless workflow state: {error}"))?,
        );
        if !cfg!(any(test, feature = "test-support")) {
            let runtime = tokio::runtime::Handle::try_current().map_err(|error| {
                format!("headless workflow runtime requires an active Tokio runtime: {error}")
            })?;
            runtime.spawn(workflow.cron.clone().run_loop());
            let webhook = workflow.webhook.clone();
            runtime.spawn(async move {
                if let Err(error) = webhook.start(workflow_emitter, 0).await {
                    log::warn!("headless workflow webhook router start failed: {error}");
                }
            });
        }
        let python_dir = plugin_install_dir
            .parent()
            .unwrap_or(plugin_install_dir.as_path())
            .join("python");
        let python_plugins = Arc::new(cognia_plugin_runtime::python::PythonRuntimeState::new(
            python_dir,
        ));
        let python_event_bus = Arc::clone(&event_bus);
        *python_plugins.event_sink.write() =
            Some(Arc::new(move |event| match serde_json::to_value(event) {
                Ok(payload) => {
                    python_event_bus.publish(
                        cognia_plugin_runtime::python::events::PYTHON_EVENT.to_string(),
                        payload,
                    );
                }
                Err(error) => log::warn!("serialize headless Python plugin event: {error}"),
            }));
        // Plugin -> host RPC (ADR-0145) rides the same bus. Without this a
        // headless python plugin's `ctx.*` call is refused rather than routed:
        // the Rust side has a sink only when someone registers one, and the
        // Tauri registration lives in the command layer this host never runs.
        let python_host_request_bus = Arc::clone(&event_bus);
        *python_plugins.host_request_sink.write() = Some(Arc::new(move |request| {
            match serde_json::to_value(request) {
                Ok(payload) => {
                    python_host_request_bus.publish(
                        cognia_plugin_runtime::python::events::PYTHON_HOST_REQUEST_EVENT
                            .to_string(),
                        payload,
                    );
                }
                Err(error) => {
                    log::warn!("serialize headless Python host request: {error}")
                }
            }
        }));
        let vscode_dir =
            cognia_plugin_runtime::vscode::extension_install_dir_for(&plugin_install_dir);
        let vscode_plugins = Arc::new(cognia_plugin_runtime::vscode::VscodeExtensionState::new(
            vscode_dir,
        ));
        let code_server = cognia_codeserver::remote::RemoteCodeServerState::new(data_dir.clone());
        cognia_codeserver::agent_channel::global().attach_event_bus(Arc::clone(&event_bus));
        let vscode_event_bus = Arc::clone(&event_bus);
        vscode_plugins.configure_host(
            resolve_vscode_ext_host_script(),
            std::env::var(VSCODE_EXT_HOST_NODE_ENV).ok(),
            Arc::new(move |event_name, raw_frame| {
                vscode_event_bus.publish(event_name, serde_json::Value::String(raw_frame));
            }),
        );
        // The profile store lives beside the plugin install dir (its parent is
        // the server data dir). An open failure degrades to an in-memory
        // store rather than failing boot — the store is a re-derivable
        // projection, and import re-seeds it.
        let profiles_path = plugin_install_dir
            .parent()
            .unwrap_or(plugin_install_dir.as_path())
            .join("provider-profiles.sqlite");
        let profiles: Arc<dyn cognia_agent_state::provider_profiles::ProviderProfileStore> =
            match cognia_agent_state::provider_profiles::SqliteProfileStore::open(&profiles_path) {
                Ok(store) => store,
                Err(error) => {
                    log::warn!(
                        "open provider profile store at {}: {error}; using in-memory store",
                        profiles_path.display()
                    );
                    // An in-memory SQLite that will not open means the process
                    // is out of memory or the driver is broken; reporting that
                    // beats aborting from inside a degradation path.
                    cognia_agent_state::provider_profiles::SqliteProfileStore::in_memory().map_err(
                        |error| format!("open in-memory provider profile store: {error}"),
                    )?
                }
            };
        Ok(Arc::new(Self {
            data_dir,
            sidecar: SidecarState::new(),
            sidecar_host,
            api_keys,
            gateway: Arc::new(cognia_gateway::GatewayState::new()),
            mcp_server: Arc::new(cognia_mcp_server::McpServerState::new()),
            ocr_registry: tokio::sync::OnceCell::new(),
            plugin_runtime: Arc::new(cognia_plugin_runtime::PluginRuntimeState::new(
                plugin_install_dir,
            )),
            wasm_plugins: Arc::new(cognia_plugin_runtime::wasm::WasmPluginState::default()),
            python_plugins,
            vscode_plugins,
            code_server,
            event_bus,
            exec,
            spawn_policy,
            connectors: ConnectorsState::new(),
            workflow,
            profiles,
            #[cfg(any(test, feature = "test-support"))]
            terminal_sessions_for_tests: tokio::sync::RwLock::new(Vec::new()),
        }))
    }

    /// Return the process-owned OCR registry after installing every backend
    /// compiled into this server artifact.
    pub async fn ocr_registry(&self) -> &cognia_ocr::NativeOcrRegistry {
        self.ocr_registry
            .get_or_init(|| async {
                let registry = cognia_ocr::NativeOcrRegistry::new();
                cognia_ocr::backend::install_server_backends(&registry).await;
                registry
            })
            .await
    }

    /// A registry with a never-resolving sidecar script — for dispatch tests
    /// that need a headless host but never actually spawn the sidecar. The
    /// spawn policy points at a per-process temp workspaces dir with the
    /// smoke stub disabled.
    #[cfg(any(test, feature = "test-support"))]
    pub fn stub_for_tests() -> Arc<Self> {
        use crate::sidecar_runtime::HeadlessSidecarHost;
        let event_bus = EventBus::new();
        let api_keys = ApiKeyState::new();
        let sidecar_host = Arc::new(HeadlessSidecarHost::new(
            std::path::PathBuf::from("cognia-headless-test-missing.mjs"),
            Arc::clone(&event_bus),
            api_keys.clone(),
        ));
        let workspaces =
            std::env::temp_dir().join(format!("cognia-test-workspaces-{}", std::process::id()));
        Self::new(
            sidecar_host,
            api_keys,
            event_bus,
            cognia_external_agent::presets::SpawnPolicy::new(workspaces, false),
            // Nested under a per-process dir so the sibling
            // provider-profiles.sqlite (derived from the plugin dir's PARENT)
            // stays test-isolated instead of landing in the shared temp root.
            std::env::temp_dir()
                .join(format!("cognia-headless-test-{}", std::process::id()))
                .join("plugins"),
        )
        // Absorbed here so the ~20 test call sites stay a plain `Arc<Self>`:
        // a construction failure under a temp dir is a broken test env, not a
        // condition any of them is written to handle.
        .expect("headless test stub")
    }
}

static SERVICES: RwLock<Option<Arc<HeadlessServices>>> = RwLock::new(None);

/// Install (or clear with `None`) the process-wide headless services.
/// Called by the `cognia-server` binary at boot (R8), before the axum
/// server spawns. Idempotent.
pub fn install_headless_services(services: Option<Arc<HeadlessServices>>) {
    crate::codeserver_host::install_host();
    // The companion core reads these services through its runtime slot; set
    // and clear it in the same call so the two can never disagree.
    match &services {
        Some(services) => {
            cognia_companion::runtime::HEADLESS.set(Arc::clone(services) as _);
        }
        None => {
            cognia_companion::runtime::HEADLESS.clear();
        }
    }
    // The hooks runtime merges this process's plugin `commandHooks` through
    // its host. Unit-test states never had that layer, so tests install none.
    // Fleet snapshots project tenants through the companion core the same way.
    #[cfg(not(any(test, feature = "test-support")))]
    if let Some(services) = &services {
        cognia_companion::fleet_view::install_companion_view();
        cognia_hooks::host::HOST.set(Arc::new(
            cognia_plugin_runtime::command_hooks::HeadlessHooksHost(Arc::clone(
                &services.plugin_runtime,
            )),
        ));
    }
    *SERVICES.write() = services;
}

#[async_trait::async_trait]
impl cognia_companion::runtime::HeadlessRuntime for HeadlessServices {
    async fn sidecar_ready(&self) -> bool {
        self.sidecar.is_ready().await
    }

    fn sidecar_restart_count(&self) -> u64 {
        self.sidecar.restart_count()
    }

    fn gateway_enabled(&self) -> bool {
        self.gateway.config().enabled
    }

    fn gateway_running(&self) -> bool {
        self.gateway.status().running
    }

    fn gateway_health(&self) -> serde_json::Value {
        let gateway_status = self.gateway.status();
        let now_ms = chrono::Utc::now().timestamp_millis();
        serde_json::json!({
            "running": gateway_status.running,
            "boundPort": gateway_status.bound_port,
            "snapshotGeneratedAtMs": gateway_status.snapshot_generated_at_ms,
            "snapshotProviderCount": gateway_status.snapshot_provider_count,
            "profileVersion": self.profiles.profile_version().ok(),
            "activeTickets": self.gateway.tickets.active_count(now_ms),
        })
    }

    fn resolve_orchestration_reply(
        &self,
        id: &str,
        reply: cognia_mcp_server::orchestration_proxy::OrchestrationReply,
    ) {
        self.mcp_server.resolve_orchestration_reply(id, reply);
    }

    fn connectors(&self) -> ConnectorsState {
        self.connectors.clone()
    }

    fn event_bus(&self) -> Arc<EventBus> {
        Arc::clone(&self.event_bus)
    }

    // `gen-companion-api.mjs` reads these routes into the route contract, and
    // it recognizes the bare `get(`/`post(` spelling.
    fn mcp_oauth_routes(&self) -> axum::Router<cognia_companion::SharedState> {
        use axum::routing::get;
        axum::Router::new().route(
            "/oauth/callback",
            get(crate::mcp_oauth::headless_callback_handler),
        )
    }

    fn ide_content_routes(&self) -> axum::Router<cognia_companion::SharedState> {
        use axum::routing::{get, post};
        axum::Router::new()
            .route(
                "/ide/content",
                post(cognia_codeserver::content_bridge::upload_content),
            )
            .route(
                "/ide/content/{handle_id}",
                get(cognia_codeserver::content_bridge::redeem_content),
            )
    }
}

/// The installed headless services, if any. `None` on desktop and in
/// unit-test states.
pub fn headless_services() -> Option<Arc<HeadlessServices>> {
    SERVICES.read().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_content_key_is_stable_and_account_scoped() {
        let first = get_or_create_account_content_key("headless-content-test-a").unwrap();
        let repeated = get_or_create_account_content_key("headless-content-test-a").unwrap();
        let other = get_or_create_account_content_key("headless-content-test-b").unwrap();

        assert_eq!(first.len(), 64);
        assert_eq!(first, repeated);
        assert_ne!(first, other);
        assert!(get_or_create_account_content_key(" ").is_err());
    }

    /// A sidecar host that never resolves its script — enough to construct the
    /// services without spawning anything.
    fn stub_sidecar_host(event_bus: Arc<EventBus>, api_keys: ApiKeyState) -> Arc<dyn SidecarHost> {
        Arc::new(crate::sidecar_runtime::HeadlessSidecarHost::new(
            std::path::PathBuf::from("cognia-headless-test-missing.mjs"),
            event_bus,
            api_keys,
        ))
    }

    fn construct_under(
        plugin_install_dir: std::path::PathBuf,
    ) -> Result<Arc<HeadlessServices>, String> {
        let event_bus = EventBus::new();
        let api_keys = ApiKeyState::new();
        HeadlessServices::new(
            stub_sidecar_host(Arc::clone(&event_bus), api_keys.clone()),
            api_keys,
            event_bus,
            cognia_external_agent::presets::SpawnPolicy::new(
                std::env::temp_dir().join("cognia-headless-ctor-test-ws"),
                false,
            ),
            plugin_install_dir,
        )
    }

    #[tokio::test]
    async fn construction_reports_an_unusable_data_dir_instead_of_aborting() {
        // The data dir is the plugin dir's PARENT, so pointing the plugin dir
        // under a regular file makes `create_dir_all` fail. This used to
        // `panic!` straight out of `cognia-server`'s boot path, taking the
        // process down instead of printing which directory was at fault.
        let tmp = tempfile::tempdir().expect("tempdir");
        let blocker = tmp.path().join("blocker");
        std::fs::write(&blocker, b"not a directory").expect("write blocker");

        // `expect_err` would need `Arc<HeadlessServices>: Debug`, which it is
        // not — match instead of deriving Debug on a struct full of runtimes.
        let error = match construct_under(blocker.join("data").join("plugins")) {
            Ok(_) => panic!("an unusable data dir must not construct successfully"),
            Err(error) => error,
        };

        assert!(
            error.starts_with("create headless workflow directory "),
            "the message must name the subsystem and the path so \
             `headless services: {{error}}` reads usefully: {error}"
        );
    }

    #[tokio::test]
    async fn construction_succeeds_under_a_healthy_data_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let services = construct_under(tmp.path().join("data").join("plugins"))
            .expect("a healthy data dir must construct");

        assert!(tmp.path().join("data").join("cognia").is_dir());
        assert!(!services.mcp_server.status().running);
    }

    #[tokio::test]
    async fn install_and_clear_round_trip() {
        // Process-global slot — serialize with the other global-slot tests
        // (healthz's headless-shape test installs here too).
        let _guard = cognia_companion::ws_bridge::test_support::lock_slot().await;
        install_headless_services(Some(HeadlessServices::stub_for_tests()));
        assert!(headless_services().is_some());
        install_headless_services(None);
        assert!(headless_services().is_none());
    }

    #[tokio::test]
    async fn stub_registry_exposes_working_api_keys_and_bus() {
        let services = HeadlessServices::stub_for_tests();
        services.api_keys.set(Some("sk-headless".into())).await;
        assert_eq!(
            services.api_keys.get().await.as_deref(),
            Some("sk-headless")
        );
        assert!(!services.sidecar.is_ready().await);
        assert!(!services.mcp_server.status().running);
        // The sidecar host publishes into the same bus the registry exposes.
        services
            .sidecar_host
            .emit("claude://message", &serde_json::json!({ "type": "x" }));
        // (Publish is fire-and-forget; the frame lands in the bus's ring.)
        let now_ms = 0;
        match services.event_bus.subscribe(Some(0), now_ms) {
            cognia_companion::event_bus::SubscribeResult::Ok { replay, .. } => {
                assert_eq!(replay.len(), 1);
                assert_eq!(replay[0].event_type, "claude://message");
            }
            _ => panic!("subscribe failed"),
        }
    }

    #[tokio::test]
    async fn python_subprocess_events_bridge_to_the_companion_bus() {
        let services = HeadlessServices::stub_for_tests();
        let sink = services.python_plugins.sink().expect("Python event sink");
        sink(cognia_plugin_runtime::python::events::PythonEvent {
            generation: "system".to_string(),
            plugin_id: "demo".into(),
            kind: "log".into(),
            call_id: None,
            data: serde_json::json!({ "line": "ready" }),
        });

        match services.event_bus.subscribe(Some(0), 0) {
            cognia_companion::event_bus::SubscribeResult::Ok { replay, .. } => {
                assert_eq!(replay.len(), 1);
                assert_eq!(replay[0].event_type, "plugin:python");
                assert_eq!(replay[0].payload["pluginId"], "demo");
                assert_eq!(replay[0].payload["data"]["line"], "ready");
            }
            _ => panic!("subscribe failed"),
        }
    }

    #[tokio::test]
    async fn vscode_sidecar_frames_bridge_to_the_companion_bus() {
        let services = HeadlessServices::stub_for_tests();
        services.vscode_plugins.emit_rpc_frame(
            "vscode://rpc/publisher_ext".into(),
            r#"{"jsonrpc":"2.0","method":"commands:register"}"#.into(),
        );

        match services.event_bus.subscribe(Some(0), 0) {
            cognia_companion::event_bus::SubscribeResult::Ok { replay, .. } => {
                assert_eq!(replay.len(), 1);
                assert_eq!(replay[0].event_type, "vscode://rpc/publisher_ext");
                assert_eq!(
                    replay[0].payload,
                    serde_json::Value::String(
                        r#"{"jsonrpc":"2.0","method":"commands:register"}"#.into()
                    )
                );
            }
            _ => panic!("subscribe failed"),
        }
    }

    #[tokio::test]
    async fn ocr_registry_is_lazy_and_reports_compiled_backends() {
        let services = HeadlessServices::stub_for_tests();
        assert!(services.ocr_registry.get().is_none());
        let registry = services.ocr_registry().await;
        assert!(services.ocr_registry.get().is_some());
        assert!(!registry.list_ids().await.is_empty());
        let available = registry.available_ids().await;
        assert!(!available.contains(&"apple-vision"));
        assert!(!available.contains(&"windows-media-ocr"));
    }
}
