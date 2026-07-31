//! Phase 2 integration tests (ADR-0090): same-protocol parity (R2), route
//! tickets (frozen candidates, fail-closed auth, sticky affinity — R4), and
//! semantic header forwarding — all through the REAL axum server against a
//! REAL mock upstream, asserting wire bytes, not internals.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Value};

use cognia_gateway::api_keys::GatewayApiKey;
use cognia_gateway::concurrency::ConcurrencyLimiter;
use cognia_gateway::cooldown::KeyCooldownMap;
use cognia_gateway::execute::KeyRotationMap;
use cognia_gateway::host::NoopGatewayHost;
use cognia_gateway::lease::CredentialLeaseMap;
use cognia_gateway::route_ticket::{InMemoryTicketMetaStore, MintRequest, RouteTicketRegistry};
use cognia_gateway::server::{spawn_server, RequestObserver};
use cognia_gateway::snapshot::RoutingSnapshot;
use cognia_gateway::types::GatewayConfig;

struct NoopObserver;
impl RequestObserver for NoopObserver {
    fn on_call(&self, _route: &str, _status: axum::http::StatusCode, _ip: std::net::IpAddr) {}
}

/// What the mock upstream records about each attempt.
#[derive(Debug, Clone)]
struct UpstreamHit {
    api_key: Option<String>,
    headers: Vec<(String, String)>,
}

#[derive(Clone)]
struct UpstreamState {
    hits: Arc<Mutex<Vec<UpstreamHit>>>,
    /// Behavior switch: number of leading requests answered with 401.
    fail_first_with_401: Arc<AtomicUsize>,
}

async fn upstream_messages(
    State(state): State<UpstreamState>,
    headers: HeaderMap,
    body: axum::extract::Json<Value>,
) -> axum::response::Response {
    let hit = UpstreamHit {
        api_key: headers
            .get("x-api-key")
            .and_then(|v| v.to_str().ok())
            .map(String::from),
        headers: headers
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_string(),
                    v.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect(),
    };
    state.hits.lock().push(hit);

    if state
        .fail_first_with_401
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
        .is_ok()
    {
        return axum::http::Response::builder()
            .status(401)
            .header("content-type", "application/json")
            .header("request-id", "req_upstream_auth")
            .body(axum::body::Body::from(
                // Byte-exact Anthropic error body — the parity contract.
                r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
            ))
            .unwrap()
            .into_response();
    }

    axum::http::Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .header("request-id", "req_upstream_ok")
        .header("anthropic-ratelimit-requests-remaining", "99")
        .body(axum::body::Body::from(
            json!({
                "id": "msg_mock_1",
                "type": "message",
                "role": "assistant",
                "model": body.0["model"],
                "content": [{ "type": "text", "text": "ok" }],
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 3, "output_tokens": 5 }
            })
            .to_string(),
        ))
        .unwrap()
        .into_response()
}

async fn start_upstream() -> (SocketAddr, UpstreamState) {
    let state = UpstreamState {
        hits: Arc::new(Mutex::new(Vec::new())),
        fail_first_with_401: Arc::new(AtomicUsize::new(0)),
    };
    let app = Router::new()
        .route("/v1/messages", post(upstream_messages))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, state)
}

struct Gateway {
    port: u16,
    key: String,
    snapshot: Arc<RwLock<Option<RoutingSnapshot>>>,
    tickets: Arc<RouteTicketRegistry>,
    leases: Arc<CredentialLeaseMap>,
    /// Dropping the handle would drop the shutdown sender and stop the server.
    _handle: cognia_gateway::server::ServerHandle,
}

fn snapshot_json(upstream: SocketAddr, keys: &[&str]) -> Value {
    json!({
        "aliases": [
            { "alias": "fast", "entries": [
                { "providerId": "dep-a", "modelId": "glm-4.6" }
            ]}
        ],
        "providers": [
            {
                "id": "dep-a",
                "protocol": "anthropic",
                "baseUrl": format!("http://{upstream}/v1"),
                "apiKey": keys[0],
                "apiKeys": keys,
                "rotationEnabled": keys.len() > 1,
                "rotationStrategy": "round-robin",
                "enabled": true,
                "models": ["glm-4.6"],
                "deploymentId": "dep-a",
            }
        ],
        "generatedAtMs": 1,
        "profileVersion": 1,
        "authority": "renderer",
    })
}

async fn start_gateway(upstream: SocketAddr, pool_keys: &[&str]) -> Gateway {
    let config = GatewayConfig {
        port: 0,
        exposed_models: vec![],
        ..GatewayConfig::default()
    };
    let config = Arc::new(RwLock::new(config));

    let secret = format!("sk-cognia-{}", "t".repeat(48));
    let keys = Arc::new(RwLock::new(vec![GatewayApiKey {
        id: "k1".into(),
        name: "test".into(),
        secret: secret.clone(),
        model_allowlist: vec![],
        expires_at_ms: None,
        enabled: true,
        rate_limit_per_min: None,
        quota_tokens: None,
        quota_used_tokens: 0,
        created_at_ms: 0,
        last_used_at_ms: None,
    }]));

    let snapshot: Arc<RwLock<Option<RoutingSnapshot>>> = Arc::new(RwLock::new(Some(
        serde_json::from_value(snapshot_json(upstream, pool_keys)).unwrap(),
    )));
    let tickets = Arc::new(RouteTicketRegistry::new(Arc::new(
        InMemoryTicketMetaStore::default(),
    )));
    let leases = Arc::new(CredentialLeaseMap::default());

    let handle = spawn_server(
        Arc::new(NoopGatewayHost),
        config,
        keys,
        Arc::clone(&snapshot),
        Arc::new(Mutex::new(std::collections::HashMap::new())),
        Arc::new(KeyRotationMap::default()),
        Arc::new(KeyCooldownMap::default()),
        Arc::new(ConcurrencyLimiter::default()),
        Arc::new(NoopObserver),
        Arc::clone(&tickets),
        Arc::clone(&leases),
    )
    .await
    .expect("gateway must bind");

    Gateway {
        port: handle.bound_port,
        key: secret,
        snapshot,
        tickets,
        leases,
        _handle: handle,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn mint_request(session: &str, affinity: &str) -> MintRequest {
    serde_json::from_value(json!({
        "sessionId": session,
        "executionFingerprint": format!("aexf1-{session}"),
        "candidates": [{ "deploymentId": "dep-a", "modelId": "glm-4.6" }],
        "modelBindings": { "primary": "glm-4.6", "sonnet": "glm-4.6" },
        "credentialAffinity": affinity,
        "routePolicy": "gateway-required",
    }))
    .unwrap()
}

fn chat_body() -> Value {
    json!({
        "model": "glm-4.6",
        "max_tokens": 16,
        "messages": [{ "role": "user", "content": "hi" }],
    })
}

async fn post_messages(
    port: u16,
    bearer: &str,
    body: &Value,
    extra_headers: &[(&str, &str)],
) -> reqwest::Response {
    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("http://127.0.0.1:{port}/v1/messages"))
        .header("x-api-key", bearer)
        .json(body);
    for (name, value) in extra_headers {
        req = req.header(*name, *value);
    }
    req.send().await.expect("gateway reachable")
}

#[tokio::test(flavor = "multi_thread")]
async fn same_protocol_error_body_and_headers_pass_through_verbatim() {
    let (upstream, upstream_state) = start_upstream().await;
    upstream_state
        .fail_first_with_401
        .store(1, Ordering::SeqCst);
    let gw = start_gateway(upstream, &["sk-up-only"]).await;

    let resp = post_messages(gw.port, &gw.key, &chat_body(), &[]).await;
    assert_eq!(resp.status(), 401);
    assert_eq!(
        resp.headers().get("request-id").unwrap(),
        "req_upstream_auth"
    );
    let body = resp.text().await.unwrap();
    assert_eq!(
        body,
        r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
        "upstream error body must reach the client byte-identical"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn semantic_headers_forward_and_hostile_headers_do_not() {
    let (upstream, upstream_state) = start_upstream().await;
    let gw = start_gateway(upstream, &["sk-up-only"]).await;

    let resp = post_messages(
        gw.port,
        &gw.key,
        &chat_body(),
        &[
            ("anthropic-beta", "computer-use-2025-01-24"),
            ("anthropic-version", "2024-10-22"),
            ("x-claude-code-version", "2.1.0"),
            ("x-stainless-lang", "js"),
            ("x-totally-custom", "nope"),
        ],
    )
    .await;
    assert_eq!(resp.status(), 200);
    // Success responses carry the safe upstream metadata headers.
    assert_eq!(resp.headers().get("request-id").unwrap(), "req_upstream_ok");
    assert_eq!(
        resp.headers()
            .get("anthropic-ratelimit-requests-remaining")
            .unwrap(),
        "99"
    );

    let hits = upstream_state.hits.lock();
    assert_eq!(hits.len(), 1);
    let names: std::collections::HashMap<&str, &str> = hits[0]
        .headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(
        names.get("anthropic-beta"),
        Some(&"computer-use-2025-01-24")
    );
    assert_eq!(names.get("x-claude-code-version"), Some(&"2.1.0"));
    assert_eq!(names.get("x-stainless-lang"), Some(&"js"));
    // The client's own anthropic-version wins over the pinned default (R2).
    assert_eq!(names.get("anthropic-version"), Some(&"2024-10-22"));
    // Auth is the GATEWAY's credential, and non-semantic/hostile names stop.
    assert_eq!(hits[0].api_key.as_deref(), Some("sk-up-only"));
    assert!(!names.contains_key("x-totally-custom"));
    assert!(!names.contains_key("authorization"));
}

#[tokio::test(flavor = "multi_thread")]
async fn ticket_flow_freezes_candidates_and_fails_closed() {
    let (upstream, upstream_state) = start_upstream().await;
    let gw = start_gateway(upstream, &["sk-up-only"]).await;

    let minted = {
        let snapshot = gw.snapshot.read();
        gw.tickets
            .mint(
                mint_request("s-ticket", "sticky-with-failover"),
                snapshot.as_ref(),
                now_ms(),
            )
            .unwrap()
    };

    // 1. Ticket-authed request succeeds via the frozen candidate.
    let resp = post_messages(gw.port, &minted.secret, &chat_body(), &[]).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(upstream_state.hits.lock().len(), 1);

    // 2. A live snapshot update that rewires the alias does NOT change the
    //    ticket's candidates: the same deployment keeps serving.
    {
        let mut altered: Value = snapshot_json(upstream, &["sk-up-only"]);
        altered["aliases"] = json!([
            { "alias": "fast", "entries": [ { "providerId": "ghost", "modelId": "other" } ] }
        ]);
        altered["profileVersion"] = json!(2);
        *gw.snapshot.write() = Some(serde_json::from_value(altered).unwrap());
    }
    let resp = post_messages(gw.port, &minted.secret, &chat_body(), &[]).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(upstream_state.hits.lock().len(), 2);

    // 3. An unbound model selector fails closed with NO upstream request.
    let mut unbound = chat_body();
    unbound["model"] = json!("gpt-4o");
    let resp = post_messages(gw.port, &minted.secret, &unbound, &[]).await;
    assert_eq!(resp.status(), 400);
    assert_eq!(upstream_state.hits.lock().len(), 2, "no upstream attempt");

    // 4. Revocation is a hard 401 — never a fallthrough to ordinary keys.
    gw.tickets.revoke(&minted.ticket.ticket_id);
    let resp = post_messages(gw.port, &minted.secret, &chat_body(), &[]).await;
    assert_eq!(resp.status(), 401);
    assert_eq!(upstream_state.hits.lock().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn ticket_auth_failure_never_switches_accounts_and_sticky_lease_holds() {
    let (upstream, upstream_state) = start_upstream().await;
    // TWO pooled upstream credentials — per-request rotation would alternate.
    let gw = start_gateway(upstream, &["sk-up-1", "sk-up-2"]).await;

    let minted = {
        let snapshot = gw.snapshot.read();
        gw.tickets
            .mint(
                mint_request("s-sticky", "sticky-with-failover"),
                snapshot.as_ref(),
                now_ms(),
            )
            .unwrap()
    };

    // First request succeeds and leases whichever credential served it.
    let resp = post_messages(gw.port, &minted.secret, &chat_body(), &[]).await;
    assert_eq!(resp.status(), 200);
    let first_key = upstream_state.hits.lock()[0].api_key.clone().unwrap();
    assert!(gw.leases.get("s-sticky").is_some(), "lease established");

    // Three more requests: the SAME credential every time (sticky), where
    // plain rotation would have alternated between the two pool keys.
    for _ in 0..3 {
        let resp = post_messages(gw.port, &minted.secret, &chat_body(), &[]).await;
        assert_eq!(resp.status(), 200);
    }
    {
        let hits = upstream_state.hits.lock();
        assert!(hits
            .iter()
            .all(|h| h.api_key.as_deref() == Some(first_key.as_str())));
    }

    // Upstream 401: surfaced to the client, and the OTHER pool account is
    // NOT tried (R4 — auth failures never switch accounts by default).
    let before = upstream_state.hits.lock().len();
    upstream_state
        .fail_first_with_401
        .store(1, Ordering::SeqCst);
    let resp = post_messages(gw.port, &minted.secret, &chat_body(), &[]).await;
    assert_eq!(resp.status(), 401);
    let hits = upstream_state.hits.lock();
    assert_eq!(
        hits.len(),
        before + 1,
        "exactly one auth attempt, no failover"
    );
}
