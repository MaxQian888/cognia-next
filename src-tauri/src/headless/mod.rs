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

pub mod backup;
pub mod brain;
pub mod gateway_host;
pub mod tenant_lease;

use std::sync::Arc;

use parking_lot::RwLock;

use crate::claude::SidecarState;
use crate::companion_api::event_bus::EventBus;

struct HeadlessWorkflowEmitter(Arc<EventBus>);

impl crate::workflow::TriggerEmitter for HeadlessWorkflowEmitter {
    fn emit(&self, event: crate::workflow::types::TriggerEvent) {
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
pub const MCP_SIDECAR_PATH_ENV: &str = "COGNIA_MCP_SIDECAR_PATH";

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

pub fn resolve_mcp_sidecar_path() -> std::path::PathBuf {
    resolve_mcp_sidecar_path_from(
        std::env::var_os(MCP_SIDECAR_PATH_ENV),
        std::env::var_os("COGNIA_BRAIN_ENTRY"),
        std::env::current_dir().unwrap_or_default(),
    )
}

fn resolve_mcp_sidecar_path_from(
    explicit: Option<std::ffi::OsString>,
    brain_entry: Option<std::ffi::OsString>,
    current_dir: std::path::PathBuf,
) -> std::path::PathBuf {
    if let Some(explicit) = explicit {
        return explicit.into();
    }
    if let Some(brain_entry) = brain_entry {
        if let Some(parent) = std::path::Path::new(&brain_entry).parent() {
            return parent.join("sidecar").join("cognia-mcp.mjs");
        }
    }
    current_dir.join("sidecar").join("cognia-mcp.mjs")
}

// Re-exports for the `cognia-server` binary (the `api_key` / `claude` /
// `secret_store` modules are crate-private; this module is the headless
// boot surface). The `pub use` also brings the names into scope here.
pub use crate::api_key::ApiKeyState;
pub use crate::claude::host::{HeadlessSidecarHost, SidecarHost, SIDECAR_SCRIPT_ENV};
pub use crate::claude::sidecar::kill_sidecar;
pub use crate::claude::sidecar::spawn as spawn_sidecar;
pub use crate::connectors::state::ConnectorsState;
pub use crate::external_agent::container_backend::exec_backend_from_env;
pub use crate::external_agent::presets::SpawnPolicy;
pub use crate::secret_store::{
    generate_master_key, init_headless as init_secret_store, parse_master_key,
    resolve_master_key_from_env, rotate_master_key, MASTER_KEY_ENV, MASTER_KEY_FILE_ENV,
};

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
    pub mcp_server: Arc<crate::mcp_server::McpServerState>,
    /// Lazily initialized native OCR registry. Backend registration is async,
    /// so the headless container owns it behind a OnceCell rather than racing
    /// server boot with a detached initializer task.
    ocr_registry: tokio::sync::OnceCell<crate::ocr::NativeOcrRegistry>,
    /// Native plugin install/snapshot/backup service shared by every companion
    /// RPC arm. The Node brain observes the same install directory.
    pub plugin_runtime: Arc<crate::plugin_api::PluginRuntimeState>,
    /// Process-owned WASM Component host. This is the same state type Tauri
    /// manages; only its owner changes when there is no WebView.
    pub wasm_plugins: Arc<crate::plugin_api::wasm::WasmPluginState>,
    /// Existing per-plugin Python subprocess host, owned by cognia-server when
    /// no Tauri state manager exists. Events are bridged onto `event_bus`.
    pub python_plugins: Arc<crate::plugin_api::python::PythonRuntimeState>,
    /// Existing VS Code extension sidecar registry, configured with a
    /// server-owned host script and bridged onto the companion event bus.
    pub vscode_plugins: Arc<crate::plugin_api::vscode::VscodeExtensionState>,
    /// Pinned code-server lifecycle and device-bound relay owned entirely by
    /// this remote host. The paired desktop cannot install or upgrade it.
    pub code_server: Arc<crate::codeserver::remote::RemoteCodeServerState>,
    /// The companion event bus — every host-emitted event rides
    /// `/ws/v1/events` from here.
    pub event_bus: Arc<EventBus>,
    /// Execution plane for external agents (ADR-0059 R10). Local processes
    /// in Phase 1; `ExecBackend::Container` swaps in at T2 (R13).
    pub exec: Arc<dyn crate::external_agent::exec_backend::ExecBackend>,
    /// Preset allowlist gating the RCE-grade `spawn_external_agent` RPC arm
    /// (ADR-0059 R11).
    pub spawn_policy: crate::external_agent::presets::SpawnPolicy,
    /// Connector adapter registry backing the public `/connectors` webhook
    /// ingress on the front door (ADR-0059 F4/R12). Adapters are registered
    /// by the brain via the service-scope `connectors_register` arm.
    pub connectors: ConnectorsState,
    /// Host-neutral workflow timing, webhook ingress, and encrypted
    /// Integration spool. Desktop owns the same state through Tauri.
    pub workflow: Arc<crate::workflow::WorkflowState>,
    /// ADR-0090 Phase 1 — the headless Provider Profile Store (same-port
    /// SQLite mirror of the renderer's Dexie v121 tables). Feeds the Phase 2
    /// Gateway snapshot projection; secret-free by construction.
    pub profiles: Arc<dyn crate::provider_profiles::ProviderProfileStore>,
    /// ADR-0090 Phase 2 — the SAME Gateway crate/state the desktop manages,
    /// started by `cognia-server` when enabled. Snapshots come from the
    /// profile-store projection (authority: profile-store), not a renderer.
    pub gateway: Arc<crate::gateway::GatewayState>,
    /// Hermetic terminal inventory used by headless dispatch tests. Production
    /// builds omit this seam and always reach the durable terminal host.
    #[cfg(test)]
    pub terminal_sessions_for_tests:
        tokio::sync::RwLock<Vec<cognia_terminal::host::HostSessionInfo>>,
}

impl HeadlessServices {
    pub fn new(
        sidecar_host: Arc<dyn SidecarHost>,
        api_keys: ApiKeyState,
        event_bus: Arc<EventBus>,
        spawn_policy: crate::external_agent::presets::SpawnPolicy,
        plugin_install_dir: std::path::PathBuf,
    ) -> Result<Arc<Self>, String> {
        Self::new_with_exec(
            sidecar_host,
            api_keys,
            event_bus,
            spawn_policy,
            crate::external_agent::exec_backend::LocalProcessBackend::new(),
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
        spawn_policy: crate::external_agent::presets::SpawnPolicy,
        exec: Arc<dyn crate::external_agent::exec_backend::ExecBackend>,
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
        let workflow_state_emitter: Arc<dyn crate::workflow::TriggerEmitter> =
            workflow_emitter.clone();
        let workflow = Arc::new(
            crate::workflow::WorkflowState::open(
                crate::workflow::default_mirror_path(&data_dir),
                workflow_state_emitter,
            )
            .map_err(|error| format!("open headless workflow state: {error}"))?,
        );
        if !cfg!(test) {
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
        let python_plugins = Arc::new(crate::plugin_api::python::PythonRuntimeState::new(
            python_dir,
        ));
        let python_event_bus = Arc::clone(&event_bus);
        *python_plugins.event_sink.write() =
            Some(Arc::new(move |event| match serde_json::to_value(event) {
                Ok(payload) => {
                    python_event_bus.publish(
                        crate::plugin_api::python::events::PYTHON_EVENT.to_string(),
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
                        crate::plugin_api::python::events::PYTHON_HOST_REQUEST_EVENT.to_string(),
                        payload,
                    );
                }
                Err(error) => {
                    log::warn!("serialize headless Python host request: {error}")
                }
            }
        }));
        let vscode_dir = plugin_install_dir
            .parent()
            .unwrap_or(plugin_install_dir.as_path())
            .join("vscode-extensions");
        let vscode_plugins = Arc::new(crate::plugin_api::vscode::VscodeExtensionState::new(
            vscode_dir,
        ));
        let code_server = crate::codeserver::remote::RemoteCodeServerState::new(data_dir.clone());
        crate::codeserver::agent_channel::global().attach_event_bus(Arc::clone(&event_bus));
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
        let profiles: Arc<dyn crate::provider_profiles::ProviderProfileStore> =
            match crate::provider_profiles::SqliteProfileStore::open(&profiles_path) {
                Ok(store) => store,
                Err(error) => {
                    log::warn!(
                        "open provider profile store at {}: {error}; using in-memory store",
                        profiles_path.display()
                    );
                    // An in-memory SQLite that will not open means the process
                    // is out of memory or the driver is broken; reporting that
                    // beats aborting from inside a degradation path.
                    crate::provider_profiles::SqliteProfileStore::in_memory().map_err(|error| {
                        format!("open in-memory provider profile store: {error}")
                    })?
                }
            };
        Ok(Arc::new(Self {
            data_dir,
            sidecar: SidecarState::new(),
            sidecar_host,
            api_keys,
            gateway: Arc::new(crate::gateway::GatewayState::new()),
            mcp_server: Arc::new(crate::mcp_server::McpServerState::new()),
            ocr_registry: tokio::sync::OnceCell::new(),
            plugin_runtime: Arc::new(crate::plugin_api::PluginRuntimeState::new(
                plugin_install_dir,
            )),
            wasm_plugins: Arc::new(crate::plugin_api::wasm::WasmPluginState::default()),
            python_plugins,
            vscode_plugins,
            code_server,
            event_bus,
            exec,
            spawn_policy,
            connectors: ConnectorsState::new(),
            workflow,
            profiles,
            #[cfg(test)]
            terminal_sessions_for_tests: tokio::sync::RwLock::new(Vec::new()),
        }))
    }

    /// Return the process-owned OCR registry after installing every backend
    /// compiled into this server artifact.
    pub async fn ocr_registry(&self) -> &crate::ocr::NativeOcrRegistry {
        self.ocr_registry
            .get_or_init(|| async {
                let registry = crate::ocr::NativeOcrRegistry::new();
                crate::ocr::backend::install_server_backends(&registry).await;
                registry
            })
            .await
    }

    /// A registry with a never-resolving sidecar script — for dispatch tests
    /// that need a headless host but never actually spawn the sidecar. The
    /// spawn policy points at a per-process temp workspaces dir with the
    /// smoke stub disabled.
    #[cfg(test)]
    pub fn stub_for_tests() -> Arc<Self> {
        use crate::claude::host::HeadlessSidecarHost;
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
            crate::external_agent::presets::SpawnPolicy::new(workspaces, false),
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
    *SERVICES.write() = services;
}

/// The installed headless services, if any. `None` on desktop and in
/// unit-test states.
pub fn headless_services() -> Option<Arc<HeadlessServices>> {
    SERVICES.read().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sidecar host that never resolves its script — enough to construct the
    /// services without spawning anything.
    fn stub_sidecar_host(event_bus: Arc<EventBus>, api_keys: ApiKeyState) -> Arc<dyn SidecarHost> {
        Arc::new(crate::claude::host::HeadlessSidecarHost::new(
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
            crate::external_agent::presets::SpawnPolicy::new(
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
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
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
            crate::companion_api::event_bus::SubscribeResult::Ok { replay, .. } => {
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
        sink(crate::plugin_api::python::events::PythonEvent {
            generation: "system".to_string(),
            plugin_id: "demo".into(),
            kind: "log".into(),
            call_id: None,
            data: serde_json::json!({ "line": "ready" }),
        });

        match services.event_bus.subscribe(Some(0), 0) {
            crate::companion_api::event_bus::SubscribeResult::Ok { replay, .. } => {
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
            crate::companion_api::event_bus::SubscribeResult::Ok { replay, .. } => {
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

    #[test]
    fn mcp_sidecar_path_prefers_override_then_packaged_brain_layout() {
        let explicit = resolve_mcp_sidecar_path_from(
            Some("/srv/custom/mcp.mjs".into()),
            Some("/srv/layout/cli.mjs".into()),
            "/work".into(),
        );
        assert_eq!(explicit, std::path::PathBuf::from("/srv/custom/mcp.mjs"));

        let packaged =
            resolve_mcp_sidecar_path_from(None, Some("/srv/layout/cli.mjs".into()), "/work".into());
        assert_eq!(
            packaged,
            std::path::PathBuf::from("/srv/layout/sidecar/cognia-mcp.mjs")
        );

        let source_tree = resolve_mcp_sidecar_path_from(None, None, "/repo".into());
        assert_eq!(
            source_tree,
            std::path::PathBuf::from("/repo/sidecar/cognia-mcp.mjs")
        );
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
