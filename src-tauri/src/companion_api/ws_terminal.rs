//! Companion WebSocket bridge for the integrated terminal —
//! `GET /ws/v1/terminal`.
//!
//! # Wire protocol (v2)
//!
//! 1. Client opens
//!    `wss://<host>/ws/v1/terminal?token=<jwt>&spawn=1&shell=…&rows=…&cols=…`.
//!    The `require_device_jwt` middleware verifies the JWT and injects
//!    [`super::middleware::DeviceContext`] before the handler runs.
//! 2. Server allocates a `PtySession` via
//!    [`crate::terminal::session::spawn_session_with_sink`], marks
//!    `origin = Remote`, registers it in the process-wide
//!    [`WsTerminalRegistry`] under the device id, and replies with a
//!    single text frame:
//!    `{"kind":"ready","sessionId":"<uuid>","shell":"<resolved>"}`.
//! 3. Steady state:
//!    * **Binary** frames Server→Client = PTY stdout (raw bytes).
//!    * **Binary** frames Client→Server = PTY stdin.
//!    * **Text** frames carry control envelopes (each gains a `seq` for
//!      Wave 2 reconnect):
//!      - `{"kind":"integration","event":…,"seq":<u64>}` from OSC 633.
//!      - `{"kind":"exit","code":…,"seq":<u64>}` once on exit.
//!      - `{"kind":"resize","rows":…,"cols":…}` (client→server).
//!      - `{"kind":"kill"}` (client→server).
//!
//! ## Wave 2 reconnect
//!
//! Clients that drop their socket can resume by re-opening
//! `wss://…/ws/v1/terminal?token=<jwt>&sessionId=<id>&resumeFrom=<seq>`.
//! The server looks the session up in [`WsTerminalRegistry`], confirms
//! the requesting device matches the device that spawned it, replays
//! every event with `seq > resumeFrom` from the in-Rust
//! [`crate::terminal::ReplayBuffer`], then resumes live emission.
//!
//! Sessions are NOT dropped when the WS closes — instead the registry
//! marks them detached. A background reaper drops sessions still
//! detached after 5 minutes, matching the renderer-side reconnect
//! budget in `lib/terminal/transport-ws.ts`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
};
use serde::Deserialize;
use serde_json::json;

use super::{middleware::DeviceContext, SharedState};
use crate::terminal::session::{
    self, EventSink, PtySession, SessionOrigin, SpawnRequest, TerminalEvent,
};

// ── Process-wide registry for resumable WS-spawned sessions ──────────

/// Window during which a detached session is kept alive waiting for a
/// reconnect. Matches the renderer-side `RECONNECT_BUDGET_MS` in
/// `lib/terminal/transport-ws.ts`.
const RESUME_TTL: Duration = Duration::from_secs(5 * 60);

/// Idle WS read timeout. Generous so mobile screen-off doesn't tear
/// the consumer down. Smaller than `RESUME_TTL` on purpose — the
/// registry GC catches the abandoned session after the consumer drops.
const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct WsTerminalRegistry {
    inner: Mutex<HashMap<String, WsSessionEntry>>,
}

struct WsSessionEntry {
    session: Arc<PtySession>,
    device_id: String,
    /// `true` while a WS consumer is currently attached. The registry
    /// reaper only kills sessions whose consumer has been gone past
    /// `RESUME_TTL`.
    attached: Arc<AtomicBool>,
    detached_at: Mutex<Option<Instant>>,
    /// Sender into the in-process MPSC the WS handler drains. We keep
    /// a clone on the entry so reconnects can swap the consumer end.
    /// `None` means "no live consumer" — events still land in the
    /// session's ReplayBuffer because the EventSink writes there first.
    consumer: Mutex<Option<tokio::sync::mpsc::UnboundedSender<(u64, TerminalEvent)>>>,
}

impl WsTerminalRegistry {
    fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    fn insert(&self, entry: WsSessionEntry) {
        let id = entry.session.id.clone();
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.insert(id, entry);
    }

    fn lookup_for_device(&self, session_id: &str, device_id: &str) -> Option<Arc<PtySession>> {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let entry = guard.get(session_id)?;
        if entry.device_id != device_id {
            return None;
        }
        Some(Arc::clone(&entry.session))
    }

    fn swap_consumer(
        &self,
        session_id: &str,
        device_id: &str,
        consumer: tokio::sync::mpsc::UnboundedSender<(u64, TerminalEvent)>,
    ) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let Some(entry) = guard.get(session_id) else {
            return false;
        };
        if entry.device_id != device_id {
            return false;
        }
        entry.attached.store(true, Ordering::SeqCst);
        *entry.detached_at.lock().unwrap_or_else(|p| p.into_inner()) = None;
        *entry.consumer.lock().unwrap_or_else(|p| p.into_inner()) = Some(consumer);
        true
    }

    fn detach_consumer(&self, session_id: &str) {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = guard.get(session_id) {
            entry.attached.store(false, Ordering::SeqCst);
            *entry.detached_at.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
            *entry.consumer.lock().unwrap_or_else(|p| p.into_inner()) = None;
        }
    }

    fn remove(&self, session_id: &str) -> Option<WsSessionEntry> {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.remove(session_id)
    }

    /// Reaper sweep: drop sessions whose consumer has been gone for
    /// longer than `RESUME_TTL`. Called by the background tokio task.
    fn reap(&self, now: Instant) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.retain(|_, entry| {
            if entry.attached.load(Ordering::SeqCst) {
                return true;
            }
            let detached = entry
                .detached_at
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            match detached {
                Some(t) if now.duration_since(t) > RESUME_TTL => {
                    let _ = entry.session.kill();
                    false
                }
                _ => true,
            }
        });
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len()
    }
}

pub static WS_TERMINAL_REGISTRY: once_cell::sync::Lazy<Arc<WsTerminalRegistry>> =
    once_cell::sync::Lazy::new(|| {
        let registry = Arc::new(WsTerminalRegistry::new());
        // Spawn a single background reaper that ticks every 30 s.
        // tokio::spawn requires a runtime — fine inside the companion
        // server, which runs under tokio. For test contexts without a
        // runtime the spawn fails silently, which is acceptable: tests
        // exercise the registry directly without time-based reaping.
        if tokio::runtime::Handle::try_current().is_ok() {
            let reg = Arc::clone(&registry);
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(30));
                loop {
                    interval.tick().await;
                    reg.reap(Instant::now());
                }
            });
        }
        registry
    });

pub fn ws_terminal_registry() -> Arc<WsTerminalRegistry> {
    Arc::clone(&WS_TERMINAL_REGISTRY)
}

#[derive(Debug, Deserialize)]
pub struct WsTerminalParams {
    /// Set to `"1"` for a fresh spawn. When omitted, `session_id` +
    /// `resume_from` must identify an existing resumable session.
    #[serde(default)]
    pub spawn: Option<String>,
    pub shell: Option<String>,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
    pub cwd: Option<String>,
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
    #[serde(rename = "extensionId")]
    pub extension_id: Option<String>,
    #[serde(rename = "shellIntegration")]
    pub shell_integration: Option<String>,
    /// Wave 2 — reconnect target. When set, server looks up the
    /// session by id in `WsTerminalRegistry` and resumes; the requesting
    /// device JWT must match the device that spawned the session.
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    /// Wave 2 — sequence number the client last observed. The server
    /// replays every event with `seq > resume_from` before resuming
    /// live emission.
    #[serde(rename = "resumeFrom")]
    pub resume_from: Option<u64>,
}

/// Axum handler for `GET /ws/v1/terminal`. The route is gated by
/// `require_device_jwt`; we read the device id off request extensions
/// before the upgrade consumes them.
pub async fn ws_terminal_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsTerminalParams>,
    State(state): State<SharedState>,
    request: axum::extract::Request,
) -> Response {
    let device_id = request
        .extensions()
        .get::<DeviceContext>()
        .map(|ctx| ctx.device_id.clone())
        .unwrap_or_default();
    ws.on_upgrade(move |socket| handle_terminal_socket(socket, params, device_id, state))
}

async fn handle_terminal_socket(
    mut socket: WebSocket,
    params: WsTerminalParams,
    device_id: String,
    _state: SharedState,
) {
    let registry = ws_terminal_registry();
    let is_spawn = params.spawn.as_deref() == Some("1");
    let resume_target = params.session_id.clone();

    let (session, session_id, resolved_shell): (Arc<PtySession>, String, String);
    let (consumer_tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u64, TerminalEvent)>();

    if is_spawn {
        let req = match build_spawn_request(&params) {
            Ok(req) => req,
            Err(reason) => {
                send_error_and_close(&mut socket, &reason).await;
                return;
            }
        };
        let resolved = req.shell.clone();
        let script_dir = resolve_script_dir();

        let consumer_for_sink = consumer_tx.clone();
        let sink: EventSink = Arc::new(move |seq, event| {
            let _ = consumer_for_sink.send((seq, event));
        });

        // Remote sessions fan out through the mpsc sink above; the desktop
        // Tauri Channel slot stays detached (the WS handler owns reconnect
        // via its own registry consumer-swap).
        let new_session = match session::spawn_session_with_sink(
            req,
            &script_dir,
            sink,
            session::detached_desk_channel(),
        ) {
            Ok(s) => s,
            Err(reason) => {
                send_error_and_close(&mut socket, &reason).await;
                return;
            }
        };
        let id = new_session.id.clone();
        let arc_session = Arc::new(new_session);

        let entry = WsSessionEntry {
            session: Arc::clone(&arc_session),
            device_id: device_id.clone(),
            attached: Arc::new(AtomicBool::new(true)),
            detached_at: Mutex::new(None),
            consumer: Mutex::new(Some(consumer_tx)),
        };
        registry.insert(entry);

        session = arc_session;
        session_id = id;
        resolved_shell = resolved;
    } else if let Some(id) = resume_target.clone() {
        let Some(existing) = registry.lookup_for_device(&id, &device_id) else {
            send_error_and_close(&mut socket, "session not found or not owned by this device").await;
            return;
        };
        if !registry.swap_consumer(&id, &device_id, consumer_tx.clone()) {
            send_error_and_close(&mut socket, "session is no longer resumable").await;
            return;
        }
        session = existing;
        session_id = id;
        resolved_shell = session.shell.clone();
    } else {
        send_error_and_close(&mut socket, "missing spawn=1 or sessionId").await;
        return;
    }

    // Ready handshake. Clients block on this frame in
    // `lib/terminal/transport-ws.ts::waitForReady`.
    let ready = json!({
        "kind": "ready",
        "sessionId": session_id,
        "shell": resolved_shell,
        "deviceId": device_id,
    });
    if socket
        .send(Message::Text(ready.to_string().into()))
        .await
        .is_err()
    {
        registry.detach_consumer(&session_id);
        return;
    }

    // Replay every event the client missed (resume only — fresh
    // spawns have an empty replay buffer at this point).
    if !is_spawn {
        let resume_from = params.resume_from.unwrap_or(0);
        let replay = session.replay();
        let last = replay.last_seq();
        if resume_from > last {
            log::warn!(
                "ws_terminal resume_from={} > last_seq={} for session={}; client ahead of server",
                resume_from,
                last,
                session_id
            );
        } else {
            for (seq, event) in replay.since(resume_from) {
                if emit_event(&mut socket, seq, &event).await.is_err() {
                    registry.detach_consumer(&session_id);
                    return;
                }
            }
        }
        // Diagnostic: log replay buffer state after resuming.
        if !replay.is_empty() {
            log::debug!(
                "ws_terminal replay buffer for session={}: {} events, {} bytes, last_seq={}",
                session_id,
                replay.len(),
                replay.retained_bytes(),
                last
            );
        }
    }

    // Steady-state proxy: tokio::select! over PTY events vs WS frames.
    let mut idle_deadline = tokio::time::Instant::now() + IDLE_TIMEOUT;
    let mut exited = false;

    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some((seq, TerminalEvent::Data { bytes })) => {
                        // Binary frames don't carry seq today — the
                        // resume buffer covers gap detection. Wave 2.x
                        // could add a tiny preamble if exact byte-level
                        // reconcilation becomes important.
                        let _ = seq; // seq used by replay only
                        if socket.send(Message::Binary(bytes.into())).await.is_err() {
                            break;
                        }
                    }
                    Some((seq, TerminalEvent::Integration { event })) => {
                        let payload = json!({ "kind": "integration", "event": event, "seq": seq });
                        if socket.send(Message::Text(payload.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Some((seq, TerminalEvent::Exit { code })) => {
                        let payload = json!({ "kind": "exit", "code": code, "seq": seq });
                        let _ = socket.send(Message::Text(payload.to_string().into())).await;
                        exited = true;
                        break;
                    }
                    None => {
                        // Sink dropped without an exit — sometimes
                        // happens when the child segfaults before the
                        // waiter ran. Treat as null-code exit.
                        let payload = json!({ "kind": "exit", "code": null });
                        let _ = socket.send(Message::Text(payload.to_string().into())).await;
                        exited = true;
                        break;
                    }
                }
            }
            msg = socket.recv() => {
                idle_deadline = tokio::time::Instant::now() + IDLE_TIMEOUT;
                match msg {
                    Some(Ok(Message::Binary(bytes))) => {
                        if session.write(&bytes).is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        match handle_control_frame(text.as_str(), &session) {
                            Ok(ControlAction::Continue) => {}
                            Ok(ControlAction::Killed) => {
                                exited = true;
                                break;
                            }
                            Err(reason) => log::warn!("ws_terminal: bad control frame: {reason}"),
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Err(_)) => break,
                }
            }
            _ = tokio::time::sleep_until(idle_deadline) => {
                break;
            }
        }
    }

    if exited {
        // Session ran its course — remove from the registry.
        registry.remove(&session_id);
    } else {
        // Consumer dropped; let the reaper decide whether to kill the
        // session based on RESUME_TTL.
        registry.detach_consumer(&session_id);
    }
}

async fn emit_event(socket: &mut WebSocket, seq: u64, event: &TerminalEvent) -> Result<(), ()> {
    match event {
        TerminalEvent::Data { bytes } => {
            let _ = seq;
            socket
                .send(Message::Binary(bytes.clone().into()))
                .await
                .map_err(|_| ())
        }
        TerminalEvent::Integration { event } => {
            let payload = json!({ "kind": "integration", "event": event, "seq": seq });
            socket
                .send(Message::Text(payload.to_string().into()))
                .await
                .map_err(|_| ())
        }
        TerminalEvent::Exit { code } => {
            let payload = json!({ "kind": "exit", "code": code, "seq": seq });
            socket
                .send(Message::Text(payload.to_string().into()))
                .await
                .map_err(|_| ())
        }
    }
}

fn build_spawn_request(params: &WsTerminalParams) -> Result<SpawnRequest, String> {
    let shell = params
        .shell
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "shell parameter is required".to_string())?;
    let rows = params.rows.unwrap_or(24);
    let cols = params.cols.unwrap_or(80);
    let cwd = params.cwd.clone().filter(|s| !s.is_empty());
    // Disable OSC 633 on remote sessions — see module docs. We accept
    // `shellIntegration` in the params so the wire format matches the
    // local path, but ignore the value for v1: the integration scripts
    // are local file paths that the remote shell can't resolve.
    let enable_shell_integration = false;
    Ok(SpawnRequest {
        shell,
        args: vec![],
        cwd,
        env: Default::default(),
        rows,
        cols,
        project_id: params.project_id.clone(),
        extension_id: params.extension_id.clone(),
        enable_shell_integration,
        origin: SessionOrigin::Remote,
    })
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ControlFrame {
    Resize { rows: u16, cols: u16 },
    Kill,
}

enum ControlAction {
    Continue,
    Killed,
}

fn handle_control_frame(text: &str, session: &PtySession) -> Result<ControlAction, String> {
    let frame: ControlFrame =
        serde_json::from_str(text).map_err(|e| format!("parse: {e}"))?;
    match frame {
        ControlFrame::Resize { rows, cols } => {
            session
                .resize(rows, cols)
                .map_err(|e| format!("resize: {e}"))?;
            Ok(ControlAction::Continue)
        }
        ControlFrame::Kill => {
            session.kill().map_err(|e| format!("kill: {e}"))?;
            Ok(ControlAction::Killed)
        }
    }
}

/// Locate the bundled shell-integration script directory. Remote
/// sessions don't use it today (integration is force-disabled) but
/// `spawn_session_with_sink` still expects a path, so we provide the
/// same fallback as `terminal::commands::resolve_script_dir`.
fn resolve_script_dir() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.join("resources").join("terminal")
}

async fn send_error_and_close(socket: &mut WebSocket, message: &str) {
    let frame = json!({ "kind": "error", "message": message });
    let _ = socket
        .send(Message::Text(frame.to_string().into()))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_params_deserializes_query_string_with_camelcase_aliases() {
        let json = serde_json::json!({
            "spawn": "1",
            "shell": "/bin/bash",
            "rows": 24,
            "cols": 80,
            "projectId": "p1",
            "extensionId": "ext.a",
            "shellIntegration": "0",
            "sessionId": "s-1",
            "resumeFrom": 42,
        });
        let params: WsTerminalParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.spawn.as_deref(), Some("1"));
        assert_eq!(params.shell.as_deref(), Some("/bin/bash"));
        assert_eq!(params.rows, Some(24));
        assert_eq!(params.cols, Some(80));
        assert_eq!(params.project_id.as_deref(), Some("p1"));
        assert_eq!(params.extension_id.as_deref(), Some("ext.a"));
        assert_eq!(params.shell_integration.as_deref(), Some("0"));
        assert_eq!(params.session_id.as_deref(), Some("s-1"));
        assert_eq!(params.resume_from, Some(42));
    }

    #[test]
    fn ws_params_optional_fields_default_to_none() {
        let params: WsTerminalParams = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(params.spawn.is_none());
        assert!(params.shell.is_none());
        assert!(params.rows.is_none());
        assert!(params.resume_from.is_none());
    }

    #[test]
    fn build_spawn_request_rejects_missing_shell() {
        let params = WsTerminalParams {
            spawn: Some("1".into()),
            shell: None,
            rows: Some(24),
            cols: Some(80),
            cwd: None,
            project_id: None,
            extension_id: None,
            shell_integration: None,
            session_id: None,
            resume_from: None,
        };
        let err = build_spawn_request(&params).unwrap_err();
        assert!(err.contains("shell"));
    }

    #[test]
    fn build_spawn_request_defaults_rows_cols_and_forces_remote_origin() {
        let params = WsTerminalParams {
            spawn: Some("1".into()),
            shell: Some("/bin/bash".into()),
            rows: None,
            cols: None,
            cwd: None,
            project_id: None,
            extension_id: None,
            shell_integration: None,
            session_id: None,
            resume_from: None,
        };
        let req = build_spawn_request(&params).unwrap();
        assert_eq!(req.rows, 24);
        assert_eq!(req.cols, 80);
        assert_eq!(req.origin, SessionOrigin::Remote);
        // Integration is always disabled on remote sessions for v1.
        assert!(!req.enable_shell_integration);
    }

    #[test]
    fn build_spawn_request_carries_project_and_extension_ids() {
        let params = WsTerminalParams {
            spawn: Some("1".into()),
            shell: Some("/bin/zsh".into()),
            rows: Some(48),
            cols: Some(120),
            cwd: Some("/tmp/x".into()),
            project_id: Some("proj-a".into()),
            extension_id: Some("ext.cline".into()),
            shell_integration: Some("1".into()),
            session_id: None,
            resume_from: None,
        };
        let req = build_spawn_request(&params).unwrap();
        assert_eq!(req.cwd.as_deref(), Some("/tmp/x"));
        assert_eq!(req.project_id.as_deref(), Some("proj-a"));
        assert_eq!(req.extension_id.as_deref(), Some("ext.cline"));
        assert_eq!(req.rows, 48);
        assert_eq!(req.cols, 120);
    }

    #[test]
    fn control_frame_parses_resize_and_kill() {
        let resize: ControlFrame =
            serde_json::from_str(r#"{"kind":"resize","rows":32,"cols":100}"#).unwrap();
        assert!(matches!(resize, ControlFrame::Resize { rows: 32, cols: 100 }));
        let kill: ControlFrame = serde_json::from_str(r#"{"kind":"kill"}"#).unwrap();
        assert!(matches!(kill, ControlFrame::Kill));
    }

    #[test]
    fn control_frame_rejects_unknown_kind() {
        let res = serde_json::from_str::<ControlFrame>(r#"{"kind":"unknown"}"#);
        assert!(res.is_err());
    }

    /// Helper: `EventSink` smoke — the closure is `Send + Sync` and can
    /// be cloned across the std-thread / tokio-task boundary that the
    /// real handler relies on. Updated for the Wave 2 `(seq, event)`
    /// signature.
    #[test]
    fn event_sink_closure_is_send_sync_clonable() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<(u64, TerminalEvent)>();
        let sink: EventSink = Arc::new(move |seq, event| {
            let _ = tx.send((seq, event));
        });
        let cloned = sink.clone();
        cloned(1, TerminalEvent::Exit { code: Some(0) });
    }

    // ── Wave 2 registry behaviour ──────────────────────────────────

    #[test]
    fn registry_can_be_constructed_and_starts_empty() {
        let reg = WsTerminalRegistry::new();
        assert_eq!(reg.len(), 0);
    }

    #[test]
    fn registry_lookup_enforces_device_ownership() {
        let reg = WsTerminalRegistry::new();
        // We can't easily insert a real PtySession from a test (it
        // needs a live PTY pair), so this test confirms only the
        // negative path. The integration test in `ws_terminal_test.rs`
        // covers the positive case.
        assert!(reg.lookup_for_device("missing", "device-a").is_none());
    }
}
