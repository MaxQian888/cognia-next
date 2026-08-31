//! Test module for `companion_api::rpc` — included from `rpc.rs` behind
//! `#[cfg(test)] mod tests;`; the inner attribute below keeps the file itself
//! test-only when compiled through any other path.
#![cfg(test)]

use super::*;
use crate::companion_api::{
    deny_list::DenyList, idempotency::IdempotencyCache, jwt::issue_device_jwt, CompanionState,
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use parking_lot::RwLock;
use serde_json::json;
use std::sync::Arc;
use tower::ServiceExt as _;

/// `super::dispatch` takes the listener plane the request arrived on. Every
/// case below asks a question that plane does not change, so this shadows the
/// glob import with the conservative one and the call sites stay as they were.
/// The plane's own behaviour is covered by
/// `loopback_plane_is_what_discloses_the_workbench_port`.
#[allow(clippy::too_many_arguments)]
async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    host: &crate::companion_api::dispatch_host::DispatchHost,
    device_id: &str,
    account_id: Option<&str>,
    scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    super::dispatch(
        name,
        args,
        state,
        host,
        device_id,
        account_id,
        scope,
        crate::companion_api::remote_execution::ExecutionPlane::Network,
    )
    .await
}

#[test]
fn known_commands_are_unique() {
    let unique: std::collections::HashSet<_> = KNOWN_COMMANDS.iter().copied().collect();
    assert_eq!(unique.len(), KNOWN_COMMANDS.len());
}

#[test]
fn remote_completion_commands_have_exact_remote_authority() {
    let expected = [
        ("agent_resolve_permission", "agent.run"),
        ("agent_vendor_roots", "host.observe"),
        ("fleet_opencode_outbox_repair", "host.admin"),
        ("fleet_opencode_outbox_status", "host.observe"),
        ("git_clone_guarded", "git.write"),
        ("read_project_mcp_config", "host.observe"),
        ("task_workspace_restore_snapshot", "workspace.write"),
    ];

    for (name, capability) in expected {
        let descriptor = crate::companion_api::command_manifest::descriptor(name)
            .unwrap_or_else(|| panic!("{name} must have a manifest descriptor"));
        assert_eq!(
            descriptor.target,
            crate::companion_api::command_manifest::CommandTarget::Execution,
            "{name} target"
        );
        assert_eq!(descriptor.capability, capability, "{name} capability");
        assert!(KNOWN_COMMANDS.contains(&name), "{name} must be allowlisted");
    }

    assert!(super::chat::COMMANDS.contains(&"agent_resolve_permission"));
    assert!(super::chat::COMMANDS.contains(&"agent_vendor_roots"));
    assert!(super::diagnostics::COMMANDS.contains(&"fleet_opencode_outbox_repair"));
    assert!(super::diagnostics::COMMANDS.contains(&"fleet_opencode_outbox_status"));
    assert!(super::source_control::COMMANDS.contains(&"git_clone_guarded"));
    assert!(super::chat::COMMANDS.contains(&"read_project_mcp_config"));
    assert!(super::filesystem::COMMANDS.contains(&"task_workspace_restore_snapshot"));
    assert!(STEP_UP_COMMANDS.contains(&"fleet_opencode_outbox_repair"));
}

#[test]
fn remote_completion_commands_reject_additional_fields_at_runtime() {
    for name in [
        "agent_resolve_permission",
        "agent_vendor_roots",
        "fleet_opencode_outbox_repair",
        "fleet_opencode_outbox_status",
        "git_clone_guarded",
        "read_project_mcp_config",
        "task_workspace_restore_snapshot",
    ] {
        let (status, Json(error)) =
            validate_completion_command_fields(name, &json!({ "definitelyUnexpected": true }))
                .expect_err("completion commands must reject additional fields");
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
        assert_eq!(error.code, "validation_failed", "{name}");
        assert!(error.message.contains("definitelyUnexpected"), "{name}");
    }
}

#[test]
fn thread_handoff_commands_have_exact_remote_authority_and_reject_extra_fields() {
    let expected = [
        ("thread_handoff_offer", "workspace.write", false),
        ("thread_handoff_preflight", "host.observe", false),
        ("thread_handoff_accept", "host.admin", true),
        ("thread_handoff_commit", "host.admin", true),
        ("thread_handoff_abort", "workspace.write", false),
        ("thread_handoff_status", "host.observe", false),
    ];

    for (name, capability, step_up) in expected {
        let descriptor = crate::companion_api::command_manifest::descriptor(name)
            .unwrap_or_else(|| panic!("{name} must have a manifest descriptor"));
        assert_eq!(descriptor.capability, capability, "{name} capability");
        assert_eq!(STEP_UP_COMMANDS.contains(&name), step_up, "{name} step-up");
        assert!(
            super::data_sync::COMMANDS.contains(&name),
            "{name} dispatch arm"
        );

        let (status, Json(error)) =
            validate_completion_command_fields(name, &json!({ "definitelyUnexpected": true }))
                .expect_err("handoff commands must reject additional fields");
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
        assert_eq!(error.code, "validation_failed", "{name}");
    }
}

#[test]
fn bridge_transport_failures_keep_the_public_retryable_error_contract() {
    for detail in [
        "brain bridge disconnected",
        "brain bridge overloaded: in-flight limit reached",
    ] {
        let (status, Json(error)) = RpcError::internal(detail.to_string());
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code, "service_unavailable");
        assert_eq!(error.message, detail);
    }

    let (status, Json(error)) = RpcError::internal("brain rejected the request".to_string());
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(error.code, "internal_error");
}

/// Moved here from external_agent::exec_backend when the crate was
/// extracted (ADR-0067): the round trip needs the companion EventBus,
/// which the crate can no longer see.
#[test]
fn bus_emitter_publishes_the_frozen_payload() {
    use crate::external_agent::exec_backend::{stdout_payload, AgentEventEmitter, STDOUT_CHANNEL};
    let bus = crate::companion_api::event_bus::EventBus::new();
    let emitter = BusAgentEmitter(std::sync::Arc::clone(&bus));
    emitter.emit(STDOUT_CHANNEL, stdout_payload("a1", "hello"));
    match bus.subscribe(Some(0), 0) {
        crate::companion_api::event_bus::SubscribeResult::Ok { replay, .. } => {
            assert_eq!(replay.len(), 1);
            assert_eq!(replay[0].event_type, STDOUT_CHANNEL);
            assert_eq!(
                replay[0].payload,
                serde_json::json!({ "agentId": "a1", "data": "hello" })
            );
        }
        _ => panic!("subscribe failed"),
    }
}

#[tokio::test]
async fn headless_orchestration_sink_uses_the_service_only_brain_bridge() {
    let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
    crate::companion_api::ws_bridge::test_support::clear_socket_for_testing();
    let mut receiver = crate::companion_api::ws_bridge::test_support::install_socket_for_testing();
    let sink = headless_orchestration_event_sink();

    sink(crate::mcp_server::orchestration_proxy::ExecEvent {
        id: "request-1".to_string(),
        command: "workflowRunCreate".to_string(),
        args: serde_json::json!({ "arguments": [{ "deploymentId": "deployment-1" }] }),
    })
    .expect("headless sink");

    let axum::extract::ws::Message::Text(frame) = receiver.try_recv().expect("bridge frame") else {
        panic!("expected text bridge frame");
    };
    let frame: Value = serde_json::from_str(frame.as_str()).expect("valid bridge frame");
    assert_eq!(frame["type"], "event");
    assert_eq!(
        frame["event"],
        crate::mcp_server::orchestration_proxy::EXEC_EVENT
    );
    assert_eq!(frame["payload"]["id"], "request-1");
    assert_eq!(frame["payload"]["command"], "workflowRunCreate");
    crate::companion_api::ws_bridge::test_support::clear_socket_for_testing();
}
const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
const ACCOUNT_ID: &str = "local_acct_a";

fn test_state() -> super::super::SharedState {
    use crate::companion_api::event_bus::EventBus;
    Arc::new(CompanionState {
        secret: RwLock::new(SECRET.to_vec()),
        deny_list: Arc::new(DenyList::new()),
        app_handle: None,
        idempotency: Arc::new(IdempotencyCache::new()),
        event_bus: EventBus::new(),
        sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        desktop_messages_bridge:
            crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
        desktop_writes_bridge:
            crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
        sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
        rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
        push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
    })
}

fn build_router(state: super::super::SharedState) -> Router {
    use super::super::middleware;
    use axum::{middleware::from_fn_with_state, routing::post};

    Router::new()
        .route("/internal/_rpc/{name}", post(rpc_handler))
        .layer(from_fn_with_state(
            state.clone(),
            middleware::require_device_jwt,
        ))
        .with_state(state)
}

fn device_jwt(device_id: &str) -> String {
    issue_device_jwt(SECRET, device_id, ACCOUNT_ID).expect("issue device jwt")
}

async fn body_json(resp: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("body bytes");
    serde_json::from_slice(&bytes).expect("json parse")
}

async fn rpc_post(
    router: Router,
    name: &str,
    body: serde_json::Value,
    jwt: &str,
    idempotency_key: Option<&str>,
) -> axum::response::Response {
    let mut builder = Request::builder()
        .method("POST")
        .uri(format!("/internal/_rpc/{name}"))
        .header("Authorization", format!("Bearer {jwt}"))
        .header("Content-Type", "application/json");

    if let Some(key) = idempotency_key {
        builder = builder.header("Idempotency-Key", key);
    }

    let req = builder
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    router.oneshot(req).await.unwrap()
}

// ── Unknown command → 404 ─────────────────────────────────────────────────

#[tokio::test]
async fn unknown_command_returns_404() {
    let state = test_state();
    let router = build_router(state);
    let jwt = device_jwt("dev1");
    let resp = rpc_post(router, "wallpaper_save", json!({}), &jwt, None).await;
    assert_eq!(resp.status().as_u16(), 404);
    let body = body_json(resp).await;
    assert_eq!(body["code"], "unknown_command");
}

// ── Remote Session Control gate ───────────────────────────────────────────

#[test]
fn an_unregistered_device_has_no_canonical_control_capability() {
    assert!(!canonical_device_capability(
        "unregistered-control-device",
        "session_attach"
    ));
}

#[test]
fn can_control_response_serializes_the_canonical_capability_decision() {
    assert_eq!(
        can_control_response_value(false),
        json!({ "allowed": false })
    );
    assert_eq!(can_control_response_value(true), json!({ "allowed": true }));
}

#[test]
fn endpoints_response_reports_both_channels() {
    let value = endpoints_response(
        Some("https://192.168.1.42:27890".to_string()),
        Some("https://calm-rock.trycloudflare.com".to_string()),
        "abc123".to_string(),
        "server-id-1".to_string(),
    );
    assert_eq!(value["lanBaseUrl"], "https://192.168.1.42:27890");
    assert_eq!(
        value["tunnelBaseUrl"],
        "https://calm-rock.trycloudflare.com"
    );
    assert_eq!(value["fingerprint"], "abc123");
    assert_eq!(value["serverId"], "server-id-1");
}

#[test]
fn endpoints_response_nulls_absent_channels() {
    // A loopback-bound desktop with no tunnel running: both address fields
    // must serialise as JSON `null`, not as the string "null" or a missing
    // key — the mobile client distinguishes "no such channel" from
    // "channel unchanged" by key presence.
    let value = endpoints_response(None, None, String::new(), "server-id-2".to_string());
    assert!(value["lanBaseUrl"].is_null());
    assert!(value["tunnelBaseUrl"].is_null());
    assert_eq!(value["fingerprint"], "");
    assert_eq!(value["serverId"], "server-id-2");
}

#[test]
fn lan_base_url_is_none_when_bound_loopback() {
    // Loopback bind mode is an explicit "not reachable from the LAN" —
    // handing the phone a 127.0.0.1 URL would make it probe itself.
    assert_eq!(lan_base_url(Some(false)), None);
}

#[test]
fn lan_base_url_is_https_with_the_advertised_port_when_lan_bound() {
    // `detect_lan_ip` returns None on a network-less CI container, in which
    // case there is genuinely no LAN address to report. Both outcomes are
    // valid; assert the SHAPE of the one that exists.
    for bind_lan in [Some(true), None] {
        match lan_base_url(bind_lan) {
            Some(url) => {
                assert!(url.starts_with("https://"), "expected https, got {url}");
                let port = match super::super::advertised_port() {
                    0 => super::super::server::DEFAULT_PORT,
                    p => p,
                };
                assert!(
                    url.ends_with(&format!(":{port}")),
                    "expected port {port} in {url}"
                );
            }
            None => {
                assert!(
                    crate::companion_api::commands::detect_lan_ip().is_none(),
                    "lan_base_url returned None despite a routable interface"
                );
            }
        }
    }
}

#[test]
fn companion_endpoints_is_read_only_and_ungated() {
    // Read-tier: a device JWT must reach it (not SERVICE_ONLY), any paired
    // device may ask how to reach its own host (not CONTROL), and the
    // answer must never be served from the 60 s idempotency cache — a
    // freshly-started tunnel has to show up on the very next poll.
    assert!(KNOWN_COMMANDS_SET.contains("companion_endpoints"));
    assert!(READ_ONLY_COMMANDS_SET.contains("companion_endpoints"));
    assert!(!CONTROL_COMMANDS_SET.contains("companion_endpoints"));
    assert!(!SERVICE_ONLY_COMMANDS_SET.contains("companion_endpoints"));
}

#[tokio::test]
async fn companion_can_control_is_not_control_gated() {
    // A device with no remote-control grant must still be able to PROBE its
    // capability — `companion_can_control` is deliberately absent from
    // CONTROL_COMMANDS. Past the gate it hits the missing-app_handle 503 in
    // test mode; the point is it is neither 404 (unwired) nor 403 (gated).
    let device = "dev-cancontrol-ungated-001";

    let state = test_state();
    let router = build_router(state);
    let jwt = device_jwt(device);
    let resp = rpc_post(router, "companion_can_control", json!({}), &jwt, None).await;
    assert_ne!(resp.status().as_u16(), 404);
    assert_ne!(resp.status().as_u16(), 403);
}

#[tokio::test]
async fn baseline_chat_command_is_not_gated() {
    // claude_send is NOT in CONTROL_COMMANDS — a paired device with no
    // remote-control grant must still be able to use baseline chat.
    let device = "dev-baseline-001";

    let state = test_state();
    let router = build_router(state);
    let jwt = device_jwt(device);
    let resp = rpc_post(
        router,
        "claude_send",
        json!({ "session_id": "s1", "prompt": "hi" }),
        &jwt,
        None,
    )
    .await;
    // Not forbidden — baseline chat bypasses the capability gate (it
    // 503s in test mode for lack of an app_handle, which is fine).
    assert_ne!(resp.status().as_u16(), 403);
}

// ── Agent Fleet remote commands ───────────────────────────────────────────

#[test]
fn fleet_reads_are_read_only_and_ungated() {
    assert!(READ_ONLY_COMMANDS_SET.contains("fleet_get_snapshot"));
    assert!(!CONTROL_COMMANDS_SET.contains("fleet_get_snapshot"));
    assert!(KNOWN_COMMANDS_SET.contains("fleet_get_snapshot"));
}

#[test]
fn fleet_writes_are_control_gated() {
    for cmd in [
        "fleet_permission_respond",
        "fleet_question_respond",
        "fleet_question_reject",
        "fleet_opencode_send_message",
        "fleet_focus_terminal",
        "fleet_interrupt_session",
    ] {
        assert!(
            CONTROL_COMMANDS_SET.contains(cmd),
            "{cmd} must be control-gated"
        );
        assert!(
            KNOWN_COMMANDS_SET.contains(cmd),
            "{cmd} must be a known command"
        );
    }
}

#[test]
fn fleet_permission_respond_uses_the_manifest_capability() {
    let descriptor = super::super::command_manifest::descriptor("fleet_permission_respond")
        .expect("registered command");
    assert!(!descriptor.capability.is_empty());
    assert!(!canonical_device_has_capability(
        "unregistered-fleet-device",
        &descriptor.capability
    ));
}

#[tokio::test]
async fn fleet_get_snapshot_read_is_not_control_gated() {
    let device = "dev-fleet-read-ungated-001";
    let state = test_state();
    let router = build_router(state);
    let jwt = device_jwt(device);
    let resp = rpc_post(router, "fleet_get_snapshot", json!({}), &jwt, None).await;
    // Neither 404 (unwired) nor 403 (gated); 503 in test mode is fine.
    assert_ne!(resp.status().as_u16(), 404);
    assert_ne!(resp.status().as_u16(), 403);
}

#[tokio::test]
async fn fleet_get_snapshot_dispatch_returns_the_runtime_snapshot() {
    let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
    // Ingest a uniquely-identified session into the process-global runtime.
    // A unique ppid too: the registry evicts same-pid/new-session rows, and
    // another (unlocked) test ingesting with a shared pid would drop ours.
    let sid = "rpc-fleet-snapshot-001";
    crate::fleet::runtime().ingest(&crate::fleet::registry::FleetEvent {
        agent: crate::fleet::registry::FleetAgent::ClaudeCode,
        event: "SessionStart".into(),
        pid: None,
        ppid: Some(918_273),
        env: Default::default(),
        payload: json!({ "session_id": sid }),
    });

    let state = test_state();
    // Host-generic (reaches the runtime directly): works on a headless host.
    let result = dispatch(
        "fleet_get_snapshot",
        json!({}),
        &state,
        &headless_host(),
        "dev-fleet-snap",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("fleet_get_snapshot must dispatch host-generically");
    let sessions = result["sessions"].as_array().expect("sessions array");
    assert!(sessions.iter().any(|s| s["sessionId"] == sid));
}

// ── Missing Authorization → 401 (middleware) ──────────────────────────────

#[tokio::test]
async fn missing_auth_returns_401() {
    let state = test_state();
    let router = build_router(state);
    let req = Request::builder()
        .method("POST")
        .uri("/internal/_rpc/claude_sidecar_status")
        .header("Content-Type", "application/json")
        .body(Body::from(b"{}".to_vec()))
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status().as_u16(), 401);
}

#[tokio::test]
async fn service_scope_startup_burst_does_not_consume_device_quota() {
    let state = test_state();
    let context = DeviceContext {
        device_id: crate::companion_api::jwt::SERVICE_DEVICE_ID.to_string(),
        account_id: ACCOUNT_ID.to_string(),
        scope: "service".to_string(),
        granted_scopes: Vec::new(),
        authorization_capabilities: None,
    };

    for request_index in 0..25 {
        let response = rpc_handler(
            Path("claude_sidecar_status".to_string()),
            Extension(context.clone()),
            HeaderMap::new(),
            State(Arc::clone(&state)),
            Json(json!({})),
        )
        .await;
        if let Err((status, body)) = response {
            assert_ne!(
                status,
                StatusCode::TOO_MANY_REQUESTS,
                "headless startup request {request_index} was rate limited: {}",
                body.0.message
            );
        }
    }
    assert_eq!(state.rate_limiter.bucket_count(), 0);
}

// ── app_handle=None → 503 for commands that need it ──────────────────────

#[tokio::test]
async fn command_requiring_app_handle_returns_503_in_test_mode() {
    // `DispatchHost::from_state` consults the process-global headless
    // services slot — hold the shared global-slot lock so a concurrent
    // test's install doesn't turn this 503 into a headless dispatch.
    let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
    crate::headless::install_headless_services(None);
    let state = test_state(); // app_handle is None
    let router = build_router(state);
    let jwt = device_jwt("dev1");
    let resp = rpc_post(router, "claude_sidecar_status", json!({}), &jwt, None).await;
    assert_eq!(resp.status().as_u16(), 503);
    let body = body_json(resp).await;
    assert_eq!(body["code"], "service_unavailable");
}

// ── DispatchHost (ADR-0059 R5) ────────────────────────────────────────────

fn headless_host() -> super::super::dispatch_host::DispatchHost {
    super::super::dispatch_host::DispatchHost::Headless(
        crate::headless::HeadlessServices::stub_for_tests(),
    )
}

#[tokio::test]
async fn headless_dispatch_rejects_desktop_automation_consent_commands() {
    let state = test_state();
    let host = headless_host();

    for command in ["automation_consent_pending", "automation_consent_respond"] {
        let error = dispatch(
            command,
            json!({}),
            &state,
            &host,
            "dev1",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect_err("headless hosts must not expose OS automation consent");
        assert_eq!(error.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.1 .0.code, "headless_unsupported");
    }
}

/// Data-plane arms work on a headless host: `session_list` served from
/// the degraded SQLite store, no AppHandle anywhere.
#[tokio::test]
async fn headless_dispatch_serves_the_data_plane_from_the_store() {
    use crate::companion_api::store::AppStore;
    let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
    crate::companion_api::ws_bridge::test_support::clear_socket_for_testing();
    let store = crate::companion_api::store::sqlite::SqliteAppStore::in_memory().expect("open");
    crate::companion_api::data_plane::install_headless_store(Some(
        store.clone() as Arc<dyn AppStore>
    ));

    let state = test_state();
    let result = dispatch(
        "session_list",
        json!({ "limit": 10, "offset": 0 }),
        &state,
        &headless_host(),
        "dev1",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("session_list must work on a headless host");
    assert_eq!(result["total"], 0);

    crate::companion_api::data_plane::install_headless_store(None);
}

/// Process-owned service status is available without a WebView. A fresh
/// headless registry reports the same stopped state as a fresh desktop
/// `McpServerState`.
#[tokio::test]
async fn headless_dispatch_reports_mcp_server_status() {
    let state = test_state();
    let status = dispatch(
        "mcp_server_status",
        json!({}),
        &state,
        &headless_host(),
        "dev1",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("mcp_server_status must work on a headless host");
    assert_eq!(status["running"], false);
    assert_eq!(status["port"], Value::Null);
}

#[tokio::test]
async fn headless_mcp_lifecycle_reuses_validation_and_idempotent_stop() {
    let state = test_state();
    let host = headless_host();

    let invalid = dispatch(
        "mcp_server_start",
        json!({
            "port": 0,
            "token": "short",
            "settingsJson": r#"{"enabled":true,"enabledScopes":[]}"#,
        }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect_err("weak MCP bearer must be rejected before sidecar spawn");
    assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
    assert_eq!(invalid.1 .0.code, "mcp_server_invalid_request");

    for _ in 0..2 {
        let stopped = dispatch(
            "mcp_server_stop",
            json!({}),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("stop is idempotent when MCP server is not running");
        assert_eq!(stopped, Value::Null);
    }
}

/// The live terminal inventory belongs to the companion WS process, not
/// to a WebView. A headless host therefore exposes an empty registry as a
/// successful read instead of claiming the command needs Tauri.
#[tokio::test]
async fn headless_dispatch_lists_live_terminal_sessions() {
    let sessions = headless_host()
        .terminal_list_all("terminal-list-headless-device")
        .await
        .expect("headless durable terminal inventory must be host-generic");
    assert!(sessions.is_empty());
}

#[test]
fn terminal_rpc_requires_host_enablement_and_the_canonical_device_capability() {
    let device = "terminal-rpc-device";

    assert!(terminal_rpc_authorization(device, true, false).is_err());
    assert!(terminal_rpc_authorization(device, false, true).is_err());
    assert!(terminal_rpc_authorization(device, true, true).is_ok());
    assert!(terminal_rpc_authorization("", true, true).is_err());
}

/// The claude arms are host-generic after R7: `claude_sidecar_status` on
/// a headless host reports the registry's (not-yet-spawned) sidecar.
#[tokio::test]
async fn headless_claude_arms_reach_the_registry_sidecar() {
    let state = test_state();
    let host = headless_host();

    let status = dispatch(
        "claude_sidecar_status",
        json!({}),
        &state,
        &host,
        "dev1",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("claude_sidecar_status must work headless");
    assert_eq!(status["ready"], false);

    // Provider-env arms hit the registry's ApiKeyState.
    dispatch(
        "claude_set_api_key",
        json!({ "key": "sk-headless" }),
        &state,
        &host,
        "dev1",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("claude_set_api_key must work headless");
    let has = dispatch(
        "claude_has_api_key",
        json!({}),
        &state,
        &host,
        "dev1",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("claude_has_api_key must work headless");
    assert_eq!(has, Value::Bool(true));

    // Control messages against a not-running sidecar surface the plain
    // "not running" error (proving the arm reached write_command).
    let err = dispatch(
        "claude_interrupt",
        json!({ "session_id": "s1" }),
        &state,
        &host,
        "dev1",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect_err("no sidecar running");
    assert!(err.1 .0.message.contains("not running"));
}

// ── External-agent arms: scope + policy + audit (ADR-0059 R11) ──────────

#[test]
fn agent_control_comes_from_the_security_store_or_the_service_scope_and_nowhere_else() {
    // The in-memory allow lists that used to shadow this decision are gone. A
    // device with no SecurityStore grant is refused no matter what; only the
    // loopback service principal bypasses the capability check.
    assert!(!is_agent_control_authorized(
        "spawn_external_agent",
        "device-with-no-grant",
        Some("device")
    ));
    assert!(is_agent_control_authorized(
        "spawn_external_agent",
        "brain-local",
        Some("service")
    ));
}

/// The agent arms must not have leaked into the remote-control tier while
/// moving out of the service-only one.
#[test]
fn agent_control_commands_are_their_own_tier() {
    for name in AGENT_CONTROL_COMMANDS {
        assert!(
            is_agent_control_command(name),
            "{name} must be in the agent-control tier"
        );
        assert!(
            !is_service_only_command(name),
            "{name} must no longer be service-token-only"
        );
        assert!(
            !is_control_command(name),
            "{name} must not ride the remote-control grant"
        );
        assert!(
            KNOWN_COMMANDS_SET.contains(name),
            "{name} must stay allowlisted"
        );
    }
}

#[test]
fn scheduled_task_agent_control_is_payload_sensitive_and_fail_closed() {
    assert!(!scheduled_task_requires_agent_control(
        "scheduled_task_create",
        &json!({ "input": { "type": "workflow" } })
    ));
    assert!(scheduled_task_requires_agent_control(
        "scheduled_task_create",
        &json!({ "input": { "type": "agent" } })
    ));
    assert!(!scheduled_task_requires_agent_control(
        "scheduled_task_delete",
        &json!({ "taskType": "backup" })
    ));
    assert!(scheduled_task_requires_agent_control(
        "scheduled_task_delete",
        &json!({})
    ));
    assert!(scheduled_task_requires_agent_control(
        "scheduled_task_list",
        &json!({})
    ));
    assert!(!scheduled_task_requires_agent_control(
        "scheduled_task_list",
        &json!({ "filter": { "types": ["workflow", "backup"] } })
    ));
}

/// Attaching is two operations wearing one command name, and the manifest can
/// only declare one capability. The baseline is the read capability every
/// paired device holds; asking for control escalates to Remote Control.
///
/// Before this, `session_attach` declared `workspace.write` outright, so a
/// read-only device could not register as a watcher at all — which is why the
/// plan's observe mode had no way to exist.
#[test]
fn attaching_escalates_to_remote_control_only_when_control_is_asked_for() {
    let descriptor =
        crate::companion_api::command_manifest::descriptor("session_attach").expect("registered");
    assert_eq!(
        descriptor.capability, "host.observe",
        "the baseline must be readable by any paired device, or observe attach cannot exist"
    );
    // Anything that is not a literal `observe` is a control request, because
    // that is exactly how `readAttachMode` in desktop-write-source.ts reads it.
    // A gate that escalated only on a literal `"control"` authorized a
    // mode-less body as a read and then let the handler treat it as control.
    for args in [
        json!({ "mode": "control" }),
        json!({}),
        json!({ "mode": "CONTROL" }),
        json!({ "mode": true }),
    ] {
        assert_eq!(
            payload_required_capability("session_attach", &args),
            Some("workspace.write"),
            "the gate must read the absent/unrecognized mode the way the handler does: {args}"
        );
    }
    assert_eq!(
        payload_required_capability("session_attach", &json!({ "mode": "observe" })),
        None,
        "observing stays at the baseline every paired device holds"
    );
    // Detaching releases the caller's own lease and can never be riskier than
    // holding it, so it stays at the baseline whatever the payload says.
    assert_eq!(
        payload_required_capability("session_detach", &json!({ "mode": "control" })),
        None
    );
}

/// Attaching happens on every viewer open and again on every renewal. An
/// interactive approval — an owner-only, explicitly-confirmed, 10-minute admin
/// lease — cannot be part of that loop; declaring one meant every attach
/// answered `interactive_approval_required` before it reached the handler.
#[test]
fn attaching_needs_no_step_up_lease() {
    for name in ["session_attach", "session_detach"] {
        let descriptor =
            crate::companion_api::command_manifest::descriptor(name).expect("registered");
        assert_eq!(
            descriptor.approval,
            crate::companion_api::command_manifest::CommandApproval::None,
            "{name} runs on every viewer open and every renewal; a step-up lease cannot gate it"
        );
    }
}

/// Attachment upload is the byte path into a session, so every arm carries the
/// Remote Control capability rather than the observe baseline `session_attach`
/// starts from — staging a file the Host will hand to a model is the same
/// elevation as sending the message that names it.
///
/// No step-up lease, for the same reason attach has none: a 10 MB file is
/// hundreds of chunk calls, and an owner-confirmed admin lease in that loop
/// would answer `interactive_approval_required` on the first one.
#[test]
fn attachment_upload_carries_remote_control_without_a_step_up_lease() {
    for name in [
        "session_attachment_upload_init",
        "session_attachment_upload_chunk",
        "session_attachment_upload_commit",
        "session_attachment_upload_abort",
    ] {
        let descriptor =
            crate::companion_api::command_manifest::descriptor(name).expect("registered");
        assert_eq!(
            descriptor.capability, "workspace.write",
            "{name} moves bytes the Host will hand to a model"
        );
        assert_eq!(
            descriptor.approval,
            crate::companion_api::command_manifest::CommandApproval::None,
            "{name} runs hundreds of times per file; a step-up lease cannot gate it"
        );
    }
}

/// Every arm binds to the authenticated caller. Without the injection a device
/// could append to — or resolve — an upload it does not own by naming its id.
#[test]
fn attachment_upload_arms_receive_the_server_bound_caller() {
    for name in [
        "session_attachment_upload_init",
        "session_attachment_upload_chunk",
        "session_attachment_upload_commit",
        "session_attachment_upload_abort",
    ] {
        let args = inject_caller_device_id(name, json!({ "callerDeviceId": "spoofed" }), "real");
        assert_eq!(
            args.get("callerDeviceId").and_then(Value::as_str),
            Some("real"),
            "{name} must not honour a self-asserted caller"
        );
    }
}

/// Every arm reserves an idempotency slot, so a chunk replayed after a lost
/// response returns the cached answer instead of being applied twice.
#[test]
fn every_attachment_upload_arm_is_a_write() {
    for name in [
        "session_attachment_upload_init",
        "session_attachment_upload_chunk",
        "session_attachment_upload_commit",
        "session_attachment_upload_abort",
    ] {
        assert!(!READ_ONLY_COMMANDS_SET.contains(name), "{name} writes");
    }
}

#[test]
fn service_scope_is_authorized_for_internal_control_plane_commands() {
    for command in [
        "terminal_exec",
        "plugin_permission_grant",
        "plugin_permission_revoke",
        "plugin_api_invoke",
        "plugin_api_batch_invoke",
        "mcp_server_start",
        "mcp_server_stop",
        "mcp_server_restart",
        "lsp_host_ensure",
        "lsp_host_request",
    ] {
        assert!(is_control_authorized(
            command,
            "brain-local",
            Some("service")
        ));
    }
    assert!(!is_control_authorized(
        "terminal_exec",
        "unapproved-device",
        Some("device")
    ));
    assert!(!is_control_authorized(
        "git_push",
        "brain-local",
        Some("service")
    ));
}

#[test]
fn plugin_permission_commands_have_remote_safe_classification() {
    assert!(READ_ONLY_COMMANDS.contains(&"plugin_permission_list"));
    assert!(CONTROL_COMMANDS.contains(&"plugin_permission_grant"));
    assert!(CONTROL_COMMANDS.contains(&"plugin_permission_revoke"));
    for command in [
        "plugin_permission_grant",
        "plugin_permission_list",
        "plugin_permission_revoke",
    ] {
        assert!(!SERVICE_ONLY_COMMANDS.contains(&command));
    }
}

#[test]
fn lsp_facade_is_control_gated_but_not_service_only() {
    for command in ["lsp_host_ensure", "lsp_host_request"] {
        assert!(CONTROL_COMMANDS.contains(&command));
        assert!(!SERVICE_ONLY_COMMANDS.contains(&command));
        assert!(!is_control_authorized(
            command,
            "unapproved-device",
            Some("device")
        ));
    }
    assert!(SERVICE_ONLY_COMMANDS.contains(&"ensure_system_lsp_host"));
    assert!(SERVICE_ONLY_COMMANDS.contains(&"plugin_invoke_vscode_rpc"));
    for method in [
        "lsp:start",
        "lsp:request",
        "lsp:cancel",
        "protocol:start",
        "protocol:request",
        "protocol:cancel",
        "protocol:stop",
    ] {
        assert!(remote_lsp_method_allowed(method), "{method}");
    }
    assert!(!remote_lsp_method_allowed("extension:activate"));
}

#[test]
fn plugin_api_facade_is_control_gated_and_capabilities_are_read_only() {
    for command in ["plugin_api_invoke", "plugin_api_batch_invoke"] {
        assert!(CONTROL_COMMANDS.contains(&command));
        assert!(!READ_ONLY_COMMANDS.contains(&command));
        assert!(!SERVICE_ONLY_COMMANDS.contains(&command));
        assert!(!is_control_authorized(
            command,
            "unapproved-device",
            Some("device")
        ));
    }
    assert!(READ_ONLY_COMMANDS.contains(&"plugin_get_capabilities"));
    assert!(!CONTROL_COMMANDS.contains(&"plugin_get_capabilities"));
}

#[test]
fn mcp_lifecycle_is_control_gated_but_not_service_only() {
    for command in ["mcp_server_start", "mcp_server_stop", "mcp_server_restart"] {
        assert!(CONTROL_COMMANDS.contains(&command));
        assert!(!READ_ONLY_COMMANDS.contains(&command));
        assert!(!SERVICE_ONLY_COMMANDS.contains(&command));
        assert!(!is_control_authorized(
            command,
            "unapproved-device",
            Some("device")
        ));
    }
    assert!(READ_ONLY_COMMANDS.contains(&"mcp_server_status"));
}

#[tokio::test]
async fn service_scope_executes_terminal_command_on_the_headless_host() {
    let state = test_state();
    let result = dispatch(
        "terminal_exec",
        json!({ "command": "echo cognia-headless-shell", "shell": true }),
        &state,
        &headless_host(),
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("service-scoped terminal exec");

    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["timedOut"], false);
    assert!(result["stdout"]
        .as_str()
        .is_some_and(|stdout| stdout.contains("cognia-headless-shell")));
}

/// Policy deny → 403 naming the violation, with a `deny` audit line;
/// policy allow (smoke stub) → spawn succeeds with an `allow` audit line
/// and the frozen events on the bus.
#[tokio::test]
async fn spawn_arm_enforces_the_policy_and_audits_both_outcomes() {
    if !crate::external_agent::command_resolver::check_command_exists("node") {
        eprintln!("skip: node not on PATH");
        return;
    }
    let state = test_state();
    let tmp = tempfile::tempdir().expect("tempdir");
    let audit_path = tmp.path().join("audit.log");
    crate::companion_api::audit::install_at_for_testing(Some(audit_path.clone()));

    // Headless services with a smoke-enabled policy + temp workspaces.
    let services = {
        use crate::claude::host::HeadlessSidecarHost;
        let event_bus = crate::companion_api::event_bus::EventBus::new();
        let api_keys = crate::api_key::ApiKeyState::new();
        let sidecar_host = Arc::new(HeadlessSidecarHost::new(
            std::path::PathBuf::from("missing.mjs"),
            Arc::clone(&event_bus),
            api_keys.clone(),
        ));
        crate::headless::HeadlessServices::new(
            sidecar_host,
            api_keys,
            event_bus,
            crate::external_agent::presets::SpawnPolicy::new(tmp.path().join("workspaces"), true),
            tmp.path().join("plugins"),
        )
        .expect("headless services for the spawn-policy test")
    };
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

    // Deny: bash is not allowlisted.
    let err = dispatch(
        "spawn_external_agent",
        json!({ "config": { "id": "evil", "command": "bash", "args": ["-c", "id"] } }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect_err("bash must be denied");
    assert_eq!(err.0, StatusCode::FORBIDDEN);
    assert!(err.1 .0.message.contains("denied by policy"));

    // Allow: the smoke stub via node.
    let stub = tmp.path().join("stub-acp-agent.mjs");
    std::fs::write(&stub, "setInterval(() => {}, 60_000);\n").unwrap();
    let spawned = dispatch(
        "spawn_external_agent",
        json!({ "config": {
                "id": "smoke-1",
                "command": "node",
                "args": [stub.display().to_string()],
                "env": { "ANTHROPIC_API_KEY": "sk", "LD_PRELOAD": "/evil.so" },
            } }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("smoke stub must be admitted");
    assert_eq!(spawned, Value::String("smoke-1".into()));

    // Status + kill round-trip through the exec backend.
    let status = dispatch(
        "get_external_agent_status",
        json!({ "agent_id": "smoke-1" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("status");
    assert_eq!(status, Value::String("Running".into()));
    dispatch(
        "kill_external_agent",
        json!({ "agent_id": "smoke-1" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("kill");

    // Audit trail: a deny line and an allow line (with the dropped
    // LD_PRELOAD recorded), then the kill.
    let audit = std::fs::read_to_string(&audit_path).expect("audit written");
    let lines: Vec<Value> = audit
        .lines()
        .map(|l| serde_json::from_str(l).expect("jsonl"))
        .collect();
    assert!(lines.iter().any(|l| l["decision"] == "deny"
        && l["kind"] == "external_agent_spawn"
        && l["command"] == "bash"));
    assert!(lines.iter().any(|l| l["decision"] == "allow"
        && l["kind"] == "external_agent_spawn"
        && l["dropped_env_keys"][0] == "LD_PRELOAD"));
    assert!(lines
        .iter()
        .any(|l| l["kind"] == "external_agent_kill" && l["scope"] == "service"));

    crate::companion_api::audit::install_at_for_testing(None);
}

#[test]
fn service_only_commands_are_known_and_not_control_gated() {
    // The four external-agent arms used to head this list. They moved to
    // the agent-control tier so a paired device can be granted them; see
    // `agent_control_commands_are_their_own_tier`, which pins that they
    // left this one rather than joining the remote-control grant.
    for name in [
        "connectors_register",
        "connectors_unregister",
        "connectors_list_adapters",
        // ADR-0059 T-A5 — connector command plane. The four
        // `connectors_keyring_*` arms left this tier in ADR-0152; see
        // `connector_keyring_arms_are_step_up_not_service_only`.
        "connectors_health",
        "connectors_http_request",
        "connectors_ws_open",
        "connectors_ws_send",
        "connectors_ws_close",
        "connectors_onebot_send",
        // ADR-0131 — moved off the client plane onto the service plane.
        "connectors_onebot_probe",
        "connectors_discord_upload",
        "connectors_lark_ws_open",
        "connectors_lark_ws_close",
        "connectors_reset_all_ws",
        "connectors_attachment_fetch",
        "connectors_attachment_read",
        // The cache-upkeep arms the housekeeping sweep drives.
        "connectors_attachment_list",
        "connectors_attachment_delete",
        "connectors_attachment_evict_adapter",
        "connectors_attachment_enforce_budget",
        "connectors_media_upload",
        "connectors_matrix_crypto_init",
        "connectors_matrix_crypto_close",
        "connectors_matrix_crypto_outgoing_requests",
        "connectors_matrix_crypto_mark_request_sent",
        "connectors_matrix_crypto_receive_sync_changes",
        "connectors_matrix_crypto_decrypt_event",
        "connectors_matrix_crypto_encrypt_event",
        "connectors_matrix_crypto_share_room_key",
        "connectors_matrix_crypto_update_tracked_users",
        "connectors_matrix_crypto_get_missing_sessions",
        "connectors_matrix_encrypted_media_upload",
        "connectors_matrix_encrypted_media_fetch",
        "connectors_lark_upload_file",
        "connectors_lark_upload_image",
        "plugin_launch_js",
        "plugin_invoke_js_callback",
        "plugin_deactivate_js",
        "plugin_stop_js",
        "plugin_js_status",
    ] {
        assert!(is_service_only_command(name), "{name} must be service-only");
        assert!(KNOWN_COMMANDS.contains(&name), "{name} must be allowlisted");
        assert!(
            !CONTROL_COMMANDS.contains(&name),
            "{name} is scope-gated, not device-control-gated"
        );
    }
}

/// ADR-0152 — configuring a bot is an admin action, not a service action.
///
/// The four keyring arms are the ones an operator must reach to set up a
/// connector from a paired device. Left on the service tier they were
/// unreachable by anything but a loopback-minted service token, so a paired
/// browser could not configure a bot at all — and the desktop only worked
/// because Tauri `invoke` bypasses this protocol face entirely.
///
/// They are NOT simply opened: the step-up tier means every call must carry a
/// valid admin lease, which supplies the time limit and the revoke-on-
/// disconnect that a bare capability check does not. This test pins both
/// halves, because losing either one silently is the failure that matters —
/// dropping the step-up entry would leave them reachable with nothing but a
/// device JWT.
#[test]
fn connector_keyring_arms_are_step_up_not_service_only() {
    for name in [
        "connectors_keyring_set",
        "connectors_keyring_get",
        "connectors_keyring_delete",
        "connectors_keyring_list",
    ] {
        assert!(
            STEP_UP_COMMANDS.contains(&name),
            "{name} must require an admin lease"
        );
        assert!(
            !is_service_only_command(name),
            "{name} must be reachable from a device plane"
        );
        assert!(KNOWN_COMMANDS.contains(&name), "{name} must be allowlisted");
        let descriptor = crate::companion_api::command_manifest::descriptor(name)
            .expect("keyring arm must have a manifest descriptor");
        assert_eq!(descriptor.capability, "host.admin", "{name}");
    }
}

/// ADR-0153 — the approver side must not need the thing it grants.
///
/// `host_consent_respond` answers the request that unblocks
/// `host_admin_lease_issue`. If either it or the lease command were step-up
/// gated, answering would require a lease and minting a lease would require an
/// answer: a loop with no entry, and one that only shows up on a device plane
/// nobody exercises in a unit test.
#[test]
fn the_consent_arms_are_not_gated_by_the_lease_they_grant() {
    for name in [
        "host_consent_pending",
        "host_consent_respond",
        "host_admin_lease_issue",
    ] {
        assert!(KNOWN_COMMANDS.contains(&name), "{name} must be allowlisted");
        assert!(
            !STEP_UP_COMMANDS.contains(&name),
            "{name} must not require the lease it exists to grant"
        );
        assert!(
            !is_service_only_command(name),
            "{name} must be reachable from a device plane — on a headless host \
             another paired device is the only approver there is"
        );
        let descriptor = crate::companion_api::command_manifest::descriptor(name)
            .expect("consent arm must have a manifest descriptor");
        assert_eq!(descriptor.capability, "host.admin", "{name}");
    }
}

/// Answering is administrator work and moves real authority, so it is
/// control-gated like the lease itself. Listing is not: a device has to be able
/// to discover it is an approver, and the arm already refuses without
/// `host.admin`.
#[test]
fn answering_is_control_gated_and_listing_is_not() {
    assert!(CONTROL_COMMANDS.contains(&"host_consent_respond"));
    assert!(!CONTROL_COMMANDS.contains(&"host_consent_pending"));
}

/// The rest of the connector plane stays where it was. Nothing an operator
/// does in Settings needs to open a raw websocket or drive Matrix crypto, so
/// widening the whole family would trade a real boundary for nothing.
#[test]
fn the_rest_of_the_connector_plane_stays_service_only() {
    for name in [
        "connectors_http_request",
        "connectors_ws_open",
        "connectors_ws_send",
        "connectors_matrix_crypto_encrypt_event",
        "connectors_attachment_read",
    ] {
        assert!(
            is_service_only_command(name),
            "{name} must stay service-only"
        );
        assert!(
            !STEP_UP_COMMANDS.contains(&name),
            "{name} is service-only; a lease must not be a way in"
        );
    }
}

#[tokio::test]
async fn headless_plugin_js_status_dispatches_to_the_native_runtime() {
    let state = test_state();
    let generation = uuid::Uuid::new_v4().to_string();
    let result = dispatch(
        "plugin_js_status",
        json!({
            "pluginId": "not-running",
            "generation": generation,
        }),
        &state,
        &headless_host(),
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("headless status query must reach the native plugin runtime");

    assert_eq!(result, Value::Bool(false));
}

// ── Connector attachment-cache upkeep arms (ADR-0059 T-A5) ───────────────

/// `lib/connectors/housekeeping-scheduler.ts` drives these every cycle. With
/// no arms behind them the whole "Connector attachment cache upkeep" task
/// failed each run with `the requested command is not registered`, so on a
/// headless host the orphan sweep and the size ceiling never ran at all and
/// the encrypted cache grew without a bound.
#[tokio::test]
async fn attachment_upkeep_arms_take_the_camel_case_shape_the_brain_sends() {
    let state = test_state();

    // An empty key list is a provable no-op — nothing on disk is read or
    // written — so this pins the arm and its `cacheKeys` alias without
    // depending on what the cache directory happens to hold.
    let report = dispatch(
        "connectors_attachment_delete",
        json!({ "cacheKeys": [] }),
        &state,
        &headless_host(),
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("the delete arm must be reachable");
    assert_eq!(report["deleted"], json!([]));
    assert_eq!(report["failed"], json!([]));
    assert_eq!(report["freedBytes"], 0);

    // The remaining two mutate the cache directory, so assert only that the
    // argument they require reaches the arm: a 400 is raised inside the arm,
    // which neither a missing dispatch arm (404) nor a missing host (503)
    // could produce.
    for name in [
        "connectors_attachment_evict_adapter",
        "connectors_attachment_enforce_budget",
    ] {
        let (status, _body) = dispatch(
            name,
            json!({}),
            &state,
            &headless_host(),
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect_err("a missing required argument must be rejected by the arm");
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
    }
}

/// The listing is read by every housekeeping cycle to find orphaned blobs, so
/// it must never come back from the 60 s idempotency cache — a stale listing
/// would name blobs a freshly written row already claims. The three mutators
/// stay outside the read tier so a retried delete is still deduplicated.
#[test]
fn only_the_attachment_listing_sits_in_the_read_tier() {
    assert!(
        READ_ONLY_COMMANDS_SET.contains("connectors_attachment_list"),
        "the orphan sweep must see a fresh listing on every cycle"
    );
    for name in [
        "connectors_attachment_delete",
        "connectors_attachment_evict_adapter",
        "connectors_attachment_enforce_budget",
    ] {
        assert!(!READ_ONLY_COMMANDS_SET.contains(name), "{name} mutates");
    }
}

// ── Connector ingress registry arms (ADR-0059 R12) ──────────────────────

#[tokio::test]
async fn connectors_registry_arms_round_trip() {
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

    dispatch(
        "connectors_register",
        json!({ "adapter_id": "tg-1", "adapter_type": "telegram" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("register");

    let listed = dispatch(
        "connectors_list_adapters",
        json!({}),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("list");
    assert_eq!(listed["adapters"][0]["adapter_id"], "tg-1");
    assert_eq!(listed["adapters"][0]["adapter_type"], "telegram");
    // The registration landed in the shared ConnectorsState the webhook
    // router verifies against.
    assert!(services
        .connectors
        .inner
        .lock()
        .registered_adapters
        .contains_key("tg-1"));

    dispatch(
        "connectors_unregister",
        json!({ "adapter_id": "tg-1" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("unregister");
    let listed = dispatch(
        "connectors_list_adapters",
        json!({}),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("list after unregister");
    assert_eq!(listed["adapters"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn connector_runtime_lease_arms_enforce_one_headless_owner() {
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

    let acquire = |owner_id: &'static str| {
        dispatch(
            "connectors_runtime_lease_acquire",
            json!({ "ownerId": owner_id, "ttlMs": 15_000 }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
    };

    assert_eq!(
        acquire("brain-a").await.expect("first acquire"),
        Value::Bool(true)
    );
    assert_eq!(
        acquire("brain-b").await.expect("contended acquire"),
        Value::Bool(false)
    );
    assert_eq!(
        dispatch(
            "connectors_runtime_lease_renew",
            json!({ "ownerId": "brain-a", "ttlMs": 15_000 }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("renew"),
        Value::Bool(true)
    );
    assert_eq!(
        dispatch(
            "connectors_runtime_lease_release",
            json!({ "ownerId": "brain-a" }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("release"),
        Value::Bool(true)
    );
    assert_eq!(
        acquire("brain-b").await.expect("acquire after release"),
        Value::Bool(true)
    );
}

#[tokio::test]
async fn connector_runtime_lease_arms_admit_a_device_principal() {
    // The lease arbitrates between EVERY runtime bound to this companion, and
    // a desktop webview holds a device JWT — never a service token. Leaving
    // these service-only made it impossible for the party that most needs to
    // contend to do so, which is how a desktop and a brain on the same
    // companion both ended up dialing the same bots.
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

    assert!(!super::is_service_only_command(
        "connectors_runtime_lease_acquire"
    ));

    assert_eq!(
        dispatch(
            "connectors_runtime_lease_acquire",
            json!({ "ownerId": "desktop:one", "ttlMs": 15_000 }),
            &state,
            &host,
            "paired-desktop",
            Some(ACCOUNT_ID),
            Some("device"),
        )
        .await
        .expect("a device principal may contend for the lease"),
        Value::Bool(true)
    );

    // A legacy caller still gets the boolean response shape. It now stands
    // down safely instead of being told to start before the desktop stopped.
    assert_eq!(
        dispatch(
            "connectors_runtime_lease_acquire",
            json!({ "ownerId": "brain:one", "ttlMs": 15_000 }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("legacy brain requests handoff"),
        Value::Bool(false)
    );

    // Legacy callers cannot observe or acknowledge a handoff. Their failed
    // acquire therefore must not poison the desktop's next renewal.
    assert_eq!(
        dispatch(
            "connectors_runtime_lease_renew",
            json!({ "ownerId": "desktop:one", "ttlMs": 15_000 }),
            &state,
            &host,
            "paired-desktop",
            Some(ACCOUNT_ID),
            Some("device"),
        )
        .await
        .expect("desktop remains owner after legacy contention"),
        Value::Bool(true)
    );

    // Handoff-aware callers can distinguish the reserved takeover from an
    // ordinary same-class busy result and wait for the desktop's release.
    assert_eq!(
        dispatch(
            "connectors_runtime_lease_acquire",
            json!({
                "ownerId": "brain:one",
                "ttlMs": 15_000,
                "handoffAware": true,
            }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("handoff-aware brain observes pending handoff"),
        Value::String("handoff-pending".into())
    );

    assert_eq!(
        dispatch(
            "connectors_runtime_lease_acquire",
            json!({
                "ownerId": "brain:two",
                "ttlMs": 15_000,
                "handoffAware": true,
            }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("same-class contender gets a stable busy result"),
        Value::String("busy".into())
    );

    assert_eq!(
        dispatch(
            "connectors_runtime_lease_renew",
            json!({ "ownerId": "desktop:one", "ttlMs": 15_000 }),
            &state,
            &host,
            "paired-desktop",
            Some(ACCOUNT_ID),
            Some("device"),
        )
        .await
        .expect("desktop observes lease loss"),
        Value::Bool(false)
    );
    assert_eq!(
        dispatch(
            "connectors_runtime_lease_release",
            json!({ "ownerId": "desktop:one" }),
            &state,
            &host,
            "paired-desktop",
            Some(ACCOUNT_ID),
            Some("device"),
        )
        .await
        .expect("desktop acknowledges shutdown"),
        Value::Bool(true)
    );
    assert_eq!(
        dispatch(
            "connectors_runtime_lease_acquire",
            json!({
                "ownerId": "brain:one",
                "ttlMs": 15_000,
                "handoffAware": true,
            }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("brain starts only after desktop shutdown"),
        Value::String("acquired".into())
    );
}

#[tokio::test]
async fn connector_runtime_lease_rejects_invalid_input_as_validation_failed() {
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(services);

    let (status, Json(error)) = dispatch(
        "connectors_runtime_lease_acquire",
        json!({ "ownerId": "brain-a", "ttlMs": 1 }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect_err("invalid TTL must be rejected");

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error.code, "validation_failed");
}

#[tokio::test]
async fn github_workspace_housekeeping_arms_reach_the_headless_host() {
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));
    let root = tempfile::TempDir::new().expect("temporary workspace root");
    let workspace = root.path().join("issue-worktree");
    std::fs::create_dir(&workspace).expect("workspace");
    let path = workspace.to_string_lossy().into_owned();

    let stat = dispatch(
        "github_workspace_stat",
        json!({ "path": path }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("stat through headless dispatch");
    assert_eq!(stat["exists"], true);

    let removed = dispatch(
        "github_workspace_remove",
        json!({ "path": workspace.to_string_lossy() }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("remove through headless dispatch");
    assert_eq!(removed, Value::Bool(true));
    assert!(!workspace.exists());
}

// ── Connector command plane arms (ADR-0059 T-A5) ─────────────────────────

/// Keyring set → list → get → delete through the dispatch arms, mixing
/// the camelCase TS-wrapper arg shape with the snake_case alias — both
/// must resolve to the same secret-store entry the webhook verifiers
/// read (hermetic via the `cfg(test)` in-memory secret store).
#[tokio::test]
async fn connectors_keyring_arms_round_trip_camel_and_snake() {
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

    macro_rules! call {
        ($name:expr, $args:expr $(,)?) => {
            dispatch(
                $name,
                $args,
                &state,
                &host,
                "brain-local",
                Some(ACCOUNT_ID),
                Some("service"),
            )
            .await
        };
    }

    // Set via the camelCase wrapper shape.
    call!(
        "connectors_keyring_set",
        json!({ "adapterId": "tg-arm-kr", "credential": "botToken", "value": "s3cret" })
    )
    .expect("set");

    let listed = call!(
        "connectors_keyring_list",
        json!({ "adapterId": "tg-arm-kr", "accounts": ["botToken", "missing"] })
    )
    .expect("list");
    assert_eq!(listed, json!(["botToken"]));

    // Get via the snake_case alias — same entry.
    let got = call!(
        "connectors_keyring_get",
        json!({ "adapter_id": "tg-arm-kr", "credential": "botToken" })
    )
    .expect("get");
    assert_eq!(got, json!("s3cret"));

    call!(
        "connectors_keyring_delete",
        json!({ "adapterId": "tg-arm-kr", "credential": "botToken" })
    )
    .expect("delete");
    let got = call!(
        "connectors_keyring_get",
        json!({ "adapterId": "tg-arm-kr", "credential": "botToken" })
    )
    .expect("get after delete");
    assert_eq!(got, Value::Null);
}

/// The headless brain's canonical secret-store facade is service-only.
/// Deprecated keyring aliases delegate to the same encrypted backend.
#[tokio::test]
async fn secret_store_arms_and_keyring_aliases_share_the_headless_backend() {
    let state = test_state();
    let host = headless_host();

    macro_rules! call {
        ($name:expr, $args:expr $(,)?) => {
            dispatch(
                $name,
                $args,
                &state,
                &host,
                "brain-local",
                Some(ACCOUNT_ID),
                Some("service"),
            )
            .await
        };
    }

    call!(
            "secret_store_set",
            json!({ "input": { "namespace": "backup", "key": "encryption.key.v1", "value": "backup-secret" } }),
        )
        .expect("set");
    let got = call!(
        "keyring_secret_get",
        json!({ "input": { "namespace": "backup", "key": "encryption.key.v1" } }),
    )
    .expect("get");
    assert_eq!(got, json!("backup-secret"));

    call!(
        "secret_store_delete",
        json!({ "input": { "namespace": "backup", "key": "encryption.key.v1" } }),
    )
    .expect("clear");
    let got = call!(
        "secret_store_get",
        json!({ "input": { "namespace": "backup", "key": "encryption.key.v1" } }),
    )
    .expect("get after clear");
    assert_eq!(got, Value::Null);
}

#[tokio::test]
async fn ocr_service_arms_use_the_headless_registry() {
    let state = test_state();
    let host = headless_host();
    let list = dispatch(
        "ocr_list_native_backends",
        json!({}),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("list backends");
    assert!(list.as_array().is_some_and(|items| !items.is_empty()));

    let available = dispatch(
        "ocr_list_available_backends",
        json!({}),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("list available backends");
    assert!(available.is_array());

    let status = dispatch(
        "ocr_model_status",
        json!({ "backend": "tesseract" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("model status");
    assert_eq!(status["installed"], false);
    assert!(status["reason"].as_str().is_some());

    let error = dispatch(
        "ocr_extract_native",
        json!({
            "payload": {
                "backend": "does-not-exist",
                "bytes": [],
                "mime_type": "image/png",
                "languages": [],
                "model_variant": null
            }
        }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect_err("unknown backend must fail");
    assert!(error.1 .0.message.contains("Unsupported backend tag"));

    // `ocr_download_model` is host-neutral through `ocr_progress_emitter()`:
    // the headless host must reach the download code proper (which rejects a
    // backend that manages no models before any I/O), never a host gate.
    let error = dispatch(
        "ocr_download_model",
        json!({ "backend": "does-not-exist", "requestId": "ocr-dl-1" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect_err("unknown backend must fail before any download");
    assert!(
        error
            .1
             .0
            .message
            .contains("does not manage its own models"),
        "unexpected error: {}",
        error.1 .0.message
    );
    assert_ne!(error.1 .0.code, "headless_unsupported");
    assert_ne!(error.1 .0.code, "headless_host_required");
}

#[tokio::test]
async fn remote_notification_protocol_is_bounded_and_event_bus_backed() {
    let state = test_state();
    let host = headless_host();
    let result = dispatch(
        "remote_notification_publish",
        json!({
            "id": "notification-1",
            "title": "Workflow finished",
            "body": "The remote run is ready for review.",
            "level": "success",
            "href": "/workflows/runs/run-1"
        }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("publish notification");
    assert_eq!(result["id"], "notification-1");
    match state.event_bus.subscribe(Some(0), 0) {
        crate::companion_api::event_bus::SubscribeResult::Ok { replay, .. } => {
            let event = replay
                .iter()
                .find(|event| event.event_type == "notification://remote")
                .expect("notification event");
            assert_eq!(event.payload["level"], "success");
            assert_eq!(event.payload["href"], "/workflows/runs/run-1");
        }
        _ => panic!("subscribe failed"),
    }

    let error = dispatch(
        "remote_notification_publish",
        json!({ "title": "Open", "body": "Unsafe", "href": "https://evil.example" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect_err("external href must fail");
    assert!(error.1 .0.message.contains("app-relative"));

    // Optional `source` (the TS NotificationSource) rides along so a companion
    // files the record under the right source preference; bounded charset.
    let result = dispatch(
        "remote_notification_publish",
        json!({
            "id": "notification-2",
            "title": "Nightly report done",
            "body": "3 rows",
            "level": "info",
            "source": "scheduler"
        }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("publish with source");
    assert_eq!(result["id"], "notification-2");
    match state.event_bus.subscribe(Some(0), 0) {
        crate::companion_api::event_bus::SubscribeResult::Ok { replay, .. } => {
            let event = replay
                .iter()
                .find(|event| event.payload["id"] == "notification-2")
                .expect("notification-2 event");
            assert_eq!(event.payload["source"], "scheduler");
        }
        _ => panic!("subscribe failed"),
    }
    let error = dispatch(
        "remote_notification_publish",
        json!({ "title": "x", "body": "y", "source": "bad source!" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect_err("invalid source must fail");
    assert!(error.1 .0.message.contains("source"));
}

#[tokio::test]
async fn plugin_lifecycle_arms_use_the_headless_process_registry() {
    let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
    let state = test_state();
    let host = headless_host();
    let mut plugin_events = match host
        .headless()
        .expect("headless services")
        .event_bus
        .subscribe(None, 0)
    {
        crate::companion_api::event_bus::SubscribeResult::Ok { receiver, .. } => receiver,
        crate::companion_api::event_bus::SubscribeResult::ResyncRequired => {
            panic!("fresh plugin event subscription must not require resync")
        }
    };
    macro_rules! call {
        ($name:expr, $args:expr $(,)?) => {
            dispatch(
                $name,
                $args,
                &state,
                &host,
                "brain-test",
                Some("account-test"),
                Some("service"),
            )
        };
    }
    let installed = call!(
        "plugin_install",
        json!({
            "pluginId": "remote-demo",
            "source": "remote-test",
            "payload": {
                "manifestJson": serde_json::json!({
                    "id": "remote-demo",
                    "name": "Remote Demo",
                    "version": "1.0.0",
                    "type": "frontend",
                    "main": "index.js"
                }).to_string()
            }
        }),
    )
    .await
    .expect("headless plugin install");
    assert_eq!(installed["plugin_id"], "remote-demo");

    let listed = call!("plugin_list", json!({}))
        .await
        .expect("headless plugin list");
    assert_eq!(listed.as_array().map(Vec::len), Some(1));

    let snapshot = call!(
        "plugin_runtime_snapshot",
        json!({ "pluginId": "remote-demo" }),
    )
    .await
    .expect("headless plugin snapshot");
    assert_eq!(snapshot["version"], "1.0.0");

    let backup = call!(
        "plugin_backup_create",
        json!({ "pluginId": "remote-demo", "label": "before-update" }),
    )
    .await
    .expect("headless plugin backup create");
    let backup_id = backup["backupId"].as_str().expect("backup id").to_string();
    call!(
        "plugin_backup_restore",
        json!({ "pluginId": "remote-demo", "backupId": backup_id }),
    )
    .await
    .expect("headless plugin backup restore");
    call!(
        "plugin_backup_delete",
        json!({ "pluginId": "remote-demo", "backupId": backup_id }),
    )
    .await
    .expect("headless plugin backup delete");

    call!("plugin_uninstall", json!({ "pluginId": "remote-demo" }),)
        .await
        .expect("headless plugin uninstall");
    assert!(call!("plugin_list", json!({}))
        .await
        .expect("empty headless plugin list")
        .as_array()
        .is_some_and(Vec::is_empty));
    let actions = [
        plugin_events.try_recv().expect("install event").payload["action"].clone(),
        plugin_events.try_recv().expect("restore event").payload["action"].clone(),
        plugin_events.try_recv().expect("uninstall event").payload["action"].clone(),
    ];
    assert_eq!(
        actions,
        [json!("installed"), json!("restored"), json!("uninstalled")]
    );
}

#[tokio::test]
async fn wasm_runtime_arms_use_the_headless_process_registry() {
    let state = test_state();
    let host = headless_host();

    let listed = dispatch(
        "plugin_wasm_list",
        json!({}),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("headless WASM list");
    assert_eq!(listed, json!([]));

    // `generation` is required by the arm even here, where nothing is loaded:
    // the token is only compared against a live entry, so for an unknown plugin
    // any value reaches the same `false`. Sending one is still the contract.
    let unloaded = dispatch(
        "plugin_wasm_unload",
        json!({ "pluginId": "missing", "generation": "00000000-0000-0000-0000-000000000000" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("unknown WASM unload remains a successful false result");
    assert_eq!(unloaded, json!(false));

    dispatch(
        "plugin_permission_grant",
        json!({
            "pluginId": "demo",
            "permission": "notification",
            "grantedBy": "manifest",
            "expiresAt": Value::Null,
        }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("grant WASM permission");
    let grants = dispatch(
        "plugin_permission_list",
        json!({ "pluginId": "demo" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("list WASM permissions");
    assert_eq!(grants[0]["permission"], json!("notification"));

    dispatch(
        "plugin_set_shell_allowlist",
        json!({ "pluginId": "demo", "commands": ["git"] }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("set shell allowlist");
    dispatch(
        "plugin_set_network_allowlist",
        json!({ "pluginId": "demo", "domains": ["example.com"] }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("set network allowlist");
    let services = host.headless().expect("headless services");
    assert!(services.plugin_runtime.shell_command_allowed("demo", "git"));
    assert!(services
        .plugin_runtime
        .network_host_allowed("demo", "api.example.com"));

    dispatch(
        "plugin_set_status",
        json!({ "pluginId": "demo", "status": "enabled" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("set plugin status");
    assert!(crate::plugin_api::lifecycle::plugin_get_all_for_state(
        services.plugin_runtime.as_ref()
    )
    .await
    .expect("runtime snapshot")
    .iter()
    .any(|snapshot| snapshot.plugin_id == "demo" && snapshot.status == "enabled"));

    dispatch(
        "plugin_permission_revoke",
        json!({ "pluginId": "demo", "permission": "notification" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("revoke WASM permission");
    assert!(!services
        .plugin_runtime
        .has_permission("demo", "notification"));
}

#[tokio::test]
async fn plugin_api_facade_uses_the_headless_gateway_and_capabilities() {
    let state = test_state();
    let host = headless_host();
    let services = host.headless().expect("headless services");
    let plugin_id = format!("rpc-native-{}", uuid::Uuid::new_v4());
    let plugin_dir = services.plugin_runtime.plugin_dir(&plugin_id);
    std::fs::create_dir_all(&plugin_dir).expect("create native plugin root");
    services.plugin_runtime.plugins.write().insert(
        plugin_id.clone(),
        crate::plugin_api::PluginRecord {
            snapshot: crate::plugin_api::PluginRuntimeSnapshot {
                plugin_id: plugin_id.clone(),
                version: "1.0.0".into(),
                status: "loaded".into(),
                last_error: None,
                loaded_at: None,
                install_path: plugin_dir.to_string_lossy().into_owned(),
            },
            runtime_state: Value::Null,
        },
    );

    for permission in ["filesystem:read", "filesystem:write"] {
        dispatch(
            "plugin_permission_grant",
            json!({
                "pluginId": plugin_id,
                "permission": permission,
                "grantedBy": "test",
                "expiresAt": Value::Null,
            }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("grant native gateway permission");
    }

    let call = |api: &str, payload: Value, request_id: &str| {
        json!({
            "request": {
                "sdkVersion": "2.0.0",
                "pluginId": plugin_id,
                "requestId": request_id,
                "api": api,
                "payload": payload,
            }
        })
    };
    let written = dispatch(
        "plugin_api_invoke",
        call(
            "fs:writeText",
            json!({ "path": "remote/note.txt", "content": "companion" }),
            "write",
        ),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("write through headless plugin gateway");
    assert_eq!(written["success"], json!(true));

    let read = dispatch(
        "plugin_api_invoke",
        call("fs:readText", json!({ "path": "remote/note.txt" }), "read"),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("read through headless plugin gateway");
    assert_eq!(read["data"], json!("companion"));

    let unavailable = dispatch(
        "plugin_api_invoke",
        call("window:minimize", json!({}), "window"),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("UI-only capability returns a typed gateway response");
    assert_eq!(unavailable["error"]["code"], json!("NOT_SUPPORTED"));

    let capabilities = dispatch(
        "plugin_get_capabilities",
        json!({}),
        &state,
        &host,
        "paired-reader",
        Some(ACCOUNT_ID),
        Some("device"),
    )
    .await
    .expect("capability projection is readable without remote control");
    let capability = |api: &str| {
        capabilities
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["api"] == api)
            .unwrap()["supported"]
            .as_bool()
            .unwrap()
    };
    assert!(capability("fs:readText"));
    assert!(!capability("window:minimize"));
}

#[tokio::test]
async fn python_runtime_arms_use_the_headless_process_registry() {
    let state = test_state();
    let host = headless_host();
    let services = host.headless().expect("headless services");
    let plugin_id = format!("rpc-python-{}", uuid::Uuid::new_v4());
    let plugin_dir = services.plugin_runtime.plugin_dir(&plugin_id);
    std::fs::create_dir_all(&plugin_dir).expect("create Python plugin root");
    std::fs::write(
        plugin_dir.join("main.py"),
        r#"
from cognia import tool, hook

@tool(description="Doubles a number")
def double(x: int):
    return x * 2

@hook("onMessage")
def on_message(payload):
    return payload

def helper(a, b):
    return [a, b]
"#,
    )
    .expect("write Python plugin");

    macro_rules! call {
        ($name:expr, $args:expr) => {
            dispatch(
                $name,
                $args,
                &state,
                &host,
                "brain-local",
                Some(ACCOUNT_ID),
                Some("service"),
            )
            .await
        };
    }

    call!("plugin_python_initialize", json!({})).expect("initialize Python runtime");
    let runtime = call!("plugin_python_runtime_info", json!({})).expect("Python runtime info");
    if runtime["available"] != json!(true) {
        std::fs::remove_dir_all(&plugin_dir).expect("cleanup unavailable Python fixture");
        return;
    }

    let load_args = json!({
        "pluginId": plugin_id,
        "pluginPath": plugin_dir.to_string_lossy(),
        "mainModule": "main.py",
        "dependencies": Value::Null,
        "config": {},
        "hostSettings": Value::Null,
    });
    let denied = call!("plugin_python_load", load_args.clone())
        .expect_err("python:execute must be explicitly granted");
    assert_eq!(denied.0, StatusCode::FORBIDDEN);
    assert_eq!(denied.1 .0.code, "plugin_permission_denied");

    call!(
        "plugin_permission_grant",
        json!({
            "pluginId": plugin_id,
            "permission": "python:execute",
            "grantedBy": "test",
            "expiresAt": Value::Null,
        })
    )
    .expect("grant python:execute");
    let loaded = call!("plugin_python_load", load_args).expect("load Python plugin");
    assert_eq!(loaded["hooks"][0]["event"], "onMessage");

    // Every post-load Python arm requires the generation token minted by the
    // load, so a call aimed at a since-reloaded runtime is rejected instead of
    // silently hitting the new host. Read it back from the load response rather
    // than inventing one — the point of the token is that only the loader knows
    // it, and a test that made one up would pass while proving nothing.
    let generation = loaded["generation"]
        .as_str()
        .expect("load response carries the generation token")
        .to_owned();

    let tools = call!(
        "plugin_python_get_tools",
        json!({ "pluginId": plugin_id, "generation": generation })
    )
    .expect("get Python tools");
    assert_eq!(tools[0]["name"], "double");
    let doubled = call!(
        "plugin_python_call_tool",
        json!({
            "pluginId": plugin_id,
            "toolName": "double",
            "args": { "x": 21 },
            "generation": generation,
        })
    )
    .expect("call Python tool");
    assert_eq!(doubled, json!(42));

    // A stale token must not be able to reach the live host.
    let stale = call!(
        "plugin_python_get_tools",
        json!({ "pluginId": plugin_id, "generation": "00000000-0000-0000-0000-000000000000" })
    )
    .expect_err("a stale generation must be refused");
    assert_eq!(stale.0, StatusCode::BAD_REQUEST);

    call!(
        "plugin_python_unload",
        json!({ "pluginId": plugin_id, "generation": generation })
    )
    .expect("unload Python plugin");
    assert_eq!(
        call!("plugin_python_list", json!({})).expect("list Python plugins"),
        json!([])
    );
    std::fs::remove_dir_all(&plugin_dir).expect("cleanup Python fixture");
}

#[tokio::test]
async fn vscode_runtime_arms_use_the_headless_process_registry() {
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));
    let plugin_id = format!("rpc-vscode-{}", uuid::Uuid::new_v4());
    let plugin_dir = services.plugin_runtime.plugin_dir(&plugin_id);
    std::fs::create_dir_all(plugin_dir.join("out")).expect("create VS Code plugin root");
    std::fs::write(
        plugin_dir.join("out/extension.js"),
        "module.exports = { activate() {}, deactivate() {} };",
    )
    .expect("write VS Code plugin");

    let host_script = plugin_dir.join("fake-vscode-host.cjs");
    std::fs::write(
            &host_script,
            r#"
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "sidecar:ready", params: {} }) + "\n");
rl.on("line", (line) => {
  const request = JSON.parse(line);
  let result = { ok: true };
  if (request.method === "extension:activate") {
    result = { registeredCommands: ["headless.rpc"], registeredWebviewViews: [], registeredLanguageProviders: [] };
  } else if (request.method === "test:echo") {
    result = request.params;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
"#,
        )
        .expect("write fake VS Code host");
    services
        .vscode_plugins
        .configure_host(host_script, None, Arc::new(|_, _| {}));

    macro_rules! call {
        ($name:expr, $args:expr) => {
            dispatch(
                $name,
                $args,
                &state,
                &host,
                "brain-local",
                Some(ACCOUNT_ID),
                Some("service"),
            )
            .await
        };
    }

    call!("lsp_host_ensure", json!({})).expect("spawn system LSP host");
    call!("lsp_host_ensure", json!({})).expect("system LSP host is idempotent");
    assert!(services
        .vscode_plugins
        .sidecars
        .read()
        .contains_key(crate::plugin_api::vscode::commands::LSP_HOST_KEY));
    assert_eq!(
        call!(
            "lsp_host_request",
            json!({ "method": "lsp:status", "payloadJson": "{}" })
        )
        .expect("invoke system LSP host"),
        json!(r#"{"ok":true}"#)
    );
    let denied_method = call!(
        "lsp_host_request",
        json!({ "method": "extension:activate", "payloadJson": "{}" })
    )
    .expect_err("remote LSP facade must reject non-LSP methods");
    assert_eq!(denied_method.0, StatusCode::BAD_REQUEST);

    let loaded = call!(
        "plugin_load_vscode",
        json!({
            "pluginId": plugin_id,
            "manifestJson": json!({
                "id": plugin_id,
                "vscodeMain": "out/extension.js",
                "vscodeExtension": { "bundleFormat": "cjs" },
            }).to_string(),
            "pluginPath": plugin_dir.to_string_lossy(),
        })
    )
    .expect("load VS Code extension");
    let generation = loaded["generation"]
        .as_str()
        .expect("VS Code generation")
        .to_string();

    let activated = call!(
        "plugin_activate_vscode",
        json!({ "pluginId": plugin_id, "generation": generation, "configJson": "{}" })
    )
    .expect("activate VS Code extension");
    assert_eq!(activated["registeredCommands"], json!(["headless.rpc"]));
    assert!(activated["sidecarPid"].as_u64().is_some());

    let echoed = call!(
        "plugin_invoke_vscode_rpc",
        json!({
            "pluginId": plugin_id,
            "generation": generation,
            "method": "test:echo",
            "payloadJson": r#"{"value":7}"#,
        })
    )
    .expect("invoke VS Code sidecar RPC");
    assert_eq!(echoed, json!(r#"{"value":7}"#));

    call!(
        "plugin_deactivate_vscode",
        json!({ "pluginId": plugin_id, "generation": generation })
    )
    .expect("deactivate VS Code extension");
    call!(
        "plugin_unload_vscode",
        json!({ "pluginId": plugin_id, "generation": generation })
    )
    .expect("unload VS Code extension");
    assert_eq!(services.vscode_plugins.sidecars.read().len(), 1);
    call!(
        "plugin_unload_vscode",
        json!({
            "pluginId": crate::plugin_api::vscode::commands::LSP_HOST_KEY,
            "generation": "system",
        })
    )
    .expect("unload system LSP host");
    assert!(services.vscode_plugins.sidecars.read().is_empty());
    std::fs::remove_dir_all(&plugin_dir).expect("cleanup VS Code fixture");
}

/// `connectors_health` reflects the always-mounted headless ingress and
/// the shared registry count (camelCase payload, wrapper parity).
#[tokio::test]
async fn connectors_health_reports_the_headless_ingress() {
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

    dispatch(
        "connectors_register",
        json!({ "adapter_id": "tg-health", "adapter_type": "telegram" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("register");

    let health = dispatch(
        "connectors_health",
        json!({}),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("health");
    assert_eq!(
        health,
        json!({
            "serverRunning": true,
            "boundAddr": Value::Null,
            "registeredAdapterCount": 1,
        })
    );
}

#[tokio::test]
async fn integration_ingress_uses_the_headless_workflow_state() {
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));
    let route_id = format!("route-{}", uuid::Uuid::new_v4());
    let input = json!({
        "routeId": route_id,
        "pluginId": "fixture-delivery",
        "integrationId": "fixture",
        "accountId": "account-1",
        "subscriptionId": "subscription-1",
        "path": route_id,
        "verification": {
            "type": "static-token",
            "tokenHeader": "x-fixture-token",
            "secretHandle": "secret-1",
        },
        "deliveryIdHeader": "x-delivery-id",
        "eventTypeHeader": "x-event-type",
        "enabled": true,
    });

    let denied = dispatch(
        "integration_ingress_register",
        json!({ "input": input.clone() }),
        &state,
        &host,
        "device-1",
        Some(ACCOUNT_ID),
        Some("device"),
    )
    .await
    .expect_err("paired devices cannot manage Integration ingress");
    assert_eq!(denied.0, StatusCode::FORBIDDEN);

    dispatch(
        "integration_ingress_register",
        json!({ "input": input }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("register integration route");

    dispatch(
        "integration_ingress_unregister",
        json!({ "routeId": route_id }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("unregister integration route");
}

/// A headless host must never answer approval RPCs from its own Rust
/// `workflow_waitpoint` mirror.
///
/// Nothing in a headless deployment writes that table: its only writer is the
/// `workflow_waitpoint_create` Tauri command, and the brain reaches it through
/// `lib/workflow/runtime/tauri-bridge.ts`, which short-circuits every native
/// call to `null` off-Tauri. Answering locally therefore reported "no pending
/// approvals" no matter how many gates were actually waiting in the brain's
/// Dexie, so the phone's pending-approvals card stayed blank and every gate ran
/// out its timeout onto the `rejected` branch.
///
/// The row planted below is the trap: it exists ONLY in the local mirror, which
/// is exactly the state a real headless host can never reach. Both commands must
/// ignore it and divert to the brain's TS arms
/// (`lib/companion/desktop-write-source.ts`). With no brain connected that
/// divert surfaces a retryable `service_unavailable` — failing loudly beats
/// answering with a confident, empty lie.
#[tokio::test]
async fn headless_approval_rpc_never_answers_from_the_local_mirror() {
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));
    services
        .workflow
        .mirror
        .create_waitpoint(&crate::workflow::types::WorkflowWaitpointRow {
            id: "approval-1".into(),
            kind: "approval".into(),
            status: "pending".into(),
            run_id: "run-1".into(),
            workflow_id: "workflow-1".into(),
            step_id: "gate".into(),
            key: "approval:run-1:gate".into(),
            correlation_id: None,
            title: Some("Ship?".into()),
            message: None,
            created_at: 1,
            not_before: 1,
            expires_at: Some(10_000),
            resolution: None,
            notification_sent_at: None,
            resolution_notification_sent_at: None,
            updated_at: 1,
        })
        .expect("persist approval");

    for (command, args) in [
        ("workflow_approval_list", json!({})),
        (
            "workflow_approval_respond",
            json!({ "approvalId": "approval-1", "decision": "approved" }),
        ),
    ] {
        let err = dispatch(
            command,
            args,
            &state,
            &host,
            "device-1",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect_err("headless must divert to the brain, not read the local mirror");
        assert_eq!(err.0, StatusCode::SERVICE_UNAVAILABLE, "{command}");
        assert_eq!(err.1 .0.code, "service_unavailable", "{command}");
        assert!(err.1 .0.retryable, "{command} must be retryable");
    }

    // The planted row is untouched: nothing decided it behind the brain's back.
    let row = services
        .workflow
        .mirror
        .get_waitpoint("approval-1")
        .expect("read approval")
        .expect("approval exists");
    assert_eq!(row.status, "pending");
    assert!(row.resolution.is_none());
}

/// Malformed args map to 400 malformed_request, not a panic or 500.
#[tokio::test]
async fn connectors_http_request_rejects_malformed_args() {
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

    let err = dispatch(
        "connectors_http_request",
        json!({}),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect_err("missing req must 400");
    assert_eq!(err.0, StatusCode::BAD_REQUEST);
    assert_eq!(err.1 .0.code, "malformed_request");
}

#[tokio::test]
async fn headless_matrix_crypto_close_reaches_the_shared_native_session_store() {
    let state = test_state();
    let services = crate::headless::HeadlessServices::stub_for_tests();
    let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

    let result = dispatch(
        "connectors_matrix_crypto_close",
        json!({ "adapterId": "matrix-headless" }),
        &state,
        &host,
        "brain-local",
        Some(ACCOUNT_ID),
        Some("service"),
    )
    .await
    .expect("close Matrix crypto session");

    assert_eq!(result, Value::Null);
}

/// `sync_pull` on a headless host routes through the connected brain's
/// socket transport end-to-end (RPC arm → event frame → respond →
/// resolved delta).
#[tokio::test]
async fn headless_sync_pull_routes_through_the_connected_brain() {
    let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
    let mut rx = crate::companion_api::ws_bridge::test_support::install_socket_for_testing();
    let state = test_state();

    let dispatch_task = {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            dispatch(
                "sync_pull",
                json!({ "table": "sessions", "since": 0 }),
                &state,
                &headless_host(),
                "dev1",
                Some(ACCOUNT_ID),
                Some("service"),
            )
            .await
        })
    };

    // The fake brain: receive the emitted event frame off the socket queue.
    let msg = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
        .await
        .expect("event frame timeout")
        .expect("socket queue closed");
    let axum::extract::ws::Message::Text(text) = msg else {
        panic!("expected text frame");
    };
    let frame: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
    assert_eq!(frame["type"], "event");
    assert_eq!(frame["event"], "companion://sync-pull-request");
    assert_eq!(frame["payload"]["table"], "sessions");
    let request_id = frame["payload"]["request_id"].as_str().unwrap().to_string();

    // Respond exactly as ws_bridge::route_respond would.
    state
        .sync_bridge
        .resolve(crate::companion_api::sync_bridge::SyncPullResponse {
            request_id,
            delta: Some(json!({ "rows": [] })),
            error: None,
        });

    let result = dispatch_task
        .await
        .expect("join")
        .expect("sync_pull must succeed via the brain");
    assert_eq!(result, json!({ "rows": [] }));

    crate::companion_api::ws_bridge::test_support::clear_socket_for_testing();
}

// ── Malformed args → 400 ──────────────────────────────────────────────────

#[tokio::test]
async fn missing_required_field_returns_400() {
    let state = test_state();
    let router = build_router(state);
    let jwt = device_jwt("dev1");
    // claude_interrupt requires session_id
    let resp = rpc_post(router, "claude_interrupt", json!({}), &jwt, None).await;
    // app_handle is None so we'll get 503 before field validation for
    // commands that reach dispatch — but the routing still works.
    // The key assertion is that we never get a 5xx crash / panic.
    assert!(resp.status().as_u16() >= 400);
}

// ── Idempotency: cache hit returns same body without re-executing ─────────

#[tokio::test]
async fn idempotency_cache_hit_returns_cached_body() {
    use std::time::Duration;

    // Use a real cache with a long TTL.
    let cache = Arc::new(IdempotencyCache::with_capacity(
        100,
        Duration::from_secs(60),
    ));
    // Pre-seed the ledger with a completed response for the exact request.
    let params = json!({ "session_id": "s1", "prompt": "hi" });
    cache
        .begin("dev-idem", "claude_send", "idem-key-1", &params)
        .unwrap();
    cache
        .complete(
            "dev-idem",
            "claude_send",
            "idem-key-1",
            &json!({ "cached": true }),
        )
        .unwrap();

    let state = Arc::new(CompanionState {
        secret: RwLock::new(SECRET.to_vec()),
        deny_list: Arc::new(DenyList::new()),
        app_handle: None,
        idempotency: cache,
        event_bus: crate::companion_api::event_bus::EventBus::new(),
        sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        desktop_messages_bridge:
            crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
        desktop_writes_bridge:
            crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
        sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
        rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
        push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
    });

    let router = build_router(state);
    let jwt = device_jwt("dev-idem");

    // Send a NON-read-only command (e.g., claude_send) with the
    // pre-seeded idempotency key. The cache hit is returned before
    // the dispatch even runs (so app_handle=None doesn't matter).
    let resp = rpc_post(router, "claude_send", params, &jwt, Some("idem-key-1")).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["cached"], true);
}

// ── Idempotency: different keys run independently ─────────────────────────

#[tokio::test]
async fn different_idempotency_keys_run_independently() {
    use std::time::Duration;
    let cache = Arc::new(IdempotencyCache::with_capacity(
        100,
        Duration::from_secs(60),
    ));
    for (key, hit) in [("k1", 1), ("k2", 2)] {
        cache
            .begin("dev2", "claude_close_session", key, &json!({}))
            .unwrap();
        cache
            .complete("dev2", "claude_close_session", key, &json!({ "hit": hit }))
            .unwrap();
    }

    let state = Arc::new(CompanionState {
        secret: RwLock::new(SECRET.to_vec()),
        deny_list: Arc::new(DenyList::new()),
        app_handle: None,
        idempotency: cache,
        event_bus: crate::companion_api::event_bus::EventBus::new(),
        sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        desktop_messages_bridge:
            crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
        desktop_writes_bridge:
            crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
        sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
        rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
        push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
    });
    let jwt = device_jwt("dev2");

    // k1
    let router1 = build_router(Arc::clone(&state));
    let r1 = rpc_post(router1, "claude_close_session", json!({}), &jwt, Some("k1")).await;
    assert_eq!(r1.status(), StatusCode::OK);
    let b1 = body_json(r1).await;
    assert_eq!(b1["hit"], 1);

    // k2
    let router2 = build_router(Arc::clone(&state));
    let r2 = rpc_post(router2, "claude_close_session", json!({}), &jwt, Some("k2")).await;
    assert_eq!(r2.status(), StatusCode::OK);
    let b2 = body_json(r2).await;
    assert_eq!(b2["hit"], 2);
}

// ── Read-only commands do NOT write to the cache ──────────────────────────

#[tokio::test]
async fn read_only_commands_skip_cache() {
    use std::time::Duration;
    let cache = Arc::new(IdempotencyCache::with_capacity(
        100,
        Duration::from_secs(60),
    ));
    let state = Arc::new(CompanionState {
        secret: RwLock::new(SECRET.to_vec()),
        deny_list: Arc::new(DenyList::new()),
        app_handle: None,
        idempotency: Arc::clone(&cache),
        event_bus: crate::companion_api::event_bus::EventBus::new(),
        sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        desktop_messages_bridge:
            crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
        desktop_writes_bridge:
            crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
        sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
        rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
        push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
    });

    let router = build_router(state);
    let jwt = device_jwt("dev3");

    // mcp_server_status is read-only. Even with an idempotency-key header,
    // a response should NOT be stored. Since app_handle=None, we get 503;
    // the important thing is that the cache stays empty.
    let _ = rpc_post(
        router,
        "mcp_server_status",
        json!({}),
        &jwt,
        Some("key-should-not-cache"),
    )
    .await;

    // Cache must still be empty.
    assert_eq!(cache.len(), 0);
}

// ── Expired idempotency entry causes re-execution ─────────────────────────

#[tokio::test]
async fn expired_idempotency_key_causes_re_execution() {
    use std::time::Duration;
    // TTL = 0 ms → immediately expired.
    let cache = Arc::new(IdempotencyCache::with_capacity(
        100,
        Duration::from_millis(0),
    ));
    let params = json!({ "session_id": "s" });
    cache
        .begin("dev4", "claude_interrupt", "stale", &params)
        .unwrap();
    cache
        .complete(
            "dev4",
            "claude_interrupt",
            "stale",
            &json!({ "stale": true }),
        )
        .unwrap();
    // Let the entry expire.
    std::thread::sleep(Duration::from_millis(5));

    let state = Arc::new(CompanionState {
        secret: RwLock::new(SECRET.to_vec()),
        deny_list: Arc::new(DenyList::new()),
        app_handle: None,
        idempotency: cache,
        event_bus: crate::companion_api::event_bus::EventBus::new(),
        sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        desktop_messages_bridge:
            crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
        desktop_writes_bridge:
            crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
        sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
        rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
        push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
    });

    let router = build_router(state);
    let jwt = device_jwt("dev4");

    // The cache entry is expired → dispatch runs → 503 (app_handle=None).
    let resp = rpc_post(router, "claude_interrupt", params, &jwt, Some("stale")).await;
    // 503 means dispatch was attempted (cache miss), not a cached 200.
    assert_eq!(resp.status().as_u16(), 503);
}

// ── Dispatch-arm lockstep ─────────────────────────────────────────────────
//
// Source-scan guard: every `KNOWN_COMMANDS` entry must have a real arm in
// the `dispatch()` match. The `assert_not_404!` coverage tests below CANNOT
// prove this — in test mode `app_handle` is `None`, so `rpc_handler` returns
// 503 (service_unavailable) right after the allowlist gate, *before*
// reaching `dispatch`. A command that is allowlisted but has no arm (the
// historical `claude_sub_*` bug) would therefore pass `assert_not_404!`
// while returning 404 on a real device. This hermetic test closes that gap
// without an `AppHandle`, mirroring `spec_parity`'s `include_str!` approach.
#[test]
fn every_known_command_has_a_dispatch_arm() {
    let body = [
        include_str!("chat.rs"),
        include_str!("codex_app.rs"),
        include_str!("native_tools.rs"),
        include_str!("data_sync.rs"),
        include_str!("service_plane.rs"),
        include_str!("source_control.rs"),
        include_str!("filesystem.rs"),
        include_str!("terminal.rs"),
        include_str!("plugins.rs"),
        include_str!("diagnostics.rs"),
    ]
    .join("\n");

    let missing: Vec<&str> = known_commands()
        .iter()
        .copied()
        // Browser commands intentionally dispatch through the typed
        // browser gateway before the general match table. Treat that
        // gateway as a real dispatch arm instead of reporting the entire
        // family as a false-positive runtime 404.
        .filter(|cmd| !crate::companion_api::browser_gateway::is_browser_rpc(cmd))
        .filter(|cmd| !body.contains(&format!("\"{cmd}\"")))
        .collect();

    assert!(
        missing.is_empty(),
        "KNOWN_COMMANDS without a `dispatch()` arm (these 404 at runtime \
             despite being allowlisted): {missing:#?}"
    );
}

// ── Dispatch table coverage: one per family ───────────────────────────────
// These just assert the dispatch arm exists and returns something (not a
// 404), since all commands need app_handle in test mode. The lockstep test
// above is what actually guarantees every allowlisted command has an arm.

macro_rules! assert_not_404 {
    ($name:expr, $body:expr) => {{
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("cover-dev");
        let resp = rpc_post(router, $name, $body, &jwt, None).await;
        assert_ne!(
            resp.status().as_u16(),
            404,
            "command '{}' returned 404 — dispatch arm missing",
            $name
        );
    }};
}

#[tokio::test]
async fn dispatch_coverage_claude_interrupt() {
    assert_not_404!("claude_interrupt", json!({ "session_id": "s" }));
}

#[tokio::test]
async fn dispatch_coverage_claude_compact() {
    assert_not_404!(
        "claude_compact",
        json!({ "session_id": "s", "focus": "the API" })
    );
}

#[tokio::test]
async fn dispatch_coverage_companion_can_control() {
    assert_not_404!("companion_can_control", json!({}));
}

#[tokio::test]
async fn dispatch_coverage_companion_endpoints() {
    assert_not_404!("companion_endpoints", json!({}));
}

#[tokio::test]
async fn dispatch_coverage_claude_approve() {
    assert_not_404!(
        "claude_approve",
        json!({
            "session_id": "s",
            "request_id": "r",
            "decision": "allow"
        })
    );
}

#[tokio::test]
async fn dispatch_coverage_claude_close_session() {
    assert_not_404!("claude_close_session", json!({ "session_id": "s" }));
}

#[tokio::test]
async fn dispatch_coverage_claude_sidecar_status() {
    assert_not_404!("claude_sidecar_status", json!({}));
}

#[tokio::test]
async fn dispatch_coverage_provider_profiles_list() {
    assert_not_404!("provider_profiles_list", json!({}));
}

#[tokio::test]
async fn dispatch_coverage_provider_profiles_import() {
    assert_not_404!("provider_profiles_import", json!({ "payload": {} }));
}

#[tokio::test]
async fn dispatch_coverage_provider_profiles_version() {
    assert_not_404!("provider_profiles_version", json!({}));
}

#[tokio::test]
async fn dispatch_coverage_provider_catalog_status() {
    assert_not_404!("provider_catalog_status", json!({}));
}

#[tokio::test]
async fn dispatch_coverage_provider_catalog_search() {
    assert_not_404!("provider_catalog_search", json!({ "query": "gpt" }));
}

#[tokio::test]
async fn dispatch_coverage_provider_catalog_refresh() {
    assert_not_404!("provider_catalog_refresh", json!({ "payload": {} }));
}

#[tokio::test]
async fn dispatch_coverage_claude_set_oauth_bearer() {
    assert_not_404!("claude_set_oauth_bearer", json!({ "token": null }));
}

#[tokio::test]
async fn dispatch_coverage_claude_has_api_key() {
    assert_not_404!("claude_has_api_key", json!({}));
}

#[tokio::test]
async fn dispatch_coverage_claude_has_oauth_bearer() {
    assert_not_404!("claude_has_oauth_bearer", json!({}));
}

#[tokio::test]
async fn dispatch_coverage_claude_set_api_key() {
    assert_not_404!("claude_set_api_key", json!({ "key": null }));
}

#[tokio::test]
async fn dispatch_coverage_claude_set_provider_env() {
    assert_not_404!(
        "claude_set_provider_env",
        json!({ "api_key": null, "base_url": null })
    );
}

#[tokio::test]
async fn dispatch_coverage_claude_restart_sidecar() {
    assert_not_404!("claude_restart_sidecar", json!({}));
}

#[tokio::test]
async fn dispatch_coverage_read_agent_config() {
    assert_not_404!("read_agent_config", json!({ "agent": "cursor" }));
}

#[tokio::test]
async fn dispatch_coverage_write_agent_config() {
    assert_not_404!(
        "write_agent_config",
        json!({ "agent": "cursor", "value": {} })
    );
}

#[tokio::test]
async fn dispatch_coverage_skills_scan_native() {
    assert_not_404!("skills_scan_native", json!({}));
}

#[tokio::test]
async fn dispatch_coverage_skills_load_registry() {
    assert_not_404!("skills_load_registry", json!({}));
}

#[tokio::test]
async fn dispatch_coverage_skills_install_native() {
    assert_not_404!(
        "skills_install_native",
        json!({
            "request": {
                "dirName": "my-skill",
                "content": "# SKILL",
                "resources": [],
                "clean": false
            }
        })
    );
}

#[tokio::test]
async fn dispatch_coverage_skills_uninstall_native() {
    assert_not_404!("skills_uninstall_native", json!({ "dir_name": "my-skill" }));
}

#[tokio::test]
async fn dispatch_coverage_mcp_server_status() {
    assert_not_404!("mcp_server_status", json!({}));
}

// ── Desktop-message bridge command coverage (Mobile completeness P2) ─────

#[tokio::test]
async fn dispatch_coverage_message_update() {
    // Required fields are present so the handler reaches dispatch and
    // returns 503 (test-mode, no AppHandle). The key assertion is that
    // the dispatch arm is wired (not a 404).
    assert_not_404!(
        "message_update",
        json!({
            "session_id": "s1",
            "message_id": "m1",
            "updates": { "role": "user" }
        })
    );
}

#[tokio::test]
async fn dispatch_coverage_message_delete() {
    assert_not_404!(
        "message_delete",
        json!({ "session_id": "s1", "message_id": "m1" })
    );
}

#[tokio::test]
async fn dispatch_coverage_session_list() {
    assert_not_404!("session_list", json!({ "limit": 20, "offset": 0 }));
}

#[tokio::test]
async fn direct_message_mutations_publish_the_transcript_revision_shape() {
    use crate::companion_api::{
        data_plane::DataPlane,
        event_bus::SubscribeResult,
        store::{sqlite::SqliteAppStore, AppStore},
    };

    let state = test_state();
    let store = SqliteAppStore::in_memory().unwrap();
    store
        .upsert_session("s1", "Transcript", "direct")
        .await
        .unwrap();
    store.create_message("s1", "hello", "user").await.unwrap();
    let data_plane = DataPlane::Direct(store as Arc<dyn AppStore>);
    let mut receiver = match state.event_bus.subscribe(None, unix_time_ms() as i64) {
        SubscribeResult::Ok { receiver, .. } => receiver,
        SubscribeResult::ResyncRequired => panic!("fresh subscriber cannot require resync"),
    };

    publish_direct_transcript_revision(&state, &data_plane, "s1").await;

    let frame = receiver.recv().await.unwrap();
    assert_eq!(frame.event_type, "transcript://revision");
    assert_eq!(frame.payload, json!({ "sessionId": "s1", "revision": 1 }));
}

#[tokio::test]
async fn dispatch_coverage_logs_query() {
    assert_not_404!(
        "logs_query",
        json!({ "query": { "file": "structured", "minLevel": "warn", "limit": 10 } })
    );
}

#[tokio::test]
async fn dispatch_coverage_logs_list_files() {
    assert_not_404!("logs_list_files", json!({}));
}

// ── Missing-field 400s ───────────────────────────────────────────────────

#[tokio::test]
async fn message_update_missing_session_id_returns_non_success() {
    // App handle is None in test-mode so the dispatch short-circuits to
    // 503 *before* per-field validation. The assertion captures the
    // contract that an empty-body request never reaches a 200 success
    // and never returns a 404 (the dispatch arm exists).
    let state = test_state();
    let router = build_router(state);
    let jwt = device_jwt("dev1");
    let resp = rpc_post(router, "message_update", json!({}), &jwt, None).await;
    let status = resp.status().as_u16();
    assert_ne!(status, 200);
    assert_ne!(status, 404);
}

#[tokio::test]
async fn message_delete_missing_message_id_returns_non_success() {
    let state = test_state();
    let router = build_router(state);
    let jwt = device_jwt("dev1");
    let resp = rpc_post(
        router,
        "message_delete",
        json!({ "session_id": "s1" }),
        &jwt,
        None,
    )
    .await;
    let status = resp.status().as_u16();
    assert_ne!(status, 200);
    assert_ne!(status, 404);
}

#[tokio::test]
async fn session_list_missing_limit_returns_non_success() {
    let state = test_state();
    let router = build_router(state);
    let jwt = device_jwt("dev1");
    let resp = rpc_post(router, "session_list", json!({ "offset": 0 }), &jwt, None).await;
    let status = resp.status().as_u16();
    assert_ne!(status, 200);
    assert_ne!(status, 404);
}

// ── session_list lives in READ_ONLY_COMMANDS (skips idempotency cache) ──

#[tokio::test]
async fn session_list_skips_idempotency_cache() {
    use std::time::Duration;
    let cache = Arc::new(IdempotencyCache::with_capacity(
        100,
        Duration::from_secs(60),
    ));
    let state = Arc::new(CompanionState {
        secret: RwLock::new(SECRET.to_vec()),
        deny_list: Arc::new(DenyList::new()),
        app_handle: None,
        idempotency: Arc::clone(&cache),
        event_bus: crate::companion_api::event_bus::EventBus::new(),
        sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        desktop_messages_bridge:
            crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
        desktop_writes_bridge:
            crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
        sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
        rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
        push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
    });

    let router = build_router(state);
    let jwt = device_jwt("dev-list");
    let _ = rpc_post(
        router,
        "session_list",
        json!({ "limit": 10, "offset": 0 }),
        &jwt,
        Some("idem-list"),
    )
    .await;

    // session_list is in READ_ONLY_COMMANDS — cache must remain empty.
    assert_eq!(cache.len(), 0);
}

// ── message_update / message_delete are NOT read-only ────────────────────
// (mutations must be cached on first success so an in-flight retry
// doesn't double-mutate the desktop's Dexie.)

#[test]
fn message_update_not_in_read_only_set() {
    assert!(!READ_ONLY_COMMANDS.contains(&"message_update"));
}

#[test]
fn message_delete_not_in_read_only_set() {
    assert!(!READ_ONLY_COMMANDS.contains(&"message_delete"));
}

#[test]
fn session_list_in_read_only_set() {
    assert!(READ_ONLY_COMMANDS.contains(&"session_list"));
}

#[test]
fn all_three_commands_in_known_commands() {
    assert!(KNOWN_COMMANDS.contains(&"message_update"));
    assert!(KNOWN_COMMANDS.contains(&"message_delete"));
    assert!(KNOWN_COMMANDS.contains(&"session_list"));
}

// ── ADR-0060 caller-device-id injection ──────────────────────────────────

#[test]
fn inject_caller_device_id_overwrites_spoofed_values() {
    let args = json!({ "workflowId": "wf_1", "callerDeviceId": "spoofed" });
    let out = inject_caller_device_id("workflow_trigger_manual", args, "dev-real");
    assert_eq!(out["callerDeviceId"], json!("dev-real"));
    assert_eq!(out["workflowId"], json!("wf_1"));
}

#[test]
fn inject_caller_device_id_only_touches_allowlisted_commands() {
    let args = json!({ "id": "c_1" });
    let out = inject_caller_device_id("character_upsert", args, "dev-real");
    assert!(out.get("callerDeviceId").is_none());
}

#[test]
fn inject_caller_device_id_applies_to_capability_report() {
    let out = inject_caller_device_id(
        "device_capabilities_report",
        json!({ "capabilities": ["camera"] }),
        "dev-cap",
    );
    assert_eq!(out["callerDeviceId"], json!("dev-cap"));
}

#[test]
fn inject_caller_device_id_ignores_non_object_payloads() {
    let out = inject_caller_device_id("workflow_trigger_manual", json!("nope"), "dev-real");
    assert_eq!(out, json!("nope"));
}

#[test]
fn host_feature_manifest_rejects_client_reported_grants_without_an_authority_snapshot() {
    let state = test_state();
    let out = inject_caller_device_grants(
        "host_feature_manifest",
        json!({ "callerDeviceGrants": ["agent.run"] }),
        &state,
        "dev-observer",
        None,
    );

    assert_eq!(out["callerDeviceGrants"], json!([]));
}

#[test]
fn caller_device_grants_only_touch_the_commands_that_authorize_on_them() {
    let state = test_state();
    let out = inject_caller_device_grants(
        "character_upsert",
        json!({ "callerDeviceGrants": ["spoofed"] }),
        &state,
        "dev-real",
        None,
    );
    assert_eq!(out["callerDeviceGrants"], json!(["spoofed"]));
}

/// `attachSession` reads `callerDeviceGrants` as the authority on whether a
/// control attachment may be granted. While only the manifest was injected the
/// attach arm read an absent field as "no grants" and downgraded every
/// controller to an observer, so no device ever held a control lease.
#[test]
fn session_attach_receives_a_server_bound_grant_snapshot() {
    let state = test_state();
    let out = inject_caller_device_grants(
        "session_attach",
        json!({ "sessionId": "s-1", "callerDeviceGrants": ["spoofed"] }),
        &state,
        "dev-observer",
        None,
    );

    // Overwritten, not merged — and empty rather than absent, which is what
    // fails every per-action check closed instead of open.
    assert_eq!(out["callerDeviceGrants"], json!([]));
    // The manifest's opaque host id is not the attach arm's business.
    assert!(out.get("authoritativeHostId").is_none());
}

#[test]
fn headless_workspace_roots_are_bound_to_the_server_policy() {
    let host = headless_host();
    let workspace = std::env::temp_dir()
        .join(format!("cognia-test-workspaces-{}", std::process::id()))
        .join("file-protocol-project");
    std::fs::create_dir_all(&workspace).unwrap();
    let authorized = authorize_workspace_root(&host, workspace.to_string_lossy().into_owned())
        .expect("workspace root");
    assert_eq!(
        std::path::Path::new(&authorized).canonicalize().unwrap(),
        workspace.canonicalize().unwrap()
    );
    let outside = std::env::temp_dir().join("cognia-file-protocol-outside");
    std::fs::create_dir_all(&outside).unwrap();
    let error = authorize_workspace_root(&host, outside.to_string_lossy().into_owned())
        .expect_err("outside root must fail");
    assert_eq!(error.0, StatusCode::FORBIDDEN);
}

#[test]
fn device_capabilities_report_is_known_and_mutating() {
    assert!(KNOWN_COMMANDS.contains(&"device_capabilities_report"));
    // Mutating (persists onto pairedDevices) → must keep idempotency.
    assert!(!READ_ONLY_COMMANDS.contains(&"device_capabilities_report"));
    // Baseline paired capability — not remote-control gated.
    assert!(!CONTROL_COMMANDS.contains(&"device_capabilities_report"));
}

#[test]
fn workflow_step_result_is_known_mutating_and_identity_injected() {
    assert!(KNOWN_COMMANDS.contains(&"workflow_step_result"));
    assert!(!READ_ONLY_COMMANDS.contains(&"workflow_step_result"));
    // The broker's target check replaces a control gate here.
    assert!(!CONTROL_COMMANDS.contains(&"workflow_step_result"));
    assert!(CALLER_DEVICE_ID_COMMANDS.contains(&"workflow_step_result"));
}

#[test]
fn workflow_placement_commands_are_classified_and_handoff_identity_is_bound() {
    assert!(KNOWN_COMMANDS.contains(&"workflow_placement_probe"));
    assert!(KNOWN_COMMANDS.contains(&"workflow_handoff_create"));
    assert!(READ_ONLY_COMMANDS.contains(&"workflow_placement_probe"));
    assert!(!READ_ONLY_COMMANDS.contains(&"workflow_handoff_create"));
    assert!(!CONTROL_COMMANDS.contains(&"workflow_placement_probe"));
    assert!(!CONTROL_COMMANDS.contains(&"workflow_handoff_create"));
    assert!(!CALLER_DEVICE_ID_COMMANDS.contains(&"workflow_placement_probe"));
    assert!(CALLER_DEVICE_ID_COMMANDS.contains(&"workflow_handoff_create"));

    let bound = inject_caller_device_id(
        "workflow_handoff_create",
        json!({ "callerDeviceId": "spoofed", "workflowId": "workflow-1" }),
        "verified-device",
    );
    assert_eq!(bound["callerDeviceId"], json!("verified-device"));
}

#[test]
fn workflow_approval_commands_are_classified() {
    assert!(KNOWN_COMMANDS.contains(&"workflow_approval_list"));
    assert!(KNOWN_COMMANDS.contains(&"workflow_approval_respond"));
    // Listing is a pure read; responding steers execution (control-gated,
    // mutating, caller identity injected).
    assert!(READ_ONLY_COMMANDS.contains(&"workflow_approval_list"));
    assert!(!READ_ONLY_COMMANDS.contains(&"workflow_approval_respond"));
    assert!(CONTROL_COMMANDS.contains(&"workflow_approval_respond"));
    assert!(!CONTROL_COMMANDS.contains(&"workflow_approval_list"));
    assert!(CALLER_DEVICE_ID_COMMANDS.contains(&"workflow_approval_respond"));
}

#[test]
fn workflow_human_input_commands_are_classified_and_identity_bound() {
    assert!(KNOWN_COMMANDS.contains(&"workflow_human_input_list"));
    assert!(KNOWN_COMMANDS.contains(&"workflow_human_input_submit"));
    assert!(READ_ONLY_COMMANDS.contains(&"workflow_human_input_list"));
    assert!(!READ_ONLY_COMMANDS.contains(&"workflow_human_input_submit"));
    assert!(!CONTROL_COMMANDS.contains(&"workflow_human_input_list"));
    assert!(CONTROL_COMMANDS.contains(&"workflow_human_input_submit"));
    assert!(CALLER_DEVICE_ID_COMMANDS.contains(&"workflow_human_input_list"));
    assert!(CALLER_DEVICE_ID_COMMANDS.contains(&"workflow_human_input_submit"));

    for command in ["workflow_human_input_list", "workflow_human_input_submit"] {
        let bound = inject_caller_device_id(
            command,
            json!({ "callerDeviceId": "spoofed" }),
            "verified-device",
        );
        assert_eq!(bound["callerDeviceId"], json!("verified-device"));
    }
}

#[test]
fn hashed_command_sets_mirror_their_arrays() {
    // Command existence comes from the generated protocol manifest. The
    // legacy classification arrays may be strict subsets while migration
    // continues, but every name they retain must resolve canonically.
    assert_eq!(
        KNOWN_COMMANDS.iter().copied().collect::<HashSet<_>>().len(),
        KNOWN_COMMANDS.len()
    );
    assert_eq!(
        READ_ONLY_COMMANDS
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .len(),
        READ_ONLY_COMMANDS.len()
    );
    assert_eq!(CONTROL_COMMANDS_SET.len(), CONTROL_COMMANDS.len());
    for c in KNOWN_COMMANDS {
        assert!(KNOWN_COMMANDS_SET.contains(c));
    }
    for c in READ_ONLY_COMMANDS {
        assert!(READ_ONLY_COMMANDS_SET.contains(c));
    }
}

#[test]
fn managed_ide_remote_commands_preserve_trust_boundaries() {
    for read in [
        "codeserver_supported",
        "codeserver_status",
        "codeserver_list_proxies",
    ] {
        assert!(KNOWN_COMMANDS.contains(&read));
        assert!(READ_ONLY_COMMANDS.contains(&read));
        assert!(!CONTROL_COMMANDS.contains(&read));
    }
    for control in [
        "codeserver_ensure",
        "codeserver_stop",
        "codeserver_stop_all",
    ] {
        assert!(KNOWN_COMMANDS.contains(&control));
        assert!(CONTROL_COMMANDS.contains(&control));
        assert!(!READ_ONLY_COMMANDS.contains(&control));
        assert!(!SERVICE_ONLY_COMMANDS.contains(&control));
    }
    for internal in [
        "codeserver_build_proxy",
        "codeserver_activate_proxy",
        "codeserver_list_proxies",
        "codeserver_broker_validate_paths",
        "codeserver_broker_respond",
        "codeserver_broker_notify",
    ] {
        assert!(KNOWN_COMMANDS.contains(&internal));
        assert!(SERVICE_ONLY_COMMANDS.contains(&internal));
    }
}

// ── Wave 4.1 classification sentinels ────────────────────────────────────
// One read + one destructive write per new domain, plus structural
// integrity (every CONTROL/READ_ONLY entry is also a KNOWN command). These
// guard the manual lockstep the cross-language parity gates can't.

#[test]
fn wave41_reads_are_read_only_and_writes_are_not() {
    for read in [
        "git_status",
        "git_diff_stat",
        "git_diff_file",
        "read_text_file",
        "fs_read_workspace_file",
        "terminal_list_all",
        "terminal_complete_paths",
        "plugin_list",
        "workflow_run_list",
        "twin_source_list",
        "backup_export",
    ] {
        assert!(
            READ_ONLY_COMMANDS.contains(&read),
            "{read} should be read-only"
        );
    }
    for write in [
        "git_push",
        "git_commit",
        "write_text_file",
        "fs_write_workspace_file",
        "terminal_exec",
        "terminal_kill_port",
        "plugin_install",
        "workflow_delete",
        "twin_delete",
        "backup_import",
    ] {
        assert!(
            !READ_ONLY_COMMANDS.contains(&write),
            "{write} must NOT be read-only (would skip idempotency on a mutation)"
        );
    }
}

#[test]
fn path_executable_listing_is_classified_like_path_completion() {
    // The two halves of terminal autocomplete: head words and file paths. They
    // are the same feature reached from the same client, so a classification
    // that differs between them is a bug in one of them.
    //
    // Read-only on the idempotency axis (same prefix, same `$PATH`, same
    // answer) and control-gated on the capability axis (it reports the host's
    // installed executables to whoever asks).
    assert!(KNOWN_COMMANDS.contains(&"terminal_list_path_executables"));
    assert!(READ_ONLY_COMMANDS.contains(&"terminal_list_path_executables"));
    assert!(is_control_command("terminal_list_path_executables"));
}

#[test]
fn git_identity_read_is_not_idempotency_cached_as_a_mutation() {
    assert!(KNOWN_COMMANDS.contains(&"git_identity"));
    assert!(READ_ONLY_COMMANDS.contains(&"git_identity"));
    assert!(!READ_ONLY_COMMANDS.contains(&"git_set_identity"));
}

#[test]
fn wave41_destructive_writes_are_control_gated() {
    for gated in [
        "git_push",
        "git_commit",
        "git_stage",
        "write_text_file",
        "fs_write_workspace_file",
        "terminal_exec",
        "terminal_kill",
        "terminal_kill_port",
        // Unconfined directory listing — read-only AND control-gated,
        // same dual-axis treatment as read_text_file below.
        "terminal_complete_paths",
        "plugin_install",
        "plugin_uninstall",
        "workflow_delete",
        "workflow_cancel_run",
        "twin_delete",
        "twin_source_delete",
        "twin_job_cancel",
        "backup_import",
        "character_delete",
        // Raw absolute-path read — gated to stop a chat-only paired device
        // from reading arbitrary files (secrets) off the desktop. It is
        // simultaneously read-only (idempotency) and control-gated.
        "read_text_file",
    ] {
        assert!(is_control_command(gated), "{gated} should be control-gated");
    }
    // Ungated mutations — create/update/schedule and run listing.
    for ungated in [
        "workflow_create",
        "workflow_update",
        "workflow_schedule_pause",
        "workflow_run_list",
        "twin_source_update",
        "conversation_overrides_update",
        "git_status",
        "git_diff_stat",
    ] {
        assert!(
            !is_control_command(ungated),
            "{ungated} should NOT be gated"
        );
    }
}

// ── Long-term memory command classification (ADR-0069) ──────────────────
// memory_list is a pure read; memory_search is NOT read-only (it bumps
// lastAccessedAt/accessCount, so idempotency-caching it would freeze the
// recency signal); the three writes are control-gated.

#[test]
fn memory_commands_are_classified_correctly() {
    assert!(READ_ONLY_COMMANDS.contains(&"memory_list"));
    assert!(
        !READ_ONLY_COMMANDS.contains(&"memory_search"),
        "memory_search mutates access recency — must not be idempotency-cached"
    );
    for gated in ["memory_store", "memory_update", "memory_forget"] {
        assert!(is_control_command(gated), "{gated} should be control-gated");
    }
    for ungated in ["memory_search", "memory_list"] {
        assert!(
            !is_control_command(ungated),
            "{ungated} should NOT be control-gated"
        );
    }
}

#[test]
fn classification_lists_are_subsets_of_known_commands() {
    for c in CONTROL_COMMANDS {
        assert!(
            KNOWN_COMMANDS.contains(c),
            "CONTROL command {c} missing from KNOWN_COMMANDS"
        );
    }
    for c in READ_ONLY_COMMANDS {
        assert!(
            KNOWN_COMMANDS.contains(c),
            "READ_ONLY command {c} missing from KNOWN_COMMANDS"
        );
    }
}

// ── app_settings_update allowlist coverage (Phase 1 of the mobile theme
//    parity work — see plan i18n-partitioned-teapot.md). The phone's
//    /me/appearance route writes these keys through `app_settings_update`,
//    so a regression here would 400 on every save. The accessor mirror
//    keeps the OpenAPI spec_parity check honest.

#[test]
fn mobile_allowed_keys_accessor_mirrors_const() {
    // The accessor must return exactly the const slice — no copying,
    // no filtering. spec_parity downstream depends on this identity.
    let from_accessor = mobile_allowed_keys();
    assert_eq!(
        from_accessor.len(),
        APP_SETTINGS_MOBILE_ALLOWED_KEYS.len(),
        "accessor length drift"
    );
    for (a, b) in from_accessor
        .iter()
        .zip(APP_SETTINGS_MOBILE_ALLOWED_KEYS.iter())
    {
        assert_eq!(a, b);
    }
}

#[test]
fn mobile_allowlist_includes_appearance_keys() {
    // Every key surfaced by the mobile appearance route must be here.
    // Adding a new tab / setting on the phone side without updating
    // this list will 400 on save.
    for key in [
        "colorTheme",
        "customThemes",
        "activeCustomThemeId",
        "customCss",
        "customCssEnabled",
        "importedVscodeThemes",
        // ADR-0056 — portable appearance keys (sync down ⇄ write up).
        "autoMode",
        "density",
        "radius",
        "motion",
        "messageDisplay",
        "typographyExt",
        "a11y",
        // Theme system enhancement — accent override + plugin theme pointer.
        "accentColor",
        "activePluginThemeId",
        // `wallpapers` is deliberately NOT here: the mobile appearance route
        // renders the wallpaper tab, but every image it can save is an
        // `indexeddb` blobKey that only this handset can resolve. It is
        // device-local now, and `nothing_that_must_not_travel_upward_is_allowlisted`
        // in `settings_sync_generated.rs` pins that it stays off the allowlist.
    ] {
        assert!(
            APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
            "appearance key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
        );
    }
}

#[test]
fn mobile_allowlist_includes_agent_default_keys() {
    // ADR-0056 — the phone's `/me/agent` page (paired mode) writes these
    // agent-default prefs through `app_settings_update`. They already sync
    // desktop→phone; this closes the write-back gap. Missing any → 400.
    for key in [
        "permissionMode",
        "defaultSystemPrompt",
        "defaultMaxThinkingTokens",
        "bareMode",
        "debugMode",
        "briefMode",
    ] {
        assert!(
            APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
            "agent-default key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
        );
    }
}

#[test]
fn mobile_allowlist_includes_conversation_keys() {
    // ADR-0056 (Wave 2) — the phone's conversation page + `/me/agent`
    // compaction toggle write these. Missing any → 400 on save.
    for key in [
        "composerBehavior",
        "streamPartialMessages",
        "compaction",
        "conversationSidebar",
    ] {
        assert!(
            APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
            "conversation key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
        );
    }
    // ADR-0056 (Wave 3) — instructions + surface-skills toggle.
    for key in ["instructions", "surfaceSkillsEnabled"] {
        assert!(
            APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
            "Wave-3 key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
        );
    }
    // `workflowEditorPerformanceTier` is deliberately NOT here. It is a
    // motion/computation budget picked for one device's GPU and CPU; the
    // old comment on the allowlist already called it "kept device-local"
    // while still letting the phone write the desktop's copy, which is a
    // contradiction. It is now `device-local` in the classification table:
    // `/me/workflows-settings` sets this handset's tier and nothing else.
    assert!(
        !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&"workflowEditorPerformanceTier"),
        "workflowEditorPerformanceTier must stay device-local"
    );
}

#[test]
fn mobile_allowlist_includes_speech_voice_keys() {
    // ADR-0056 (Wave 2) — the phone's `/me/speech` page writes the active
    // provider's flat voice key. Missing any → 400 on save.
    for key in [
        "systemVoice",
        "openaiVoice",
        "geminiVoice",
        "edgeVoice",
        "elevenlabsVoice",
        "lmntVoice",
        "humeVoice",
        "cartesiaVoice",
        "deepgramVoice",
        "xiaomiVoice",
        "mistralVoiceId",
    ] {
        assert!(
            APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
            "speech voice key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
        );
    }
}

#[test]
fn mobile_allowlist_includes_web_search_and_notification_keys() {
    // ADR-0056 (Wave 2) — `/me/web-search` preferred provider + fallback,
    // and `/me/notifications` preference object. Provider API keys
    // (`searchProviders`) must stay OUT (credentials). Missing any → 400.
    for key in [
        "defaultSearchProvider",
        "searchFallbackEnabled",
        "notificationPreferences",
    ] {
        assert!(
            APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
            "Wave-2 key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
        );
    }
    // Credential / non-portable search keys must NOT be writable.
    for forbidden in ["searchProviders", "customSearchSources"] {
        assert!(
            !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&forbidden),
            "credential key '{forbidden}' must NOT be in APP_SETTINGS_MOBILE_ALLOWED_KEYS"
        );
    }
}

#[test]
fn mobile_allowlist_excludes_transport_config_keys() {
    // These were allowlisted for a "mobile companion settings tab" that was
    // never built — no mobile surface ever wrote one of them, so the
    // entries were dead. Worse, the direction was backwards: the phone
    // reads `signalingUrl` / `iceServers` / `turnServers` from its OWN
    // settings row to dial the rendezvous, and they were never mirrored
    // down, so a self-hosted signaling server or TURN relay configured on
    // the desktop could not reach the phone at all — it silently fell back
    // to the public default and WebRTC failed behind symmetric NAT.
    //
    // They are now `server-authoritative` in
    // `packages/agent-config-types/src/settings-sync.ts`: mirrored down,
    // never accepted up. `webrtcEnabled` is `device-local` — whether to
    // attempt the tier is each device's own call.
    for key in [
        "webrtcEnabled",
        "signalingUrl",
        "iceServers",
        "turnServers",
        "turnProvider",
    ] {
        assert!(
            !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
            "transport key '{key}' must NOT be writable from a paired client"
        );
    }
}

#[test]
fn mobile_allowlist_keeps_baseline_keys() {
    // Don't accidentally drop a baseline key while editing this list.
    for key in [
        "theme",
        "fontScale",
        "language",
        "reduceMotion",
        "defaultModel",
    ] {
        assert!(
            APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
            "baseline key '{key}' must stay in the mobile allowlist"
        );
    }

    // Two former "baseline" entries are gone on purpose.
    //
    // `defaultCharacterId` never existed on `AppSettings` — it lives on
    // `AdapterInstanceRow`. A phone could pass the allowlist with it and
    // then write a field the desktop's settings row does not have. It was
    // pure drift, invisible because nothing checked the constant against
    // the type.
    //
    // `biometricRequiredFor` is now `device-local`: gating is a property of
    // the device's own authenticator, and letting one device push its
    // policy onto another either weakens it or locks out a device with no
    // biometric hardware.
    for key in ["defaultCharacterId", "biometricRequiredFor"] {
        assert!(
            !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
            "'{key}' must NOT be in the mobile allowlist"
        );
    }
}

#[test]
fn mobile_allowlist_rejects_transport_and_sidecar_keys() {
    // Sentinel keys that the phone must never be allowed to write —
    // protects the desktop-only configuration plane.
    for key in [
        "apiBaseUrl",
        "anthropicApiKey",
        "claudeOauthBearer",
        "mcpServers",
        "providerConfigs",
        "sidecarPath",
    ] {
        assert!(
            !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
            "key '{key}' must NOT be writable from the mobile client"
        );
    }
}

#[tokio::test]
async fn app_settings_update_rejects_unknown_key() {
    // End-to-end: a patch carrying an unknown key returns 400 with
    // `validation_failed` rather than reaching the desktop_writes_bridge.
    let cache = Arc::new(IdempotencyCache::with_capacity(
        100,
        std::time::Duration::from_secs(60),
    ));
    let state = Arc::new(CompanionState {
        secret: RwLock::new(SECRET.to_vec()),
        deny_list: Arc::new(DenyList::new()),
        app_handle: None,
        idempotency: Arc::clone(&cache),
        event_bus: crate::companion_api::event_bus::EventBus::new(),
        sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        desktop_messages_bridge:
            crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
        desktop_writes_bridge:
            crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
        sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
        rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
        push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
    });

    let router = build_router(state);
    let jwt = device_jwt("dev-allowlist");
    let resp = rpc_post(
        router,
        "app_settings_update",
        json!({ "patch": { "apiBaseUrl": "https://attacker.example" } }),
        &jwt,
        None,
    )
    .await;

    assert_eq!(
        resp.status().as_u16(),
        400,
        "unknown key must be rejected as 400"
    );
    let body = body_json(resp).await;
    assert_eq!(body["code"], "validation_failed");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("apiBaseUrl"),
        "error message should name the rejected key"
    );
}

#[tokio::test]
async fn app_settings_update_accepts_color_theme_key() {
    // End-to-end: a patch carrying only allowlisted keys passes the
    // validation gate. The bridge will return service_unavailable
    // here (no app_handle in test state) — that's distinct from a
    // 400, which is what we're guarding against.
    let cache = Arc::new(IdempotencyCache::with_capacity(
        100,
        std::time::Duration::from_secs(60),
    ));
    let state = Arc::new(CompanionState {
        secret: RwLock::new(SECRET.to_vec()),
        deny_list: Arc::new(DenyList::new()),
        app_handle: None,
        idempotency: Arc::clone(&cache),
        event_bus: crate::companion_api::event_bus::EventBus::new(),
        sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        desktop_messages_bridge:
            crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
        desktop_writes_bridge:
            crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
        sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
        rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
        push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
    });

    let router = build_router(state);
    let jwt = device_jwt("dev-allowlist-ok");
    let resp = rpc_post(
        router,
        "app_settings_update",
        json!({ "patch": { "colorTheme": "ocean" } }),
        &jwt,
        None,
    )
    .await;

    // The patch is valid — must NOT be a 400 validation_failed.
    // (The bridge layer below returns 500/503 in unit-test mode
    // without a real app_handle, which is fine for this assertion.)
    assert_ne!(
        resp.status().as_u16(),
        400,
        "allowlisted colorTheme patch must not be rejected as 400"
    );
}

#[test]
fn host_feature_manifest_is_a_read_only_rpc_contract() {
    assert!(KNOWN_COMMANDS.contains(&"host_feature_manifest"));
    assert!(READ_ONLY_COMMANDS.contains(&"host_feature_manifest"));
    assert!(!CONTROL_COMMANDS.contains(&"host_feature_manifest"));
}

#[test]
fn twin_draft_review_is_a_mutating_desktop_bridge_command() {
    assert!(KNOWN_COMMANDS.contains(&"twin_draft_review"));
    assert!(!READ_ONLY_COMMANDS.contains(&"twin_draft_review"));
    assert!(!SERVICE_ONLY_COMMANDS.contains(&"twin_draft_review"));
}

#[test]
fn twin_draft_review_conflict_is_non_retryable_at_the_rpc_boundary() {
    let (status, Json(error)) = map_desktop_write_bridge_error(
        "twin_draft_review",
        format!("{TWIN_DRAFT_REVIEW_CONFLICT_SENTINEL} accept already in progress"),
    );
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error.code, "twin_draft_review_conflict");
    assert!(!error.message.contains(TWIN_DRAFT_REVIEW_CONFLICT_SENTINEL));

    let (status, Json(error)) =
        map_desktop_write_bridge_error("twin_source_create", "offline".to_string());
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(error.code, "internal_error");
}

#[test]
fn single_agent_task_commands_are_control_gated() {
    for command in [
        "agent_task_start",
        "agent_task_pause",
        "agent_task_resume",
        "agent_task_cancel",
        "agent_task_comment",
        "agent_task_move",
    ] {
        assert!(
            KNOWN_COMMANDS.contains(&command),
            "{command} must be reachable"
        );
        assert!(
            CONTROL_COMMANDS.contains(&command),
            "{command} must require remote control"
        );
        assert!(
            !READ_ONLY_COMMANDS.contains(&command),
            "{command} mutates the Agent task board"
        );
    }
}

#[test]
fn remote_claude_response_commands_are_control_gated() {
    for command in [
        "claude_restore",
        "claude_set_mode",
        "claude_plugin_tool_response",
        "claude_tool_result_decision",
        "claude_protocol_adapter_message",
    ] {
        assert!(
            KNOWN_COMMANDS.contains(&command),
            "{command} must be remotely reachable"
        );
        assert!(
            CONTROL_COMMANDS.contains(&command),
            "{command} must require remote control"
        );
        assert!(
            !READ_ONLY_COMMANDS.contains(&command),
            "{command} mutates a live session"
        );
    }
}

#[test]
fn command_families_cover_known_non_browser_commands_once() {
    let families = [
        super::chat::COMMANDS,
        super::codex_app::COMMANDS,
        super::native_tools::COMMANDS,
        super::data_sync::COMMANDS,
        super::service_plane::COMMANDS,
        super::source_control::COMMANDS,
        super::filesystem::COMMANDS,
        super::terminal::COMMANDS,
        super::plugins::COMMANDS,
        super::diagnostics::COMMANDS,
    ];
    let routed: Vec<_> = families.into_iter().flatten().copied().collect();
    let unique: std::collections::HashSet<_> = routed.iter().copied().collect();
    assert_eq!(unique.len(), routed.len(), "command families overlap");

    let expected: std::collections::HashSet<_> = KNOWN_COMMANDS
        .iter()
        .copied()
        .filter(|name| !super::super::browser_gateway::is_browser_rpc(name))
        .collect();
    let missing: Vec<_> = expected.difference(&unique).copied().collect();
    assert!(missing.is_empty(), "unrouted known commands: {missing:?}");
}
