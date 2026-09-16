//! `ExecBackend` — the execution-plane seam for external agents
//! (ADR-0059 D2, slice R10).
//!
//! `external_agent/process.rs` assumes "spawn = local tokio process". This
//! trait collapses that assumption so the topology ladder can swap it:
//!
//! - [`LocalProcessBackend`] — desktop + single-container cloud (T1). A thin
//!   delegate over [`ExternalAgentProcessManager`]; `command_resolver` and
//!   `proc_group` hardening are untouched.
//! - `ContainerBackend` (R13, feature `container-exec`) — per-workspace
//!   runner containers. ACP is a stdio stream, so attaching to a container's
//!   stdio is transparent to the TS `acp-client`.
//!
//! # Frozen event payloads (C3 contract)
//!
//! The TS side (`lib/ai/agent/external/acp-client.ts`) consumes the
//! `external-agent://*` channels via `Transport.subscribe`, identically over
//! Tauri events (desktop) and `/ws/v1/events` (headless). The payload shapes
//! built by the `*_payload` functions below are therefore FROZEN — the
//! shape-lock tests pin them byte-for-byte.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::process::{
    ExternalAgentEventSink, ExternalAgentProcessManager, ExternalAgentProcessState,
    ExternalAgentSpawnConfig,
};

// ---------------------------------------------------------------------------
// Frozen `external-agent://*` payload shapes (C3)
// ---------------------------------------------------------------------------

pub const STDOUT_CHANNEL: &str = "external-agent://stdout";
/// Undecoded stdout bytes, base64 in `data`, for agents spawned with
/// `framing: "raw"`. Additive: nothing subscribes unless an adapter asked for
/// raw framing, and the four channels above keep their exact shapes.
pub const STDOUT_RAW_CHANNEL: &str = "external-agent://stdout-raw";
pub const STDERR_CHANNEL: &str = "external-agent://stderr";
pub const EXIT_CHANNEL: &str = "external-agent://exit";
pub const STATE_CHANGE_CHANNEL: &str = "external-agent://state-change";
pub const SPAWN_CHANNEL: &str = "external-agent://spawn";
/// Where a spawn that carried a runtime environment placement runs (ADR-0182).
/// Additive, like `stdout-raw`: only spawns with a placement produce it.
pub const PLACEMENT_CHANNEL: &str = "external-agent://placement";

pub fn stdout_payload(agent_id: &str, line: &str) -> Value {
    json!({ "agentId": agent_id, "data": line })
}

/// Same `{agentId, data}` shape as [`stdout_payload`], but `data` is base64 of
/// the undecoded chunk — matching what the Node backend's raw mode emits, so
/// one adapter decodes both hosts identically.
pub fn stdout_raw_payload(agent_id: &str, base64: &str) -> Value {
    json!({ "agentId": agent_id, "data": base64 })
}

pub fn stderr_payload(agent_id: &str, line: &str) -> Value {
    json!({ "agentId": agent_id, "data": line })
}

/// `code` defaults to 0 when unavailable — mirrors the historical poll-loop
/// payload the TS side still expects.
pub fn exit_payload(agent_id: &str, code: Option<i32>, signal: Option<&str>) -> Value {
    json!({ "agentId": agent_id, "code": code.unwrap_or(0), "signal": signal })
}

pub fn state_change_payload(agent_id: &str, state: &str) -> Value {
    json!({ "agentId": agent_id, "state": state })
}

pub fn spawn_payload(agent_id: &str) -> Value {
    json!({ "agentId": agent_id, "status": "starting" })
}

/// `placement` is `{kind: "sandbox", …}` or `{kind: "fallback", code, message}`.
pub fn placement_payload(agent_id: &str, placement: &Value) -> Value {
    json!({ "agentId": agent_id, "placement": placement })
}

// ---------------------------------------------------------------------------
// Event emission seam
// ---------------------------------------------------------------------------

/// Delivers `external-agent://*` events to whichever surface hosts the UI:
/// `AppHandle::emit` on desktop, `EventBus::publish` headless. Same seam
/// shape as `BridgeTransport` / `SidecarHost::emit`.
pub trait AgentEventEmitter: Send + Sync + 'static {
    fn emit(&self, channel: &str, payload: Value);
}

/// [`ExternalAgentEventSink`] that forwards reader/supervisor events through
/// an [`AgentEventEmitter`] with the frozen shapes. Replaces the old
/// Tauri-only `TauriEventSink`.
pub struct EmitterEventSink {
    emitter: Arc<dyn AgentEventEmitter>,
}

impl EmitterEventSink {
    pub fn new(emitter: Arc<dyn AgentEventEmitter>) -> Arc<Self> {
        Arc::new(Self { emitter })
    }
}

impl ExternalAgentEventSink for EmitterEventSink {
    fn stdout_line(&self, agent_id: &str, line: &str) {
        self.emitter
            .emit(STDOUT_CHANNEL, stdout_payload(agent_id, line));
    }

    fn stdout_raw(&self, agent_id: &str, base64: &str) {
        self.emitter
            .emit(STDOUT_RAW_CHANNEL, stdout_raw_payload(agent_id, base64));
    }

    fn stderr_line(&self, agent_id: &str, line: &str) {
        self.emitter
            .emit(STDERR_CHANNEL, stderr_payload(agent_id, line));
    }

    fn exited(&self, agent_id: &str, code: Option<i32>, signal: Option<String>) {
        // Mirror the historical payload order: a state-change to Stopped
        // followed by the exit event.
        self.emitter.emit(
            STATE_CHANGE_CHANNEL,
            state_change_payload(agent_id, "Stopped"),
        );
        self.emitter.emit(
            EXIT_CHANNEL,
            exit_payload(agent_id, code, signal.as_deref()),
        );
    }

    fn sandbox_placement(&self, agent_id: &str, placement: &Value) {
        self.emitter
            .emit(PLACEMENT_CHANNEL, placement_payload(agent_id, placement));
    }
}

// ---------------------------------------------------------------------------
// ExecBackend
// ---------------------------------------------------------------------------

/// The execution plane for external agents. Implementations own the
/// process/container lifecycle; the caller owns event choreography via
/// [`spawn_with_events`].
#[async_trait]
pub trait ExecBackend: Send + Sync + 'static {
    async fn spawn(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, String>;
    async fn send(&self, id: &str, message: &str) -> Result<(), String>;
    async fn kill(&self, id: &str) -> Result<(), String>;
    async fn kill_all(&self) -> Result<(), String>;
    async fn status(&self, id: &str) -> Option<ExternalAgentProcessState>;
    async fn list(&self) -> Vec<String>;
    async fn is_running(&self, id: &str) -> Result<bool, String>;
    async fn get_info(&self, id: &str) -> Result<Value, String>;
    async fn set_running(&self, id: &str) -> Result<(), String>;
    async fn set_failed(&self, id: &str) -> Result<(), String>;
    /// `"local-process"` | `"container"` — for logs and healthz.
    fn kind(&self) -> &'static str;

    /// Remove execution resources this process did not create but owns —
    /// what a previous run left behind after a crash or a hard kill.
    ///
    /// Returns the ids reaped. The default is correct for backends whose
    /// resources die with the process: a local child process cannot outlive
    /// its parent, so there is nothing to find. Container-shaped backends
    /// override it, because a container very much does outlive us.
    async fn reap_orphans(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    /// Whether this backend honours a spawn's runtime environment placement
    /// ([`crate::sandbox_routing_backend::SandboxRoutingBackend`]). False for
    /// every backend that predates runtime environments; see
    /// [`spawn_with_events`] for what happens to a placement then.
    fn routes_sandboxes(&self) -> bool {
        false
    }
}

/// T1 backend: local tokio processes via the existing manager
/// (`command_resolver` + `proc_group` untouched).
pub struct LocalProcessBackend(pub Arc<ExternalAgentProcessManager>);

impl LocalProcessBackend {
    pub fn new() -> Arc<Self> {
        Arc::new(Self(Arc::new(ExternalAgentProcessManager::new())))
    }

    /// Wrap an existing manager (the desktop's Tauri-managed instance).
    pub fn from_manager(manager: Arc<ExternalAgentProcessManager>) -> Arc<Self> {
        Arc::new(Self(manager))
    }
}

#[async_trait]
impl ExecBackend for LocalProcessBackend {
    async fn spawn(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, String> {
        self.0.spawn(config, sink).await
    }

    async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        self.0.send(id, message).await
    }

    async fn kill(&self, id: &str) -> Result<(), String> {
        self.0.kill(id).await
    }

    async fn kill_all(&self) -> Result<(), String> {
        self.0.kill_all().await
    }

    async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
        self.0.status(id).await
    }

    async fn list(&self) -> Vec<String> {
        self.0.list().await
    }

    async fn is_running(&self, id: &str) -> Result<bool, String> {
        self.0.is_running(id).await
    }

    async fn get_info(&self, id: &str) -> Result<Value, String> {
        self.0.get_info(id).await
    }

    async fn set_running(&self, id: &str) -> Result<(), String> {
        self.0.set_running(id).await
    }

    async fn set_failed(&self, id: &str) -> Result<(), String> {
        self.0.set_failed(id).await
    }

    fn kind(&self) -> &'static str {
        "local-process"
    }
}

/// Spawn + event choreography, shared by the desktop Tauri command and the
/// headless RPC arm (R11) so the wire behavior cannot drift:
/// `spawn` → `spawn(starting)` event → `set_running` → `state-change(Running)`
/// on success; `state-change(Failed)` on spawn error. stdout/stderr/exit ride
/// the sink from the reader/supervisor tasks.
///
/// A spawn carrying a runtime environment placement on a backend that does
/// not route sandboxes (the pool is off on this host, or this is a desktop
/// without the local-container toggle) is the pool-disabled case of the fault
/// rule: refused with `sandbox_pool_disabled` when isolation is mandatory,
/// otherwise run on this path with a `sandbox_fallback_pool_disabled`
/// placement event. A spawn without a placement never reaches that branch.
pub async fn spawn_with_events(
    backend: &dyn ExecBackend,
    emitter: Arc<dyn AgentEventEmitter>,
    mut config: ExternalAgentSpawnConfig,
) -> Result<String, String> {
    // A sandboxed agent runs in a container even when the host's own path is
    // local processes, so it gets none of the local-only payloads.
    let runs_locally = config.sandbox.is_none() && backend.kind() == "local-process";
    if config.env.contains_key(crate::devin_mcp_config::PAYLOAD_ENV) && !runs_locally {
        return Err("Isolated Devin MCP configuration requires a local process backend".into());
    }
    if config.env.contains_key(crate::gateway_task::PAYLOAD_ENV) && !runs_locally {
        return Err("Cognia gateway tasks require a local process backend; remote gateway transport is not configured".into());
    }
    let id = config.id.clone();
    let sink: Arc<dyn ExternalAgentEventSink> = EmitterEventSink::new(Arc::clone(&emitter));

    if let Some(placement) = config.sandbox.as_ref() {
        if !backend.routes_sandboxes() {
            let refusal = crate::sandbox_routing_backend::SandboxSpawnError::fault(
                "sandbox_pool_disabled",
                "runtime environments are not enabled on this host",
            );
            if placement.isolation_mandatory() {
                return Err(refusal.to_string());
            }
            sink.sandbox_placement(
                &id,
                &crate::sandbox_routing_backend::fallback_placement(
                    &refusal.fallback_code(),
                    &refusal.message,
                ),
            );
            config.sandbox = None;
        }
    }

    let result = backend.spawn(config, sink).await;

    match &result {
        Ok(_) => {
            emitter.emit(SPAWN_CHANNEL, spawn_payload(&id));
            let _ = backend.set_running(&id).await;
            emitter.emit(STATE_CHANGE_CHANNEL, state_change_payload(&id, "Running"));
        }
        Err(_) => {
            emitter.emit(STATE_CHANGE_CHANNEL, state_change_payload(&id, "Failed"));
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(any(test, feature = "test-support"))]
pub mod test_support {
    use super::*;
    use parking_lot::Mutex;

    /// Records every emitted `external-agent://*` event.
    #[derive(Default)]
    pub struct RecordingAgentEmitter {
        pub emitted: Mutex<Vec<(String, Value)>>,
    }

    impl RecordingAgentEmitter {
        pub fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        pub fn events(&self) -> Vec<(String, Value)> {
            self.emitted.lock().clone()
        }
    }

    impl AgentEventEmitter for RecordingAgentEmitter {
        fn emit(&self, channel: &str, payload: Value) {
            self.emitted.lock().push((channel.to_string(), payload));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::RecordingAgentEmitter;
    use super::*;
    use std::collections::HashMap;

    // ── Shape locks (C3 contract — do not "fix" these without bumping the
    //    protocol on the TS side) ─────────────────────────────────────────────

    #[test]
    fn frozen_payload_shapes() {
        assert_eq!(
            stdout_payload("a1", "line"),
            json!({ "agentId": "a1", "data": "line" })
        );
        assert_eq!(
            stderr_payload("a1", "oops"),
            json!({ "agentId": "a1", "data": "oops" })
        );
        assert_eq!(
            exit_payload("a1", Some(3), Some("SIGKILL")),
            json!({ "agentId": "a1", "code": 3, "signal": "SIGKILL" })
        );
        // code defaults to 0 (historical poll-loop semantics).
        assert_eq!(
            exit_payload("a1", None, None),
            json!({ "agentId": "a1", "code": 0, "signal": null })
        );
        assert_eq!(
            state_change_payload("a1", "Running"),
            json!({ "agentId": "a1", "state": "Running" })
        );
        assert_eq!(
            spawn_payload("a1"),
            json!({ "agentId": "a1", "status": "starting" })
        );
    }

    #[test]
    fn emitter_sink_exit_emits_stopped_then_exit() {
        let emitter = RecordingAgentEmitter::new();
        let sink = EmitterEventSink::new(emitter.clone());
        sink.stdout_line("a1", "out");
        sink.stderr_line("a1", "err");
        sink.exited("a1", Some(2), None);

        let events = emitter.events();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].0, STDOUT_CHANNEL);
        assert_eq!(events[1].0, STDERR_CHANNEL);
        assert_eq!(events[2].0, STATE_CHANGE_CHANNEL);
        assert_eq!(events[2].1["state"], "Stopped");
        assert_eq!(events[3].0, EXIT_CHANNEL);
        assert_eq!(events[3].1["code"], 2);
    }

    // ── spawn_with_events choreography ────────────────────────────────────────

    #[tokio::test]
    async fn devin_mcp_payload_never_reaches_remote_execution() {
        struct Remote;
        #[async_trait]
        impl ExecBackend for Remote {
            async fn spawn(&self, _: ExternalAgentSpawnConfig, _: Arc<dyn ExternalAgentEventSink>) -> Result<String, String> { panic!("remote spawn must not be reached") }
            async fn send(&self, _: &str, _: &str) -> Result<(), String> { unreachable!() }
            async fn kill(&self, _: &str) -> Result<(), String> { unreachable!() }
            async fn kill_all(&self) -> Result<(), String> { unreachable!() }
            async fn status(&self, _: &str) -> Option<ExternalAgentProcessState> { unreachable!() }
            async fn list(&self) -> Vec<String> { unreachable!() }
            async fn is_running(&self, _: &str) -> Result<bool, String> { unreachable!() }
            async fn get_info(&self, _: &str) -> Result<Value, String> { unreachable!() }
            async fn set_running(&self, _: &str) -> Result<(), String> { unreachable!() }
            async fn set_failed(&self, _: &str) -> Result<(), String> { unreachable!() }
            fn kind(&self) -> &'static str { "container" }
        }
        let config = ExternalAgentSpawnConfig {
            id: "devin".into(), command: "devin".into(), args: vec!["acp".into()],
            env: HashMap::from([(crate::devin_mcp_config::PAYLOAD_ENV.into(), "[]".into())]),
            cwd: None, framing: Default::default(), sandbox: None,
        };
        let result = spawn_with_events(&Remote, RecordingAgentEmitter::new(), config).await;
        assert!(result.unwrap_err().contains("requires a local process backend"));
    }

    #[test]
    fn the_placement_payload_shape() {
        assert_eq!(
            placement_payload("a1", &json!({ "kind": "fallback", "code": "c", "message": "m" })),
            json!({ "agentId": "a1", "placement": { "kind": "fallback", "code": "c", "message": "m" } })
        );
    }

    fn placed(id: &str, command: &str, isolation_mandatory: bool) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: id.into(),
            command: command.into(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            framing: Default::default(),
            sandbox: Some(crate::sandbox_routing_backend::SandboxPlacement::Container {
                spec: json!({}),
                isolation_mandatory,
            }),
        }
    }

    /// With the pool off there is no router, and a placement the brain sent
    /// anyway (a stale client, a pool switched off since) is the pool-disabled
    /// fault: mandatory isolation refuses, anything else runs here and says so.
    #[tokio::test]
    async fn a_placement_on_a_host_without_sandboxes_refuses_or_falls_back() {
        let backend = LocalProcessBackend::new();
        let emitter = RecordingAgentEmitter::new();
        let refused = spawn_with_events(
            backend.as_ref(),
            emitter.clone(),
            placed("strict", "definitely-not-a-real-binary-xyz-123", true),
        )
        .await
        .unwrap_err();
        assert!(refused.starts_with("sandbox_pool_disabled: "), "{refused}");
        assert!(emitter.events().is_empty(), "nothing was attempted");

        // The fallback reaches the backend without a placement: this binary
        // does not exist, so the local spawn fails after the event is out.
        let fell_back = spawn_with_events(
            backend.as_ref(),
            emitter.clone(),
            placed("soft", "definitely-not-a-real-binary-xyz-123", false),
        )
        .await;
        assert!(fell_back.is_err());
        let events = emitter.events();
        assert_eq!(events[0].0, PLACEMENT_CHANNEL);
        assert_eq!(
            events[0].1["placement"]["code"],
            "sandbox_fallback_pool_disabled"
        );
        assert_eq!(events[1].1["state"], "Failed");
    }

    #[tokio::test]
    async fn a_sandboxed_spawn_never_carries_local_only_payloads() {
        let backend = LocalProcessBackend::new();
        for env in [
            crate::gateway_task::PAYLOAD_ENV,
            crate::devin_mcp_config::PAYLOAD_ENV,
        ] {
            let mut config = placed("payload", "codex-acp", false);
            config.env.insert(env.into(), "{}".into());
            let error = spawn_with_events(backend.as_ref(), RecordingAgentEmitter::new(), config)
                .await
                .unwrap_err();
            assert!(error.contains("local process backend"), "{env}: {error}");
        }
    }

    #[tokio::test]
    async fn spawn_failure_emits_failed_state_only() {
        let backend = LocalProcessBackend::new();
        let emitter = RecordingAgentEmitter::new();
        let config = ExternalAgentSpawnConfig {
            id: "nope".into(),
            command: "definitely-not-a-real-binary-xyz-123".into(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            framing: Default::default(),
            sandbox: None,
        };
        let result = spawn_with_events(backend.as_ref(), emitter.clone(), config).await;
        assert!(result.is_err());
        let events = emitter.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, STATE_CHANGE_CHANNEL);
        assert_eq!(events[0].1, json!({ "agentId": "nope", "state": "Failed" }));
    }

    /// Full delegation parity: spawn a real node child through the backend,
    /// drive send/list/status/is_running/get_info/kill, and assert the event
    /// choreography (spawn → Running, stdout via sink, Stopped → exit).
    /// Skips gracefully when Node is missing.
    #[tokio::test]
    async fn local_backend_delegates_the_full_lifecycle() {
        if !crate::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("echo-agent.mjs");
        std::fs::write(
            &script,
            concat!(
                "process.stdin.setEncoding('utf8');\n",
                "let buf='';\n",
                "process.stdin.on('data',(d)=>{buf+=d;let i;\n",
                "  while((i=buf.indexOf('\\n'))>=0){\n",
                "    const line=buf.slice(0,i);buf=buf.slice(i+1);\n",
                "    if(line.trim())process.stdout.write('echo:'+line+'\\n');\n",
                "  }});\n",
                "process.stdin.on('end',()=>process.exit(0));\n",
            ),
        )
        .expect("write agent script");

        let backend = LocalProcessBackend::new();
        let emitter = RecordingAgentEmitter::new();
        let config = ExternalAgentSpawnConfig {
            id: "agent-1".into(),
            command: "node".into(),
            args: vec![script.display().to_string()],
            env: HashMap::new(),
            cwd: Some(tmp.path().display().to_string()),
            framing: Default::default(),
            sandbox: None,
        };

        let id = spawn_with_events(backend.as_ref(), emitter.clone(), config)
            .await
            .expect("spawn");
        assert_eq!(id, "agent-1");

        // Choreography: spawn(starting) then state-change(Running).
        let events = emitter.events();
        assert_eq!(events[0].0, SPAWN_CHANNEL);
        assert_eq!(events[0].1["status"], "starting");
        assert_eq!(events[1].0, STATE_CHANGE_CHANNEL);
        assert_eq!(events[1].1["state"], "Running");

        // Delegation: list / status / is_running / get_info.
        assert!(backend.list().await.contains(&"agent-1".to_string()));
        assert_eq!(
            backend.status("agent-1").await,
            Some(ExternalAgentProcessState::Running)
        );
        assert_eq!(backend.is_running("agent-1").await, Ok(true));
        let info = backend.get_info("agent-1").await.expect("info");
        assert!(info.is_object());
        assert_eq!(backend.kind(), "local-process");

        // send → the child echoes → stdout event arrives via the sink.
        backend.send("agent-1", "ping").await.expect("send");
        let mut saw_echo = false;
        for _ in 0..100 {
            if emitter
                .events()
                .iter()
                .any(|(ch, p)| ch == STDOUT_CHANNEL && p["data"] == "echo:ping")
            {
                saw_echo = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(saw_echo, "stdin round-trip must surface as a stdout event");

        // kill → supervisor emits Stopped + exit; manager forgets the id.
        backend.kill("agent-1").await.expect("kill");
        let mut saw_exit = false;
        for _ in 0..100 {
            if emitter.events().iter().any(|(ch, _)| ch == EXIT_CHANNEL) {
                saw_exit = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(saw_exit, "kill must surface the exit event via the sink");
        assert!(backend.list().await.is_empty());
        assert!(backend.status("agent-1").await.is_none());
    }
}
