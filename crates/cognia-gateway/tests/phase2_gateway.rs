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

/// Mock `/v1/messages/count_tokens`. Shares the 401 switch so a dead
/// credential is reported the same way on both endpoints.
async fn upstream_count_tokens(
    State(state): State<UpstreamState>,
    headers: HeaderMap,
    _body: axum::extract::Json<Value>,
) -> axum::response::Response {
    state.hits.lock().push(UpstreamHit {
        api_key: headers
            .get("x-api-key")
            .and_then(|v| v.to_str().ok())
            .map(String::from),
        headers: vec![("x-upstream-route".into(), "count_tokens".into())],
    });
    if state
        .fail_first_with_401
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
        .is_ok()
    {
        return axum::http::Response::builder()
            .status(401)
            .header("content-type", "application/json")
            .header("request-id", "req_upstream_count_auth")
            .body(axum::body::Body::from(
                r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
            ))
            .unwrap()
            .into_response();
    }
    axum::http::Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .header("request-id", "req_upstream_count_ok")
        .body(axum::body::Body::from(r#"{"input_tokens":4242}"#))
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
        .route("/v1/messages/count_tokens", post(upstream_count_tokens))
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
    start_gateway_with_snapshot(snapshot_json(upstream, pool_keys)).await
}

async fn start_gateway_with_snapshot(snapshot_value: Value) -> Gateway {
    let config = GatewayConfig {
        port: 0,
        exposed_models: vec![],
        ..GatewayConfig::default()
    };
    let config = Arc::new(RwLock::new(config));

    let secret = format!("sk-cognia-{}", "t".repeat(48));
    let keys = Arc::new(RwLock::new(vec![GatewayApiKey {
        owner_account_id: None,
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
        serde_json::from_value(snapshot_value).unwrap(),
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
        Arc::new(cognia_gateway::route_planner::RoutePlannerState::default()),
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

async fn post_count_tokens(port: u16, bearer: &str, body: &Value) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/messages/count_tokens"))
        .header("x-api-key", bearer)
        .json(body)
        .send()
        .await
        .expect("gateway reachable")
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

// ---- /v1/messages/count_tokens ----------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn count_tokens_forwards_to_the_anthropic_candidate_verbatim() {
    let (upstream, upstream_state) = start_upstream().await;
    let gw = start_gateway(upstream, &["sk-up-only"]).await;

    // Key auth.
    let resp = post_count_tokens(gw.port, &gw.key, &chat_body()).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("request-id").unwrap(),
        "req_upstream_count_ok"
    );
    let body: Value = resp.json().await.unwrap();
    assert_eq!(
        body["input_tokens"],
        json!(4242),
        "upstream count, not an estimate"
    );
    {
        let hits = upstream_state.hits.lock();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].api_key.as_deref(), Some("sk-up-only"));
        assert_eq!(hits[0].headers[0].1, "count_tokens");
    }

    // Ticket auth walks the frozen candidate the same way.
    let minted = {
        let snapshot = gw.snapshot.read();
        gw.tickets
            .mint(
                mint_request("s-count", "session-sticky"),
                snapshot.as_ref(),
                now_ms(),
            )
            .unwrap()
    };
    let resp = post_count_tokens(gw.port, &minted.secret, &chat_body()).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(upstream_state.hits.lock().len(), 2);

    // A selector the ticket never bound fails closed with no upstream call.
    let mut unbound = chat_body();
    unbound["model"] = json!("gpt-4o");
    let resp = post_count_tokens(gw.port, &minted.secret, &unbound).await;
    assert_eq!(resp.status(), 400);
    assert_eq!(upstream_state.hits.lock().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn task_token_counting_blocks_pii_before_upstream_forwarding() {
    let (addr, upstream) = start_upstream().await;
    let gw = start_gateway(addr, &["sk-up-only"]).await;
    let minted = gw
        .tickets
        .mint(
            mint_request("pii-count", "session-sticky"),
            gw.snapshot.read().as_ref(),
            now_ms(),
        )
        .unwrap();
    let mut body = chat_body();
    body["messages"][0]["content"] = json!("person@example.com");
    let response = post_count_tokens(gw.port, &minted.secret, &body).await;
    assert_eq!(response.status(), 400);
    assert!(response.text().await.unwrap().contains("pii_blocked"));
    assert!(upstream.hits.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn count_tokens_synthesizes_locally_when_no_anthropic_candidate_exists() {
    let (upstream, upstream_state) = start_upstream().await;
    let mut snapshot = snapshot_json(upstream, &["sk-up-only"]);
    snapshot["providers"][0]["protocol"] = json!("openai");
    let gw = start_gateway_with_snapshot(snapshot).await;

    let body = json!({
        "model": "glm-4.6",
        "system": "You are terse.",
        "messages": [{ "role": "user", "content": "Count these words please." }],
    });
    let resp = post_count_tokens(gw.port, &gw.key, &body).await;
    assert_eq!(resp.status(), 200);
    let parsed: Value = resp.json().await.unwrap();
    let count = parsed["input_tokens"]
        .as_u64()
        .expect("input_tokens present");
    assert!(count > 0 && count < 100, "local estimate, got {count}");
    assert!(
        upstream_state.hits.lock().is_empty(),
        "an OpenAI-protocol upstream must never be asked to count tokens"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn count_tokens_upstream_401_is_not_swallowed_into_an_estimate() {
    let (upstream, upstream_state) = start_upstream().await;
    upstream_state
        .fail_first_with_401
        .store(1, Ordering::SeqCst);
    let gw = start_gateway(upstream, &["sk-up-only"]).await;

    let resp = post_count_tokens(gw.port, &gw.key, &chat_body()).await;
    assert_eq!(resp.status(), 401, "auth failures pass through verbatim");
    assert_eq!(
        resp.headers().get("request-id").unwrap(),
        "req_upstream_count_auth"
    );
    let text = resp.text().await.unwrap();
    assert_eq!(
        text,
        r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#
    );
    assert_eq!(upstream_state.hits.lock().len(), 1);
}

// ---- ticket scope + budget --------------------------------------------------

async fn post_json(port: u16, path: &str, bearer: &str, body: &Value) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}{path}"))
        .header("x-api-key", bearer)
        .json(body)
        .send()
        .await
        .expect("gateway reachable")
}

#[tokio::test(flavor = "multi_thread")]
async fn ticket_scoped_to_chat_cannot_call_embeddings_or_responses() {
    let (upstream, upstream_state) = start_upstream().await;
    let gw = start_gateway(upstream, &["sk-up-only"]).await;
    let minted = {
        let snapshot = gw.snapshot.read();
        gw.tickets
            .mint(
                mint_request("s-scope", "session-sticky"),
                snapshot.as_ref(),
                now_ms(),
            )
            .unwrap()
    };
    let body = json!({ "model": "glm-4.6", "input": "vector me" });
    let resp = post_json(gw.port, "/v1/embeddings", &minted.secret, &body).await;
    assert_eq!(resp.status(), 403);
    let resp = post_json(gw.port, "/v1/responses", &minted.secret, &chat_body()).await;
    assert_eq!(resp.status(), 403);
    assert!(
        upstream_state.hits.lock().is_empty(),
        "closed before any upstream work"
    );
    // The default scope still serves chat and count_tokens.
    let resp = post_messages(gw.port, &minted.secret, &chat_body(), &[]).await;
    assert_eq!(resp.status(), 200);
    let resp = post_count_tokens(gw.port, &minted.secret, &chat_body()).await;
    assert_eq!(resp.status(), 200);
    assert!(
        gw.tickets.open_reservations().is_empty(),
        "every served call settled its reservation"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ticket_budget_admits_exactly_max_requests_under_concurrency() {
    let (upstream, upstream_state) = start_upstream().await;
    let gw = start_gateway(upstream, &["sk-up-only"]).await;
    let minted = {
        let snapshot = gw.snapshot.read();
        let mut request = mint_request("s-budget", "session-sticky");
        request.budget = Some(cognia_gateway::route_ticket::TicketBudget {
            max_requests: Some(1),
            ..Default::default()
        });
        gw.tickets
            .mint(request, snapshot.as_ref(), now_ms())
            .unwrap()
    };
    let secret = Arc::new(minted.secret);
    let port = gw.port;
    let tasks: Vec<_> = (0..8)
        .map(|_| {
            let secret = Arc::clone(&secret);
            tokio::spawn(async move { post_messages(port, &secret, &chat_body(), &[]).await })
        })
        .collect();
    let mut ok = 0;
    let mut exhausted = 0;
    for task in tasks {
        let resp = task.await.unwrap();
        match resp.status().as_u16() {
            200 => ok += 1,
            429 => {
                let text = resp.text().await.unwrap();
                assert!(text.contains("route ticket budget exhausted"), "{text}");
                exhausted += 1;
            }
            other => panic!("unexpected status {other}"),
        }
    }
    assert_eq!(
        ok, 1,
        "exactly one request may pass a max_requests=1 budget"
    );
    assert_eq!(exhausted, 7);
    assert_eq!(upstream_state.hits.lock().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_ticket_without_operations_reaches_messages_and_count_tokens() {
    let (upstream, _upstream_state) = start_upstream().await;
    let gw = start_gateway(upstream, &["sk-up-only"]).await;
    // The pre-scoping mint shape: no `operations`, no `budget`, no `model`.
    let minted = {
        let snapshot = gw.snapshot.read();
        gw.tickets
            .mint(
                mint_request("s-legacy", "session-sticky"),
                snapshot.as_ref(),
                now_ms(),
            )
            .unwrap()
    };
    assert_eq!(
        minted.ticket.operations,
        cognia_gateway::route_ticket::default_ticket_operations()
    );
    assert!(minted.ticket.budget.is_none());
    let resp = post_messages(gw.port, &minted.secret, &chat_body(), &[]).await;
    assert_eq!(resp.status(), 200);
    let resp = post_count_tokens(gw.port, &minted.secret, &chat_body()).await;
    assert_eq!(resp.status(), 200);
}

#[derive(Clone, Default)]
struct TaskModelFixture {
    bodies: Arc<Mutex<Vec<Value>>>,
    authorizations: Arc<Mutex<Vec<String>>>,
    cancelled: Arc<AtomicUsize>,
}

async fn task_model_chat(
    State(state): State<TaskModelFixture>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> axum::response::Response {
    state.bodies.lock().push(body.clone());
    state.authorizations.lock().push(
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .into(),
    );
    if body["messages"].to_string().contains("hang-stream") {
        struct Dropped(Arc<AtomicUsize>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let guard = Dropped(state.cancelled.clone());
        let stream = futures_util::stream::unfold((false, guard), |(started, guard)| async move {
            if started {
                std::future::pending::<()>().await;
            }
            Some((Ok::<_,std::io::Error>(bytes::Bytes::from_static(b"data: {\"choices\":[{\"delta\":{\"content\":\"waiting\"},\"finish_reason\":null}]}\n\n")),(true,guard)))
        });
        return (
            [("content-type", "text/event-stream")],
            axum::body::Body::from_stream(stream),
        )
            .into_response();
    }
    let has_result = body["messages"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["role"] == "tool"));
    let tool = body["tools"].as_array().and_then(|tools| {
        tools
            .iter()
            .find(|t| {
                t["function"]["name"] == "exec_command" || t["function"]["name"] == "shell_command"
            })
            .or_else(|| tools.first())
    });
    let name = tool.and_then(|tool| tool["function"]["name"].as_str());
    let wants_tool = name.is_some() && !has_result;
    let shell_tool = tool.is_some_and(|t| {
        t["function"]["parameters"]["properties"]
            .get("cmd")
            .is_some()
            || t["function"]["parameters"]["properties"]
                .get("command")
                .is_some()
    });
    let args = if name == Some("apply_patch") {
        r#"{"input":"*** Begin Patch\n*** End Patch"}"#
    } else if shell_tool {
        r#"{"cmd":"printf gateway-tool-roundtrip","command":"printf gateway-tool-roundtrip","yield_time_ms":1000}"#
    } else {
        r#"{"path":"fixture.txt"}"#
    };
    let message = if wants_tool {
        json!({"role":"assistant","content":null,"tool_calls":[{"id":"call_fixture","type":"function","function":{"name":name,"arguments":args}}]})
    } else {
        json!({"role":"assistant","content":"gateway-roundtrip-ok"})
    };
    let reason = if wants_tool { "tool_calls" } else { "stop" };
    if body["stream"] == true {
        let mut frames = Vec::new();
        if wants_tool {
            frames.push(json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":name,"arguments":""}}]},"finish_reason":null}]}));
            for fragment in args.as_bytes().chunks(11) {
                frames.push(json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":std::str::from_utf8(fragment).unwrap()}}]},"finish_reason":null}]}));
            }
        } else {
            frames.push(json!({"choices":[{"index":0,"delta":{"reasoning_content":"checked"},"finish_reason":null}]}));
            frames.push(json!({"choices":[{"index":0,"delta":{"content":"gateway-roundtrip-ok"},"finish_reason":null}]}));
        }
        frames.push(json!({"choices":[{"index":0,"delta":{},"finish_reason":reason}],"usage":{"prompt_tokens":25,"completion_tokens":12}}));
        let wire = frames
            .into_iter()
            .map(|value| format!("data: {value}\n\n"))
            .collect::<String>()
            + "data: [DONE]\n\n";
        return ([("content-type", "text/event-stream")], wire).into_response();
    }
    axum::Json(json!({"id":"chat_fixture","model":body["model"],"choices":[{"index":0,"message":message,"finish_reason":reason}],"usage":{"prompt_tokens":25,"completion_tokens":12}})).into_response()
}

async fn task_native_responses(
    State(state): State<TaskModelFixture>,
    axum::Json(body): axum::Json<Value>,
) -> axum::response::Response {
    state.bodies.lock().push(body.clone());
    let response = json!({"id":"resp_native_fixture","object":"response","model":body["model"],"status":"completed","output":[{"id":"msg_native","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"native-ok","annotations":[]}]}],"usage":{"input_tokens":8,"output_tokens":3}});
    if body["stream"] != true {
        return axum::Json(response).into_response();
    }
    let events = [
        json!({"type":"response.created","response":{"id":"resp_native_fixture","status":"in_progress"}}),
        json!({"type":"response.output_text.delta","item_id":"msg_native","output_index":0,"content_index":0,"delta":"native-ok"}),
        json!({"type":"response.completed","response":response}),
    ];
    (
        [("content-type", "text/event-stream")],
        events
            .iter()
            .map(|v| format!("event: {}\ndata: {v}\n\n", v["type"].as_str().unwrap()))
            .collect::<String>(),
    )
        .into_response()
}

async fn task_anthropic_messages(
    State(state): State<TaskModelFixture>,
    axum::Json(body): axum::Json<Value>,
) -> axum::response::Response {
    state.bodies.lock().push(body.clone());
    axum::Json(json!({"id":"msg_fixture","type":"message","role":"assistant","model":body["model"],
        "content":[{"type":"text","text":"anthropic-ok"}],"stop_reason":"end_turn","usage":{"input_tokens":8,"output_tokens":3}})).into_response()
}

async fn start_task_model() -> (SocketAddr, TaskModelFixture, tokio::task::JoinHandle<()>) {
    let state = TaskModelFixture::default();
    let app = Router::new()
        .route("/v1/chat/completions", post(task_model_chat))
        .route("/v1/responses", post(task_native_responses))
        .route("/v1/messages", post(task_anthropic_messages))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, state, task)
}

fn task_snapshot(addr: SocketAddr) -> Value {
    json!({"generatedAtMs":1,"providers":[{"id":"global","protocol":"openai","baseUrl":format!("http://{addr}/v1"),"apiKey":"global-key","enabled":true,"models":["fixture-model"]}]})
}
fn task_mint(
    gw: &Gateway,
    addr: SocketAddr,
    session: &str,
    flavor: &str,
) -> cognia_gateway::route_ticket::MintedTicket {
    let id = format!("task-{session}");
    let request: MintRequest = serde_json::from_value(json!({
        "sessionId":session,"executionFingerprint":format!("fingerprint-{session}"),
        "candidates":[{"deploymentId":id,"modelId":"fixture-model"}],"modelBindings":{"primary":"fixture-model"},
        "credentialAffinity":"session-sticky","routePolicy":"gateway-required","operations":["responses","chat","models"],
        "providerOverrides":[{"id":id,"deploymentId":id,"protocol":if flavor == "anthropic" {"anthropic"} else {"openai"},"apiFlavor":if flavor == "anthropic" {"chat"} else {flavor},
            "baseUrl":format!("http://{addr}/v1"),"apiKey":format!("private-{session}"),"enabled":true,"models":["fixture-model"],
            "modelMetadata":[{"id":"fixture-model","name":"Task model","contextLength":262144,"maxInputTokens":240000,"maxOutputTokens":2048,"supportsTools":true,"supportsStreaming":true}]}]
    })).unwrap();
    gw.tickets
        .mint(request, gw.snapshot.read().as_ref(), now_ms())
        .unwrap()
}

fn response_event(wire: &str, kind: &str) -> Value {
    wire.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value["type"] == kind)
        .unwrap_or_else(|| panic!("missing {kind}: {wire}"))
}

#[tokio::test]
async fn task_responses_preserves_structured_controls_and_multimodal_results_at_upstream() {
    let (addr, upstream, task) = start_task_model().await;
    let gw = start_gateway_with_snapshot(task_snapshot(addr)).await;
    let anthropic = task_mint(&gw, addr, "expanded-anthropic", "anthropic");
    let chat = task_mint(&gw, addr, "expanded-chat", "chat");
    let client = reqwest::Client::new();
    let schema = json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false});
    let mut body = json!({"model":"primary","input":[{"type":"function_call","call_id":"call_1","name":"inspect","arguments":"{}"},
        {"type":"function_call_output","call_id":"call_1","output":[{"type":"input_text","text":"screenshot"},{"type":"input_image","image_url":"data:image/png;base64,aGVsbG8="}]}],
        "text":{"format":{"type":"json_schema","name":"Answer","schema":schema,"strict":true}},"reasoning":{"effort":"high"},
        "tools":[{"type":"function","name":"inspect","parameters":schema,"strict":true}],"tool_choice":"auto","parallel_tool_calls":false,"max_output_tokens":8192});
    let url = format!("http://127.0.0.1:{}/v1/responses", gw.port);
    let response = client
        .post(&url)
        .bearer_auth(&anthropic.secret)
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let value: Value = response.json().await.unwrap();
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["output"][0]["content"][0]["text"], "anthropic-ok");
    {
        let bodies = upstream.bodies.lock();
        let sent = bodies.last().unwrap();
        assert_eq!(
            sent["messages"][1]["content"][0]["content"][1]["source"]["data"],
            "aGVsbG8="
        );
        assert_eq!(sent["output_config"]["format"]["schema"], schema);
        assert_eq!(sent["output_config"]["effort"], "high");
        assert_eq!(sent["tools"][0]["strict"], true);
        assert_eq!(sent["tool_choice"]["disable_parallel_tool_use"], true);
        assert_eq!(sent["max_tokens"], 2048);
    }
    let response = client
        .post(&url)
        .bearer_auth(&chat.secret)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    assert!(response.text().await.unwrap().contains("text-only"));
    assert_eq!(upstream.bodies.lock().len(), 1);
    body["input"][1]["output"] = json!("screenshot described");
    let response = client
        .post(&url)
        .bearer_auth(&chat.secret)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
    let bodies = upstream.bodies.lock();
    let sent = bodies.last().unwrap();
    assert_eq!(sent["response_format"]["json_schema"]["schema"], schema);
    assert_eq!(sent["reasoning_effort"], "high");
    assert_eq!(sent["parallel_tool_calls"], false);
    assert_eq!(sent["tools"][0]["function"]["strict"], true);
    task.abort();
}

#[tokio::test]
async fn external_task_responses_tools_history_models_and_credentials_are_isolated() {
    let (addr, upstream, task) = start_task_model().await;
    let gw = start_gateway_with_snapshot(task_snapshot(addr)).await;
    let a = task_mint(&gw, addr, "a", "chat");
    let b = task_mint(&gw, addr, "b", "chat");
    let client = reqwest::Client::new();
    let models: Value = client
        .get(format!("http://127.0.0.1:{}/v1/models", gw.port))
        .bearer_auth(&a.secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(models["data"]
        .as_array()
        .unwrap()
        .iter()
        .all(|model| model["owned_by"] == "task-a"));
    let detail: Value = client
        .get(format!("http://127.0.0.1:{}/v1/models/primary", gw.port))
        .bearer_auth(&a.secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(detail["max_output_tokens"], 2048);
    assert_eq!(detail["max_input_tokens"], 240000);
    let body = json!({"model":"primary","input":"inspect the fixture","stream":true,"max_output_tokens":8192,
        "tools":[{"type":"function","name":"read_file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}]});
    let first = post_json(gw.port, "/v1/responses", &a.secret, &body).await;
    assert_eq!(first.status(), 200);
    let wire = first.text().await.unwrap();
    assert!(wire.contains("response.function_call_arguments.delta"));
    let completed = response_event(&wire, "response.completed")["response"].clone();
    assert_eq!(completed["output"][0]["call_id"], "call_fixture");
    let next = json!({"model":"primary","previous_response_id":completed["id"],"stream":true,
        "input":[{"type":"function_call_output","call_id":"call_fixture","output":"fixture contents"}]});
    let wrong_task = post_json(gw.port, "/v1/responses", &b.secret, &next).await;
    assert_eq!(wrong_task.status(), 400);
    let second = post_json(gw.port, "/v1/responses", &a.secret, &next)
        .await
        .text()
        .await
        .unwrap();
    assert!(second.contains("gateway-roundtrip-ok"));
    assert!(second.contains("response.reasoning_summary_text.delta"));
    assert_eq!(upstream.bodies.lock()[0]["max_tokens"], 2048);
    assert!(upstream.bodies.lock()[1]["messages"]
        .to_string()
        .contains("fixture contents"));
    assert!(upstream
        .authorizations
        .lock()
        .iter()
        .all(|key| key == "Bearer private-a"));
    assert_eq!(gw.snapshot.read().as_ref().unwrap().providers.len(), 1);
    let denied = post_json(
        gw.port,
        "/v1/responses",
        &a.secret,
        &json!({"model":"global:fixture-model","input":"hello"}),
    )
    .await;
    assert_eq!(denied.status(), 400);
    let pii = post_json(
        gw.port,
        "/v1/responses",
        &a.secret,
        &json!({"model":"primary","input":"contact user@example.com"}),
    )
    .await;
    assert_eq!(pii.status(), 400);
    assert!(pii.text().await.unwrap().contains("pii_blocked"));
    gw.tickets.revoke(&a.ticket.ticket_id);
    assert!(gw
        .tickets
        .provider_overrides(&a.ticket.ticket_id)
        .is_empty());
    assert_eq!(
        post_json(gw.port, "/v1/responses", &a.secret, &body)
            .await
            .status(),
        401
    );
    task.abort();
}

#[tokio::test]
async fn external_task_custom_tools_and_native_responses_preserve_wire_contract() {
    let (addr, upstream, task) = start_task_model().await;
    let gw = start_gateway_with_snapshot(task_snapshot(addr)).await;
    let a = task_mint(&gw, addr, "custom", "chat");
    let response = post_json(
        gw.port,
        "/v1/responses",
        &a.secret,
        &json!({"model":"primary","input":"patch fixture","stream":true,
        "tools":[{"type":"custom","name":"apply_patch","format":{"type":"text"}}]}),
    )
    .await
    .text()
    .await
    .unwrap();
    assert!(response.contains("response.custom_tool_call_input.done"));
    let completed = response_event(&response, "response.completed")["response"].clone();
    assert_eq!(completed["output"][0]["type"], "custom_tool_call");
    assert!(completed["output"][0]["input"]
        .as_str()
        .unwrap()
        .contains("Begin Patch"));
    let native = task_mint(&gw, addr, "native", "responses");
    let request = json!({"model":"primary","input":"native","stream":true,"store":false,"reasoning":{"effort":"high"},"tools":[{"type":"web_search"}]});
    let wire = post_json(gw.port, "/v1/responses", &native.secret, &request)
        .await
        .text()
        .await
        .unwrap();
    assert_eq!(
        response_event(&wire, "response.completed")["response"]["id"],
        "resp_native_fixture"
    );
    let seen = upstream.bodies.lock().last().unwrap().clone();
    assert_eq!(seen["tools"], request["tools"]);
    assert_eq!(seen["reasoning"], request["reasoning"]);
    assert_eq!(seen["store"], false);
    assert_eq!(seen["max_output_tokens"], 2048);
    let chat = post_json(
        gw.port,
        "/v1/chat/completions",
        &native.secret,
        &json!({"model":"primary","messages":[{"role":"user","content":"hello"}],"stream":true}),
    )
    .await
    .text()
    .await
    .unwrap();
    assert!(chat.contains("native-ok"));
    assert!(chat.contains("[DONE]"));
    task.abort();
}

#[tokio::test]
async fn revoking_external_task_cancels_idle_upstream_stream() {
    use futures_util::StreamExt;
    let (addr, upstream, task) = start_task_model().await;
    let gw = start_gateway_with_snapshot(task_snapshot(addr)).await;
    let ticket = task_mint(&gw, addr, "cancel", "chat");
    let response = post_json(
        gw.port,
        "/v1/responses",
        &ticket.secret,
        &json!({"model":"primary","input":"hang-stream","stream":true}),
    )
    .await;
    let mut stream = response.bytes_stream();
    assert!(stream.next().await.is_some());
    gw.tickets.revoke(&ticket.ticket.ticket_id);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while stream.next().await.is_some() {}
        while upstream.cancelled.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("revoke must close both downstream and idle upstream");
    task.abort();
}

/// Explicit opt-in: invokes a real installed CLI with only a loopback model and
/// throwaway config/auth directories. Inference uses only the loopback fixture;
/// no real provider credentials are supplied.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "set COGNIA_TEST_CODEX_BINARY to an installed Codex executable"]
async fn installed_codex_completes_tool_roundtrip_through_task_gateway() {
    let binary = std::env::var("COGNIA_TEST_CODEX_BINARY").expect("test binary must be explicit");
    let (addr, upstream, task) = start_task_model().await;
    let gw = start_gateway_with_snapshot(task_snapshot(addr)).await;
    let ticket = task_mint(&gw, addr, "codex-cli", "chat");
    let dir = std::env::temp_dir().join(format!("cognia-codex-gateway-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("config")).unwrap();
    let output_path = dir.join("stdout.jsonl");
    let error_path = dir.join("stderr.log");
    let executable_dir = std::path::Path::new(&binary)
        .parent()
        .unwrap()
        .display()
        .to_string();
    let mut child = std::process::Command::new(binary)
        .env_clear()
        .env(
            "PATH",
            format!("{executable_dir}:/usr/bin:/bin:/usr/sbin:/sbin"),
        )
        .env("HOME", &dir)
        .env("CODEX_HOME", dir.join("config"))
        .env("COGNIA_TASK_TOKEN", &ticket.secret)
        .args([
            "exec",
            "--json",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
        ])
        .arg("-C")
        .arg(&dir)
        .arg("-c")
        .arg("model_provider=\"cognia_fixture\"")
        .arg("-c")
        .arg("model=\"primary\"")
        .arg("-c")
        .arg("model_providers.cognia_fixture.name=\"Cognia fixture\"")
        .arg("-c")
        .arg(format!(
            "model_providers.cognia_fixture.base_url=\"http://127.0.0.1:{}/v1\"",
            gw.port
        ))
        .arg("-c")
        .arg("model_providers.cognia_fixture.wire_api=\"responses\"")
        .arg("-c")
        .arg("model_providers.cognia_fixture.env_key=\"COGNIA_TASK_TOKEN\"")
        .arg("-c")
        .arg("model_providers.cognia_fixture.requires_openai_auth=false")
        .arg("-c")
        .arg("web_search=\"disabled\"")
        .arg(
            "Run printf gateway-tool-roundtrip once using your shell tool, then report the result.",
        )
        .stdin(std::process::Stdio::null())
        .stdout(std::fs::File::create(&output_path).unwrap())
        .stderr(std::fs::File::create(&error_path).unwrap())
        .spawn()
        .unwrap();
    let status = tokio::time::timeout(std::time::Duration::from_secs(45), async {
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await;
    if status.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    gw.tickets.revoke(&ticket.ticket.ticket_id);
    let output = std::fs::read_to_string(&output_path).unwrap_or_default();
    let errors = std::fs::read_to_string(&error_path)
        .unwrap_or_default()
        .replace(&ticket.secret, "[ticket]");
    let requests = upstream.bodies.lock().clone();
    task.abort();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        status.as_ref().is_ok_and(|s| s.success()),
        "Codex failed: {errors}\n{output}"
    );
    assert!(
        output.contains("gateway-roundtrip-ok"),
        "missing final: {output}"
    );
    assert!(
        requests.len() >= 2,
        "Codex never followed the tool call: {output}"
    );
    assert!(
        requests.iter().any(|body| body["messages"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["role"] == "tool"))),
        "no tool result returned through gateway"
    );
}
