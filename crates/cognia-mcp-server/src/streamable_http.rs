//! Streamable-HTTP transport for the External Bridge MCP endpoint.
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
//! routes every emitted line to exactly one stream (the spec forbids
//! broadcasting a message across streams):
//!
//! - a JSON-RPC response goes only to the POST that sent the matching request;
//! - a progress notification goes to the POST whose request carried its
//!   `progressToken`;
//! - any other server-initiated message goes to one open GET channel, or, when
//!   none is open, to the oldest in-flight SSE POST.
//!
//! After `initialize`, requests must carry the negotiated `MCP-Protocol-Version`
//! (or omit it); any other value is rejected with 400. Admission is capped at
//! 128 active sessions; excess initialize requests fail explicitly with 503.
//! Bearer auth and the body-size limit are inherited from the router-level
//! layers in `http_server.rs`.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{Extension, State},
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
use tokio::sync::{mpsc, Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

use super::http_server::{stamp_client_authorization, AppState, ClientAuthorization};
use super::sidecar::{spawn_streaming_node, SidecarLines};

/// How long a streaming POST waits for the matching JSON-RPC response.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// Default idle TTL after which a session is reaped.
pub(crate) const DEFAULT_IDLE_TTL: Duration = Duration::from_secs(300);
/// Hard admission limit for active MCP sessions.
const MAX_ACTIVE_SESSIONS: usize = 128;
/// Header that carries the session id (MCP streamable-HTTP spec).
const SESSION_HEADER: &str = "mcp-session-id";
/// Messages a stream may hold unread. A client that stops reading must not
/// grow the host's memory: a full GET channel is closed (the client can
/// reconnect), and a POST drops further notifications but always keeps one
/// slot for its response.
const STREAM_QUEUE: usize = 256;
/// Header that carries the negotiated protocol version (MCP streamable-HTTP spec).
const PROTOCOL_VERSION_HEADER: &str = "mcp-protocol-version";

#[derive(Debug, thiserror::Error)]
enum SessionCreateError {
    #[error("MCP session capacity exceeded (maximum {max_sessions} active sessions)")]
    Overloaded { max_sessions: usize },
    #[error("{0}")]
    Spawn(String),
}

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

/// Where a session's outbound lines may go. Every line is delivered to at most
/// one receiver.
#[derive(Default)]
struct RouterState {
    /// In-flight requests by canonical JSON-RPC id.
    pending: HashMap<String, PendingRoute>,
    /// `progressToken` → id key of the request that announced it.
    progress: HashMap<String, String>,
    /// Open GET channels, oldest first.
    listeners: Vec<(u64, mpsc::Sender<String>)>,
    next_listener: u64,
    next_sequence: u64,
    /// Version agreed in the `initialize` exchange, once it has completed.
    protocol_version: Option<String>,
}

struct PendingRoute {
    tx: mpsc::Sender<String>,
    /// Whether the POST streams SSE and can carry related notifications.
    streams: bool,
    /// Admission order, so "the oldest in-flight SSE POST" is well defined.
    sequence: u64,
    /// This is the `initialize` request: record the negotiated version.
    initialize: bool,
    progress_token: Option<String>,
}

#[derive(Default)]
pub(crate) struct MessageRouter {
    state: Mutex<RouterState>,
}

/// What a request registration needs to know about the request.
struct RouteRequest {
    id: Value,
    streams: bool,
    initialize: bool,
    progress_token: Option<Value>,
}

impl MessageRouter {
    /// Register an in-flight request. Fails when the same id is already in
    /// flight: the second response could not be told apart from the first.
    fn register(
        self: &Arc<Self>,
        request: RouteRequest,
    ) -> Result<(PendingGuard, mpsc::Receiver<String>), String> {
        let key = id_key(&request.id);
        let mut state = self.state.lock();
        if state.pending.contains_key(&key) {
            return Err(format!("request id {key} is already in flight"));
        }
        let (tx, rx) = mpsc::channel(STREAM_QUEUE);
        let progress_token = request.progress_token.as_ref().map(id_key);
        if let Some(token) = &progress_token {
            state.progress.insert(token.clone(), key.clone());
        }
        let sequence = state.next_sequence;
        state.next_sequence += 1;
        state.pending.insert(
            key.clone(),
            PendingRoute {
                tx,
                streams: request.streams,
                sequence,
                initialize: request.initialize,
                progress_token,
            },
        );
        Ok((
            PendingGuard {
                router: Arc::clone(self),
                key,
            },
            rx,
        ))
    }

    fn listen(self: &Arc<Self>) -> (ListenerGuard, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel(STREAM_QUEUE);
        let mut state = self.state.lock();
        let id = state.next_listener;
        state.next_listener += 1;
        state.listeners.push((id, tx));
        (
            ListenerGuard {
                router: Arc::clone(self),
                id,
            },
            rx,
        )
    }

    fn protocol_version(&self) -> Option<String> {
        self.state.lock().protocol_version.clone()
    }

    fn remove_pending(state: &mut RouterState, key: &str) -> Option<PendingRoute> {
        let route = state.pending.remove(key)?;
        if let Some(token) = &route.progress_token {
            if state.progress.get(token).map(String::as_str) == Some(key) {
                state.progress.remove(token);
            }
        }
        Some(route)
    }

    /// Deliver one sidecar line to exactly one receiver, or drop it when no
    /// receiver may take it.
    fn route(&self, line: String) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            return;
        };
        let mut state = self.state.lock();
        let is_response = message.get("method").is_none();
        if is_response {
            let Some(id) = message.get("id").filter(|id| !id.is_null()) else {
                return;
            };
            let Some(route) = Self::remove_pending(&mut state, &id_key(id)) else {
                return;
            };
            if route.initialize {
                if let Some(version) = message
                    .pointer("/result/protocolVersion")
                    .and_then(Value::as_str)
                {
                    state.protocol_version = Some(version.to_string());
                }
            }
            // The reserved slot: notifications never take the last one.
            let _ = route.tx.try_send(line);
            return;
        }

        // A progress notification belongs to the request that asked for it.
        if let Some(token) = message.pointer("/params/progressToken") {
            let owner = state.progress.get(&id_key(token)).cloned();
            if let Some(route) = owner.and_then(|key| state.pending.get(&key)) {
                if route.streams {
                    send_notification(&route.tx, line);
                    return;
                }
            }
        }

        // Anything else: one open GET channel, else the oldest SSE POST.
        let mut line = line;
        while let Some((_, tx)) = state.listeners.first() {
            match tx.try_send(line) {
                Ok(()) => return,
                // Closed, or not reading: drop it so a live channel takes over.
                Err(mpsc::error::TrySendError::Full(back))
                | Err(mpsc::error::TrySendError::Closed(back)) => {
                    line = back;
                    state.listeners.remove(0);
                }
            }
        }
        if let Some(route) = state
            .pending
            .values()
            .filter(|route| route.streams && !route.tx.is_closed())
            .min_by_key(|route| route.sequence)
        {
            send_notification(&route.tx, line);
        }
    }
}

/// Queue a notification on a POST stream unless only the slot reserved for
/// its response is left; past that it is dropped (the client is not reading).
fn send_notification(tx: &mpsc::Sender<String>, line: String) {
    if tx.capacity() > 1 {
        let _ = tx.try_send(line);
    }
}

/// Removes a request's route when its POST finishes or its client goes away.
struct PendingGuard {
    router: Arc<MessageRouter>,
    key: String,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        let mut state = self.router.state.lock();
        MessageRouter::remove_pending(&mut state, &self.key);
    }
}

/// Removes a GET channel when its client disconnects.
struct ListenerGuard {
    router: Arc<MessageRouter>,
    id: u64,
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        self.router
            .state
            .lock()
            .listeners
            .retain(|(id, _)| *id != self.id);
    }
}

/// Canonical text of a JSON-RPC id or progress token (`1` and `"1"` differ).
fn id_key(id: &Value) -> String {
    id.to_string()
}

/// One live streamable-HTTP session: a dedicated sidecar child, its stdin
/// (write side, serialized), and the router for every line the child emits.
pub(crate) struct StreamSession {
    stdin: AsyncMutex<ChildStdin>,
    router: Arc<MessageRouter>,
    last_seen: Mutex<Instant>,
    client_id: String,
    /// Admission permit held until every in-flight user of the session drops
    /// its `Arc`, not merely until the registry entry is removed.
    _capacity_permit: OwnedSemaphorePermit,
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
    capacity: Arc<Semaphore>,
    max_sessions: usize,
}

impl SessionRegistry {
    pub(crate) fn new(spawner: Spawner, idle_ttl: Duration) -> Self {
        Self::with_capacity(spawner, idle_ttl, MAX_ACTIVE_SESSIONS)
    }

    pub(crate) fn with_capacity(spawner: Spawner, idle_ttl: Duration, max_sessions: usize) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            spawner,
            idle_ttl,
            capacity: Arc::new(Semaphore::new(max_sessions)),
            max_sessions,
        }
    }

    fn get(&self, id: &str) -> Option<Arc<StreamSession>> {
        self.sessions.lock().get(id).cloned()
    }

    fn remove(&self, id: &str, client_id: &str) -> bool {
        let mut sessions = self.sessions.lock();
        if sessions
            .get(id)
            .is_some_and(|session| session.client_id == client_id)
        {
            sessions.remove(id);
            true
        } else {
            false
        }
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

    /// Terminate every streaming session. Used when the Bridge client
    /// verifier set changes so an already-open SSE stream cannot outlive a
    /// credential rotation, revocation, or expiry update.
    pub(crate) fn close_all(&self) -> usize {
        let mut sessions = self.sessions.lock();
        let count = sessions.len();
        sessions.clear();
        count
    }

    /// Spawn a sidecar child + reader task and register a new session.
    async fn create_session(
        &self,
        client_id: String,
    ) -> Result<(String, Arc<StreamSession>), SessionCreateError> {
        let capacity_permit = Arc::clone(&self.capacity)
            .try_acquire_owned()
            .map_err(|_| SessionCreateError::Overloaded {
                max_sessions: self.max_sessions,
            })?;
        let (child, stdin, lines) = match &self.spawner {
            Spawner::Node {
                sidecar_path,
                settings_json,
                extra_env,
            } => spawn_streaming_node(sidecar_path, settings_json, extra_env)
                .await
                .map_err(|e| SessionCreateError::Spawn(e.to_string()))?,
            #[cfg(test)]
            Spawner::Echo => super::sidecar::spawn_streaming_echo()
                .await
                .map_err(|()| SessionCreateError::Spawn("node not available".to_string()))?,
        };

        let router = Arc::new(MessageRouter::default());
        spawn_reader(lines, Arc::clone(&router));

        let session = Arc::new(StreamSession {
            stdin: AsyncMutex::new(stdin),
            router,
            last_seen: Mutex::new(Instant::now()),
            client_id,
            _capacity_permit: capacity_permit,
            _child: child,
        });
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .insert(id.clone(), Arc::clone(&session));
        Ok((id, session))
    }
}

/// Drain the sidecar's stdout, routing each line. Ends on EOF / error so the
/// task can't outlive the child; dropping the router's senders then closes
/// every open stream.
fn spawn_reader(mut lines: SidecarLines, router: Arc<MessageRouter>) {
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
                    // Requests register their route before the matching
                    // write, so a response can't arrive ahead of its receiver.
                    router.route(trimmed);
                }
            }
        }
        let mut state = router.state.lock();
        state.pending.clear();
        state.progress.clear();
        state.listeners.clear();
    });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /mcp/stream`.
pub(crate) async fn post_handler(
    State(state): State<AppState>,
    Extension(authorization): Extension<ClientAuthorization>,
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
    // `id` absent or null → a notification. No `method` → the client's response
    // to a server request. Neither expects a response.
    let req_id = match value.get("id") {
        Some(Value::Null) | None => None,
        Some(_) if method.is_none() => None,
        Some(other) => Some(other.clone()),
    };

    let registry = &state.sessions;
    let header_sid = headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let (session, sid, is_new) = match header_sid {
        Some(sid) => match registry.get(&sid) {
            Some(s) if s.client_id == authorization.client_id => (s, sid, false),
            Some(_) => {
                return error_body(
                    StatusCode::FORBIDDEN,
                    "Mcp-Session-Id belongs to another client",
                )
            }
            None => return error_body(StatusCode::NOT_FOUND, "unknown Mcp-Session-Id"),
        },
        None => {
            if method != Some("initialize") {
                return error_body(
                    StatusCode::BAD_REQUEST,
                    "missing Mcp-Session-Id (send `initialize` first)",
                );
            }
            match registry
                .create_session(authorization.client_id.clone())
                .await
            {
                Ok((sid, s)) => (s, sid, true),
                Err(error @ SessionCreateError::Overloaded { .. }) => {
                    return error_body(StatusCode::SERVICE_UNAVAILABLE, &error.to_string())
                }
                Err(SessionCreateError::Spawn(error)) => {
                    return error_body(StatusCode::BAD_GATEWAY, &format!("session spawn: {error}"))
                }
            }
        }
    };
    session.touch();
    if !is_new && method != Some("initialize") {
        if let Some(response) = protocol_version_rejection(&headers, &session) {
            return response;
        }
    }

    let wants_sse = accepts_event_stream(&headers);
    // Register the route BEFORE writing so the matching response can't slip past.
    let route = match &req_id {
        Some(id) => match session.router.register(RouteRequest {
            id: id.clone(),
            streams: wants_sse,
            initialize: method == Some("initialize"),
            progress_token: value.pointer("/params/_meta/progressToken").cloned(),
        }) {
            Ok(route) => Some(route),
            Err(error) => return error_body(StatusCode::BAD_REQUEST, &error),
        },
        None => None,
    };
    let request_str = match stamp_client_authorization(&request_str, &authorization) {
        Ok(request) => request,
        Err(error) => return error_body(StatusCode::BAD_REQUEST, &error),
    };
    if let Err(e) = session.write_line(&request_str).await {
        return error_body(StatusCode::BAD_GATEWAY, &format!("sidecar error: {e}"));
    }

    // A notification or response gets no response — acknowledge per the spec.
    let Some((guard, rx)) = route else {
        let mut resp = StatusCode::ACCEPTED.into_response();
        if is_new {
            insert_session_header(&mut resp, &sid);
        }
        return resp;
    };

    if wants_sse {
        let stream = response_event_stream(rx, guard);
        let mut resp = Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response();
        if is_new {
            insert_session_header(&mut resp, &sid);
        }
        resp
    } else {
        let result = await_response(rx, RESPONSE_TIMEOUT).await;
        drop(guard);
        match result {
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
pub(crate) async fn get_handler(
    State(state): State<AppState>,
    Extension(authorization): Extension<ClientAuthorization>,
    headers: HeaderMap,
) -> Response {
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
    if session.client_id != authorization.client_id {
        return error_body(
            StatusCode::FORBIDDEN,
            "Mcp-Session-Id belongs to another client",
        );
    }
    if let Some(response) = protocol_version_rejection(&headers, &session) {
        return response;
    }
    session.touch();
    // Server-initiated messages only; responses always go to their own POST.
    let (guard, rx) = session.router.listen();
    let stream = listener_event_stream(rx, guard);
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

/// `DELETE /mcp/stream` — end the session (kills the sidecar child on drop).
pub(crate) async fn delete_handler(
    State(state): State<AppState>,
    Extension(authorization): Extension<ClientAuthorization>,
    headers: HeaderMap,
) -> Response {
    let Some(sid) = headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
    else {
        return error_body(StatusCode::BAD_REQUEST, "missing Mcp-Session-Id");
    };
    if let Some(session) = state.sessions.get(&sid) {
        if session.client_id == authorization.client_id {
            if let Some(response) = protocol_version_rejection(&headers, &session) {
                return response;
            }
        }
    }
    if state.sessions.remove(&sid, &authorization.client_id) {
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

/// The 400 for a request whose `MCP-Protocol-Version` is not the version
/// this session negotiated. An absent header is allowed (the spec tells servers to
/// assume a default), as is any header before `initialize` has completed.
fn protocol_version_rejection(headers: &HeaderMap, session: &StreamSession) -> Option<Response> {
    let value = headers.get(PROTOCOL_VERSION_HEADER)?;
    let negotiated = session.router.protocol_version()?;
    match value.to_str() {
        Ok(version) if version.trim() == negotiated => None,
        Ok(version) => Some(error_body(
            StatusCode::BAD_REQUEST,
            &format!(
                "unsupported MCP-Protocol-Version {version:?}; this session negotiated {negotiated:?}"
            ),
        )),
        Err(_) => Some(error_body(
            StatusCode::BAD_REQUEST,
            "MCP-Protocol-Version must be visible ASCII",
        )),
    }
}

/// SSE stream for one POST: related notifications, then the response, then
/// the end of the stream. The guard keeps the route registered until the
/// stream is dropped (response delivered or client gone).
fn response_event_stream(
    rx: mpsc::Receiver<String>,
    guard: PendingGuard,
) -> impl Stream<Item = Result<Event, Infallible>> {
    stream::unfold((rx, guard, false), |(mut rx, guard, done)| async move {
        if done {
            return None;
        }
        let line = rx.recv().await?;
        let is_final = is_response_line(&line);
        Some((Ok(Event::default().data(line)), (rx, guard, is_final)))
    })
}

/// SSE stream for one GET channel. Never ends on its own; the guard removes
/// the channel from the router when the client disconnects.
fn listener_event_stream(
    rx: mpsc::Receiver<String>,
    guard: ListenerGuard,
) -> impl Stream<Item = Result<Event, Infallible>> {
    stream::unfold((rx, guard), |(mut rx, guard)| async move {
        let line = rx.recv().await?;
        Some((Ok(Event::default().data(line)), (rx, guard)))
    })
}

/// Whether a routed line is a JSON-RPC response (no `method`).
fn is_response_line(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .map(|value| value.get("method").is_none())
        .unwrap_or(false)
}

/// Await the response routed to this request, skipping related notifications
/// (a JSON reply cannot carry them), bounded by `timeout`.
async fn await_response(
    mut rx: mpsc::Receiver<String>,
    timeout: Duration,
) -> Result<String, String> {
    let fut = async {
        while let Some(line) = rx.recv().await {
            if is_response_line(&line) {
                return Ok(line);
            }
        }
        Err("sidecar closed before responding".to_string())
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

    fn request(id: Value, streams: bool) -> RouteRequest {
        RouteRequest {
            id,
            streams,
            initialize: false,
            progress_token: None,
        }
    }

    #[test]
    fn response_reaches_only_its_request_never_a_listener() {
        let router = Arc::new(MessageRouter::default());
        let (_a_guard, mut a) = router.register(request(json!(1), true)).unwrap();
        let (_b_guard, mut b) = router.register(request(json!(2), true)).unwrap();
        let (_l1_guard, mut l1) = router.listen();
        let (_l2_guard, mut l2) = router.listen();

        router.route(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.into());

        assert!(a.try_recv().unwrap().contains(r#""id":1"#));
        assert!(b.try_recv().is_err());
        assert!(l1.try_recv().is_err());
        assert!(l2.try_recv().is_err());
        // Delivered once: the route is gone, a duplicate line goes nowhere.
        router.route(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.into());
        assert!(a.try_recv().is_err());
    }

    #[test]
    fn numeric_and_string_ids_are_distinct_routes() {
        let router = Arc::new(MessageRouter::default());
        let (_n_guard, mut numeric) = router.register(request(json!(7), false)).unwrap();
        let (_s_guard, mut text) = router.register(request(json!("7"), false)).unwrap();
        router.route(r#"{"jsonrpc":"2.0","id":"7","result":{}}"#.into());
        assert!(numeric.try_recv().is_err());
        assert!(text.try_recv().is_ok());
    }

    #[test]
    fn duplicate_in_flight_id_is_rejected_until_the_first_finishes() {
        let router = Arc::new(MessageRouter::default());
        let (guard, _rx) = router.register(request(json!(5), true)).unwrap();
        assert!(router.register(request(json!(5), true)).is_err());
        drop(guard);
        assert!(router.register(request(json!(5), true)).is_ok());
    }

    #[test]
    fn server_message_goes_to_exactly_one_listener() {
        let router = Arc::new(MessageRouter::default());
        let (_post_guard, mut post) = router.register(request(json!(1), true)).unwrap();
        let (l1_guard, mut l1) = router.listen();
        let (_l2_guard, mut l2) = router.listen();

        router.route(r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#.into());
        assert!(l1.try_recv().is_ok());
        assert!(l2.try_recv().is_err());
        assert!(post.try_recv().is_err());

        // A disconnected channel stops receiving; the next one takes over.
        drop(l1_guard);
        drop(l1);
        router.route(r#"{"jsonrpc":"2.0","method":"notifications/message"}"#.into());
        assert!(l2.try_recv().is_ok());
    }

    #[test]
    fn progress_follows_its_token_to_the_originating_stream() {
        let router = Arc::new(MessageRouter::default());
        let (_a_guard, mut a) = router
            .register(RouteRequest {
                progress_token: Some(json!("tok-a")),
                ..request(json!(1), true)
            })
            .unwrap();
        let (_b_guard, mut b) = router.register(request(json!(2), true)).unwrap();
        let (_l_guard, mut listener) = router.listen();

        router.route(
            r#"{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"tok-a","progress":1}}"#
                .into(),
        );
        assert!(a.try_recv().unwrap().contains("tok-a"));
        assert!(b.try_recv().is_err());
        assert!(listener.try_recv().is_err());
    }

    #[test]
    fn without_a_listener_server_messages_go_to_the_oldest_streaming_post_only() {
        let router = Arc::new(MessageRouter::default());
        let (_json_guard, mut json_post) = router.register(request(json!(1), false)).unwrap();
        let (_old_guard, mut oldest) = router.register(request(json!(2), true)).unwrap();
        let (_new_guard, mut newest) = router.register(request(json!(3), true)).unwrap();

        router.route(r#"{"jsonrpc":"2.0","method":"notifications/message"}"#.into());
        assert!(json_post.try_recv().is_err());
        assert!(oldest.try_recv().is_ok());
        assert!(newest.try_recv().is_err());
    }

    #[test]
    fn a_listener_that_stops_reading_is_closed_and_the_next_one_takes_over() {
        let router = Arc::new(MessageRouter::default());
        let (_stalled_guard, mut stalled) = router.listen();
        let (_live_guard, mut live) = router.listen();
        let note = r#"{"jsonrpc":"2.0","method":"notifications/message"}"#;
        for _ in 0..STREAM_QUEUE {
            router.route(note.into());
        }
        assert!(live.try_recv().is_err(), "the first channel still had room");

        router.route(note.into());
        assert!(
            live.try_recv().is_ok(),
            "the overflow went to the live channel"
        );
        assert_eq!(router.state.lock().listeners.len(), 1);
        // The stalled client reads what was queued, then its stream ends.
        let mut drained = 0;
        while stalled.try_recv().is_ok() {
            drained += 1;
        }
        assert_eq!(drained, STREAM_QUEUE);
        assert!(matches!(
            stalled.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn a_flood_of_notifications_never_crowds_out_the_response() {
        let router = Arc::new(MessageRouter::default());
        let (_guard, mut rx) = router
            .register(RouteRequest {
                progress_token: Some(json!("t")),
                ..request(json!(1), true)
            })
            .unwrap();
        for _ in 0..STREAM_QUEUE * 4 {
            router.route(
                r#"{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"t"}}"#
                    .into(),
            );
        }
        router.route(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.into());
        let mut last = None;
        let mut count = 0;
        while let Ok(line) = rx.try_recv() {
            count += 1;
            last = Some(line);
        }
        assert_eq!(count, STREAM_QUEUE);
        assert!(last.unwrap().contains(r#""id":1"#));
    }

    #[test]
    fn dropping_a_request_guard_releases_its_route_and_token() {
        let router = Arc::new(MessageRouter::default());
        let (guard, _rx) = router
            .register(RouteRequest {
                progress_token: Some(json!(9)),
                ..request(json!(1), true)
            })
            .unwrap();
        drop(guard);
        let state = router.state.lock();
        assert!(state.pending.is_empty());
        assert!(state.progress.is_empty());
    }

    #[test]
    fn initialize_response_records_the_negotiated_version() {
        let router = Arc::new(MessageRouter::default());
        assert_eq!(router.protocol_version(), None);
        let (_guard, _rx) = router
            .register(RouteRequest {
                initialize: true,
                ..request(json!(0), true)
            })
            .unwrap();
        router
            .route(r#"{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25"}}"#.into());
        assert_eq!(router.protocol_version().as_deref(), Some("2025-11-25"));
    }

    #[test]
    fn accepts_event_stream_reads_accept_header() {
        let mut h = HeaderMap::new();
        h.insert(
            axum::http::header::ACCEPT,
            "text/event-stream".parse().unwrap(),
        );
        assert!(accepts_event_stream(&h));
        let mut h2 = HeaderMap::new();
        h2.insert(
            axum::http::header::ACCEPT,
            "application/json".parse().unwrap(),
        );
        assert!(!accepts_event_stream(&h2));
        assert!(!accepts_event_stream(&HeaderMap::new()));
    }

    #[tokio::test]
    async fn create_session_registers_and_routes_the_matching_response() {
        let Ok(()) = node_available().await else {
            return;
        };
        let reg = echo_registry();
        let (_sid, session) = reg
            .create_session("client-a".into())
            .await
            .expect("create session");
        assert_eq!(reg.len(), 1);

        let (_guard, rx) = session
            .router
            .register(RouteRequest {
                initialize: true,
                ..request(json!(1), false)
            })
            .unwrap();
        session
            .write_line(
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}"#,
            )
            .await
            .expect("write");
        let line = await_response(rx, Duration::from_secs(5))
            .await
            .expect("matching response");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["method"], "initialize");
        assert_eq!(
            session.router.protocol_version().as_deref(),
            Some("2025-11-25")
        );
    }

    #[tokio::test]
    async fn await_response_skips_related_notifications() {
        let Ok(()) = node_available().await else {
            return;
        };
        let reg = echo_registry();
        let (_sid, session) = reg.create_session("client-a".into()).await.expect("create");
        let (_guard, rx) = session
            .router
            .register(RouteRequest {
                progress_token: Some(json!("p")),
                ..request(json!(42), true)
            })
            .unwrap();
        // The responder emits a progress notification, then the response.
        session
            .write_line(
                r#"{"jsonrpc":"2.0","id":42,"method":"tools/list","params":{"_meta":{"progressToken":"p"}}}"#,
            )
            .await
            .unwrap();
        let line = await_response(rx, Duration::from_secs(5))
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
        let reg = Arc::new(SessionRegistry::new(
            Spawner::Echo,
            Duration::from_millis(0),
        ));
        let _ = reg.create_session("client-a".into()).await.expect("create");
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
        assert!(!reg.remove("does-not-exist", "client-a"));
    }

    #[tokio::test]
    async fn close_all_drops_every_client_bound_session() {
        let reg = echo_registry();
        if reg.create_session("client-a".into()).await.is_err() {
            return;
        }
        if reg.create_session("client-b".into()).await.is_err() {
            return;
        }

        assert_eq!(reg.close_all(), 2);
        assert_eq!(reg.len(), 0);
    }

    #[tokio::test]
    async fn session_capacity_rejects_overload_and_recovers_after_delete() {
        let Ok(()) = node_available().await else {
            return;
        };
        let reg = Arc::new(SessionRegistry::with_capacity(
            Spawner::Echo,
            DEFAULT_IDLE_TTL,
            1,
        ));
        let (first_id, first) = reg
            .create_session("client-a".into())
            .await
            .expect("first session");

        let overloaded = match reg.create_session("client-b".into()).await {
            Ok(_) => panic!("second session must be rejected at capacity"),
            Err(error) => error,
        };
        assert!(matches!(
            overloaded,
            SessionCreateError::Overloaded { max_sessions: 1 }
        ));

        assert!(reg.remove(&first_id, "client-a"));
        drop(first);
        reg.create_session("client-b".into())
            .await
            .expect("capacity is released when a session is deleted");
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
