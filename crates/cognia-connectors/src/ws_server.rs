//! Axum WebSocket route for OneBot reverse-WS adapters.
//!
//! Route: `/ws/onebot/:adapter_id`
//! Auth:  `Authorization: Bearer <token>` — token stored in keyring at
//!        service `com.cognia.platforms`, account `<adapter_id>:onebotBearer`.
//!
//! When the bearer token is absent or wrong, the upgrade is rejected with 401.
//!
//! Once upgraded, the socket is bridged to the renderer via Tauri events,
//! honouring the contract the TS adapter (`lib/connectors/adapters/onebot/
//! transport-reverse-ws.ts`) subscribes to:
//!
//!   emit  `connectors://onebot/<id>/open`              — on upgrade
//!   emit  `connectors://onebot/<id>/event`    <frame>  — inbound event push
//!   emit  `connectors://onebot/<id>/response` <frame>  — inbound API response
//!   emit  `connectors://onebot/<id>/close`             — on disconnect
//!   listen `connectors://onebot/<id>/send`    <call>   — outbound RPC → WS
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
use tauri::{Emitter, EventId, Listener};
use tokio::sync::mpsc;

use super::axum_app::AppHandleExt;
use super::state::ConnectorsState;
use super::types::OneBotLiveClient;

/// Per-adapter `/send` listener registry. A reconnect for the same `adapter_id`
/// must evict the prior connection's listener so a stale half-open socket stops
/// stealing outbound frames. Keyed by `adapter_id` → that connection's listener
/// `EventId`.
static ONEBOT_SEND_LISTENERS: OnceLock<Arc<Mutex<HashMap<String, EventId>>>> = OnceLock::new();

fn send_listeners() -> &'static Arc<Mutex<HashMap<String, EventId>>> {
    ONEBOT_SEND_LISTENERS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Live reverse-WS client registry: `adapter_id` → connect time (epoch ms).
/// Populated on a successful upgrade and cleared on disconnect, so the OneBot
/// settings UI can probe which adapters actually have a client dialed in.
/// Keyed by `adapter_id` (a reconnect overwrites the timestamp); the disconnect
/// cleanup only removes the entry when the closing socket is still the current
/// connection (mirrors the `send_listeners` reconnect guard).
static ONEBOT_LIVE_CLIENTS: OnceLock<Arc<Mutex<HashMap<String, u64>>>> = OnceLock::new();

fn live_client_map() -> &'static Arc<Mutex<HashMap<String, u64>>> {
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
        .map(|(adapter_id, &connected_at_ms)| OneBotLiveClient {
            adapter_id: adapter_id.clone(),
            connected_at_ms,
        })
        .collect()
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
    app_ext: Option<Extension<AppHandleExt>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let app = app_ext.map(|Extension(AppHandleExt(app))| app);

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

    upgrade(ws, app, adapter_id)
}

/// Complete the upgrade: run the full event bridge when an `AppHandle` is
/// available (production), else fall back to draining frames (the
/// `build_unresolved_router` test path, which carries no `AppHandle`).
fn upgrade(ws: WebSocketUpgrade, app: Option<tauri::AppHandle>, adapter_id: String) -> Response {
    match app {
        Some(app) => ws.on_upgrade(move |socket| run_bridge(app, adapter_id, socket)),
        None => ws.on_upgrade(|mut socket| async move {
            let _ = socket.recv().await;
        }),
    }
}

/// Bridge an accepted reverse-WS socket to the renderer over Tauri events.
async fn run_bridge(app: tauri::AppHandle, adapter_id: String, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(64);

    // Listen for outbound RPC calls the TS adapter emits on `…/send`. The JS
    // side emits `JSON.stringify(call)` as a string payload, so `event.payload()`
    // is that JSON-encoded string — decode one level to recover the call JSON
    // before forwarding it as a WS text frame.
    let send_channel = format!("connectors://onebot/{adapter_id}/send");
    let listener_tx = tx.clone();
    let listener_id = app.listen(send_channel, move |event| {
        let raw = event.payload();
        let call_json = serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string());
        // Bounded channel: drop on a full queue rather than block the sync
        // listener — mirrors the break-on-error back-pressure in ws_client.
        let _ = listener_tx.try_send(Message::Text(call_json.into()));
    });
    // The listener owns the only sender we need; drop our copy so the outbound
    // pump terminates once the listener is unlistened.
    drop(tx);

    // Reconnect: evict any prior connection's listener for this adapter.
    let prev = send_listeners()
        .lock()
        .unwrap()
        .insert(adapter_id.clone(), listener_id);
    if let Some(prev_id) = prev {
        if prev_id != listener_id {
            app.unlisten(prev_id);
        }
    }

    // Record the live connection so `connectors_onebot_probe` can report it.
    live_client_map()
        .lock()
        .unwrap()
        .insert(adapter_id.clone(), now_ms());

    let _ = app.emit(&format!("connectors://onebot/{adapter_id}/open"), ());

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
                let _ = app.emit(&topic, text.to_string());
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
        let mut map = send_listeners().lock().unwrap();
        if map.get(&adapter_id) == Some(&listener_id) {
            map.remove(&adapter_id);
            true
        } else {
            false
        }
    };
    if still_current {
        live_client_map().lock().unwrap().remove(&adapter_id);
        app.unlisten(listener_id);
        let _ = app.emit(&format!("connectors://onebot/{adapter_id}/close"), ());
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

    #[test]
    fn send_listeners_evicts_prior_on_reconnect() {
        // A reconnect re-inserting the same adapter_id returns the prior
        // listener id so the caller can unlisten the stale connection.
        let map = send_listeners();
        let key = "ob-reconnect-test";
        map.lock().unwrap().remove(key);
        assert!(map.lock().unwrap().insert(key.to_string(), 11).is_none());
        assert_eq!(map.lock().unwrap().insert(key.to_string(), 22), Some(11));
        map.lock().unwrap().remove(key);
    }

    #[test]
    fn live_clients_reports_registered_connections() {
        let key = "ob-live-probe-test";
        // Clean slate, then simulate an upgrade recording a live client.
        live_client_map().lock().unwrap().remove(key);
        live_client_map()
            .lock()
            .unwrap()
            .insert(key.to_string(), 1234);

        let snapshot = live_clients();
        let entry = snapshot.iter().find(|c| c.adapter_id == key);
        assert!(entry.is_some(), "probe must report the live client");
        assert_eq!(entry.unwrap().connected_at_ms, 1234);

        // Disconnect cleanup removes it again.
        live_client_map().lock().unwrap().remove(key);
        assert!(live_clients().iter().all(|c| c.adapter_id != key));
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

    struct NoopEmitter;
    impl crate::axum_app::EventEmitter for NoopEmitter {
        fn emit_webhook(&self, _adapter_id: &str, _payload: &serde_json::Value) {}
    }

    async fn start_live_server() -> (std::net::SocketAddr, crate::server_lifecycle::ServerHandle) {
        let state = ConnectorsState::new();
        let handle = crate::server_lifecycle::start_server(
            state,
            std::net::SocketAddr::from(([127, 0, 0, 1], 0)),
            std::sync::Arc::new(NoopEmitter),
            None,
        )
        .await
        .unwrap();
        (handle.bound_addr, handle)
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

        let (addr, handle) = start_live_server().await;
        let result = ws_handshake(addr, adapter, None).await;
        assert_http_status(result, StatusCode::UNAUTHORIZED);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn ws_onebot_unauthenticated_optin_is_accepted() {
        // Explicit opt-in restores unauthenticated acceptance for trusted
        // localhost instances. No bearer set; opt-in flag truthy.
        let adapter = "ob-optin-test";
        super::super::keyring::delete(adapter, "onebotBearer").unwrap();
        super::super::keyring::set(adapter, "onebotAllowUnauthenticated", "true").unwrap();

        let (addr, handle) = start_live_server().await;
        let result = ws_handshake(addr, adapter, None).await;
        assert!(
            result.is_ok(),
            "opt-in upgrade must succeed, got {result:?}"
        );
        handle.shutdown().await;

        super::super::keyring::delete(adapter, "onebotAllowUnauthenticated").unwrap();
    }

    #[tokio::test]
    async fn ws_onebot_with_wrong_token_returns_401() {
        // Set a bearer token in the (in-memory test) secret store.
        let adapter = "guarded-ws-adapter";
        super::super::keyring::set(adapter, "onebotBearer", "correct-secret").unwrap();

        let (addr, handle) = start_live_server().await;
        let result = ws_handshake(addr, adapter, Some("wrong-secret")).await;
        assert_http_status(result, StatusCode::UNAUTHORIZED);

        // The correct bearer is accepted on the same server.
        let ok = ws_handshake(addr, adapter, Some("correct-secret")).await;
        assert!(ok.is_ok(), "correct bearer must upgrade, got {ok:?}");
        handle.shutdown().await;

        super::super::keyring::delete(adapter, "onebotBearer").unwrap();
    }
}
