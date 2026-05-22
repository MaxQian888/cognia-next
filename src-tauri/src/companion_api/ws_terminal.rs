//! Companion WebSocket bridge for the integrated terminal —
//! `GET /ws/v1/terminal`.
//!
//! # Wire protocol (v1)
//!
//! 1. Client opens
//!    `wss://<host>/ws/v1/terminal?token=<jwt>&spawn=1&shell=…&rows=…&cols=…`.
//!    The `require_device_jwt` middleware verifies the JWT and injects
//!    [`super::middleware::DeviceContext`] before the handler runs.
//! 2. Server allocates a `PtySession` via
//!    [`crate::terminal::session::spawn_session_with_sink`], marks
//!    `origin = Remote`, and replies with a single text frame:
//!    `{"kind":"ready","sessionId":"<uuid>","shell":"<resolved>"}`.
//! 3. Steady state:
//!    * **Binary** frames Server→Client = PTY stdout (raw bytes).
//!    * **Binary** frames Client→Server = PTY stdin.
//!    * **Text** frames carry control envelopes:
//!      - `{"kind":"integration","event":…}` from OSC 633.
//!      - `{"kind":"exit","code":…}` once on exit.
//!      - `{"kind":"resize","rows":…,"cols":…}` (client→server).
//!      - `{"kind":"kill"}` (client→server).
//! 4. Server closes with code 1000 on clean exit. The drop of the
//!    handler-scoped `PtySession` kills any still-running child.
//!
//! # Threading
//!
//! The reader / waiter threads inside `PtySession` are OS threads;
//! they push events through an [`crate::terminal::session::EventSink`]
//! closure that the handler wraps around a
//! `tokio::sync::mpsc::UnboundedSender<TerminalEvent>`. The handler's
//! `tokio::select!` loop drains the receiver alongside incoming WS
//! frames, so one tokio task handles both directions.
//!
//! # Shell-integration scripts
//!
//! Remote sessions deliberately disable OSC 633 injection — the
//! integration scripts are local file paths the remote shell can't
//! resolve. A future v1.x can serve the scripts over the WS during the
//! handshake; for v1 we leave the prompt markers off and the mobile
//! dock renders the simpler "no-OSC" status (always `idle` until exit).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

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

#[derive(Debug, Deserialize)]
pub struct WsTerminalParams {
    /// Set to `"1"` for a fresh spawn. The `sessionId` reconnect path
    /// isn't wired yet (would need a process-wide registry shared with
    /// `crate::terminal::TerminalState`).
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
    /// Reconnect target. Currently unused — reserved for a future
    /// follow-up that shares `TerminalState` with the local dock.
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
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
    if params.spawn.as_deref() != Some("1") {
        send_error_and_close(&mut socket, "spawn=1 is required (reconnect is unwired)").await;
        return;
    }

    let req = match build_spawn_request(&params) {
        Ok(req) => req,
        Err(reason) => {
            send_error_and_close(&mut socket, &reason).await;
            return;
        }
    };

    let resolved_shell = req.shell.clone();
    let script_dir = resolve_script_dir();

    // Event pipe: reader/waiter threads push here; this task drains.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<TerminalEvent>();
    let sink: EventSink = Arc::new(move |event| {
        let _ = tx.send(event);
    });

    let session = match session::spawn_session_with_sink(req, &script_dir, sink) {
        Ok(s) => s,
        Err(reason) => {
            send_error_and_close(&mut socket, &reason).await;
            return;
        }
    };
    let session_id = session.id.clone();
    let session = Arc::new(session);

    // Ready handshake — clients block on this frame in
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
        return;
    }

    // Steady-state proxy: tokio::select! over PTY events vs WS frames.
    // Generous idle timeout — mobile clients can sit on stdin for
    // minutes while the user reads scrollback.
    let idle_timeout = Duration::from_secs(15 * 60);
    let mut idle_deadline = tokio::time::Instant::now() + idle_timeout;
    let mut exited = false;

    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some(TerminalEvent::Data { bytes }) => {
                        if socket.send(Message::Binary(bytes.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(TerminalEvent::Integration { event }) => {
                        let payload = json!({ "kind": "integration", "event": event });
                        if socket.send(Message::Text(payload.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Some(TerminalEvent::Exit { code }) => {
                        let payload = json!({ "kind": "exit", "code": code });
                        let _ = socket.send(Message::Text(payload.to_string().into())).await;
                        exited = true;
                        break;
                    }
                    None => {
                        // Sink dropped without an exit — sometimes happens
                        // when the child segfaults before the waiter ran.
                        // Treat as null-code exit.
                        let payload = json!({ "kind": "exit", "code": null });
                        let _ = socket.send(Message::Text(payload.to_string().into())).await;
                        exited = true;
                        break;
                    }
                }
            }
            msg = socket.recv() => {
                idle_deadline = tokio::time::Instant::now() + idle_timeout;
                match msg {
                    Some(Ok(Message::Binary(bytes))) => {
                        if session.write(&bytes).is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if let Err(reason) = handle_control_frame(text.as_str(), &session) {
                            log::warn!("ws_terminal: bad control frame: {reason}");
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

    if !exited {
        // Best-effort signal so we don't leak a half-detached child.
        let _ = session.kill();
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

fn handle_control_frame(text: &str, session: &PtySession) -> Result<(), String> {
    let frame: ControlFrame =
        serde_json::from_str(text).map_err(|e| format!("parse: {e}"))?;
    match frame {
        ControlFrame::Resize { rows, cols } => {
            session
                .resize(rows, cols)
                .map_err(|e| format!("resize: {e}"))?;
        }
        ControlFrame::Kill => {
            session.kill().map_err(|e| format!("kill: {e}"))?;
        }
    }
    Ok(())
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
    }

    #[test]
    fn ws_params_optional_fields_default_to_none() {
        let params: WsTerminalParams = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(params.spawn.is_none());
        assert!(params.shell.is_none());
        assert!(params.rows.is_none());
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
    /// real handler relies on. This exercises the type bounds without
    /// spinning a real PTY (which is covered by `session::tests`).
    #[test]
    fn event_sink_closure_is_send_sync_clonable() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<TerminalEvent>();
        let sink: EventSink = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        let cloned = sink.clone();
        cloned(TerminalEvent::Exit { code: Some(0) });
    }
}

