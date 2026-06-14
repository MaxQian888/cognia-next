//! Streamable-HTTP (and legacy SSE-alias) transport for the External Bridge
//! MCP endpoint.
//!
//! The legacy `POST /mcp` path is a strictly sequential one-line-in /
//! one-line-out round-trip behind a single mutex — it cannot carry
//! server→client notifications, batched responses, or the per-session
//! semantics newer MCP clients (Cursor, recent Claude Code) prefer.
//!
//! This module implements the modern streamable-HTTP transport:
//!
//! - `POST /mcp/stream` — JSON-RPC request. The first `initialize` (sent with
//!   no `Mcp-Session-Id`) creates a session backed by a dedicated stdio
//!   sidecar and replies with an `Mcp-Session-Id` header. Subsequent requests
//!   carry that header. A request with `Accept: text/event-stream` gets an SSE
//!   stream (notifications + the final response); otherwise it gets a single
//!   JSON body. A notification (no `id`) is forwarded and answered `202`.
//! - `GET  /mcp/stream` — long-lived SSE channel for server-initiated messages.
//! - `DELETE /mcp/stream` — end the session (kills the sidecar child).
//!
//! Each session owns ONE Node sidecar with an independent reader task that
//! broadcasts every emitted line, so both the POST-response path and the GET
//! channel observe responses + notifications. Bearer auth and the body-size
//! limit are inherited from the router-level layers in `http_server.rs`.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures_util::stream::{self, Stream};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{broadcast, Mutex as AsyncMutex};
use tokio::time::Instant;

use super::http_server::AppState;
use super::sidecar::{spawn_streaming_node, SidecarLines};

/// How long a streaming POST waits for the matching JSON-RPC response.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// Default idle TTL after which a session is reaped.
pub(crate) const DEFAULT_IDLE_TTL: Duration = Duration::from_secs(300);
/// Header that carries the session id (MCP streamable-HTTP spec).
const SESSION_HEADER: &str = "mcp-session-id";

/// How a session's sidecar child is launched. Production spawns the real Node
/// bridge; tests use an inline echo process.
pub(crate) enum Spawner {
    Node {
        sidecar_path: String,
        settings_json: String,
        extra_env: Vec<(String, String)>,
    },
    #[cfg(test)]
    Echo,
}

/// One live streamable-HTTP session: a dedicated sidecar child, its stdin
/// (write side, serialized), and a broadcast of every line the child emits.
pub(crate) struct StreamSession {
    stdin: AsyncMutex<ChildStdin>,
    tx: broadcast::Sender<String>,
    last_seen: Mutex<Instant>,
    /// Kept alive so `kill_on_drop` terminates the child when the session is
    /// removed from the registry.
    _child: Child,
}

impl StreamSession {
    fn touch(&self) {
        *self.last_seen.lock() = Instant::now();
    }

    async fn write_line(&self, request: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let line = format!("{request}\n");
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write to sidecar failed: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush sidecar failed: {e}"))?;
        Ok(())
    }
}

/// Registry of live streaming sessions plus the spawner used to create them.
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, Arc<StreamSession>>>,
    spawner: Spawner,
    idle_ttl: Duration,
}

impl SessionRegistry {
    pub(crate) fn new(spawner: Spawner, idle_ttl: Duration) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            spawner,
            idle_ttl,
        }
    }

    fn get(&self, id: &str) -> Option<Arc<StreamSession>> {
        self.sessions.lock().get(id).cloned()
    }

    fn remove(&self, id: &str) -> bool {
        self.sessions.lock().remove(id).is_some()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.sessions.lock().len()
    }

    /// Drop every session whose `last_seen` is older than the idle TTL. The
    /// removed sessions' children are killed on drop. Returns the count reaped.
    pub(crate) fn reap_idle(&self) -> usize {
        let now = Instant::now();
        let ttl = self.idle_ttl;
        let mut guard = self.sessions.lock();
        let stale: Vec<String> = guard
            .iter()
            .filter(|(_, s)| now.duration_since(*s.last_seen.lock()) > ttl)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &stale {
            guard.remove(id);
        }
        stale.len()
    }

    /// Spawn a sidecar child + reader task and register a new session.
    async fn create_session(&self) -> Result<(String, Arc<StreamSession>), String> {
        let (child, stdin, lines) = match &self.spawner {
            Spawner::Node {
                sidecar_path,
                settings_json,
                extra_env,
            } => spawn_streaming_node(sidecar_path, settings_json, extra_env)
                .await
                .map_err(|e| e.to_string())?,
            #[cfg(test)]
            Spawner::Echo => super::sidecar::spawn_streaming_echo()
                .await
                .map_err(|()| "node not available".to_string())?,
        };

        let (tx, _rx) = broadcast::channel::<String>(256);
        spawn_reader(lines, tx.clone());

        let session = Arc::new(StreamSession {
            stdin: AsyncMutex::new(stdin),
            tx,
            last_seen: Mutex::new(Instant::now()),
            _child: child,
        });
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().insert(id.clone(), Arc::clone(&session));
        Ok((id, session))
    }
}

/// Drain the sidecar's stdout, broadcasting each line. Ends on EOF / error so
/// the task can't outlive the child.
fn spawn_reader(mut lines: SidecarLines, tx: broadcast::Sender<String>) {
    tokio::spawn(async move {
        let mut line = String::new();
        loop {
            line.clear();
            match lines.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches('\n').to_string();
                    if trimmed.is_empty() {
                        continue;
                    }
                    // No receivers yet is fine — `recv` subscribers attach
                    // before the matching write in the request path.
                    let _ = tx.send(trimmed);
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /mcp/stream` (and the `/mcp/sse` back-compat alias).
pub async fn post_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request_str = match std::str::from_utf8(&body) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return error_body(StatusCode::BAD_REQUEST, "request body must be UTF-8"),
    };
    if request_str.is_empty() {
        return error_body(StatusCode::BAD_REQUEST, "request body required");
    }
    let value: Value = match serde_json::from_str(&request_str) {
        Ok(v) => v,
        Err(e) => return error_body(StatusCode::BAD_REQUEST, &format!("invalid JSON: {e}")),
    };
    let method = value.get("method").and_then(Value::as_str);
    // `id` absent or null → a notification (no response expected).
    let req_id = match value.get("id") {
        Some(Value::Null) | None => None,
        Some(other) => Some(other.clone()),
    };

    let registry = &state.sessions;
    let header_sid = headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let (session, sid, is_new) = match header_sid {
        Some(sid) => match registry.get(&sid) {
            Some(s) => (s, sid, false),
            None => return error_body(StatusCode::NOT_FOUND, "unknown Mcp-Session-Id"),
        },
        None => {
            if method != Some("initialize") {
                return error_body(
                    StatusCode::BAD_REQUEST,
                    "missing Mcp-Session-Id (send `initialize` first)",
                );
            }
            match registry.create_session().await {
                Ok((sid, s)) => (s, sid, true),
                Err(e) => {
                    return error_body(StatusCode::BAD_GATEWAY, &format!("session spawn: {e}"))
                }
            }
        }
    };
    session.touch();

    // Subscribe BEFORE writing so the matching response can't slip past.
    let rx = session.tx.subscribe();
    if let Err(e) = session.write_line(&request_str).await {
        return error_body(StatusCode::BAD_GATEWAY, &format!("sidecar error: {e}"));
    }

    // A notification gets no response — acknowledge per the streamable-HTTP spec.
    if req_id.is_none() {
        let mut resp = StatusCode::ACCEPTED.into_response();
        if is_new {
            insert_session_header(&mut resp, &sid);
        }
        return resp;
    }

    let wants_sse = accepts_event_stream(&headers);
    if wants_sse {
        let stream = response_event_stream(rx, req_id);
        let mut resp = Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response();
        if is_new {
            insert_session_header(&mut resp, &sid);
        }
        resp
    } else {
        match await_matching(rx, req_id, RESPONSE_TIMEOUT).await {
            Ok(line) => {
                let raw: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                let mut resp = (StatusCode::OK, Json(raw)).into_response();
                if is_new {
                    insert_session_header(&mut resp, &sid);
                }
                resp
            }
            Err(e) => error_body(StatusCode::GATEWAY_TIMEOUT, &e),
        }
    }
}

/// `GET /mcp/stream` — long-lived SSE channel for server-initiated messages.
pub async fn get_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(sid) = headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
    else {
        return error_body(StatusCode::BAD_REQUEST, "missing Mcp-Session-Id");
    };
    let Some(session) = state.sessions.get(&sid) else {
        return error_body(StatusCode::NOT_FOUND, "unknown Mcp-Session-Id");
    };
    session.touch();
    // No request id → never terminates; every line is forwarded as an event.
    let stream = response_event_stream(session.tx.subscribe(), None);
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// `DELETE /mcp/stream` — end the session (kills the sidecar child on drop).
pub async fn delete_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(sid) = headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
    else {
        return error_body(StatusCode::BAD_REQUEST, "missing Mcp-Session-Id");
    };
    if state.sessions.remove(&sid) {
        StatusCode::NO_CONTENT.into_response()
    } else {
        error_body(StatusCode::NOT_FOUND, "unknown Mcp-Session-Id")
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn accepts_event_stream(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/event-stream"))
        .unwrap_or(false)
}

fn insert_session_header(resp: &mut Response, sid: &str) {
    if let Ok(value) = sid.parse() {
        resp.headers_mut().insert(SESSION_HEADER, value);
    }
}

/// Whether `line`'s JSON-RPC `id` equals `req_id`.
fn line_matches_id(line: &str, req_id: &Value) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .map(|got| &got == req_id)
        .unwrap_or(false)
}

/// Build an SSE stream that forwards every broadcast line as a `data:` event.
/// When `req_id` is set, the stream ends right after the matching response.
fn response_event_stream(
    rx: broadcast::Receiver<String>,
    req_id: Option<Value>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    stream::unfold((rx, req_id, false), |(mut rx, req_id, done)| async move {
        if done {
            return None;
        }
        loop {
            match rx.recv().await {
                Ok(line) => {
                    let is_final = req_id
                        .as_ref()
                        .map(|id| line_matches_id(&line, id))
                        .unwrap_or(false);
                    let event = Event::default().data(line);
                    return Some((Ok(event), (rx, req_id, is_final)));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
}

/// Await the broadcast line whose JSON-RPC `id` matches `req_id`, bounded by
/// `timeout`. Notifications (non-matching ids) are skipped.
async fn await_matching(
    mut rx: broadcast::Receiver<String>,
    req_id: Option<Value>,
    timeout: Duration,
) -> Result<String, String> {
    let fut = async {
        loop {
            match rx.recv().await {
                Ok(line) => {
                    let matches = req_id
                        .as_ref()
                        .map(|id| line_matches_id(&line, id))
                        .unwrap_or(true);
                    if matches {
                        return Ok(line);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => {
                    return Err("sidecar closed before responding".to_string())
                }
            }
        }
    };
    match tokio::time::timeout(timeout, fut).await {
        Ok(res) => res,
        Err(_) => Err("timed out waiting for sidecar response".to_string()),
    }
}

fn error_body(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn echo_registry() -> Arc<SessionRegistry> {
        Arc::new(SessionRegistry::new(Spawner::Echo, DEFAULT_IDLE_TTL))
    }

    #[test]
    fn line_matches_id_compares_jsonrpc_id() {
        assert!(line_matches_id(r#"{"id":7,"result":{}}"#, &json!(7)));
        assert!(!line_matches_id(r#"{"id":8,"result":{}}"#, &json!(7)));
        assert!(!line_matches_id(r#"{"method":"x"}"#, &json!(7)));
    }

    #[test]
    fn accepts_event_stream_reads_accept_header() {
        let mut h = HeaderMap::new();
        h.insert(axum::http::header::ACCEPT, "text/event-stream".parse().unwrap());
        assert!(accepts_event_stream(&h));
        let mut h2 = HeaderMap::new();
        h2.insert(axum::http::header::ACCEPT, "application/json".parse().unwrap());
        assert!(!accepts_event_stream(&h2));
        assert!(!accepts_event_stream(&HeaderMap::new()));
    }

    #[tokio::test]
    async fn create_session_registers_and_echoes_matching_response() {
        let Ok(()) = node_available().await else {
            return;
        };
        let reg = echo_registry();
        let (_sid, session) = reg.create_session().await.expect("create session");
        assert_eq!(reg.len(), 1);

        let rx = session.tx.subscribe();
        session
            .write_line(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#)
            .await
            .expect("write");
        let line = await_matching(rx, Some(json!(1)), Duration::from_secs(5))
            .await
            .expect("matching response");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["id"], 1);
        assert_eq!(v["method"], "initialize");
    }

    #[tokio::test]
    async fn await_matching_skips_notifications() {
        let Ok(()) = node_available().await else {
            return;
        };
        let reg = echo_registry();
        let (_sid, session) = reg.create_session().await.expect("create");
        let rx = session.tx.subscribe();
        // A notification (no id) then the real response — only the latter matches.
        session
            .write_line(r#"{"jsonrpc":"2.0","method":"notifications/progress"}"#)
            .await
            .unwrap();
        session
            .write_line(r#"{"jsonrpc":"2.0","id":42,"method":"tools/list"}"#)
            .await
            .unwrap();
        let line = await_matching(rx, Some(json!(42)), Duration::from_secs(5))
            .await
            .expect("matching");
        assert!(line.contains("\"id\":42"));
    }

    #[tokio::test]
    async fn reap_idle_removes_stale_sessions() {
        let Ok(()) = node_available().await else {
            return;
        };
        // Zero TTL → every session is immediately stale.
        let reg = Arc::new(SessionRegistry::new(Spawner::Echo, Duration::from_millis(0)));
        let _ = reg.create_session().await.expect("create");
        assert_eq!(reg.len(), 1);
        // Let `last_seen` fall strictly behind `now`.
        tokio::time::sleep(Duration::from_millis(5)).await;
        let reaped = reg.reap_idle();
        assert_eq!(reaped, 1);
        assert_eq!(reg.len(), 0);
    }

    #[tokio::test]
    async fn remove_unknown_session_is_false() {
        let reg = echo_registry();
        assert!(!reg.remove("does-not-exist"));
    }

    /// Probe whether `node` is on PATH (the echo spawner needs it).
    async fn node_available() -> Result<(), ()> {
        match tokio::process::Command::new("node")
            .arg("-e")
            .arg("process.exit(0)")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
        {
            Ok(s) if s.success() => Ok(()),
            _ => Err(()),
        }
    }
}
