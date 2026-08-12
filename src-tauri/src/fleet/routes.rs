//! Fleet ingress routes, mounted on the companion API router.
//!
//! Auth tier: loopback-source + `X-Cognia-Fleet-Token` (shared token from
//! `~/.cognia/agent-monitor.json`) — deliberately NOT the device-JWT tier
//! (a hook ping must not require mobile pairing) and NOT the pre-auth rate
//! limiter (hook events fire on every tool call; the token gates them).
//! Mounted AFTER `with_state` in `companion_api::server::build_router`, so
//! these are stateless `Router<()>` handlers reaching the process-global
//! [`super::FleetRuntime`].

use axum::{
    extract::ConnectInfo,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::net::SocketAddr;

use super::registry::{FleetAgent, FleetEvent, RegistryEffect};
use super::{PermissionBehavior, QuestionResponse};

pub const FLEET_TOKEN_HEADER: &str = "x-cognia-fleet-token";

/// Stateless fleet router — merged into the companion router post-`with_state`.
pub fn router() -> Router {
    Router::new()
        .route("/api/fleet/hook", post(hook_handler))
        .route(
            "/api/fleet/opencode/commands",
            post(opencode_commands_handler),
        )
        .route(
            "/api/v1/fleet/opencode/commands/ack",
            post(opencode_command_ack_handler),
        )
        .route(
            "/api/v1/fleet/opencode/commands/nack",
            post(opencode_command_nack_handler),
        )
}

/// Body for the OpenCode command poll.
#[derive(serde::Deserialize)]
struct CommandPollBody {
    #[serde(default)]
    session_ids: Vec<String>,
}

/// `POST /api/fleet/opencode/commands` — the OpenCode plugin long-polls for
/// queued send-message commands targeting the sessions it owns. Same loopback
/// + fleet-token gate as the hook endpoint.
async fn opencode_commands_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CommandPollBody>,
) -> Response {
    if !addr.ip().is_loopback() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let runtime = super::runtime();
    let presented = headers
        .get(FLEET_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !runtime.token_matches(presented) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match runtime
        .poll_opencode_commands(&body.session_ids, super::command_poll_wait_ms())
        .await
    {
        Ok(commands) => Json(serde_json::json!({ "commands": commands })).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandAckBody {
    id: String,
    result: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandNackBody {
    id: String,
    error: String,
}

fn authorize_command_route(addr: SocketAddr, headers: &HeaderMap) -> Result<(), StatusCode> {
    if !addr.ip().is_loopback() {
        return Err(StatusCode::FORBIDDEN);
    }
    let presented = headers
        .get(FLEET_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !super::runtime().token_matches(presented) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}

async fn opencode_command_ack_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CommandAckBody>,
) -> Response {
    if let Err(status) = authorize_command_route(addr, &headers) {
        return status.into_response();
    }
    match super::runtime()
        .ack_opencode_command(body.id, body.result)
        .await
    {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

async fn opencode_command_nack_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CommandNackBody>,
) -> Response {
    if let Err(status) = authorize_command_route(addr, &headers) {
        return status.into_response();
    }
    match super::runtime()
        .nack_opencode_command(body.id, body.error)
        .await
    {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

/// `POST /api/fleet/hook` — Claude/Codex hook envelope ingress.
///
/// Fire-and-forget events answer `204` immediately. `PermissionRequest`
/// long-polls until the island answers (→ `200` with the Claude hook decision
/// JSON) or the wait budget lapses (→ `204` empty, so the hook script prints
/// nothing and Claude falls back to its own terminal prompt — fail-open).
async fn hook_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(event): Json<FleetEvent>,
) -> Response {
    if !addr.ip().is_loopback() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let runtime = super::runtime();
    let presented = headers
        .get(FLEET_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !runtime.token_matches(presented) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !runtime.is_enabled() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }

    let agent = event.agent;
    let effect = runtime.ingest(&event);
    // Capture the git branch off the async worker (bounded, once-per-turn) —
    // it's live subprocess I/O, so it can't live in the pure fold.
    if !matches!(effect, RegistryEffect::Ignored) {
        runtime.capture_git_branch(&event).await;
    }
    match effect {
        RegistryEffect::Ignored => StatusCode::UNPROCESSABLE_ENTITY.into_response(),
        RegistryEffect::Updated => StatusCode::NO_CONTENT.into_response(),
        RegistryEffect::PermissionRequested { request_id } => {
            match runtime
                .wait_for_permission(&request_id, super::permission_wait_ms())
                .await
            {
                Some(behavior) => Json(permission_decision(agent, behavior)).into_response(),
                None => StatusCode::NO_CONTENT.into_response(),
            }
        }
        // AskUserQuestion long-poll: answer with the island's option selections
        // as an `allow` + `updatedInput.answers` decision; empty `204` on
        // timeout so the agent's own terminal picker takes over (fail-open).
        RegistryEffect::QuestionRequested { request_id } => {
            let raw_questions = event
                .payload
                .get("tool_input")
                .and_then(|i| i.get("questions"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            match runtime
                .wait_for_question(&request_id, raw_questions, super::permission_wait_ms())
                .await
            {
                Some(QuestionResponse::Answer(updated_input)) => {
                    match question_decision(agent, updated_input) {
                        Some(decision) => Json(decision).into_response(),
                        None => StatusCode::NO_CONTENT.into_response(),
                    }
                }
                Some(QuestionResponse::Reject) => {
                    Json(permission_decision(agent, PermissionBehavior::Deny)).into_response()
                }
                None => StatusCode::NO_CONTENT.into_response(),
            }
        }
    }
}

/// The AskUserQuestion answer decision, encoded by the agent's manifest.
/// `None` when the agent declares no answer channel — the ingress then fails
/// open with an empty `204` instead of shipping an envelope the forwarder
/// cannot parse. Unreachable for OpenCode today (the registry only emits
/// `QuestionRequested` when the manifest sets `answers_questions`), which is
/// exactly why the guard lives in the manifest rather than in a comment.
fn question_decision(
    agent: FleetAgent,
    updated_input: serde_json::Value,
) -> Option<serde_json::Value> {
    super::integrations::manifest_for(agent).question_decision(updated_input)
}

/// The decision JSON the agent's forwarder expects back — the envelope is the
/// manifest's `decision_shape`, not a branch here (Claude Code / Codex hooks
/// echo the `hookSpecificOutput` block on stdout; the OpenCode plugin reads
/// `{status}` and sets `output.status`).
fn permission_decision(agent: FleetAgent, behavior: PermissionBehavior) -> serde_json::Value {
    let behavior_str = match behavior {
        PermissionBehavior::Allow => "allow",
        PermissionBehavior::Deny => "deny",
    };
    super::integrations::manifest_for(agent).permission_decision(behavior_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::runtime;
    use tower::ServiceExt as _;

    fn loopback_peer() -> ConnectInfo<SocketAddr> {
        ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 45678)))
    }

    fn lan_peer() -> ConnectInfo<SocketAddr> {
        ConnectInfo(SocketAddr::from(([192, 168, 1, 20], 45678)))
    }

    fn hook_request(
        peer: ConnectInfo<SocketAddr>,
        token: Option<&str>,
        body: serde_json::Value,
    ) -> axum::http::Request<axum::body::Body> {
        let mut builder = axum::http::Request::builder()
            .method("POST")
            .uri("/api/fleet/hook")
            .header("content-type", "application/json");
        if let Some(t) = token {
            builder = builder.header(FLEET_TOKEN_HEADER, t);
        }
        builder
            .extension(peer)
            .body(axum::body::Body::from(body.to_string()))
            .unwrap()
    }

    fn envelope(event: &str, session_id: &str) -> serde_json::Value {
        serde_json::json!({
            "agent": "claude-code",
            "event": event,
            "pid": 111, "ppid": 222,
            "env": {"TERM_PROGRAM": "ghostty"},
            "payload": {"session_id": session_id, "cwd": "/tmp/proj", "tool_name": "Bash",
                         "tool_input": {"command": "ls"}}
        })
    }

    /// Arm the global runtime with a known token; returns it. Each test uses
    /// unique session ids so the shared registry never collides.
    fn arm(token: &str) -> String {
        let rt = runtime();
        *rt.token.write() = Some(token.to_string());
        rt.enabled.store(true, std::sync::atomic::Ordering::SeqCst);
        token.to_string()
    }

    #[tokio::test]
    async fn rejects_non_loopback_peer() {
        let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
        let token = arm("routes-test-token-lan");
        let resp = router()
            .oneshot(hook_request(
                lan_peer(),
                Some(&token),
                envelope("SessionStart", "route-lan"),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn rejects_missing_or_wrong_token() {
        let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
        arm("routes-test-token-auth");
        let resp = router()
            .oneshot(hook_request(
                loopback_peer(),
                None,
                envelope("SessionStart", "route-noauth"),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let resp = router()
            .oneshot(hook_request(
                loopback_peer(),
                Some("wrong"),
                envelope("SessionStart", "route-noauth"),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn accepts_fire_event_and_folds_into_registry() {
        let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
        let token = arm("routes-test-token-fire");
        let resp = router()
            .oneshot(hook_request(
                loopback_peer(),
                Some(&token),
                envelope("SessionStart", "route-fire-session"),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let snap = runtime().snapshot();
        let session = snap
            .sessions
            .iter()
            .find(|s| s.session_id == "route-fire-session")
            .expect("session registered");
        assert_eq!(session.agent, FleetAgent::ClaudeCode);
        assert_eq!(session.project_name.as_deref(), Some("proj"));
        assert!(session.terminal.is_some(), "env classified");
    }

    #[tokio::test]
    async fn unusable_payload_is_422() {
        let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
        let token = arm("routes-test-token-422");
        let body = serde_json::json!({
            "agent": "claude-code", "event": "SessionStart", "payload": {}
        });
        let resp = router()
            .oneshot(hook_request(loopback_peer(), Some(&token), body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn permission_long_poll_returns_decision_json() {
        let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
        let token = arm("routes-test-token-perm");
        let rt = runtime();

        // Answer the permission as soon as it shows up in the snapshot.
        let responder = tokio::spawn(async move {
            for _ in 0..100 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                let snap = rt.snapshot();
                if let Some(pending) = snap
                    .sessions
                    .iter()
                    .find(|s| s.session_id == "route-perm-session")
                    .and_then(|s| s.pending_permission.clone())
                {
                    rt.respond_permission(&pending.request_id, PermissionBehavior::Allow);
                    return true;
                }
            }
            false
        });

        let resp = router()
            .oneshot(hook_request(
                loopback_peer(),
                Some(&token),
                envelope("PermissionRequest", "route-perm-session"),
            ))
            .await
            .unwrap();
        assert!(responder.await.unwrap(), "responder saw the pending row");
        assert_eq!(resp.status(), StatusCode::OK);

        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            json["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(json["hookSpecificOutput"]["decision"]["behavior"], "allow");

        // Pending cleared after resolution.
        let snap = runtime().snapshot();
        let session = snap
            .sessions
            .iter()
            .find(|s| s.session_id == "route-perm-session")
            .unwrap();
        assert!(session.pending_permission.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ask_user_question_long_poll_returns_answer_decision() {
        let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
        let token = arm("routes-test-token-question");
        let rt = runtime();

        // Answer the question (single-select → option index 0) as soon as the
        // answerable handle shows up in the snapshot.
        let responder = tokio::spawn(async move {
            for _ in 0..100 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                let snap = rt.snapshot();
                if let Some(req) = snap
                    .sessions
                    .iter()
                    .find(|s| s.session_id == "route-question-session")
                    .and_then(|s| s.pending_question_request.clone())
                {
                    rt.respond_question(&req.request_id, vec![vec![0]]);
                    return true;
                }
            }
            false
        });

        let body = serde_json::json!({
            "agent": "claude-code",
            "event": "PermissionRequest",
            "pid": 111, "ppid": 222,
            "env": {"TERM_PROGRAM": "ghostty"},
            "payload": {
                "session_id": "route-question-session",
                "cwd": "/tmp/proj",
                "tool_name": "AskUserQuestion",
                "tool_input": { "questions": [{
                    "question": "Which auth method?",
                    "options": [{"label": "OAuth"}, {"label": "API key"}]
                }] }
            }
        });
        let resp = router()
            .oneshot(hook_request(loopback_peer(), Some(&token), body))
            .await
            .unwrap();
        assert!(
            responder.await.unwrap(),
            "responder saw the parked question"
        );
        assert_eq!(resp.status(), StatusCode::OK);

        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let decision = &json["hookSpecificOutput"]["decision"];
        assert_eq!(
            json["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(decision["behavior"], "allow");
        assert_eq!(
            decision["updatedInput"]["answers"]["Which auth method?"],
            "OAuth"
        );
        // Original questions pass through for the tool to process.
        assert!(decision["updatedInput"]["questions"].is_array());
    }

    #[tokio::test]
    async fn permission_timeout_answers_empty_204() {
        let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
        let token = arm("routes-test-token-timeout");
        crate::fleet::set_permission_wait_override_ms(Some(80));

        let resp = router()
            .oneshot(hook_request(
                loopback_peer(),
                Some(&token),
                envelope("PermissionRequest", "route-timeout-session"),
            ))
            .await
            .unwrap();
        crate::fleet::set_permission_wait_override_ms(None);

        // Fail-open: empty body so the hook script prints nothing and the
        // agent's own terminal prompt takes over.
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let snap = runtime().snapshot();
        let session = snap
            .sessions
            .iter()
            .find(|s| s.session_id == "route-timeout-session")
            .unwrap();
        assert!(session.pending_permission.is_none(), "countdown cleared");
    }

    #[tokio::test]
    async fn opencode_commands_poll_requires_loopback_and_token() {
        let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
        let token = arm("routes-cmd-token");

        let req = |peer: ConnectInfo<SocketAddr>, tok: Option<&str>| {
            let mut b = axum::http::Request::builder()
                .method("POST")
                .uri("/api/fleet/opencode/commands")
                .header("content-type", "application/json");
            if let Some(t) = tok {
                b = b.header(FLEET_TOKEN_HEADER, t);
            }
            b.extension(peer)
                .body(axum::body::Body::from(r#"{"session_ids":["x"]}"#))
                .unwrap()
        };

        // LAN peer → 403.
        let resp = router()
            .oneshot(req(lan_peer(), Some(&token)))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        // Bad token → 401.
        let resp = router()
            .oneshot(req(loopback_peer(), Some("nope")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn opencode_commands_poll_returns_queued_command() {
        let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
        let tmp = tempfile::tempdir().unwrap();
        let token = arm("routes-cmd-drain-token");
        let rt = runtime();
        rt.replace_opencode_outbox_for_tests(tmp.path().join("commands.json"));
        let command_id = rt
            .queue_opencode_command("route-cmd-sess".into(), "please continue".into())
            .await
            .unwrap();

        let resp = router()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/fleet/opencode/commands")
                    .header("content-type", "application/json")
                    .header(FLEET_TOKEN_HEADER, &token)
                    .extension(loopback_peer())
                    .body(axum::body::Body::from(
                        r#"{"session_ids":["route-cmd-sess"]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["commands"][0]["sessionId"], "route-cmd-sess");
        assert_eq!(json["commands"][0]["text"], "please continue");

        let ack = router()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/v1/fleet/opencode/commands/ack")
                    .header("content-type", "application/json")
                    .header(FLEET_TOKEN_HEADER, &token)
                    .extension(loopback_peer())
                    .body(axum::body::Body::from(
                        serde_json::json!({"id": command_id, "result": {"ok": true}}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ack.status(), StatusCode::NO_CONTENT);
        assert!(rt
            .take_opencode_commands(vec!["route-cmd-sess".into()])
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn opencode_command_settlement_requires_auth_and_nack_redelivers() {
        let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
        let tmp = tempfile::tempdir().unwrap();
        let token = arm("routes-cmd-settle-token");
        let rt = runtime();
        rt.replace_opencode_outbox_for_tests(tmp.path().join("commands.json"));
        let id = rt
            .queue_opencode_command("route-nack-sess".into(), "retry".into())
            .await
            .unwrap();
        assert_eq!(
            rt.take_opencode_commands(vec!["route-nack-sess".into()])
                .await
                .unwrap()
                .len(),
            1
        );

        let request = |peer: ConnectInfo<SocketAddr>, token: Option<&str>| {
            let mut builder = axum::http::Request::builder()
                .method("POST")
                .uri("/api/v1/fleet/opencode/commands/nack")
                .header("content-type", "application/json");
            if let Some(token) = token {
                builder = builder.header(FLEET_TOKEN_HEADER, token);
            }
            builder
                .extension(peer)
                .body(axum::body::Body::from(
                    serde_json::json!({"id": id, "error": "offline"}).to_string(),
                ))
                .unwrap()
        };

        let forbidden = router()
            .oneshot(request(lan_peer(), Some(&token)))
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        let unauthorized = router()
            .oneshot(request(loopback_peer(), Some("wrong")))
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let nacked = router()
            .oneshot(request(loopback_peer(), Some(&token)))
            .await
            .unwrap();
        assert_eq!(nacked.status(), StatusCode::NO_CONTENT);
        let redelivered = rt
            .take_opencode_commands(vec!["route-nack-sess".into()])
            .await
            .unwrap();
        assert_eq!(redelivered.len(), 1);
        assert_eq!(redelivered[0].last_error.as_deref(), Some("offline"));
    }

    #[test]
    fn permission_decision_shape_per_agent() {
        // Claude / Codex → hookSpecificOutput block.
        let deny = permission_decision(FleetAgent::ClaudeCode, PermissionBehavior::Deny);
        assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
        let codex = permission_decision(FleetAgent::Codex, PermissionBehavior::Allow);
        assert_eq!(codex["hookSpecificOutput"]["decision"]["behavior"], "allow");
        // OpenCode → flat {status}.
        let oc = permission_decision(FleetAgent::Opencode, PermissionBehavior::Allow);
        assert_eq!(oc["status"], "allow");
        assert!(oc.get("hookSpecificOutput").is_none());
    }

    /// The ingress must not hold its own copy of the reply format: every
    /// agent's decision is byte-for-byte what its manifest encodes. A
    /// re-introduced `match agent { … }` here fails this even if it happens to
    /// agree with the manifest today, because a new manifest entry would not.
    #[test]
    fn permission_decision_is_delegated_to_the_manifest() {
        for manifest in crate::fleet::integrations::MANIFESTS {
            for (behavior, s) in [
                (PermissionBehavior::Allow, "allow"),
                (PermissionBehavior::Deny, "deny"),
            ] {
                assert_eq!(
                    permission_decision(manifest.agent, behavior),
                    manifest.permission_decision(s),
                    "{:?}",
                    manifest.agent
                );
            }
        }
    }

    /// An agent that declares no answer channel gets no answer envelope — the
    /// route falls through to the fail-open `204` rather than emitting a
    /// `hookSpecificOutput` block its forwarder would choke on.
    #[test]
    fn question_decision_follows_the_manifests_answer_channel() {
        let updated = serde_json::json!({ "questions": [], "answers": {} });
        assert!(question_decision(FleetAgent::ClaudeCode, updated.clone()).is_some());
        assert!(question_decision(FleetAgent::Codex, updated.clone()).is_some());
        assert!(question_decision(FleetAgent::Opencode, updated).is_some());
    }
}
