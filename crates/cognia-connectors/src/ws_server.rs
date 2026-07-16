//! Axum WebSocket route for OneBot reverse-WS adapters.
//!
//! Route: `/ws/onebot/:adapter_id`
//! Auth:  `Authorization: Bearer <token>` — token stored in keyring at
//!        service `com.cognia.platforms`, account `<adapter_id>:onebotBearer`.
//!
//! When the bearer token is absent or wrong, the upgrade is rejected with 401.
//!
//! Once upgraded, the socket emits through the shared connector event sink,
//! honouring the contract the TS adapter (`lib/connectors/adapters/onebot/
//! transport-reverse-ws.ts`) subscribes to:
//!
//!   emit  `connectors://onebot/<id>/open`              — on upgrade
//!   emit  `connectors://onebot/<id>/event`    <frame>  — inbound event push
//!   emit  `connectors://onebot/<id>/response` <frame>  — inbound API response
//!   emit  `connectors://onebot/<id>/close`             — on disconnect
//!   command `connectors_onebot_send`          <call>   — outbound RPC → WS
//!
//! OneBot multiplexes API responses (carry an `echo` field) and event pushes
//! (no `echo`) on the one socket, so each inbound frame is routed by inspecting
//! `echo`. This mirrors the outbound bridge in `ws_client.rs` (split socket +
//! mpsc pump + per-connection event plumbing).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Extension, Path, State, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;
use uuid::Uuid;

use super::axum_app::{EmitterExt, EventEmitter};
use super::state::ConnectorsState;
use super::types::OneBotLiveClient;

struct LiveClient {
    connected_at_ms: u64,
    connection_id: Uuid,
    tx: mpsc::Sender<Message>,
}

/// Live reverse-WS client registry: `adapter_id` → active socket sender.
/// Populated on a successful upgrade and cleared on disconnect, so the OneBot
/// settings UI can probe which adapters actually have a client dialed in.
/// Keyed by `adapter_id` (a reconnect overwrites the timestamp); the disconnect
/// cleanup only removes the entry when the closing socket is still the current
/// connection.
static ONEBOT_LIVE_CLIENTS: OnceLock<Arc<Mutex<HashMap<String, LiveClient>>>> = OnceLock::new();

fn live_client_map() -> &'static Arc<Mutex<HashMap<String, LiveClient>>> {
    ONEBOT_LIVE_CLIENTS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Snapshot of the OneBot reverse-WS clients with a live connection. Read by
/// the `connectors_onebot_probe` Tauri command.
pub fn live_clients() -> Vec<OneBotLiveClient> {
    live_client_map()
        .lock()
        .unwrap()
        .iter()
        .map(|(adapter_id, client)| OneBotLiveClient {
            adapter_id: adapter_id.clone(),
            connected_at_ms: client.connected_at_ms,
        })
        .collect()
}

/// Queue an API call on the currently connected reverse-WS client.
pub async fn send(adapter_id: &str, call_json: String) -> Result<(), String> {
    let tx = live_client_map()
        .lock()
        .unwrap()
        .get(adapter_id)
        .map(|client| client.tx.clone())
        .ok_or_else(|| format!("OneBot adapter '{adapter_id}' has no connected client"))?;
    tx.send(Message::Text(call_json.into()))
        .await
        .map_err(|e| format!("OneBot send failed: {e}"))
}

/// Where an inbound reverse-WS frame should be forwarded.
#[derive(Debug, PartialEq, Eq)]
enum FrameRoute {
    /// API call response (has an `echo` field) → `/response`.
    Response,
    /// Event push (no `echo`) → `/event`.
    Event,
    /// Non-JSON frame → dropped (the TS subscribers JSON-parse and ignore parse
    /// failures, so forwarding would be wasted work).
    Drop,
}

/// Classify an inbound text frame. AppHandle-free so it is unit-testable
/// without a running Tauri app (cf. `verify_webhook` in `axum_app.rs`).
fn route_frame(text: &str) -> FrameRoute {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) => {
            if value.get("echo").is_some() {
                FrameRoute::Response
            } else {
                FrameRoute::Event
            }
        }
        Err(_) => FrameRoute::Drop,
    }
}

/// Register the `/ws/onebot/:adapter_id` route on the supplied router.
pub fn register_routes(router: Router<ConnectorsState>) -> Router<ConnectorsState> {
    router.route("/ws/onebot/{adapter_id}", get(ws_onebot_handler))
}

/// Constant-time bearer comparison. Length is compared first (the length of a
/// secret is not itself secret) so `ct_eq` only runs on equal-length inputs.
fn bearer_matches(expected: &str, supplied: &str) -> bool {
    let e = expected.as_bytes();
    let s = supplied.as_bytes();
    e.len() == s.len() && e.ct_eq(s).unwrap_u8() == 1
}

/// Pure authorization decision for an inbound OneBot reverse-WS connection.
///
/// **Fail-closed**: when no bearer is configured (`expected == None`) the
/// connection is rejected unless the operator has *explicitly* opted into
/// unauthenticated mode. Previously a missing bearer silently accepted any
/// peer, letting anyone who could reach the listener inject forged platform
/// events into the AI loop. A truthy `onebotAllowUnauthenticated` keyring entry
/// restores the old behavior for trusted localhost instances (NapCat/Lagrange)
/// that genuinely run without an access token.
fn authorize_onebot(expected: Option<&str>, allow_unauthenticated: bool, supplied: &str) -> bool {
    match expected {
        Some(token) => bearer_matches(token, supplied),
        None => allow_unauthenticated,
    }
}

async fn ws_onebot_handler(
    State(_state): State<ConnectorsState>,
    Path(adapter_id): Path<String>,
    emitter_ext: Option<Extension<EmitterExt>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let emitter = emitter_ext.map(|Extension(EmitterExt(emitter))| emitter);

    // Read the expected bearer from keyring.
    let expected_token = match super::keyring::get(&adapter_id, "onebotBearer") {
        Ok(t) => t,
        Err(e) => {
            log::warn!("ws_server: keyring error for {adapter_id}: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "keyring error").into_response();
        }
    };

    // Explicit opt-in for the no-bearer case (fail-closed by default).
    let allow_unauthenticated = expected_token.is_none()
        && matches!(
            super::keyring::get(&adapter_id, "onebotAllowUnauthenticated")
                .ok()
                .flatten()
                .as_deref(),
            Some("1") | Some("true")
        );

    let supplied = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    if !authorize_onebot(expected_token.as_deref(), allow_unauthenticated, supplied) {
        if expected_token.is_none() {
            log::warn!(
                "ws_server: rejecting unauthenticated OneBot connection for {adapter_id}: \
                 no onebotBearer configured and onebotAllowUnauthenticated not set"
            );
        }
        return (StatusCode::UNAUTHORIZED, "invalid or missing bearer token").into_response();
    }

    upgrade(ws, emitter, adapter_id)
}

/// Complete the upgrade only when a live event sink is installed.
fn upgrade(
    ws: WebSocketUpgrade,
    emitter: Option<Arc<dyn EventEmitter>>,
    adapter_id: String,
) -> Response {
    match emitter {
        Some(emitter) => ws.on_upgrade(move |socket| run_bridge(emitter, adapter_id, socket)),
        None => {
            log::error!(
                "ws_server: refusing OneBot upgrade for {adapter_id}: no event sink installed; \
                 frames would be silently dropped"
            );
            (StatusCode::SERVICE_UNAVAILABLE, "onebot bridge unavailable").into_response()
        }
    }
}

/// Bridge an accepted reverse-WS socket to the configured event sink.
async fn run_bridge(emitter: Arc<dyn EventEmitter>, adapter_id: String, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(64);

    // Record the live connection so `connectors_onebot_probe` can report it.
    let connection_id = Uuid::new_v4();
    let previous = {
        let mut clients = live_client_map().lock().unwrap();
        let connected_at_ms = clients.get(&adapter_id).map_or_else(now_ms, |previous| {
            now_ms().max(previous.connected_at_ms.saturating_add(1))
        });
        clients.insert(
            adapter_id.clone(),
            LiveClient {
                connected_at_ms,
                connection_id,
                tx,
            },
        )
    };
    if let Some(previous) = previous {
        let _ = previous.tx.try_send(Message::Close(None));
    }

    emitter.emit(
        &format!("connectors://onebot/{adapter_id}/open"),
        serde_json::Value::Null,
    );

    // Outbound pump: forward queued frames to the socket.
    let pump = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Inbound loop: route each frame to `/response` or `/event`.
    while let Some(item) = stream.next().await {
        match item {
            Ok(Message::Text(text)) => {
                let text = text.as_str();
                let topic = match route_frame(text) {
                    FrameRoute::Response => format!("connectors://onebot/{adapter_id}/response"),
                    FrameRoute::Event => format!("connectors://onebot/{adapter_id}/event"),
                    FrameRoute::Drop => continue,
                };
                emitter.emit(&topic, serde_json::Value::String(text.to_string()));
            }
            Ok(Message::Close(_)) | Err(_) => break,
            // Binary / Ping / Pong — axum auto-responds to pings; ignore.
            _ => {}
        }
    }

    // Cleanup — only if we are still the registered connection (a newer
    // reconnect may have replaced and already unlistened us; in that case the
    // spurious `/close` must NOT fire and degrade the live connection).
    let still_current = {
        let mut clients = live_client_map().lock().unwrap();
        if clients.get(&adapter_id).map(|client| client.connection_id) == Some(connection_id) {
            clients.remove(&adapter_id);
            true
        } else {
            false
        }
    };
    if still_current {
        emitter.emit(
            &format!("connectors://onebot/{adapter_id}/close"),
            serde_json::Value::Null,
        );
    }
    pump.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // route_frame — pure classifier, no AppHandle / socket needed. The full
    // upgrade→emit/listen bridge needs a real `tauri::AppHandle`, which cannot
    // be constructed headless, so the testable core is factored out here.
    // -----------------------------------------------------------------------

    #[test]
    fn route_frame_routes_api_response_by_echo() {
        let frame = r#"{"status":"ok","retcode":0,"data":{"message_id":42},"echo":"x:1"}"#;
        assert_eq!(route_frame(frame), FrameRoute::Response);
    }

    #[test]
    fn route_frame_routes_event_push_without_echo() {
        let frame = r#"{"post_type":"message","message_type":"group","raw_message":"hi"}"#;
        assert_eq!(route_frame(frame), FrameRoute::Event);
    }

    #[test]
    fn route_frame_treats_empty_object_as_event() {
        assert_eq!(route_frame("{}"), FrameRoute::Event);
    }

    #[test]
    fn route_frame_drops_non_json() {
        assert_eq!(route_frame("not json {"), FrameRoute::Drop);
        assert_eq!(route_frame(""), FrameRoute::Drop);
    }

    #[tokio::test]
    async fn live_clients_reports_and_sends_to_registered_connection() {
        let key = "ob-live-probe-test";
        let (tx, mut rx) = mpsc::channel(1);
        live_client_map().lock().unwrap().remove(key);
        live_client_map().lock().unwrap().insert(
            key.to_string(),
            LiveClient {
                connected_at_ms: 1234,
                connection_id: Uuid::new_v4(),
                tx,
            },
        );

        let snapshot = live_clients();
        let entry = snapshot.iter().find(|c| c.adapter_id == key);
        assert!(entry.is_some(), "probe must report the live client");
        assert_eq!(entry.unwrap().connected_at_ms, 1234);

        send(key, r#"{"action":"get_status"}"#.to_string())
            .await
            .unwrap();
        assert_eq!(
            rx.recv().await,
            Some(Message::Text(r#"{"action":"get_status"}"#.into()))
        );

        live_client_map().lock().unwrap().remove(key);
        assert!(live_clients().iter().all(|c| c.adapter_id != key));
        assert!(send(key, "{}".into()).await.is_err());
    }

    // ── Authorization decision — pure, keyring-free (P1-3 fail-closed) ──────

    #[test]
    fn authorize_onebot_with_bearer_requires_exact_match() {
        assert!(authorize_onebot(Some("s3cret"), false, "s3cret"));
        assert!(!authorize_onebot(Some("s3cret"), false, "wrong"));
        // Length mismatch is rejected before the constant-time compare.
        assert!(!authorize_onebot(Some("s3cret"), false, "s3cre"));
        assert!(!authorize_onebot(Some("s3cret"), false, ""));
    }

    #[test]
    fn authorize_onebot_no_bearer_fails_closed_by_default() {
        // The core fix: a missing bearer no longer accepts anyone.
        assert!(!authorize_onebot(None, false, ""));
        assert!(!authorize_onebot(None, false, "whatever"));
    }

    #[test]
    fn authorize_onebot_no_bearer_accepts_only_with_explicit_optin() {
        // Operator explicitly opted into unauthenticated mode.
        assert!(authorize_onebot(None, true, ""));
        assert!(authorize_onebot(None, true, "ignored"));
    }

    #[test]
    fn bearer_matches_is_length_then_value() {
        assert!(bearer_matches("abc", "abc"));
        assert!(!bearer_matches("abc", "abd"));
        assert!(!bearer_matches("abc", "ab"));
        assert!(!bearer_matches("", "x"));
        assert!(bearer_matches("", ""));
    }

    // -----------------------------------------------------------------------
    // Auth over a REAL handshake. A synthetic `oneshot` request cannot reach
    // the handler's 401 branch: axum's `WebSocketUpgrade` extractor rejects
    // any request lacking hyper's `OnUpgrade` extension with 426 before the
    // handler runs. So these tests start a live server on an ephemeral port
    // and drive a genuine client handshake.
    // -----------------------------------------------------------------------

    #[derive(Default)]
    struct RecordingEmitter {
        events: parking_lot::Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl crate::axum_app::EventEmitter for RecordingEmitter {
        fn emit(&self, topic: &str, payload: serde_json::Value) {
            self.events.lock().push((topic.to_string(), payload));
        }
    }

    async fn start_live_server() -> (
        std::net::SocketAddr,
        crate::server_lifecycle::ServerHandle,
        Arc<RecordingEmitter>,
    ) {
        let state = ConnectorsState::new();
        let emitter = Arc::new(RecordingEmitter::default());
        let handle = crate::server_lifecycle::start_server(
            state,
            std::net::SocketAddr::from(([127, 0, 0, 1], 0)),
            emitter.clone(),
        )
        .await
        .unwrap();
        (handle.bound_addr, handle, emitter)
    }

    /// Drive a client handshake with optional bearer; returns the result.
    async fn ws_handshake(
        addr: std::net::SocketAddr,
        adapter: &str,
        bearer: Option<&str>,
    ) -> Result<(), tokio_tungstenite::tungstenite::Error> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let mut req = format!("ws://{addr}/ws/onebot/{adapter}")
            .into_client_request()
            .unwrap();
        if let Some(token) = bearer {
            req.headers_mut()
                .insert("Authorization", format!("Bearer {token}").parse().unwrap());
        }
        tokio_tungstenite::connect_async(req).await.map(|_| ())
    }

    fn assert_http_status(
        result: Result<(), tokio_tungstenite::tungstenite::Error>,
        expected: StatusCode,
    ) {
        match result {
            Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
                assert_eq!(resp.status(), expected)
            }
            other => panic!("expected HTTP {expected} rejection, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn ws_onebot_without_bearer_rejects_fail_closed() {
        // No bearer and no opt-in configured for this adapter → reject.
        let adapter = "ob-noauth-failclosed-test";
        super::super::keyring::delete(adapter, "onebotBearer").unwrap();
        super::super::keyring::delete(adapter, "onebotAllowUnauthenticated").unwrap();

        let (addr, handle, _) = start_live_server().await;
        let result = ws_handshake(addr, adapter, None).await;
        assert_http_status(result, StatusCode::UNAUTHORIZED);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn ws_onebot_headless_emits_open_and_inbound_event() {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

        // Explicit auth opt-in plus a headless event sink must bridge frames
        // even though no Tauri AppHandle exists.
        let adapter = "ob-optin-test";
        super::super::keyring::delete(adapter, "onebotBearer").unwrap();
        super::super::keyring::set(adapter, "onebotAllowUnauthenticated", "true").unwrap();

        let (addr, handle, emitter) = start_live_server().await;
        let req = format!("ws://{addr}/ws/onebot/{adapter}")
            .into_client_request()
            .unwrap();
        let (mut socket, _) = tokio_tungstenite::connect_async(req).await.unwrap();
        socket
            .send(Message::Text(
                r#"{"post_type":"message","raw_message":"hi"}"#.into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                r#"{"status":"ok","echo":"request-1"}"#.into(),
            ))
            .await
            .unwrap();
        send(
            adapter,
            r#"{"action":"send_msg","echo":"outbound-1"}"#.to_string(),
        )
        .await
        .unwrap();
        let outbound = socket.next().await.unwrap().unwrap();
        assert_eq!(
            outbound,
            Message::Text(r#"{"action":"send_msg","echo":"outbound-1"}"#.into())
        );
        socket.close(None).await.unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if emitter.events.lock().len() >= 4 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        assert_eq!(
            emitter.events.lock().as_slice(),
            &[
                (
                    format!("connectors://onebot/{adapter}/open"),
                    serde_json::Value::Null,
                ),
                (
                    format!("connectors://onebot/{adapter}/event"),
                    serde_json::Value::String(
                        r#"{"post_type":"message","raw_message":"hi"}"#.into(),
                    ),
                ),
                (
                    format!("connectors://onebot/{adapter}/response"),
                    serde_json::Value::String(r#"{"status":"ok","echo":"request-1"}"#.into(),),
                ),
                (
                    format!("connectors://onebot/{adapter}/close"),
                    serde_json::Value::Null,
                ),
            ]
        );
        handle.shutdown().await;

        super::super::keyring::delete(adapter, "onebotAllowUnauthenticated").unwrap();
    }

    #[tokio::test]
    async fn ws_onebot_without_any_event_sink_returns_503() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let adapter = "ob-no-sink-test";
        super::super::keyring::delete(adapter, "onebotBearer").unwrap();
        super::super::keyring::set(adapter, "onebotAllowUnauthenticated", "true").unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = crate::axum_app::build_unresolved_router().with_state(ConnectorsState::new());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let req = format!("ws://{addr}/ws/onebot/{adapter}")
            .into_client_request()
            .unwrap();
        let result = tokio_tungstenite::connect_async(req).await.map(|_| ());
        assert_http_status(result, StatusCode::SERVICE_UNAVAILABLE);

        server.abort();
        super::super::keyring::delete(adapter, "onebotAllowUnauthenticated").unwrap();
    }

    #[tokio::test]
    async fn ws_onebot_with_wrong_token_returns_401() {
        // Set a bearer token in the (in-memory test) secret store.
        let adapter = "guarded-ws-adapter";
        super::super::keyring::set(adapter, "onebotBearer", "correct-secret").unwrap();

        let (addr, handle, _) = start_live_server().await;
        let result = ws_handshake(addr, adapter, Some("wrong-secret")).await;
        assert_http_status(result, StatusCode::UNAUTHORIZED);

        let accepted = ws_handshake(addr, adapter, Some("correct-secret")).await;
        assert!(
            accepted.is_ok(),
            "correct bearer must upgrade, got {accepted:?}"
        );
        handle.shutdown().await;

        super::super::keyring::delete(adapter, "onebotBearer").unwrap();
    }
}
