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
pub const STDERR_CHANNEL: &str = "external-agent://stderr";
pub const EXIT_CHANNEL: &str = "external-agent://exit";
pub const STATE_CHANGE_CHANNEL: &str = "external-agent://state-change";
pub const SPAWN_CHANNEL: &str = "external-agent://spawn";

pub fn stdout_payload(agent_id: &str, line: &str) -> Value {
    json!({ "agentId": agent_id, "data": line })
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

// ---------------------------------------------------------------------------
// Event emission seam
// ---------------------------------------------------------------------------

/// Delivers `external-agent://*` events to whichever surface hosts the UI:
/// `AppHandle::emit` on desktop, `EventBus::publish` headless. Same seam
/// shape as `BridgeTransport` / `SidecarHost::emit`.
pub trait AgentEventEmitter: Send + Sync + 'static {
    fn emit(&self, channel: &str, payload: Value);
}

/// Headless emitter: publishes into the companion EventBus so every
/// `/ws/v1/events` subscriber (the brain's acp-client, phones) receives the
/// frozen payloads.
#[allow(dead_code)] // constructed by the headless RPC arms (R11).
pub struct BusAgentEmitter(pub Arc<crate::companion_api::event_bus::EventBus>);

impl AgentEventEmitter for BusAgentEmitter {
    fn emit(&self, channel: &str, payload: Value) {
        self.0.publish(channel.to_string(), payload);
    }
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
pub async fn spawn_with_events(
    backend: &dyn ExecBackend,
    emitter: Arc<dyn AgentEventEmitter>,
    config: ExternalAgentSpawnConfig,
) -> Result<String, String> {
    let id = config.id.clone();
    let sink: Arc<dyn ExternalAgentEventSink> = EmitterEventSink::new(Arc::clone(&emitter));

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

#[cfg(test)]
pub(crate) mod test_support {
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

    #[test]
    fn bus_emitter_publishes_the_frozen_payload() {
        let bus = crate::companion_api::event_bus::EventBus::new();
        let emitter = BusAgentEmitter(Arc::clone(&bus));
        emitter.emit(STDOUT_CHANNEL, stdout_payload("a1", "hello"));
        match bus.subscribe(Some(0), 0) {
            crate::companion_api::event_bus::SubscribeResult::Ok { replay, .. } => {
                assert_eq!(replay.len(), 1);
                assert_eq!(replay[0].event_type, STDOUT_CHANNEL);
                assert_eq!(
                    replay[0].payload,
                    json!({ "agentId": "a1", "data": "hello" })
                );
            }
            _ => panic!("subscribe failed"),
        }
    }

    // ── spawn_with_events choreography ────────────────────────────────────────

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
        if !crate::external_agent::command_resolver::check_command_exists("node") {
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
