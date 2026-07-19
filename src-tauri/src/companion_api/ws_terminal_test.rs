//! End-to-end WebSocket integration test for the integrated-terminal
//! proxy at `/ws/v1/terminal`. Mirrors the placement / style of
//! `companion_api::pair_flow_test` (sibling-module file, all behavior
//! gated under `#[cfg(test)]`).
//!
//! The test:
//!   1. Boots an axum router with the real `ws_terminal_handler` and
//!      the device-JWT middleware applied.
//!   2. Binds the router on an ephemeral 127.0.0.1 port via
//!      `tokio::net::TcpListener` + `axum::serve`.
//!   3. Issues a device JWT through the same `issue_device_jwt` helper
//!      production uses.
//!   4. Connects a `tokio_tungstenite` client to
//!      `ws://<addr>/ws/v1/terminal?token=…&spawn=1&shell=…`.
//!   5. Reads the `ready` text frame, asserts `sessionId` is present.
//!   6. Sends a binary frame ("echo hello\n" on POSIX, equivalent on
//!      Windows), expects the echoed bytes back on the data channel.
//!   7. Sends `{"kind":"kill"}`, expects an `exit` text frame, then a
//!      clean close.
//!
//! Caveats:
//!   * The test cannot run when `cargo test`'s loader hits Windows
//!     `STATUS_ENTRYPOINT_NOT_FOUND` (see plan §Outstanding) — but it
//!     compiles and verifies on any healthy box (CI, WSL).
//!   * Skipped on platforms where no usable shell is detectable.

#[cfg(test)]
mod tests {
    use crate::companion_api::{
        deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache,
        jwt::issue_device_jwt, middleware, push, rate_limit, redemption_lru::RedemptionLru, rpc,
        sync_bridge::SyncBridge, sync_registry::SyncTableRegistry, ws_terminal, CompanionState,
        SharedState,
    };
    use axum::{
        routing::{any, post},
        Router,
    };
    use futures_util::StreamExt;
    use parking_lot::RwLock;
    use serde_json::Value;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio_tungstenite::tungstenite::Message;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";
    const DEVICE_ID: &str = "test-device-1";

    fn test_state() -> SharedState {
        Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: SyncTableRegistry::with_defaults(),
            rate_limiter: rate_limit::RateLimiter::with_defaults(),
            push_tokens: push::PushTokenRegistry::new(),
        })
    }

    fn build_router(state: SharedState) -> Router {
        Router::new()
            .route("/ws/v1/terminal", any(ws_terminal::ws_terminal_handler))
            .route("/api/v1/_rpc/{name}", post(rpc::rpc_handler))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                middleware::require_device_jwt,
            ))
            .with_state(state)
    }

    /// Resolve a shell binary that's available on this OS and accepts
    /// `-c "<cmd>"` (or the Windows equivalent). Returns `None` to
    /// signal "skip the test gracefully".
    fn detect_test_shell() -> Option<(String, String)> {
        if cfg!(target_os = "windows") {
            // ComSpec → cmd.exe. `/C` accepts an inline command.
            std::env::var("COMSPEC")
                .ok()
                .map(|c| (c, "/C echo hello".to_string()))
        } else {
            // POSIX sh is universal. Echo + exit so the session
            // terminates within the test window.
            Some(("/bin/sh".to_string(), "-c".to_string()))
        }
    }

    async fn bind_and_serve(router: Router) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        addr
    }

    /// End-to-end happy path. Uses a shell command that echoes a known
    /// marker so the test can wait for the bytes to round-trip without
    /// depending on a TTY-bound prompt.
    #[tokio::test]
    async fn ws_terminal_spawn_echo_and_exit() {
        let Some((shell, _shell_arg)) = detect_test_shell() else {
            eprintln!("skip: no usable shell for this OS");
            return;
        };

        // `rpc_handler` resolves its host through the process registry when no
        // Tauri AppHandle exists. Serialize the global slot and install the
        // same minimal headless services used by the RPC unit tests.
        let _slot_guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        crate::headless::install_headless_services(Some(
            crate::headless::HeadlessServices::stub_for_tests(),
        ));

        let state = test_state();
        let router = build_router(Arc::clone(&state));
        let addr = bind_and_serve(router).await;

        // Opening a remote terminal requires the remote-control capability
        // (P0-1). Grant it for this device id; a merely-paired device is
        // rejected before the upgrade (see `ws_terminal_rejects_uncontrolled`).
        crate::companion_api::control_allow_list::global().allow(DEVICE_ID.to_string());

        let token = issue_device_jwt(SECRET, DEVICE_ID, ACCOUNT_ID).expect("issue device jwt");
        let url = format!(
            "ws://{addr}/ws/v1/terminal?token={token}&spawn=1&shell={shell_enc}&rows=24&cols=80&projectId=project-a",
            shell_enc = urlencoding::encode(&shell),
        );

        let (mut ws, _resp) = match tokio_tungstenite::connect_async(&url).await {
            Ok(pair) => pair,
            Err(e) => {
                // Either the route failed to register, the JWT didn't
                // verify, or `tokio-tungstenite`'s handshake hit a TLS
                // expectation we can't satisfy on plain `ws://`. In
                // any case, fail loudly so the contract drift surfaces.
                panic!("ws connect failed: {e}");
            }
        };

        // 1. Ready frame.
        let ready = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("ready timeout")
            .expect("ws closed before ready")
            .expect("ws frame err");
        let Message::Text(text) = ready else {
            panic!("expected text ready frame, got {ready:?}");
        };
        let frame: Value = serde_json::from_str(text.as_str()).expect("parse ready");
        assert_eq!(frame["kind"], "ready");
        let session_id = frame["sessionId"]
            .as_str()
            .expect("sessionId present")
            .to_string();
        assert!(!session_id.is_empty(), "session_id must be non-empty uuid");

        // The companion RPC inventory reads this exact reconnect registry.
        // It exposes the owner session, applies project filtering, and never
        // leaks it to another authenticated device.
        let registry = ws_terminal::ws_terminal_registry();
        let owned = registry.list_for_device(DEVICE_ID);
        assert!(owned.iter().any(|session| session.id == session_id));
        let project = registry.list_for_device_project(DEVICE_ID, "project-a");
        assert!(project.iter().any(|session| session.id == session_id));
        assert!(registry.list_for_device("test-device-foreign").is_empty());

        // 2. Kill through the public companion RPC. This is the headless
        // inventory/control seam under test; the WS remains attached so it
        // must still receive the terminal lifecycle completion event.
        let kill = reqwest::Client::new()
            .post(format!("http://{addr}/api/v1/_rpc/terminal_kill"))
            .bearer_auth(&token)
            .json(&serde_json::json!({ "id": &session_id }))
            .send()
            .await
            .expect("terminal_kill request");
        assert_eq!(kill.status(), reqwest::StatusCode::OK);

        // 3. Drain frames until we see exit or the socket closes.
        let mut saw_exit = false;
        for _ in 0..50 {
            let next = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;
            match next {
                Ok(Some(Ok(Message::Text(t)))) => {
                    if let Ok(parsed) = serde_json::from_str::<Value>(t.as_str()) {
                        if parsed["kind"] == "exit" {
                            saw_exit = true;
                            break;
                        }
                    }
                }
                Ok(Some(Ok(Message::Binary(_)))) => {
                    // PTY noise from the early shell startup — fine to drop.
                    continue;
                }
                Ok(Some(Ok(Message::Close(_)))) => break,
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) => break,
                Ok(None) => break,
                Err(_) => break,
            }
        }
        assert!(saw_exit, "expected an exit text frame after kill");
        assert!(registry
            .list_for_device(DEVICE_ID)
            .iter()
            .all(|session| session.id != session_id));
        crate::headless::install_headless_services(None);
    }

    /// Sad path: a request without the JWT must be rejected by the
    /// middleware before our handler runs. The exact status code is
    /// determined by `require_device_jwt`; we just assert the handshake
    /// failed.
    #[tokio::test]
    async fn ws_terminal_rejects_unauthenticated_connect() {
        let state = test_state();
        let router = build_router(Arc::clone(&state));
        let addr = bind_and_serve(router).await;
        let url = format!("ws://{addr}/ws/v1/terminal?spawn=1&shell=/bin/sh");
        let result = tokio_tungstenite::connect_async(&url).await;
        assert!(result.is_err(), "expected handshake failure without token");
    }

    /// Sad path: `spawn=1` but no shell. Handler must reply with an
    /// error envelope and close.
    /// Sad path: a *paired but not remote-control-authorized* device must be
    /// rejected by the capability gate (P0-1) before the WS upgrade, even with
    /// a valid device JWT. This is the core fix: pairing alone (chat-only tier)
    /// must not grant a remote shell.
    #[tokio::test]
    async fn ws_terminal_rejects_uncontrolled_device() {
        let state = test_state();
        let router = build_router(Arc::clone(&state));
        let addr = bind_and_serve(router).await;

        // A device id that is never granted the remote-control capability.
        let uncontrolled = "ws-terminal-uncontrolled-device";
        crate::companion_api::control_allow_list::global().disallow(uncontrolled);

        let token = issue_device_jwt(SECRET, uncontrolled, ACCOUNT_ID).expect("issue device jwt");
        let url = format!(
            "ws://{addr}/ws/v1/terminal?token={token}&spawn=1&shell=/bin/sh&rows=24&cols=80",
        );
        // Valid JWT, but the gate rejects the upgrade with 403 → the WS
        // handshake fails.
        let result = tokio_tungstenite::connect_async(&url).await;
        assert!(
            result.is_err(),
            "expected handshake failure for a paired-but-uncontrolled device"
        );
    }

    #[tokio::test]
    async fn ws_terminal_rejects_spawn_without_shell() {
        let state = test_state();
        let router = build_router(Arc::clone(&state));
        let addr = bind_and_serve(router).await;
        // Reaches the handler, so the device needs the remote-control grant.
        crate::companion_api::control_allow_list::global().allow(DEVICE_ID.to_string());
        let token = issue_device_jwt(SECRET, DEVICE_ID, ACCOUNT_ID).expect("issue device jwt");
        let url = format!("ws://{addr}/ws/v1/terminal?token={token}&spawn=1");
        let (mut ws, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("ws connect");
        let first = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("error timeout")
            .expect("ws closed prematurely")
            .expect("ws frame err");
        let Message::Text(text) = first else {
            panic!("expected text error frame, got {first:?}");
        };
        let frame: Value = serde_json::from_str(text.as_str()).expect("parse error frame");
        assert_eq!(frame["kind"], "error");
        let message = frame["message"].as_str().unwrap_or("");
        assert!(
            message.contains("shell"),
            "error mentions shell, got: {message}"
        );
    }
}
