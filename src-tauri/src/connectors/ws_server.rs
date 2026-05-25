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

/// Per-adapter `/send` listener registry. A reconnect for the same `adapter_id`
/// must evict the prior connection's listener so a stale half-open socket stops
/// stealing outbound frames. Keyed by `adapter_id` → that connection's listener
/// `EventId`.
static ONEBOT_SEND_LISTENERS: OnceLock<Arc<Mutex<HashMap<String, EventId>>>> = OnceLock::new();

fn send_listeners() -> &'static Arc<Mutex<HashMap<String, EventId>>> {
    ONEBOT_SEND_LISTENERS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
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
        Ok(Some(t)) => t,
        Ok(None) => {
            // No token configured → accept without auth (development mode).
            // Adapters that need auth must have the keyring entry set.
            return upgrade(ws, app, adapter_id);
        }
        Err(e) => {
            log::warn!("ws_server: keyring error for {adapter_id}: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "keyring error").into_response();
        }
    };

    // Validate bearer token.
    let supplied = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    let expected_bytes = expected_token.as_bytes();
    let supplied_bytes = supplied.as_bytes();

    if expected_bytes.len() != supplied_bytes.len()
        || expected_bytes.ct_eq(supplied_bytes).unwrap_u8() == 0
    {
        return (StatusCode::UNAUTHORIZED, "invalid bearer token").into_response();
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
        app.unlisten(listener_id);
        let _ = app.emit(&format!("connectors://onebot/{adapter_id}/close"), ());
    }
    pump.abort();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::axum_app::build_unresolved_router;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn router_with_ws() -> Router<ConnectorsState> {
        let base = build_unresolved_router();
        register_routes(base)
    }

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

    #[tokio::test]
    async fn ws_onebot_without_keyring_entry_upgrades_ok() {
        // Without a keyring entry, the server accepts any connection.
        // We can't do a real WS handshake in tower oneshot, so just verify
        // it doesn't return 401 for a non-upgrade request (it returns 400
        // "no upgrade header" which is axum's normal response for a missing
        // Upgrade header, not a 401).
        // This test doesn't actually need a real keyring — just ensures the
        // route exists and doesn't reject without auth configured.

        let state = ConnectorsState::new();
        let app = router_with_ws().with_state(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/ws/onebot/test-adapter-noauth")
                    .header("Connection", "Upgrade")
                    .header("Upgrade", "websocket")
                    .header("Sec-WebSocket-Version", "13")
                    .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // Without a bearer requirement in keyring, the upgrade proceeds (101)
        // or at minimum does not return 401.
        assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn ws_onebot_with_wrong_token_returns_401() {
        if !crate::connectors::keyring_available() {
            return;
        }
        // Set a bearer token in the real keyring.
        super::super::keyring::set("guarded-ws-adapter", "onebotBearer", "correct-secret").unwrap();

        let state = ConnectorsState::new();
        let app = router_with_ws().with_state(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/ws/onebot/guarded-ws-adapter")
                    .header("Authorization", "Bearer wrong-secret")
                    .header("Connection", "Upgrade")
                    .header("Upgrade", "websocket")
                    .header("Sec-WebSocket-Version", "13")
                    .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
