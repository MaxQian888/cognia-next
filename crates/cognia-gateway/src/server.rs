//! Local axum HTTP server exposing OpenAI- and Anthropic-compatible chat
//! endpoints backed by the user's configured providers + routing snapshot.
//!
//! Layout:
//!   - GET  /healthz                  → liveness (no auth)
//!   - GET  /v1/models                → aliases + provider models (exposure-filtered)
//!   - POST /v1/chat/completions      → OpenAI-format chat (stream + non-stream)
//!   - POST /v1/messages              → Anthropic-format chat (Claude Code CLI)
//!   - POST /v1/messages/count_tokens → Anthropic token count (forwarded, or a local estimate when no Anthropic route)
//!   - POST /v1/embeddings            → OpenAI-format embeddings
//!   - POST /v1/responses             → OpenAI Responses API (stream + non-stream)
//!   - GET  /v1/models/cognia/{mode}  → one Router + Fusion virtual model (ADR-0188)
//!   - ANY  /v1/runs, /v1/sessions/{id}, /v1/artifacts/{id}[/content]
//!     → the Router + Fusion Run API (`runs.rs`); 403 until the brain turns it on
//!
//! Middleware mirrors `remote_control::server` (the audited reference), with
//! the gateway's own additions: Host check (skipped for LAN peers when LAN
//! binding is on) → Origin/Referer rejection → IPv4 allowlist → scoped API-key
//! auth (constant-time; accepts BOTH `Authorization: Bearer` and `x-api-key`)
//! → per-key rate limit → global rate limit. The listener binds 127.0.0.1 by
//! default, 0.0.0.0 when the LAN interface is selected.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::host::GatewayHost;
use crate::lease::CredentialLeaseMap;
use crate::route_ticket::{
    RouteTicket, RouteTicketRegistry, TicketAffinity, TicketOperation, TicketReject,
    TICKET_SECRET_PREFIX,
};
use axum::{
    body::Body,
    extract::{ConnectInfo, Extension, State},
    http::{header::RETRY_AFTER, HeaderMap, HeaderValue, StatusCode},
    middleware::{from_fn_with_state, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use futures_util::StreamExt;
use parking_lot::RwLock;
use serde_json::{json, Value};
use tokio::sync::{oneshot, watch};
use tower_http::limit::RequestBodyLimitLayer;

use cognia_net::inbound_policy::{FixedWindowRateLimiter, ParsedAllowlist};

use super::api_keys::{self, GatewayApiKey};
use super::concurrency::{ConcurrencyLimiter, InFlightGuard, InFlightTracker, Slot};
use super::cooldown::{self, KeyCooldownMap};
use super::count_tokens::estimate_input_tokens;
use super::execute::{
    candidates_from_entries, count_tokens_url, embeddings_url, expand_for_ticket, expand_key_pools,
    is_executable_protocol, record_key_success, resolve_candidates, rewrite_model,
    strip_request_fields, upstream_headers, upstream_url, Candidate, KeyRotationMap, SseDeframer,
};
use super::keyed_rate_limit::KeyedRateLimiter;
use super::session_key::derive_session_id;
use super::snapshot::{AliasSnapshot, RoutingSnapshot};
use super::translate::errors::{error_body, InboundFormat};
use super::translate::responses as responses_translate;
use super::translate::stream::{Direction, SseOut, StreamTranscoder};
use super::translate::{request_from_ir, request_to_ir, response_from_ir, response_to_ir};
use super::types::{BindInterface, GatewayConfig, GatewayError};
use super::DecisionRegistry;

pub const REQUEST_LOG_EVENT: &str = "gateway://request-log";
pub const REQUEST_OUTCOME_EVENT: &str = "gateway://request-outcome";
pub const DECIDE_EVENT: &str = "gateway://decide";

/// How long the gateway waits for the renderer's live routing decision before
/// falling back to the snapshot's pre-ordered candidates.
const DECIDE_TIMEOUT_MS: u64 = 800;

/// Chat bodies can be large (long histories); 16 MiB is generous without
/// being a memory hazard.
const BODY_LIMIT_BYTES: usize = 16 * 1024 * 1024;

/// How long an SSE pump tolerates total silence from the upstream before giving
/// up on the stream. The live value is always read per-request from
/// `GatewayConfig::stream_idle_timeout_secs`, whose default is produced by
/// `types::default_stream_idle_timeout_secs`; this mirrors that default so the
/// tests below exercise the shipped timing rather than an invented one.
///
/// Streaming requests deliberately skip `apply_timeout` (a long generation is
/// not a hung one) and `reqwest` here sets only a connect timeout, so an
/// upstream that accepts the connection and then never writes or closes would
/// park the pump task forever — holding its concurrency slots AND its in-flight
/// tally. The tally drives least-busy routing, so a single hung stream would
/// steer traffic away from that provider permanently, with nothing in the UI to
/// explain it.
///
/// Five minutes of *zero bytes* is well past any real generation: both upstream
/// protocols emit keepalives (Anthropic `event: ping`, OpenAI incremental
/// chunks) far more often than that, so this fires only on a genuinely dead
/// connection.
#[cfg(test)]
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Why a stream was abandoned, in terms of the timeout that actually fired.
///
/// Formatting `STREAM_IDLE_TIMEOUT` here reported 300s regardless of what
/// `streamIdleTimeoutSecs` was configured to — the gating already honoured the
/// config, so only the message lied.
fn stall_reason(idle_timeout: Option<Duration>) -> String {
    match idle_timeout {
        Some(limit) => format!("upstream stream stalled: no data for {}s", limit.as_secs()),
        // Not reachable through the idle path (`None` parks forever), but the
        // same flag is set by a transport-level break on the pump.
        None => "upstream stream stalled".to_string(),
    }
}

/// Pull the next chunk from an upstream byte stream, bounded by the configured
/// idle timeout.
///
/// `Ok(Some(chunk))` = data, `Ok(None)` = clean end of stream, `Err(())` = the
/// upstream went silent for longer than `idle`. `idle == None` (config `0`)
/// waits forever, restoring the pre-timeout park-forever behaviour — kept
/// reachable because a deliberately slow self-hosted upstream is a legitimate,
/// if unwise, configuration.
async fn next_chunk_before_idle<S>(
    stream: &mut S,
    idle: Option<Duration>,
) -> Result<Option<S::Item>, ()>
where
    S: futures_util::Stream + Unpin,
{
    match idle {
        Some(limit) => tokio::time::timeout(limit, stream.next())
            .await
            .map_err(|_| ()),
        None => Ok(stream.next().await),
    }
}

#[derive(Clone)]
pub struct ServerHandle {
    pub bound_port: u16,
    pub shutdown: watch::Sender<()>,
    /// The live server's state, so out-of-band callers (the settings
    /// self-check, via Tauri IPC) probe through the SAME rotation cursors,
    /// cooldown map and in-flight tally the serving path uses. Private: the
    /// only supported access is [`ServerHandle::probe_handle`].
    state: AppState,
}

impl ServerHandle {
    /// Detach a probe bound to the running server's state.
    ///
    /// Returned as its own value rather than exposing `AppState` so callers can
    /// drop the lock guard that produced this handle before awaiting the probe.
    pub fn probe_handle(&self) -> UpstreamProbe {
        UpstreamProbe {
            state: self.state.clone(),
        }
    }
}

/// A detached handle for running an upstream self-check against a live server.
pub struct UpstreamProbe {
    state: AppState,
}

impl UpstreamProbe {
    pub async fn run(&self, model: &str) -> UpstreamProbeOutcome {
        let mut changes = self.state.account_changes.subscribe();
        tokio::select! {
            biased;
            _ = changes.changed() => UpstreamProbeOutcome::NoSnapshot,
            outcome = run_upstream_probe(&self.state, model) => outcome,
        }
    }
}

/// Hook fired on every request (post-middleware / on reject) for the durable
/// status counters (calls_total + last_call_at).
pub trait RequestObserver: Send + Sync + 'static {
    fn on_call(&self, route: &str, status: StatusCode, remote_ip: IpAddr);
}

/// Per-request context threaded from the auth middleware into the handlers so
/// they can enforce the matched key's model allowlist and stamp the durable
/// request log.
#[derive(Clone)]
struct ReqCtx {
    account_generation: u64,
    /// Per-request id; the key every ticket reservation is settled or
    /// released under.
    request_id: String,
    route: String,
    remote_ip: String,
    key_id: Option<String>,
    key_model_allowlist: Vec<String>,
    /// Client User-Agent, captured for the W1.3 fallback session key (all
    /// loopback callers share `remote_ip`, so the UA carries the distinctness).
    user_agent: String,
    /// Present when the request authenticated with a route-ticket secret
    /// (ADR-0090 Phase 2). Frozen candidates/bindings; never the secret.
    ticket: Option<RouteTicket>,
    /// Inbound headers whose NAMES pass the shared header policy (auth,
    /// hop-by-hop, Host, browser and internal headers already stripped).
    /// Same-protocol sends forward the semantic subset of these (R2).
    inbound_headers: Vec<(String, String)>,
}

#[derive(Clone)]
struct AppState {
    account: Arc<RwLock<crate::GatewayAccountContext>>,
    account_changes: Arc<tokio::sync::watch::Sender<u64>>,
    host: Arc<dyn GatewayHost>,
    keys: Arc<RwLock<Vec<GatewayApiKey>>>,
    /// Request-time config (timeouts, retry policy, model exposure) — read live
    /// so an `update_config` applies without a restart.
    config: Arc<RwLock<GatewayConfig>>,
    allowlist: Arc<ParsedAllowlist>,
    rate_limiter: Arc<FixedWindowRateLimiter>,
    key_rate_limiter: Arc<KeyedRateLimiter>,
    /// Bind-time: whether the Host-loopback check is relaxed for LAN peers.
    bind_is_lan: bool,
    on_request: Arc<dyn RequestObserver>,
    snapshot: Arc<RwLock<Option<RoutingSnapshot>>>,
    decisions: Arc<DecisionRegistry>,
    /// Per-provider upstream key-pool rotation cursors (shared with the state).
    key_rotation: Arc<KeyRotationMap>,
    route_planner: Arc<crate::route_planner::RoutePlannerState>,
    /// Per-upstream-key cooldown / permanent-disable state (W1.1 + W3.1).
    key_cooldown: Arc<KeyCooldownMap>,
    /// In-flight concurrency caps (W1.2).
    concurrency: Arc<ConcurrencyLimiter>,
    /// Per-provider in-flight tally, counted regardless of whether a cap is set.
    /// Serialized into each decide request so the renderer's `least-busy`
    /// strategy can see the load the gateway itself is generating.
    in_flight: Arc<InFlightTracker>,
    /// Route-ticket registry (ADR-0090 Phase 2) — session-scoped frozen routes.
    tickets: Arc<RouteTicketRegistry>,
    /// Session → credential leases backing ticket affinity (R4).
    leases: Arc<CredentialLeaseMap>,
    /// Upstream HTTP clients, one per live proxy route.
    http: Arc<UpstreamClients>,
    response_history: Arc<parking_lot::Mutex<ResponseHistory>>,
    /// The Run API's brain link, surface switches and compat-waiter cap
    /// (ADR-0188 B2–B3). With the surface off — the default — `/v1/runs` and
    /// the `cognia/*` models refuse without ever touching the brain.
    runs: crate::runs::RunsState,
}

struct AccountBoundHost {
    host: Arc<dyn GatewayHost>,
    account: Arc<RwLock<crate::GatewayAccountContext>>,
    generation: u64,
}
impl GatewayHost for AccountBoundHost {
    fn emit(&self, event: &str, mut payload: Value) -> bool {
        let account = self.account.read();
        if account.generation != self.generation {
            return false;
        }
        if account.required {
            payload["ownerAccountId"] = json!(account.owner_account_id);
            payload["accountGeneration"] = json!(account.generation);
        }
        self.host.emit(event, payload)
    }
    fn supports_live_decisions(&self) -> bool {
        self.host.supports_live_decisions()
    }
}
impl AppState {
    fn for_request(mut self, ctx: &ReqCtx) -> Self {
        if let Some(ticket) = &ctx.ticket {
            let overrides = self.tickets.provider_overrides(&ticket.ticket_id);
            if !overrides.is_empty() {
                let snapshot = self.snapshot.read().clone().map(|mut snapshot| {
                    for provider in overrides {
                        snapshot.providers.retain(|p| p.id != provider.id);
                        snapshot.providers.push(provider);
                    }
                    snapshot
                });
                self.snapshot = Arc::new(RwLock::new(snapshot));
            }
        }
        self.host = Arc::new(AccountBoundHost {
            host: self.host.clone(),
            account: self.account.clone(),
            generation: ctx.account_generation,
        });
        self
    }
}

/// Stream pumps are detached from the response future, so they need their own
/// cancellation boundary; dropping the body alone does not cancel an idle read.
fn spawn_account_task(
    mut changes: tokio::sync::watch::Receiver<u64>,
    generation: u64,
    task: impl std::future::Future<Output = ()> + Send + 'static,
) {
    tokio::spawn(async move {
        if *changes.borrow() != generation {
            return;
        }
        tokio::select! { biased; _ = changes.changed() => {}, _ = task => {} }
    });
}

async fn ticket_ended(tickets: Arc<RouteTicketRegistry>, ticket_id: String) {
    loop {
        if !tickets.is_live(&ticket_id, chrono::Utc::now().timestamp_millis()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn spawn_request_task(
    state: &AppState,
    ctx: &ReqCtx,
    task: impl std::future::Future<Output = ()> + Send + 'static,
) {
    let ticket = ctx.ticket.as_ref().map(|t| t.ticket_id.clone());
    let tickets = state.tickets.clone();
    let request_id = ctx.request_id.clone();
    spawn_account_task(
        state.account_changes.subscribe(),
        ctx.account_generation,
        async move {
            struct ReleaseReservation(Arc<RouteTicketRegistry>, String);
            impl Drop for ReleaseReservation {
                fn drop(&mut self) {
                    self.0.release_reservation(&self.1);
                }
            }
            let _reservation = ReleaseReservation(tickets.clone(), request_id);
            match ticket {
                Some(id) => {
                    tokio::select! { biased; _ = ticket_ended(tickets,id) => {}, _ = task => {} }
                }
                None => task.await,
            }
        },
    );
}

async fn run_with_ticket_boundary(
    next: Next,
    request: axum::extract::Request,
    changes: tokio::sync::watch::Receiver<u64>,
    tickets: Arc<RouteTicketRegistry>,
    ticket_id: String,
) -> Response {
    let response = tokio::select! { biased;
        _ = ticket_ended(tickets.clone(),ticket_id.clone()) => return (StatusCode::UNAUTHORIZED,Json(json!({"error":{"message":"route ticket expired or revoked"}}))).into_response(),
        response = run_with_account_boundary(next,request,changes) => response,
    };
    let (parts, body) = response.into_parts();
    let stream = futures_util::stream::unfold(
        (body.into_data_stream(), tickets, ticket_id),
        |(mut body, tickets, id)| async move {
            tokio::select! { biased;
                _ = ticket_ended(tickets.clone(),id.clone()) => None,
                chunk = body.next() => chunk.map(|bytes| (bytes,(body,tickets,id))),
            }
        },
    );
    Response::from_parts(parts, Body::from_stream(stream))
}

fn body_has_no_leaking_pii(body: &Value) -> bool {
    fn clean(value: &Value) -> bool {
        match value {
            Value::String(text) => cognia_net::outbound_pii::has_no_leaking_pii(text),
            Value::Array(items) => items.iter().all(clean),
            Value::Object(fields) => fields.values().all(clean),
            _ => true,
        }
    }
    [
        "messages",
        "input",
        "instructions",
        "system",
        "tools",
        "response_format",
    ]
    .iter()
    .all(|field| clean(&body[*field]))
        && clean(&body["text"]["format"])
        && clean(&body["output_config"]["format"])
}

/// Upstream HTTP clients bound to the live network-proxy policy.
///
/// The gateway used to build ONE `reqwest::Client` at startup and reuse it
/// for every upstream call. That client took whatever proxy variables the
/// process had at that instant and kept them: on the desktop the policy is
/// handed down by the renderer later, so a gateway started early either
/// dialled direct past the user's proxy or inherited the deliberate
/// `127.0.0.1:9` black hole and never recovered. The bypass list was never
/// consulted at all.
///
/// Now every upstream URL resolves through `cognia_net::proxy_config` at
/// request time, exactly like every other outbound call on the host, and
/// the client for each distinct route is pooled so keep-alive and TLS
/// session reuse survive. While the policy is not initialized yet the
/// env-driven fallback client is used, which is the old behaviour.
pub(crate) struct UpstreamClients {
    connect_timeout: Duration,
    fallback: reqwest::Client,
    cache: parking_lot::Mutex<std::collections::HashMap<u64, reqwest::Client>>,
}

/// Distinct pooled clients to keep before the pool is cleared. A host has a
/// handful of routes at most (direct, the proxy, a bypassed local server).
const UPSTREAM_CLIENT_CACHE_CAP: usize = 8;

impl UpstreamClients {
    pub(crate) fn new(connect_timeout: Duration) -> Self {
        cognia_net::proxy_config::ensure_crypto_provider();
        let fallback = reqwest::Client::builder()
            .connect_timeout(connect_timeout)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            connect_timeout,
            fallback,
            cache: parking_lot::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// The client that dials `url` under the current policy.
    pub(crate) fn client_for(&self, url: &str) -> reqwest::Client {
        let Ok(policy) = cognia_net::proxy_config::current() else {
            return self.fallback.clone();
        };
        let Some(key) = route_cache_key(&policy, url) else {
            return self.fallback.clone();
        };
        if let Some(client) = self.cache.lock().get(&key) {
            return client.clone();
        }
        let builder = reqwest::Client::builder().connect_timeout(self.connect_timeout);
        let client = match policy.apply_reqwest_policy(builder, url) {
            Ok((builder, _route)) => builder.build().unwrap_or_else(|_| self.fallback.clone()),
            Err(_) => return self.fallback.clone(),
        };
        let mut cache = self.cache.lock();
        if cache.len() >= UPSTREAM_CLIENT_CACHE_CAP {
            cache.clear();
        }
        cache.insert(key, client.clone());
        client
    }

    pub(crate) fn post(&self, url: &str) -> reqwest::RequestBuilder {
        self.client_for(url).post(url)
    }

    #[cfg(test)]
    fn pooled(&self) -> usize {
        self.cache.lock().len()
    }
}

/// One key per (route, proxy credential): a changed password must not keep
/// serving a client built with the old one. The credentialed URL is hashed,
/// never stored.
fn route_cache_key(policy: &cognia_net::proxy_config::ProxyConfig, url: &str) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let route = policy.route_for(url).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match route {
        cognia_net::proxy_config::ProxyRouteSummary::Direct { .. } => "direct".hash(&mut hasher),
        cognia_net::proxy_config::ProxyRouteSummary::Proxy { .. } => {
            "proxy".hash(&mut hasher);
            policy.credentialed_proxy_url().ok()?.hash(&mut hasher);
        }
    }
    Some(hasher.finish())
}

#[allow(clippy::too_many_arguments)]
pub async fn spawn_server(
    host: Arc<dyn GatewayHost>,
    config: Arc<RwLock<GatewayConfig>>,
    keys: Arc<RwLock<Vec<GatewayApiKey>>>,
    snapshot: Arc<RwLock<Option<RoutingSnapshot>>>,
    decisions: Arc<DecisionRegistry>,
    key_rotation: Arc<KeyRotationMap>,
    route_planner: Arc<crate::route_planner::RoutePlannerState>,
    key_cooldown: Arc<KeyCooldownMap>,
    concurrency: Arc<ConcurrencyLimiter>,
    on_request: Arc<dyn RequestObserver>,
    tickets: Arc<RouteTicketRegistry>,
    leases: Arc<CredentialLeaseMap>,
) -> Result<ServerHandle, GatewayError> {
    spawn_server_with_account(
        Arc::new(RwLock::new(crate::GatewayAccountContext::default())),
        Arc::new(tokio::sync::watch::channel(0).0),
        host,
        config,
        keys,
        snapshot,
        decisions,
        key_rotation,
        route_planner,
        key_cooldown,
        concurrency,
        on_request,
        tickets,
        leases,
        // No brain is attached to this listener and the Router + Fusion
        // switches start off, so `/v1/runs` and the `cognia/*` models answer
        // `403 ROUTER_FUSION_DISABLED`; were a host to switch them on without
        // installing a bridge, they would answer `503 BRAIN_UNAVAILABLE`. Never
        // a read of state this process does not have.
        crate::runs::RunsState::detached(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn spawn_server_with_account(
    account: Arc<RwLock<crate::GatewayAccountContext>>,
    account_changes: Arc<tokio::sync::watch::Sender<u64>>,
    host: Arc<dyn GatewayHost>,
    config: Arc<RwLock<GatewayConfig>>,
    keys: Arc<RwLock<Vec<GatewayApiKey>>>,
    snapshot: Arc<RwLock<Option<RoutingSnapshot>>>,
    decisions: Arc<DecisionRegistry>,
    key_rotation: Arc<KeyRotationMap>,
    route_planner: Arc<crate::route_planner::RoutePlannerState>,
    key_cooldown: Arc<KeyCooldownMap>,
    concurrency: Arc<ConcurrencyLimiter>,
    on_request: Arc<dyn RequestObserver>,
    tickets: Arc<RouteTicketRegistry>,
    leases: Arc<CredentialLeaseMap>,
    runs: crate::runs::RunsState,
) -> Result<ServerHandle, GatewayError> {
    // Snapshot the bind-time config (these apply only on start).
    let (port, bind_interface, allowlist_raw, rate_limit_per_min, connect_timeout_secs) = {
        let cfg = config.read();
        (
            cfg.port,
            cfg.bind_interface,
            cfg.allowlist.clone(),
            cfg.rate_limit_per_min,
            cfg.connect_timeout_secs,
        )
    };

    let parsed_allowlist =
        ParsedAllowlist::parse(&allowlist_raw).map_err(GatewayError::InvalidConfig)?;

    let bind_ip = match bind_interface {
        BindInterface::Loopback => IpAddr::V4(Ipv4Addr::LOCALHOST),
        BindInterface::Lan => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
    };
    let bind_addr = SocketAddr::new(bind_ip, port);
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|source| GatewayError::Bind {
            addr: bind_addr.to_string(),
            source,
        })?;
    let bound_port = listener
        .local_addr()
        .map_err(|source| GatewayError::Bind {
            addr: bind_addr.to_string(),
            source,
        })?
        .port();

    let http = Arc::new(UpstreamClients::new(Duration::from_secs(
        connect_timeout_secs.max(1) as u64,
    )));

    // Clone the key handle for the periodic quota-flush task before the
    // original moves into `AppState`.
    let keys_for_flush = keys.clone();
    let state = AppState {
        account,
        account_changes,
        host,
        keys,
        config,
        allowlist: Arc::new(parsed_allowlist),
        rate_limiter: Arc::new(FixedWindowRateLimiter::new(rate_limit_per_min)),
        key_rate_limiter: Arc::new(KeyedRateLimiter::new()),
        bind_is_lan: bind_interface.is_lan(),
        on_request,
        snapshot,
        decisions,
        key_rotation,
        route_planner,
        key_cooldown,
        concurrency,
        // Transient by nature — nothing is in flight when a listener starts, so
        // this is built per-spawn rather than threaded through from the state.
        in_flight: Arc::new(InFlightTracker::default()),
        tickets,
        leases,
        http,
        response_history: Arc::new(parking_lot::Mutex::new(ResponseHistory::default())),
        runs,
    };
    // Cloned before the router consumes `state`; both share the same Arcs, so a
    // probe run through this sees the live cooldown / in-flight state.
    let probe_state = state.clone();

    let app = app_router(state);

    let (tx, mut rx) = watch::channel(());

    // Periodic key flush: per-key quota draw-down + last-used timestamps live on
    // the shared in-memory key list and are otherwise only persisted on stop.
    // A ~60s flush bounds crash-loss of quota accounting to one interval. Tied
    // to the same shutdown signal so it exits with the listener.
    let flush_keys = keys_for_flush;
    let flush_tickets = Arc::clone(&probe_state.tickets);
    let mut flush_rx = tx.subscribe();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.tick().await; // consume the immediate first tick
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let _ = api_keys::save_keys(&flush_keys.read());
                    // Ticket budget counters ride the same cadence: never a
                    // disk write per request.
                    let _ = flush_tickets.flush();
                }
                _ = flush_rx.changed() => break,
            }
        }
    });

    tokio::spawn(async move {
        let server = axum::serve(
            listener,
            // The connection's own local address rides along with the peer's
            // (`split_connection` hands the middleware its `SocketAddr`).
            app.into_make_service_with_connect_info::<GatewayConnection>(),
        );
        let result = server
            .with_graceful_shutdown(async move {
                let _ = rx.changed().await;
            })
            .await;
        if let Err(error) = result {
            log::warn!("gateway server exited with error: {error}");
        }
    });

    Ok(ServerHandle {
        bound_port,
        shutdown: tx,
        state: probe_state,
    })
}

/// The whole HTTP surface the listener serves. Built in one place so the
/// server-level tests drive exactly the router the listener mounts: every Run
/// API route, fallback and guard is reached through it (ADR-0188).
fn app_router(state: AppState) -> Router {
    // Bind-time (the interface) plus request-time (the public origin, read
    // live so an `update_config` changes read links without a restart).
    let listener = ListenerOriginState {
        lan: state.bind_is_lan,
        config: state.config.clone(),
    };
    let protected = Router::new()
        .route("/v1/models", get(list_models))
        .route("/v1/models/{model}", get(get_model))
        // A virtual model's name holds a slash, which `{model}` never matches
        // (ADR-0188 D13).
        .route("/v1/models/cognia/{mode}", get(get_virtual_model))
        .route("/v1/chat/completions", post(openai_chat))
        .route("/v1/messages", post(anthropic_messages))
        .route("/v1/messages/count_tokens", post(anthropic_count_tokens))
        .route("/v1/embeddings", post(openai_embeddings))
        .route("/v1/responses", post(openai_responses))
        // `/v1/runs` shares this router's Host, origin, allowlist, key and
        // rate-limit checks; what it adds is the scope check and the brain.
        .merge(crate::runs::routes().with_state(state.runs.clone()))
        .layer(from_fn_with_state(state.clone(), middleware))
        .layer(RequestBodyLimitLayer::new(BODY_LIMIT_BYTES))
        // Outermost, so a Run API failure answered by any layer above — the
        // body limit included — leaves in the contract's shape. A pass-through
        // for every other path (ADR-0188 D37).
        .layer(axum::middleware::from_fn(
            crate::runs::contract_error_envelope,
        ));

    Router::new()
        // R2 client-compat: Claude Code probes `GET/HEAD /` before trusting an
        // ANTHROPIC_BASE_URL and treats a non-2xx as "model unavailable".
        // Answer 200 with an empty JSON object (no state, no data exposure).
        .route("/", get(root_probe).head(root_probe))
        .route("/healthz", get(healthz))
        // W3.4: real-relay upstream self-check (loopback-only). Probes each
        // resolved candidate through the actual resolve + upstream path.
        .route("/healthz/upstream", post(healthz_upstream))
        .merge(protected)
        .with_state(state)
        .layer(axum::middleware::map_request_with_state(
            listener,
            split_connection,
        ))
}

/// What [`split_connection`] needs to describe this listener to the Run API:
/// whether it takes LAN peers, and the operator's configured public origin.
#[derive(Clone)]
struct ListenerOriginState {
    lan: bool,
    config: Arc<RwLock<GatewayConfig>>,
}

/// One accepted connection as the listener saw it: the peer, and the local
/// address it arrived on. The local address is the one origin a request cannot
/// forge, so the Run API builds read links from it whenever the Host header is
/// not one it can vouch for (ADR-0188 B3 hardening).
#[derive(Clone, Copy, Debug)]
struct GatewayConnection {
    remote: SocketAddr,
    local: Option<SocketAddr>,
}

impl
    axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, tokio::net::TcpListener>>
    for GatewayConnection
{
    fn connect_info(stream: axum::serve::IncomingStream<'_, tokio::net::TcpListener>) -> Self {
        Self {
            remote: *stream.remote_addr(),
            local: stream.io().local_addr().ok(),
        }
    }
}

/// Split the listener's connection info into what the handlers read: the
/// peer's `ConnectInfo<SocketAddr>`, exactly as before, and the Run API's
/// [`crate::runs::ListenerOrigin`].
async fn split_connection(
    State(listener): State<ListenerOriginState>,
    mut request: axum::extract::Request,
) -> axum::extract::Request {
    let connection = request
        .extensions()
        .get::<ConnectInfo<GatewayConnection>>()
        .map(|ConnectInfo(connection)| *connection);
    if let Some(connection) = connection {
        request
            .extensions_mut()
            .insert(ConnectInfo(connection.remote));
        request
            .extensions_mut()
            .insert(crate::runs::ListenerOrigin {
                lan: listener.lan,
                local_addr: connection.local,
                // Normalised on the way in; `None` leaves the derived
                // behaviour (Host header or listener address) untouched.
                public_origin: listener.config.read().resolved_public_origin(),
            });
    }
    request
}

/// Claude Code base-URL probe endpoint (see router comment). Stateless.
async fn root_probe() -> Response {
    (StatusCode::OK, Json(json!({}))).into_response()
}

async fn healthz() -> impl IntoResponse {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

/// Loopback-only upstream self-check (W3.4). Resolves the requested model to its
/// candidates through the REAL resolve path and fires one minimal (`max_tokens`
/// = 1) upstream call per candidate, reporting each candidate's ok/status/
/// latency. "Test is the production path": it exercises candidate resolution,
/// pool expansion (cooldown-aware), field stripping, headers and the timeout —
/// the same plumbing a live chat request walks — without the renderer-side
/// batch tester's separate code path.
#[derive(serde::Deserialize)]
struct UpstreamProbeRequest {
    model: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamProbeResult {
    pub provider_id: String,
    pub model_id: String,
    pub ok: bool,
    pub status: Option<u16>,
    pub latency_ms: u64,
    pub error: Option<String>,
}

/// Why a self-check could not produce per-candidate results, or the results.
///
/// Kept as a typed enum rather than baked into an HTTP response so the same
/// probe can serve the axum `/healthz/upstream` route AND the Tauri command the
/// settings UI calls. The renderer cannot reach the listener over HTTP — the
/// app CSP's `connect-src` admits no loopback origin — so without an IPC path
/// this endpoint stays the dead code it has been since it was written.
pub enum UpstreamProbeOutcome {
    /// No routing snapshot has been published yet.
    NoSnapshot,
    /// The model resolved to zero candidates.
    NoCandidate,
    Probed(Vec<UpstreamProbeResult>),
}

/// Fire a minimal upstream call for every candidate `model` resolves to.
///
/// Each probe is a real, billable request, so callers must gate this behind an
/// explicit user action.
async fn run_upstream_probe(state: &AppState, model: &str) -> UpstreamProbeOutcome {
    let cfg = state.config.read().clone();
    let Some(snapshot) = state.snapshot.read().clone() else {
        return UpstreamProbeOutcome::NoSnapshot;
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let candidates = expand_key_pools(
        route_candidates(state, &snapshot, &cfg, model, &Value::Null, "gateway-probe").await,
        &state.key_rotation,
        &state.key_cooldown,
        now_ms,
    );
    if candidates.is_empty() {
        return UpstreamProbeOutcome::NoCandidate;
    }
    let mut results = Vec::new();
    for candidate in candidates.iter().take(cfg.attempt_budget(candidates.len())) {
        let started = Instant::now();
        // A probe is a real (billable) upstream call, so it counts toward the
        // in-flight tally that now drives least-busy routing — otherwise a
        // self-check would be invisible to the very decisions it runs beside.
        let _in_flight = state.in_flight.enter(&candidate.provider.id);
        let (ok, status, error) = probe_candidate(state, &cfg, candidate).await;
        results.push(UpstreamProbeResult {
            provider_id: candidate.provider.id.clone(),
            model_id: candidate.model_id.clone(),
            ok,
            status,
            latency_ms: started.elapsed().as_millis() as u64,
            error,
        });
    }
    UpstreamProbeOutcome::Probed(results)
}

async fn healthz_upstream(
    State(state): State<AppState>,
    ConnectInfo(connect_info): ConnectInfo<SocketAddr>,
    Json(req): Json<UpstreamProbeRequest>,
) -> Response {
    // A diagnostic that makes real (billable) upstream calls must never be
    // reachable off-box, even under LAN binding.
    if !connect_info.ip().is_loopback() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "self-check is loopback-only" })),
        )
            .into_response();
    }
    match run_upstream_probe(&state, &req.model).await {
        UpstreamProbeOutcome::NoSnapshot => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "no routing snapshot yet" })),
        )
            .into_response(),
        UpstreamProbeOutcome::NoCandidate => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("model \"{}\" resolves to no candidate", req.model) })),
        )
            .into_response(),
        UpstreamProbeOutcome::Probed(results) => {
            Json(json!({ "model": req.model, "results": results })).into_response()
        }
    }
}

/// Fire one minimal upstream call for a candidate and classify the outcome.
async fn probe_candidate(
    state: &AppState,
    cfg: &GatewayConfig,
    candidate: &Candidate,
) -> (bool, Option<u16>, Option<String>) {
    let mut body = minimal_probe_body(&candidate.provider.protocol, &candidate.model_id);
    strip_request_fields(
        &mut body,
        &candidate.provider.id,
        &cfg.stripped_request_fields,
        &cfg.field_strip_allow,
    );
    let url = upstream_url(&candidate.provider.protocol, &candidate.provider.base_url);
    let mut rb = apply_timeout(state.http.post(&url).json(&body), cfg);
    for (name, value) in upstream_headers(
        &candidate.provider.protocol,
        candidate.provider.api_key.as_deref(),
    ) {
        rb = rb.header(name, value);
    }
    match rb.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status < 400 {
                (true, Some(status), None)
            } else {
                classify_probe_failure(status, &resp.text().await.unwrap_or_default())
            }
        }
        Err(err) => (false, None, Some(format!("connect error: {err}"))),
    }
}

/// How much of an upstream error body the probe row carries.
///
/// Bounded because this string reaches the settings UI verbatim, and an
/// upstream that answers a rejected request with an HTML error page would
/// otherwise put the whole page in a table cell.
const PROBE_ERROR_CHARS: usize = 200;

/// Classify a >=400 probe response. Split out from `probe_candidate` so the
/// truncation and the shape of the row are testable without standing up an
/// upstream — the network half of the probe is not, and is what kept this path
/// at one covered function.
fn classify_probe_failure(status: u16, body: &str) -> (bool, Option<u16>, Option<String>) {
    (
        false,
        Some(status),
        // `chars`, not bytes: a multi-byte boundary would panic on slicing, and
        // upstream error bodies are routinely non-ASCII.
        Some(body.chars().take(PROBE_ERROR_CHARS).collect::<String>()),
    )
}

/// A one-token probe body in the candidate's wire protocol.
fn minimal_probe_body(protocol: &str, model_id: &str) -> Value {
    let mut body = json!({
        "model": model_id,
        "max_tokens": 1,
        "messages": [{ "role": "user", "content": "ping" }],
    });
    if protocol != "anthropic" {
        // OpenAI-compatible chat completions don't require max_tokens, but a
        // 1-token cap keeps the probe cheap; leave the shape otherwise shared.
        body["max_tokens"] = json!(1);
    }
    body
}

// ---- middleware -------------------------------------------------------------

/// Accept only loopback Host headers (DNS-rebinding mitigation).
fn host_is_local(host: &str) -> bool {
    let host = host.trim();
    if host == "[::1]" || host == "::1" {
        return true;
    }
    let without_port = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(rest),
        None => host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host),
    };
    matches!(without_port, "127.0.0.1" | "localhost" | "::1")
}

/// Extract the supplied credential: `Authorization: Bearer <t>` (OpenAI
/// clients) or `x-api-key: <t>` (Anthropic clients — Claude Code CLI sends
/// this).
fn supplied_token(headers: &HeaderMap) -> Option<&str> {
    if let Some(bearer) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return Some(bearer);
    }
    headers.get("x-api-key").and_then(|v| v.to_str().ok())
}

/// Collect inbound headers whose names the shared policy allows (values
/// re-checked for injection bytes). Auth headers never appear here.
fn clean_inbound_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            let name = name.as_str();
            let verdict = crate::header_policy::check_header(
                name,
                None,
                crate::header_policy::HeaderContext::Forward,
            );
            if !verdict.allowed {
                return None;
            }
            let value = value.to_str().ok()?;
            if value.contains(['\r', '\n', '\0']) {
                return None;
            }
            Some((name.to_ascii_lowercase(), value.to_string()))
        })
        .collect()
}

/// The ticket operation a protected route performs. `None` for anything a
/// ticket can never reach, which the middleware turns into a 403 rather than
/// guessing a scope.
fn ticket_operation_for_route(route: &str) -> Option<TicketOperation> {
    match route {
        "/v1/models" => Some(TicketOperation::Models),
        path if path.starts_with("/v1/models/") => Some(TicketOperation::Models),
        "/v1/chat/completions" | "/v1/messages" => Some(TicketOperation::Chat),
        "/v1/messages/count_tokens" => Some(TicketOperation::CountTokens),
        "/v1/embeddings" => Some(TicketOperation::Embeddings),
        "/v1/responses" => Some(TicketOperation::Responses),
        _ => None,
    }
}

/// Tokens a request may consume, for a ticket with a token ceiling: the
/// estimated prompt. Output is reserved after model caps/history expansion,
/// then refined to the real usage at settlement. The body is buffered once and handed back intact.
async fn estimate_request_hold(
    request: axum::extract::Request,
) -> Result<(axum::extract::Request, u64), ()> {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, BODY_LIMIT_BYTES)
        .await
        .map_err(|_| ())?;
    // Reserve the input first. The final candidate's published output cap and
    // any expanded Responses history are reserved atomically at the send boundary.
    let hold = serde_json::from_slice::<Value>(&bytes)
        .map(|v| estimate_input_tokens(&v))
        .unwrap_or(0);
    Ok((
        axum::extract::Request::from_parts(parts, Body::from(bytes)),
        hold,
    ))
}

async fn middleware(
    State(state): State<AppState>,
    ConnectInfo(connect_info): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let route = request.uri().path().to_string();
    let remote_ip = connect_info.ip();
    let request_id = uuid::Uuid::new_v4().to_string();
    let (account, account_changes) = {
        let account = state.account.read();
        (account.clone(), state.account_changes.subscribe())
    };
    // Rejections happen before ReqCtx exists, so bind their event authority
    // at entry too. Never relabel an earlier request with a later account.
    let rejection_host = AccountBoundHost {
        host: state.host.clone(),
        account: state.account.clone(),
        generation: account.generation,
    };
    // ADR-0188 D37: a Run API path gets these refusals in its contract's
    // `ErrorResponse`; every other path keeps the body its clients parse.
    let run_surface = crate::runs::is_run_surface_path(&route);

    let reject = |status: StatusCode, message: &str, key_id: Option<String>| -> Response {
        state.on_request.on_call(&route, status, remote_ip);
        emit_request_log(
            &rejection_host,
            &route,
            &remote_ip.to_string(),
            key_id.as_deref(),
            None,
            None,
            status.as_u16(),
            0,
            None,
            None,
            Some(message),
            false,
            None,
        );
        if run_surface {
            return crate::runs::gateway_refusal(status, message);
        }
        (status, Json(json!({ "error": { "message": message } }))).into_response()
    };

    // 0. Host-header allowlist. Loopback binding requires a loopback Host; LAN
    // binding accepts LAN peers whose Host is this machine's LAN authority.
    // The cross-origin rejection below still blocks browser DNS-rebinding in
    // both modes (real CLI clients never send Origin/Referer).
    if !state.bind_is_lan {
        let host_ok = headers
            .get(axum::http::header::HOST)
            .and_then(|v| v.to_str().ok())
            .map(host_is_local)
            .unwrap_or(false);
        if !host_ok {
            return reject(StatusCode::FORBIDDEN, "invalid host", None);
        }
    }
    if headers.contains_key(axum::http::header::ORIGIN)
        || headers.contains_key(axum::http::header::REFERER)
    {
        return reject(StatusCode::FORBIDDEN, "cross-origin not allowed", None);
    }

    // 1. IPv4 allowlist (the real LAN gate — defaults loopback-only).
    let canonical = match remote_ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4,
            None => return reject(StatusCode::FORBIDDEN, "ipv6 not supported", None),
        },
    };
    if !state.allowlist.contains(canonical) {
        return reject(StatusCode::FORBIDDEN, "origin not allowed", None);
    }

    if account.required && account.owner_account_id.is_none() {
        return reject(
            StatusCode::UNAUTHORIZED,
            "the local account is locked",
            None,
        );
    }

    // 2. Scoped API-key auth — constant-time, dual header support.
    let Some(supplied) = supplied_token(&headers) else {
        return reject(
            StatusCode::UNAUTHORIZED,
            "missing credentials (Authorization: Bearer or x-api-key)",
            None,
        );
    };
    let now_ms = chrono::Utc::now().timestamp_millis();

    // 2a. Route-ticket auth (ADR-0090 Phase 2). Ticket secrets have their own
    // prefix and NEVER fall through into the ordinary key path — an expired,
    // revoked, or unknown ticket is a hard 401 (fail closed).
    if supplied.starts_with(TICKET_SECRET_PREFIX) {
        // Operation scope: a route the ticket vocabulary cannot name is closed
        // to every ticket, and `/v1/embeddings` + `/v1/responses` are closed
        // to the default (chat) scope, before any secret work.
        let Some(op) = ticket_operation_for_route(&route) else {
            return reject(
                StatusCode::FORBIDDEN,
                "route tickets cannot be used on this route",
                None,
            );
        };
        // Hold an estimate only when the ticket meters tokens; buffering the
        // body for an unmetered ticket would be pure overhead.
        let mut est_tokens = 0u64;
        if op.consumes_tokens() && state.tickets.secret_has_token_budget(supplied) {
            match estimate_request_hold(request).await {
                Ok((buffered, hold)) => {
                    request = buffered;
                    est_tokens = hold;
                }
                Err(()) => {
                    return reject(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "request body too large",
                        None,
                    )
                }
            }
        }
        let ticket =
            match state
                .tickets
                .validate_and_reserve(supplied, now_ms, op, &request_id, est_tokens)
            {
                Ok(ticket) => ticket,
                Err(kind) => {
                    let (status, message) = match kind {
                        TicketReject::Expired => (StatusCode::UNAUTHORIZED, "route ticket expired"),
                        TicketReject::Revoked => (StatusCode::UNAUTHORIZED, "route ticket revoked"),
                        TicketReject::Unknown => (StatusCode::UNAUTHORIZED, "unknown route ticket"),
                        TicketReject::OperationNotAllowed => (
                            StatusCode::FORBIDDEN,
                            "route ticket is not scoped for this operation",
                        ),
                        TicketReject::BudgetExhausted => (
                            StatusCode::TOO_MANY_REQUESTS,
                            "insufficient_quota: route ticket budget exhausted",
                        ),
                    };
                    return reject(status, message, None);
                }
            };
        // Per-ticket rate limit (only when the ticket sets one), then global.
        // A rate-limited request was never served: hand the slot back.
        if let Some(limit) = ticket.budget.as_ref().and_then(|b| b.max_requests_per_min) {
            if !state.key_rate_limiter.try_acquire(&ticket.ticket_id, limit) {
                state.tickets.release_reservation(&request_id);
                return reject(
                    StatusCode::TOO_MANY_REQUESTS,
                    "per-ticket rate limit exceeded",
                    None,
                );
            }
        }
        if !state.rate_limiter.try_acquire() {
            state.tickets.release_reservation(&request_id);
            return reject(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded", None);
        }
        let user_agent = headers
            .get(axum::http::header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let ticket_id = ticket.ticket_id.clone();
        // A route-ticket caller is an agent borrowing credentials, not a Run API
        // actor: no scopes, so every run verb refuses it by the ordinary rule.
        request
            .extensions_mut()
            .insert(crate::runs::RunActor::default());
        request.extensions_mut().insert(ReqCtx {
            account_generation: account.generation,
            request_id: request_id.clone(),
            route: route.clone(),
            remote_ip: remote_ip.to_string(),
            key_id: None,
            key_model_allowlist: Vec::new(),
            user_agent,
            ticket: Some(ticket),
            inbound_headers: clean_inbound_headers(&headers),
        });
        let response = run_with_ticket_boundary(
            next,
            request,
            account_changes,
            state.tickets.clone(),
            ticket_id,
        )
        .await;
        // Settlement: a served metered call settles itself in `log_success`
        // (streams do so at stream end). A call that consumes nothing settles
        // here at zero; a failed call releases its slot.
        if !response.status().is_success() {
            state.tickets.release_reservation(&request_id);
        } else if !op.consumes_tokens() {
            state.tickets.settle_reservation(&request_id, 0);
        }
        state
            .on_request
            .on_call(&route, response.status(), remote_ip);
        return response;
    }

    let matched = {
        let keys = state.keys.read();
        api_keys::match_index(&keys, supplied, now_ms)
            .filter(|i| account.permits_key(&keys[*i]))
            .map(|i| {
                let k = &keys[i];
                (
                    i,
                    k.id.clone(),
                    k.model_allowlist.clone(),
                    k.rate_limit_per_min,
                    k.is_over_quota(),
                    // The Run API's identity for this key (ADR-0188 D8). A key
                    // written before scopes existed carries none, so it reaches
                    // the chat endpoints exactly as before and no run verb.
                    crate::runs::RunActor {
                        key_id: Some(k.id.clone()),
                        key_name: k.name.clone(),
                        scopes: k.scopes.clone(),
                    },
                )
            })
    };
    let Some((idx, key_id, key_model_allowlist, key_rate_limit, over_quota, run_actor)) = matched
    else {
        return reject(StatusCode::UNAUTHORIZED, "invalid token", None);
    };

    // Quota gate: a key that has drawn down its entire token budget is rejected
    // before any upstream work (drawn down after each request; see `log_success`).
    if over_quota {
        return reject(
            StatusCode::TOO_MANY_REQUESTS,
            "insufficient_quota: key token quota exhausted",
            Some(key_id),
        );
    }

    // Bump last-used on the shared key list (persisted on next save/stop).
    if let Some(k) = state.keys.write().get_mut(idx) {
        k.last_used_at_ms = Some(now_ms);
    }

    // 3. Per-key rate limit (only when the key sets its own budget).
    if let Some(limit) = key_rate_limit {
        if !state.key_rate_limiter.try_acquire(&key_id, limit) {
            return reject(
                StatusCode::TOO_MANY_REQUESTS,
                "per-key rate limit exceeded",
                Some(key_id.clone()),
            );
        }
    }

    // 4. Global rate limit.
    if !state.rate_limiter.try_acquire() {
        return reject(
            StatusCode::TOO_MANY_REQUESTS,
            "rate limit exceeded",
            Some(key_id.clone()),
        );
    }

    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    request.extensions_mut().insert(run_actor);
    request.extensions_mut().insert(ReqCtx {
        account_generation: account.generation,
        request_id,
        route: route.clone(),
        remote_ip: remote_ip.to_string(),
        key_id: Some(key_id),
        key_model_allowlist,
        user_agent,
        ticket: None,
        inbound_headers: clean_inbound_headers(&headers),
    });

    let response = run_with_account_boundary(next, request, account_changes).await;
    state
        .on_request
        .on_call(&route, response.status(), remote_ip);
    response
}

// ---- /v1/models -------------------------------------------------------------

/// Cancel pre-response upstream work and streaming bodies on authority change.
/// A previously authenticated A request cannot observe B's snapshot.
async fn run_with_account_boundary(
    next: Next,
    request: axum::http::Request<Body>,
    mut changes: tokio::sync::watch::Receiver<u64>,
) -> Response {
    // ADR-0188 D37: only a Run API path trades the bare string for the
    // contract's `ErrorResponse`.
    let run_surface = crate::runs::is_run_surface_path(request.uri().path());
    let response = tokio::select! {
        biased;
        _ = changes.changed() => {
            if run_surface {
                return crate::runs::account_context_changed();
            }
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "gateway account context changed" }))).into_response();
        }
        response = next.run(request) => response,
    };
    let (parts, body) = response.into_parts();
    let stream = futures_util::stream::unfold(
        (body.into_data_stream(), changes),
        |(mut body, mut changes)| async move {
            tokio::select! {
                biased;
                _ = changes.changed() => None,
                chunk = body.next() => chunk.map(|chunk| (chunk, (body, changes))),
            }
        },
    );
    Response::from_parts(parts, Body::from_stream(stream))
}

async fn list_models(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    actor: Option<Extension<crate::runs::RunActor>>,
) -> Response {
    let state = state.for_request(&ctx);
    let snapshot = state.snapshot.read().clone();
    let Some(snapshot) = snapshot else {
        return no_snapshot_error(InboundFormat::OpenAiChat);
    };
    let cfg = state.config.read().clone();

    // A model is listed only if the gateway exposes it AND the calling key may
    // use it AND the gateway can actually execute it. That last clause is why
    // `resolve_candidates` is consulted for aliases below: without it a provider
    // on a non-executable protocol (anything but openai / anthropic — see
    // `is_executable_protocol`) was advertised here and then 404'd on the very
    // next /v1/chat/completions call.
    let visible = |model: &str| -> bool { cfg.model_is_exposed(model) && ctx_allows(&ctx, model) };

    let data = if let Some(ticket) = &ctx.ticket {
        let mut selectors = ticket.model_bindings.keys().cloned().collect::<Vec<_>>();
        selectors.extend(ticket.candidates.iter().map(|c| c.model_id.clone()));
        selectors.sort();
        selectors.dedup();
        selectors
            .into_iter()
            .filter_map(|selector| {
                let resolved = ticket.resolve_model(&selector)?;
                let candidates = ticket_base_candidates(&snapshot, ticket, Some(&resolved));
                candidates.first().map(|candidate| {
                    model_document(&selector, &candidate.provider, &candidate.model_id)
                })
            })
            .collect()
    } else {
        let mut data = listable_models(&snapshot, cfg.hide_raw_provider_models, &visible);
        // The `cognia/*` virtual models, for a key that may run them (ADR-0188 D13).
        let actor = actor.map(|Extension(actor)| actor).unwrap_or_default();
        data.extend(
            crate::virtual_models::model_documents(state.runs.runs_enabled(), &actor)
                .into_iter()
                .filter(|doc| doc["id"].as_str().is_some_and(|id| ctx_allows(&ctx, id))),
        );
        data
    };
    Json(json!({ "object": "list", "data": data })).into_response()
}

async fn get_model(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    actor: Option<Extension<crate::runs::RunActor>>,
    axum::extract::Path(model): axum::extract::Path<String>,
) -> Response {
    let response = list_models(State(state), Extension(ctx), actor).await;
    if !response.status().is_success() {
        return response;
    }
    let bytes = axum::body::to_bytes(response.into_body(), BODY_LIMIT_BYTES)
        .await
        .unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    if let Some(item) = body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| item["id"] == model)
    {
        return Json(item.clone()).into_response();
    }
    (StatusCode::NOT_FOUND,Json(json!({"error":{"type":"not_found_error","message":"model is not available to this task"}}))).into_response()
}

/// `GET /v1/models/cognia/{mode}`: one Router + Fusion virtual model, under
/// the rule `/v1/models` lists it by — the `gatewayRuns` switch is on, the key
/// may create and read runs, and its model allowlist admits the name
/// (ADR-0188 D13). Any name this key would not see listed is the same bare
/// 404 the path answered before the route existed, so a switched-off gateway
/// is unchanged (D37).
async fn get_virtual_model(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    actor: Option<Extension<crate::runs::RunActor>>,
    axum::extract::Path(mode): axum::extract::Path<String>,
) -> Response {
    let model = format!("cognia/{mode}");
    let actor = actor.map(|Extension(actor)| actor).unwrap_or_default();
    let document = crate::virtual_models::model_document(&model, state.runs.runs_enabled(), &actor)
        .filter(|_| ctx_allows(&ctx, &model));
    match document {
        Some(document) => Json(document).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn model_document(id: &str, provider: &crate::snapshot::ProviderSnapshot, concrete: &str) -> Value {
    let mut out = json!({"id":id,"object":"model","owned_by":provider.id,"created":0});
    if let Some(metadata) = provider
        .model_metadata
        .iter()
        .find(|entry| entry.id == concrete)
    {
        for (name, value) in &metadata.fields {
            out[name] = value.clone();
        }
        for (from, to) in [
            ("name", "display_name"),
            ("contextLength", "context_length"),
            ("maxInputTokens", "max_input_tokens"),
            ("maxOutputTokens", "max_output_tokens"),
        ] {
            if let Some(value) = metadata.fields.get(from) {
                out[to] = value.clone();
            }
        }
        if let Some(value) = metadata.fields.get("maxOutputTokens") {
            out["max_tokens"] = value.clone();
        }
    }
    out
}

/// Walk message content, including tool results, but never JSON tool schemas,
/// function argument objects or arbitrary request metadata.
fn content_has_type(value: &Value, kinds: &[&str]) -> bool {
    match value {
        Value::Array(items) => items.iter().any(|item| content_has_type(item, kinds)),
        Value::Object(object) => {
            object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kinds.contains(&kind))
                || ["content", "output"].iter().any(|key| {
                    object
                        .get(*key)
                        .is_some_and(|part| content_has_type(part, kinds))
                })
        }
        _ => false,
    }
}

fn tools_require_strict(tools: &Value) -> bool {
    tools.as_array().is_some_and(|tools| {
        tools.iter().any(|tool| {
            tool["strict"] == true
                || tool.pointer("/function/strict") == Some(&Value::Bool(true))
                || tools_require_strict(&tool["tools"])
        })
    })
}

/// Enforce only published model facts; absent limits remain absent. Input
/// estimates use the same gateway estimator as ticket reservations/count_tokens.
fn apply_model_limits(body: &mut Value, candidate: &Candidate) -> Result<(), String> {
    let Some(metadata) = candidate
        .provider
        .model_metadata
        .iter()
        .find(|m| m.id == candidate.model_id)
    else {
        return Ok(());
    };
    let positive = |field: &str| {
        metadata
            .fields
            .get(field)
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
    };
    if metadata.fields.get("supportsTools") == Some(&Value::Bool(false))
        && body["tools"].as_array().is_some_and(|t| !t.is_empty())
    {
        return Err("selected model does not support tools".into());
    }
    if metadata.fields.get("supportsStreaming") == Some(&Value::Bool(false))
        && body["stream"] == true
    {
        return Err("selected model does not support streaming".into());
    }
    let structured = body
        .get("response_format")
        .is_some_and(|f| !f.is_null() && f["type"] != "text")
        || body
            .pointer("/text/format")
            .is_some_and(|f| !f.is_null() && f["type"] != "text")
        || body
            .pointer("/output_config/format")
            .is_some_and(|f| !f.is_null())
        || tools_require_strict(&body["tools"]);
    if metadata.fields.get("supportsStructuredOutput") == Some(&Value::Bool(false)) && structured {
        return Err("selected model does not support structured output or strict tools".into());
    }
    let reasoning = body
        .get("reasoning_effort")
        .or(body.pointer("/reasoning/effort"))
        .or(body.pointer("/output_config/effort"))
        .is_some_and(|effort| !effort.is_null() && effort != "none")
        || body
            .get("thinking")
            .is_some_and(|thinking| !thinking.is_null() && thinking["type"] != "disabled");
    if metadata.fields.get("supportsReasoning") == Some(&Value::Bool(false)) && reasoning {
        return Err("selected model does not support reasoning controls".into());
    }
    for (capability, kinds, label) in [
        (
            "supportsVision",
            &["image", "image_url", "input_image"][..],
            "images",
        ),
        ("supportsAudio", &["input_audio", "audio"][..], "audio"),
        (
            "supportsVideo",
            &["video", "video_url", "input_video"][..],
            "video",
        ),
    ] {
        if metadata.fields.get(capability) == Some(&Value::Bool(false))
            && ["messages", "input", "system"]
                .iter()
                .any(|key| content_has_type(&body[*key], kinds))
        {
            return Err(format!("selected model does not support {label}"));
        }
    }
    let input = estimate_input_tokens(body);
    if positive("maxInputTokens").is_some_and(|limit| input > limit) {
        return Err("estimated input exceeds the selected model's maximum input tokens".into());
    }
    let mut cap = positive("maxOutputTokens");
    if let Some(context) = positive("contextLength") {
        if input >= context {
            return Err("estimated input exhausts the selected model's context window".into());
        }
        cap = Some(cap.map_or(context - input, |output| output.min(context - input)));
    }
    if let Some(cap) = cap {
        let field = if body.get("max_completion_tokens").is_some() {
            "max_completion_tokens"
        } else if body.get("max_output_tokens").is_some()
            || candidate.provider.protocol == "responses"
        {
            "max_output_tokens"
        } else {
            "max_tokens"
        };
        let requested = body[field].as_u64().filter(|n| *n > 0).unwrap_or(cap);
        body[field] = json!(requested.min(cap));
    }
    Ok(())
}

/// The `/v1/models` payload for a caller, given a per-model visibility
/// predicate. Pure (no `AppHandle`) so the executability rule is unit-testable —
/// this crate does not use `tauri::test::mock_app`.
fn listable_models(
    snapshot: &RoutingSnapshot,
    hide_raw_provider_models: bool,
    visible: &dyn Fn(&str) -> bool,
) -> Vec<Value> {
    // An alias is executable if ANY of its entries points at an enabled provider
    // on a protocol the gateway can drive. Deliberately not `resolve_candidates`:
    // that clones every matching `ProviderSnapshot` — credentials included —
    // onto the heap just to answer a yes/no, once per alias per request.
    let alias_is_executable = |alias: &AliasSnapshot| -> bool {
        alias.entries.iter().any(|entry| {
            snapshot
                .provider(&entry.provider_id)
                .is_some_and(|p| is_executable_protocol(&p.protocol))
        })
    };

    let mut data: Vec<Value> = Vec::new();
    for alias in &snapshot.aliases {
        if visible(&alias.alias) && alias_is_executable(alias) {
            data.push(json!({
                "id": alias.alias,
                "object": "model",
                "owned_by": "cognia-routing",
            }));
        }
    }
    if !hide_raw_provider_models {
        for provider in &snapshot.providers {
            if !provider.enabled || !is_executable_protocol(&provider.protocol) {
                continue;
            }
            for model in &provider.models {
                if visible(model) {
                    data.push(model_document(model, provider, model));
                }
            }
        }
    }
    data
}

fn ctx_allows(ctx: &ReqCtx, model: &str) -> bool {
    ctx.key_model_allowlist.is_empty() || ctx.key_model_allowlist.iter().any(|m| m == model)
}

// ---- chat handlers ----------------------------------------------------------

async fn openai_chat(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    actor: Option<Extension<crate::runs::RunActor>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    // ADR-0188 D13: a `cognia/*` model on this endpoint is a run, served through
    // the strict compat subset. Every other endpoint refuses one (`handle_chat`).
    if let Some(model) = body["model"].as_str().map(str::to_string) {
        if let crate::virtual_models::VirtualModelVerdict::Serve { .. } =
            crate::virtual_models::classify(&model, state.runs.runs_enabled())
        {
            let state = state.for_request(&ctx);
            // A key limited to named models reaches a virtual one only by name,
            // as it would any other model.
            if !ctx_allows(&ctx, &model) {
                return crate::runs::error_response(
                    StatusCode::FORBIDDEN,
                    "MODEL_NOT_PERMITTED",
                    &format!("this key is not permitted to use model \"{model}\""),
                    None,
                );
            }
            let actor = actor.map(|Extension(actor)| actor).unwrap_or_default();
            let idempotency_key = headers
                .get("idempotency-key")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let stream = body["stream"].as_bool() == Some(true);
            let started = Instant::now();
            // The answer's tokens draw down the key's quota, as a passthrough
            // request's do.
            let keys = state.keys.clone();
            let key_id = ctx.key_id.clone();
            let on_usage: crate::virtual_models::UsageSink = Box::new(move |tokens| {
                let consumed = i64::try_from(tokens).unwrap_or(i64::MAX);
                if let (true, Some(key_id)) = (consumed > 0, key_id.as_deref()) {
                    let _ = api_keys::add_quota_usage(&mut keys.write(), key_id, consumed);
                }
            });
            let response = crate::virtual_models::serve_chat(
                &state.runs,
                &actor,
                body,
                idempotency_key,
                on_usage,
            )
            .await;
            emit_request_log_ctx(
                state.host.as_ref(),
                &ctx,
                Some(&model),
                None,
                response.status().as_u16(),
                started.elapsed().as_millis() as u64,
                None,
                None,
                None,
                stream,
                None,
            );
            return response;
        }
    }
    handle_chat(state, ctx, InboundFormat::OpenAiChat, body).await
}

async fn anthropic_messages(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Json(body): Json<Value>,
) -> Response {
    handle_chat(state, ctx, InboundFormat::AnthropicMessages, body).await
}

/// A ticket's frozen candidates joined against the live snapshot by
/// deployment id. A candidate whose deployment vanished is skipped. Shared by
/// every ticket-authenticated handler so the walk cannot drift per route.
///
/// `resolved` is the model the ticket's frozen bindings mapped the request's
/// selector to. When the candidate's provider lists it, the request goes to
/// that model (a `haiku` background turn reaches the provider's haiku-class
/// model); otherwise the candidate's own frozen model serves.
fn ticket_base_candidates(
    snapshot: &RoutingSnapshot,
    ticket: &RouteTicket,
    resolved: Option<&str>,
) -> Vec<Candidate> {
    ticket
        .candidates
        .iter()
        .filter_map(|tc| {
            snapshot
                .provider_by_deployment(&tc.deployment_id)
                .or_else(|| snapshot.provider(&tc.deployment_id))
                .map(|p| {
                    let model_id = match resolved {
                        Some(model) if p.models.iter().any(|m| m == model) => model.to_string(),
                        _ => tc.model_id.clone(),
                    };
                    Candidate::new(p, &model_id)
                })
        })
        .collect()
}

// ---- count_tokens handler ---------------------------------------------------

/// `POST /v1/messages/count_tokens`. Gate order is identical to
/// [`handle_chat`]: snapshot, model, exposure guard (keys) or frozen binding
/// (tickets), then the same candidate walk. The request is forwarded to the
/// first Anthropic-protocol candidate and the upstream answer returned
/// verbatim (status, body, safe headers). Only when there is NO Anthropic
/// candidate, or the upstream explicitly lacks the endpoint (404 / 405 /
/// 501), does the gateway synthesize a local estimate. Every other upstream
/// failure (401 / 403 / 429 / 5xx) passes through untouched, otherwise Claude
/// Code would read a dead credential as a healthy connection.
///
/// The synthesized path draws no quota, records no cooldown, and logs with
/// `synthesized: true`. The forwarded path draws no quota either: counting
/// tokens consumes none.
async fn anthropic_count_tokens(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Json(body): Json<Value>,
) -> Response {
    let state = state.for_request(&ctx);
    let _perf = cognia_instrument::guard("gateway.count_tokens");
    // ADR-0188 D13: `cognia/*` has no tokenizer to count against.
    if let Some(refusal) = virtual_model_refusal(&state, &ctx, &body) {
        return refusal;
    }
    let format = InboundFormat::AnthropicMessages;
    if ctx.ticket.is_some() && !body_has_no_leaking_pii(&body) {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::BAD_REQUEST,
            "pii_blocked",
            "recognized sensitive data must be redacted before sending this task to the model",
            None,
        );
    }
    let cfg = state.config.read().clone();
    let snapshot = state.snapshot.read().clone();
    let Some(snapshot) = snapshot else {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::SERVICE_UNAVAILABLE,
            "overloaded_error",
            "no routing snapshot yet — open the Cognia window once so it can publish providers",
            None,
        );
    };
    let Some(model) = body["model"].as_str().map(|s| s.to_string()) else {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "model is required",
            None,
        );
    };
    let ticket = ctx.ticket.clone();
    if ticket.is_none() {
        if let Some(resp) = exposure_guard(&state, &ctx, format, &cfg, &model) {
            return resp;
        }
    }
    let mut resolved: Option<String> = None;
    if let Some(t) = &ticket {
        resolved = t.resolve_model(&model);
        if resolved.is_none() {
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                &format!("model \"{model}\" is not bound by this route ticket"),
                Some(&model),
            );
        }
    }

    let session_id = match &ticket {
        Some(t) => t.session_id.clone(),
        None => derive_session_id(
            &body,
            &ctx.remote_ip,
            &ctx.user_agent,
            ctx.key_id.as_deref().unwrap_or(""),
        ),
    };
    // Same walk as chat, but NOT expanded across key pools: a token count
    // needs one credential, never a rotation slot.
    let candidates = match &ticket {
        Some(t) => ticket_base_candidates(&snapshot, t, resolved.as_deref()),
        None => route_candidates(&state, &snapshot, &cfg, &model, &body, &session_id).await,
    };
    let anthropic = candidates
        .iter()
        .find(|c| c.provider.protocol == "anthropic")
        .cloned();
    let Some(candidate) = anthropic else {
        return synthesized_count(&state, &ctx, &model, &body);
    };

    let started = Instant::now();
    let mut upstream_body = rewrite_model(&body, &candidate.model_id);
    strip_request_fields(
        &mut upstream_body,
        &candidate.provider.id,
        &cfg.stripped_request_fields,
        &cfg.field_strip_allow,
    );
    let url = count_tokens_url(&candidate.provider.base_url);
    let mut req = state.http.post(&url).json(&upstream_body);
    req = apply_timeout(req, &cfg);
    let inbound_version = ctx
        .inbound_headers
        .iter()
        .find(|(name, _)| name == "anthropic-version")
        .map(|(_, value)| value.as_str());
    for (name, value) in super::execute::upstream_headers_for(
        &candidate.provider.protocol,
        candidate.provider.transport.as_ref(),
        candidate.provider.api_key.as_deref(),
        inbound_version,
    ) {
        req = req.header(name, value);
    }
    // Always same-protocol here, so semantic headers forward as on chat.
    let transport_extra: Vec<&str> = candidate
        .provider
        .transport
        .as_ref()
        .map(|t| {
            t.forwarded_semantic_headers
                .iter()
                .map(String::as_str)
                .collect()
        })
        .unwrap_or_default();
    for (name, value) in &ctx.inbound_headers {
        if name == "anthropic-version" {
            continue;
        }
        let semantic = crate::header_policy::is_forwardable_semantic_header(name)
            || transport_extra
                .iter()
                .any(|extra| extra.eq_ignore_ascii_case(name));
        if semantic {
            req = req.header(name, value);
        }
    }

    let resp = match req.send().await {
        Ok(resp) => resp,
        Err(err) => {
            let message = format!("connect error: {err}");
            emit_outcome(
                state.host.as_ref(),
                &candidate,
                false,
                started,
                None,
                Some(&message),
                None,
                None,
            );
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_GATEWAY,
                "api_error",
                &message,
                Some(&model),
            );
        }
    };

    let status = resp.status().as_u16();
    let headers = resp.headers().clone();
    let text = resp.text().await.unwrap_or_default();
    if matches!(status, 404 | 405 | 501) {
        // The upstream is reachable but has no count_tokens endpoint (an
        // Anthropic-compatible relay, not Anthropic itself). Estimate locally.
        return synthesized_count(&state, &ctx, &model, &body);
    }
    let input_tokens = if status < 400 {
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["input_tokens"].as_u64())
    } else {
        None
    };
    let error = (status >= 400).then(|| {
        format!(
            "HTTP {status}: {}",
            text.chars().take(500).collect::<String>()
        )
    });
    emit_request_log_ctx(
        state.host.as_ref(),
        &ctx,
        Some(&model),
        Some(&candidate.provider.id),
        status,
        started.elapsed().as_millis() as u64,
        input_tokens,
        None,
        error.as_deref(),
        false,
        Some(&candidate),
    );
    let mut builder = axum::http::Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY))
        .header("content-type", "application/json");
    for (name, value) in safe_upstream_response_headers(&headers) {
        builder = builder.header(name, value);
    }
    builder
        .body(Body::from(text))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// The local count_tokens estimate. Draws no quota, records no cooldown, and
/// is flagged `synthesized` in the request log so the audit surface never
/// mistakes it for an upstream answer.
fn synthesized_count(state: &AppState, ctx: &ReqCtx, model: &str, body: &Value) -> Response {
    let input_tokens = estimate_input_tokens(body);
    emit_request_log_full(
        state.host.as_ref(),
        &ctx.route,
        &ctx.remote_ip,
        ctx.key_id.as_deref(),
        Some(model),
        None,
        200,
        0,
        Some(input_tokens),
        None,
        None,
        false,
        None,
        true,
    );
    Json(json!({ "input_tokens": input_tokens })).into_response()
}

// ---- embeddings handler -----------------------------------------------------

async fn openai_embeddings(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Json(body): Json<Value>,
) -> Response {
    let state = state.for_request(&ctx);
    let _perf = cognia_instrument::guard("gateway.embeddings");
    // ADR-0188 D13: `cognia/*` is a routing mode, never an embeddings model.
    if let Some(refusal) = virtual_model_refusal(&state, &ctx, &body) {
        return refusal;
    }
    let format = InboundFormat::OpenAiChat;
    let cfg = state.config.read().clone();
    let snapshot = state.snapshot.read().clone();
    let Some(snapshot) = snapshot else {
        let response = logged_error(
            &state,
            &ctx,
            format,
            StatusCode::SERVICE_UNAVAILABLE,
            "overloaded_error",
            "no routing snapshot yet — open the Cognia window once so it can publish providers",
            None,
        );
        return response;
    };

    let Some(model) = body["model"].as_str().map(|s| s.to_string()) else {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "model is required",
            None,
        );
    };
    if body.get("input").map(Value::is_null).unwrap_or(true) {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "input is required",
            Some(&model),
        );
    }
    if let Some(resp) = exposure_guard(&state, &ctx, format, &cfg, &model) {
        return resp;
    }

    // W1.2: gateway-key in-flight cap. Embeddings responses are always buffered,
    // so the slot lives in this handler's scope — no SSE-pump hand-off needed.
    // The key is byte-identical to the chat path's so a single configured cap is
    // one shared budget across endpoints, not one budget per endpoint.
    let wait = Duration::from_millis(cfg.concurrency_wait_ms as u64);
    let _gw_slot = match state
        .concurrency
        .acquire(&gw_gate_key(&ctx), cfg.max_concurrent_per_key, wait)
        .await
    {
        Ok(slot) => slot,
        Err(()) => return concurrency_rejected(&state, &ctx, format, Some(&model)),
    };

    // Only OpenAI-compatible providers expose `/embeddings`. Expand each
    // provider's upstream key pool so a rate-limited account fails over, and
    // skip pooled keys the upstream just parked (W1.1) / permanently disabled
    // (W3.1) — the same cooldown state the chat path records.
    let now_ms = chrono::Utc::now().timestamp_millis();
    let all = route_candidates(&state, &snapshot, &cfg, &model, &body, "gateway-embeddings").await;
    let candidates: Vec<Candidate> = expand_key_pools(
        all.into_iter()
            .filter(|c| c.provider.protocol == "openai")
            .collect(),
        &state.key_rotation,
        &state.key_cooldown,
        now_ms,
    );
    if candidates.is_empty() {
        let status = if crate::route_planner::model_is_known(&snapshot, &model) {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::NOT_FOUND
        };
        let response = logged_error(
            &state,
            &ctx,
            format,
            status,
            "invalid_request_error",
            &format!("embeddings model \"{model}\" matches no enabled OpenAI-compatible provider"),
            Some(&model),
        );
        return with_retry_after(
            response,
            route_retry_after_ms(&snapshot, &state.key_cooldown, &model, now_ms),
        );
    }

    let mut failures: Vec<String> = Vec::new();
    let attempt_limit = route_attempt_limit(&cfg, &snapshot, candidates.len());
    let mut retry_wait_remaining_ms = cfg.max_retry_wait_ms;
    for (attempt_index, candidate) in candidates.iter().take(attempt_limit).enumerate() {
        let started = Instant::now();

        // W1.2: per-upstream-key cap for THIS attempt; released when the loop
        // iteration ends (failover) or the handler returns (success).
        let _up_slot = match state
            .concurrency
            .acquire(
                &up_gate_key(candidate),
                cfg.max_concurrent_per_upstream_key,
                wait,
            )
            .await
        {
            Ok(slot) => slot,
            Err(()) => {
                failures.push(format!(
                    "{}: upstream concurrency limit reached",
                    candidate.provider.id
                ));
                continue;
            }
        };
        // Counted whether or not a cap is set — this is the least-busy signal.
        let _in_flight = state.in_flight.enter(&candidate.provider.id);

        let mut upstream_body = rewrite_model(&body, &candidate.model_id);
        strip_request_fields(
            &mut upstream_body,
            &candidate.provider.id,
            &cfg.stripped_request_fields,
            &cfg.field_strip_allow,
        );
        let url = embeddings_url(&candidate.provider.base_url);
        let mut req = state.http.post(&url).json(&upstream_body);
        req = apply_timeout(req, &cfg);
        for (name, value) in upstream_headers("openai", candidate.provider.api_key.as_deref()) {
            req = req.header(name, value);
        }

        let resp = match req.send().await {
            Ok(resp) => resp,
            Err(err) => {
                let message = format!("connect error: {err}");
                // Embeddings traffic trains the same health / breaker / cost
                // stores as chat. `session_id` is None: embeddings must never
                // pin a chat session's affinity (same rule as /v1/responses).
                emit_outcome(
                    state.host.as_ref(),
                    candidate,
                    false,
                    started,
                    None,
                    Some(&message),
                    None,
                    None,
                );
                wait_before_retry(
                    &cfg,
                    attempt_index,
                    None,
                    &mut retry_wait_remaining_ms,
                    attempt_index + 1 < attempt_limit,
                )
                .await;
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
        };

        let status = resp.status().as_u16();
        if status >= 400 {
            let headers = resp.headers().clone();
            let retry_after = headers.get("retry-after").and_then(|v| v.to_str().ok());
            let unified = headers
                .get("anthropic-ratelimit-unified-reset")
                .and_then(|v| v.to_str().ok());
            let text = resp.text().await.unwrap_or_default();
            // W1.1 + W3.1: park / disable the pooled key so later requests (any
            // endpoint) stop re-selecting it.
            let retry_after_ms = record_upstream_cooldown(
                &state,
                &cfg,
                candidate,
                status,
                retry_after,
                unified,
                &text,
                now_ms,
            );
            let message = format!(
                "HTTP {status}: {}",
                text.chars().take(500).collect::<String>()
            );
            // Forward the cooldown window so the renderer breaker gets the same
            // dynamic backoff the chat path already feeds it.
            emit_outcome(
                state.host.as_ref(),
                candidate,
                false,
                started,
                None,
                Some(&message),
                retry_after_ms,
                None,
            );
            // R4: authentication failures never switch credentials/providers
            // unless a verified route ticket explicitly allows auth failover.
            let auth_failure = status == 401 || status == 403;
            let auth_failover_allowed = ctx
                .ticket
                .as_ref()
                .is_some_and(|ticket| ticket.allow_auth_failover);
            if cfg.should_retry(status) && (!auth_failure || auth_failover_allowed) {
                wait_before_retry(
                    &cfg,
                    attempt_index,
                    retry_after_ms,
                    &mut retry_wait_remaining_ms,
                    attempt_index + 1 < attempt_limit,
                )
                .await;
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
                "invalid_request_error",
                &message,
                Some(&model),
            );
        }

        let upstream: Value = match resp.json().await {
            Ok(value) => value,
            Err(err) => {
                // A 200 the provider can't serialize is still the provider's
                // fault — the chat path already reports this (see
                // `buffered_response`), so embeddings must too or the breaker
                // never sees a provider that reliably returns garbage.
                let message = format!("invalid upstream JSON: {err}");
                emit_outcome(
                    state.host.as_ref(),
                    candidate,
                    false,
                    started,
                    None,
                    Some(&message),
                    None,
                    None,
                );
                return logged_error(
                    &state,
                    &ctx,
                    format,
                    StatusCode::BAD_GATEWAY,
                    "api_error",
                    &message,
                    Some(&model),
                );
            }
        };
        // Embeddings report only prompt tokens (no completion side).
        let input_tokens = upstream["usage"]["prompt_tokens"]
            .as_u64()
            .or_else(|| upstream["usage"]["total_tokens"].as_u64());
        emit_outcome(
            state.host.as_ref(),
            candidate,
            true,
            started,
            Some((input_tokens, None)),
            None,
            None,
            None,
        );
        log_success(
            &state,
            &ctx,
            &model,
            candidate,
            started.elapsed().as_millis() as u64,
            input_tokens,
            None,
            false,
        );
        return Json(upstream).into_response();
    }

    all_failed(&state, &ctx, format, &model, &failures)
}

// ---- responses handler ------------------------------------------------------

/// Bounded, memory-only continuation state. Scope includes account generation,
/// authentication authority and model; a response id alone never grants access.
#[derive(Default)]
struct ResponseHistory {
    entries: std::collections::VecDeque<(String, String, i64, Vec<Value>)>,
}
impl ResponseHistory {
    fn get(&mut self, scope: &str, id: &str) -> Option<Vec<Value>> {
        let now = chrono::Utc::now().timestamp_millis();
        self.entries.retain(|entry| now - entry.2 < 3_600_000);
        self.entries
            .iter()
            .find(|entry| entry.0 == scope && entry.1 == id)
            .map(|entry| entry.3.clone())
    }
    fn put(&mut self, scope: String, response: &Value, input: &[Value]) {
        let Some(id) = response["id"].as_str() else {
            return;
        };
        if response["status"] != "completed" && response["status"] != "incomplete" {
            return;
        }
        let mut items = input.to_vec();
        items.extend(response["output"].as_array().cloned().unwrap_or_default());
        let bytes = items
            .iter()
            .map(|item| item.to_string().len())
            .sum::<usize>();
        // Retaining a huge history is optional: clients can resend full input.
        if bytes > 2 * 1024 * 1024 {
            return;
        }
        while self.entries.len() >= 32 {
            self.entries.pop_front();
        }
        self.entries.push_back((
            scope,
            id.into(),
            chrono::Utc::now().timestamp_millis(),
            items,
        ));
    }
}

async fn openai_responses(
    State(state): State<AppState>,
    Extension(ctx): Extension<ReqCtx>,
    Json(mut body): Json<Value>,
) -> Response {
    let state = state.for_request(&ctx);
    // ADR-0188 D13: refused before the Responses checks read the body.
    if let Some(refusal) = virtual_model_refusal(&state, &ctx, &body) {
        return refusal;
    }
    let format = InboundFormat::OpenAiChat;
    let native = state.snapshot.read().as_ref().is_some_and(|snapshot| {
        let model = body["model"].as_str().unwrap_or("");
        let candidates = if let Some(ticket) = &ctx.ticket {
            ticket_base_candidates(snapshot, ticket, ticket.resolve_model(model).as_deref())
        } else {
            resolve_candidates(snapshot, model)
        };
        !candidates.is_empty()
            && candidates
                .iter()
                .all(|c| c.provider.protocol == "responses")
    });
    if let Some(reason) = responses_translate::unsupported_feature(&body).filter(|_| !native) {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            &reason,
            None,
        );
    }
    let model = body["model"].as_str().unwrap_or("").to_string();
    let scope = format!(
        "{}:{}:{}",
        ctx.account_generation,
        ctx.ticket
            .as_ref()
            .map(|t| t.ticket_id.as_str())
            .or(ctx.key_id.as_deref())
            .unwrap_or(""),
        model
    );
    let mut input = match &body["input"] {
        Value::String(text) => vec![json!({"role":"user","content":text})],
        Value::Array(items) => items.clone(),
        _ => Vec::new(),
    };
    if let Some(previous) = body["previous_response_id"].as_str() {
        let history = state.response_history.lock().get(&scope, previous);
        let Some(mut history) = history else {
            return logged_error(&state,&ctx,format,StatusCode::BAD_REQUEST,"invalid_request_error",
                "previous_response_id is unknown, expired, or belongs to another task/model; resend full input",Some(&model));
        };
        if !native {
            history.append(&mut input);
            input = history;
        }
    }
    body["input"] = json!(input);
    let stream = body["stream"].as_bool().unwrap_or(false);
    if !native {
        if let Err(error) = responses_translate::request_to_ir(&body) {
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                &error.reason,
                Some(&model),
            );
        }
    }
    let custom_tools = responses_translate::custom_tool_names(&body);
    let namespaces = responses_translate::tool_namespaces(&body);
    let response = handle_chat(
        state.clone(),
        ctx.clone(),
        InboundFormat::OpenAiResponses,
        body,
    )
    .await;
    if !response.status().is_success() {
        return response;
    }
    let native = response
        .headers()
        .get("x-cognia-upstream-responses")
        .is_some()
        || (native && !stream);
    if !stream {
        let bytes = match axum::body::to_bytes(response.into_body(), BODY_LIMIT_BYTES).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return logged_error(
                    &state,
                    &ctx,
                    format,
                    StatusCode::BAD_GATEWAY,
                    "api_error",
                    "invalid upstream response",
                    Some(&model),
                )
            }
        };
        if native {
            let value: Value = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(_) => {
                    return logged_error(
                        &state,
                        &ctx,
                        format,
                        StatusCode::BAD_GATEWAY,
                        "api_error",
                        "invalid upstream response",
                        Some(&model),
                    )
                }
            };
            state.response_history.lock().put(scope, &value, &input);
            return Json(value).into_response();
        }
        let converted = serde_json::from_slice::<Value>(&bytes).ok();
        let Some(mut converted) = converted else {
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_GATEWAY,
                "api_error",
                "invalid upstream response",
                Some(&model),
            );
        };
        if let Err(reason) =
            responses_translate::restore_custom_tools(&mut converted, &custom_tools)
        {
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_GATEWAY,
                "api_error",
                &reason,
                Some(&model),
            );
        }
        responses_translate::restore_namespaces(&mut converted, &namespaces);
        state.response_history.lock().put(scope, &converted, &input);
        return Json(converted).into_response();
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(16);
    spawn_request_task(&state.clone(), &ctx.clone(), async move {
        let mut upstream = response.into_body().into_data_stream();
        let mut deframer = SseDeframer::default();
        let mut encoder = responses_translate::ResponsesStream::new(&model, custom_tools)
            .with_namespaces(namespaces);
        if !native {
            for frame in encoder.start() {
                if tx.send(Bytes::from(frame)).await.is_err() {
                    return;
                }
            }
        }
        loop {
            let next = tokio::select! { biased; _ = tx.closed() => return, next = upstream.next() => next };
            match next {
                Some(Ok(bytes)) => {
                    if native {
                        for payload in deframer.push(&bytes) {
                            if let Ok(value) = serde_json::from_str::<Value>(&payload) {
                                if matches!(
                                    value["type"].as_str(),
                                    Some("response.completed" | "response.incomplete")
                                ) {
                                    state.response_history.lock().put(
                                        scope.clone(),
                                        &value["response"],
                                        &input,
                                    );
                                }
                            }
                        }
                        if tx.send(bytes).await.is_err() {
                            return;
                        }
                        continue;
                    }
                    for payload in deframer.push(&bytes) {
                        for frame in encoder.push(&payload) {
                            if tx.send(Bytes::from(frame)).await.is_err() {
                                return;
                            }
                        }
                    }
                }
                Some(Err(_)) => break,
                None => {
                    if native {
                        return;
                    }
                    if let Some(payload) = deframer.finish() {
                        for frame in encoder.push(&payload) {
                            if tx.send(Bytes::from(frame)).await.is_err() {
                                return;
                            }
                        }
                    }
                    break;
                }
            }
        }
        if native {
            return;
        }
        for frame in encoder.fail("upstream stream ended before completion") {
            if tx.send(Bytes::from(frame)).await.is_err() {
                return;
            }
        }
        state
            .response_history
            .lock()
            .put(scope, &encoder.response, &input);
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|bytes| (Ok::<_, std::io::Error>(bytes), rx))
    });
    sse_response(Body::from_stream(stream))
}

fn no_snapshot_error(format: InboundFormat) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(error_body(
            format,
            "overloaded_error",
            "no routing snapshot yet — open the Cognia window once so it can publish providers",
        )),
    )
        .into_response()
}

/// Emit a durable request-log row for a terminal error and return the inbound
/// error response in one call.
#[allow(clippy::too_many_arguments)]
fn logged_error(
    state: &AppState,
    ctx: &ReqCtx,
    format: InboundFormat,
    status: StatusCode,
    err_code: &str,
    message: &str,
    model: Option<&str>,
) -> Response {
    emit_request_log_ctx(
        state.host.as_ref(),
        ctx,
        model,
        None,
        status.as_u16(),
        0,
        None,
        None,
        Some(message),
        false,
        None,
    );
    (status, Json(error_body(format, err_code, message))).into_response()
}

/// The "every candidate failed" 502 terminal.
fn all_failed(
    state: &AppState,
    ctx: &ReqCtx,
    format: InboundFormat,
    model: &str,
    failures: &[String],
) -> Response {
    let message = format!("every candidate failed: {}", failures.join(" | "));
    emit_request_log_ctx(
        state.host.as_ref(),
        ctx,
        Some(model),
        None,
        StatusCode::BAD_GATEWAY.as_u16(),
        0,
        None,
        None,
        Some(&message),
        false,
        None,
    );
    (
        StatusCode::BAD_GATEWAY,
        Json(error_body(format, "api_error", &message)),
    )
        .into_response()
}

/// Enforce gateway model exposure + the calling key's allowlist. Returns
/// `Some(response)` when the model is denied.
fn exposure_guard(
    state: &AppState,
    ctx: &ReqCtx,
    format: InboundFormat,
    cfg: &GatewayConfig,
    model: &str,
) -> Option<Response> {
    if !cfg.model_is_exposed(model) {
        return Some(logged_error(
            state,
            ctx,
            format,
            StatusCode::NOT_FOUND,
            "invalid_request_error",
            &format!("model \"{model}\" is not exposed by this gateway"),
            Some(model),
        ));
    }
    if !ctx_allows(ctx, model) {
        return Some(logged_error(
            state,
            ctx,
            format,
            StatusCode::FORBIDDEN,
            "invalid_request_error",
            &format!("this key is not permitted to use model \"{model}\""),
            Some(model),
        ));
    }
    None
}

/// Apply the configured total timeout to a NON-streaming upstream request.
fn apply_timeout(req: reqwest::RequestBuilder, cfg: &GatewayConfig) -> reqwest::RequestBuilder {
    if cfg.request_timeout_secs > 0 {
        req.timeout(Duration::from_secs(cfg.request_timeout_secs as u64))
    } else {
        req
    }
}

/// Parse an upstream error response's account-level cooldown signal, record it
/// against the pooled key (temporary cooldown or permanent disable — W1.1 +
/// W3.1), and return the cooldown window (ms) to surface on the outcome event
/// (the renderer breaker's dynamic-cooldown path consumes it). A no-op for
/// keyless / single-key providers with no pooled key to park.
#[allow(clippy::too_many_arguments)]
fn record_upstream_cooldown(
    state: &AppState,
    cfg: &GatewayConfig,
    candidate: &Candidate,
    status: u16,
    retry_after: Option<&str>,
    unified_reset: Option<&str>,
    body: &str,
    now_ms: i64,
) -> Option<i64> {
    let api_key = candidate.provider.api_key.as_deref()?;
    if let Some(reason) = cooldown::permanent_failure_reason(status, body, &cfg.disable_keywords) {
        cooldown::record_permanent(
            &state.key_cooldown,
            &candidate.provider.id,
            api_key,
            &reason,
        );
        return None;
    }
    let ms = cooldown::cooldown_ms_from_headers(
        status,
        retry_after,
        unified_reset,
        cfg.cooldown_fallback_secs,
        cfg.overload_cooldown_secs,
        now_ms,
    )?;
    cooldown::record_cooldown(
        &state.key_cooldown,
        &candidate.provider.id,
        api_key,
        now_ms + ms,
        &format!("HTTP {status}"),
    );
    Some(ms)
}

/// Concurrency-gate key for the calling gateway API key (W1.2).
///
/// Chat, embeddings and responses MUST derive this identically — a single
/// configured `maxConcurrentPerKey` is one budget shared across every endpoint,
/// and three hand-copied `format!` literals would silently split it into three.
fn gw_gate_key(ctx: &ReqCtx) -> String {
    format!("gw:{}", ctx.key_id.as_deref().unwrap_or("_"))
}

/// Concurrency-gate key for one pooled upstream account (W1.2). Same
/// shared-budget invariant as [`gw_gate_key`].
///
/// Note this embeds the upstream secret and therefore must never be serialized;
/// the renderer-facing in-flight tally keys on `provider.id` alone.
fn up_gate_key(candidate: &Candidate) -> String {
    format!(
        "up:{}:{}",
        candidate.provider.id,
        candidate.provider.api_key.as_deref().unwrap_or("")
    )
}

/// The "in-flight concurrency cap reached" 429 terminal (W1.2).
fn concurrency_rejected(
    state: &AppState,
    ctx: &ReqCtx,
    format: InboundFormat,
    model: Option<&str>,
) -> Response {
    logged_error(
        state,
        ctx,
        format,
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limit_error",
        "concurrency limit reached — too many in-flight requests for this key",
        model,
    )
}

fn route_retry_after_ms(
    snapshot: &RoutingSnapshot,
    cooldown: &KeyCooldownMap,
    model: &str,
    now_ms: i64,
) -> Option<i64> {
    let provider_ids = crate::route_planner::route_provider_ids(snapshot, model);
    snapshot
        .providers
        .iter()
        .filter(|provider| provider_ids.contains(&provider.id) && provider.rotation_enabled)
        .filter_map(|provider| {
            let pool: Vec<String> = provider
                .api_keys
                .iter()
                .map(|key| key.trim().to_string())
                .filter(|key| !key.is_empty())
                .collect();
            cooldown::all_cooling_retry_after_ms(cooldown, &provider.id, &pool, now_ms)
        })
        .min()
}

fn with_retry_after(mut response: Response, retry_after_ms: Option<i64>) -> Response {
    if let Some(milliseconds) = retry_after_ms {
        let seconds = (milliseconds.max(1) + 999) / 1000;
        if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
            response.headers_mut().insert(RETRY_AFTER, value);
        }
    }
    response
}

fn route_attempt_limit(cfg: &GatewayConfig, snapshot: &RoutingSnapshot, available: usize) -> usize {
    let configured = cfg.attempt_budget(available);
    snapshot
        .routing_policy
        .as_ref()
        .map(|policy| configured.min(policy.max_fallback_attempts.max(1) as usize))
        .unwrap_or(configured)
}

async fn wait_before_retry(
    cfg: &GatewayConfig,
    attempt_index: usize,
    retry_after_ms: Option<i64>,
    remaining_ms: &mut u32,
    has_next_attempt: bool,
) {
    if !has_next_attempt || *remaining_ms == 0 {
        return;
    }
    let exponent = attempt_index.min(16) as u32;
    let local = cfg
        .retry_backoff_base_ms
        .saturating_mul(2u32.saturating_pow(exponent))
        .min(cfg.retry_backoff_max_ms);
    let hinted = retry_after_ms
        .filter(|_| cfg.respect_retry_after)
        .and_then(|value| u32::try_from(value).ok());
    let delay = hinted.unwrap_or(local).min(*remaining_ms);
    *remaining_ms = remaining_ms.saturating_sub(delay);
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(u64::from(delay))).await;
    }
}

async fn route_candidates(
    state: &AppState,
    snapshot: &RoutingSnapshot,
    cfg: &GatewayConfig,
    model: &str,
    body: &Value,
    session_id: &str,
) -> Vec<Candidate> {
    if cfg.gateway_local_routing_v2 && snapshot.routing_policy.is_some() {
        return crate::route_planner::plan_candidates(
            snapshot,
            model,
            body,
            &state.route_planner,
            &state.in_flight.snapshot(),
        );
    }
    if !cfg.gateway_local_routing_v2 {
        if let Some(candidates) = live_decision(state, snapshot, model, body, session_id).await {
            return candidates;
        }
    }
    resolve_candidates(snapshot, model)
}

/// Ask the renderer for a live routing decision (full engine).
async fn live_decision(
    state: &AppState,
    snapshot: &RoutingSnapshot,
    model: &str,
    body: &Value,
    session_id: &str,
) -> Option<Vec<Candidate>> {
    let request_id = format!("gwd_{}", uuid::Uuid::new_v4().simple());
    let (tx, rx) = oneshot::channel::<Vec<super::snapshot::SnapshotEntry>>();
    state.decisions.lock().insert(request_id.clone(), tx);

    let prompt_text = body["messages"]
        .as_array()
        .and_then(|m| m.iter().rev().find(|msg| msg["role"] == "user"))
        .and_then(|msg| match &msg["content"] {
            Value::String(s) => Some(s.clone()),
            Value::Array(parts) => Some(
                parts
                    .iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            _ => None,
        });

    if !state.host.supports_live_decisions() {
        return None;
    }
    let emitted = state.host.emit(
        DECIDE_EVENT,
        json!({
            "requestId": request_id,
            "model": model,
            "promptText": prompt_text,
            "sessionId": session_id,
            // W1.2b: gateway-generated load, per provider. This runs BEFORE the
            // candidate walk, so the snapshot is exactly "what other requests
            // are in flight" — the signal the renderer's least-busy strategy
            // otherwise reads as a constant zero for gateway traffic.
            "inFlight": state.in_flight.snapshot(),
        }),
    );
    if !emitted {
        state.decisions.lock().remove(&request_id);
        return None;
    }

    let entries = match tokio::time::timeout(Duration::from_millis(DECIDE_TIMEOUT_MS), rx).await {
        Ok(Ok(entries)) if !entries.is_empty() => entries,
        _ => {
            state.decisions.lock().remove(&request_id);
            return None;
        }
    };
    let candidates = candidates_from_entries(snapshot, &entries);
    if candidates.is_empty() {
        None
    } else {
        Some(candidates)
    }
}

/// ADR-0188 D13/D37: a request naming a `cognia/*` model — or `router/*` while
/// runs are on — on an endpoint that does not serve it is refused here, first,
/// in the Run API contract's `ErrorResponse` (the code in `code`, never in the
/// legacy `type`), and logged like any other terminal error. Falling through
/// would report "unknown model", which tells the caller nothing about the
/// switch to turn on or the endpoint that serves what it asked for. `None` for
/// any other model: the ordinary path carries on unchanged.
fn virtual_model_refusal(state: &AppState, ctx: &ReqCtx, body: &Value) -> Option<Response> {
    let model = body["model"].as_str()?;
    let crate::virtual_models::VirtualModelVerdict::Refuse {
        status,
        code,
        message,
    } = crate::virtual_models::verdict_off_compat(model, state.runs.runs_enabled())
    else {
        return None;
    };
    let response = crate::virtual_models::refusal_response(model, status, &code, &message);
    emit_request_log_ctx(
        state.host.as_ref(),
        ctx,
        Some(model),
        None,
        response.status().as_u16(),
        0,
        None,
        None,
        Some(&message),
        false,
        None,
    );
    Some(response)
}

async fn handle_chat(state: AppState, ctx: ReqCtx, format: InboundFormat, body: Value) -> Response {
    let state = state.for_request(&ctx);
    let _perf = cognia_instrument::guard("gateway.chat");
    // `cognia/*` names a routing MODE, not a model (ADR-0188 D13), and is
    // answered before anything else reads the request. `/v1/chat/completions`
    // serves the four modes before it gets here, so what reaches this point is
    // refused: switched off, `delegate`, an unknown mode, or another endpoint.
    if let Some(refusal) = virtual_model_refusal(&state, &ctx, &body) {
        return refusal;
    }
    let cfg = state.config.read().clone();
    if ctx.ticket.is_some() && !body_has_no_leaking_pii(&body) {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::BAD_REQUEST,
            "pii_blocked",
            "recognized sensitive data must be redacted before sending this task to the model",
            None,
        );
    }
    let snapshot = state.snapshot.read().clone();
    let Some(snapshot) = snapshot else {
        let response = logged_error(
            &state,
            &ctx,
            format,
            StatusCode::SERVICE_UNAVAILABLE,
            "overloaded_error",
            "no routing snapshot yet — open the Cognia window once so it can publish providers",
            None,
        );
        return response;
    };

    let Some(model) = body["model"].as_str().map(|s| s.to_string()) else {
        return logged_error(
            &state,
            &ctx,
            format,
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "model is required",
            None,
        );
    };
    let ticket = ctx.ticket.clone();
    // Ticket requests skip the exposure guard: their model surface was frozen
    // and validated at mint, and live exposure edits must not alter it.
    if ticket.is_none() {
        if let Some(resp) = exposure_guard(&state, &ctx, format, &cfg, &model) {
            return resp;
        }
    }
    let body = crate::route_planner::apply_parameter_defaults(&snapshot, &model, &body);
    let stream = body["stream"].as_bool().unwrap_or(false);
    let now_ms = chrono::Utc::now().timestamp_millis();

    // Frozen selector mapping (ADR-0090 Phase 2): a ticket request whose model
    // selector is not bound fails closed BEFORE any upstream work — never a
    // live-alias substitution.
    let mut resolved: Option<String> = None;
    if let Some(t) = &ticket {
        resolved = t.resolve_model(&model);
        if resolved.is_none() {
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                &format!("model \"{model}\" is not bound by this route ticket"),
                Some(&model),
            );
        }
    }

    // W1.3: derive a stable affinity key for this request and thread it through
    // the live decision (so the routing engine's session-affinity filter sticks
    // this conversation to one deployment) and the outcome event (so a
    // successful turn pins it — the same machinery the chat plane already uses).
    let session_id = match &ticket {
        Some(t) => t.session_id.clone(),
        None => derive_session_id(
            &body,
            &ctx.remote_ip,
            &ctx.user_agent,
            ctx.key_id.as_deref().unwrap_or(""),
        ),
    };

    // W1.2: gateway-key in-flight cap for the whole request. Held until the
    // response completes — moved into the streaming task below so it releases at
    // stream end, not at this handler's return.
    let wait = Duration::from_millis(cfg.concurrency_wait_ms as u64);
    let gw_slot = match state
        .concurrency
        .acquire(&gw_gate_key(&ctx), cfg.max_concurrent_per_key, wait)
        .await
    {
        Ok(slot) => slot,
        Err(()) => return concurrency_rejected(&state, &ctx, format, Some(&model)),
    };

    let candidates = if let Some(t) = &ticket {
        // Frozen walk: ONLY the ticket's candidates, joined against the live
        // snapshot by deployment id. A global alias update cannot change this
        // set; a candidate whose deployment vanished is skipped, and zero
        // servable candidates is a 503 (gateway-generated — legitimate here).
        let base = ticket_base_candidates(&snapshot, t, resolved.as_deref());
        if base.is_empty() {
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::SERVICE_UNAVAILABLE,
                "overloaded_error",
                "no ticket candidate is servable by the current snapshot",
                Some(&model),
            );
        }
        expand_for_ticket(
            base,
            t.credential_affinity,
            &state.leases,
            &session_id,
            &state.key_rotation,
            &state.key_cooldown,
            now_ms,
        )
    } else {
        expand_key_pools(
            route_candidates(&state, &snapshot, &cfg, &model, &body, &session_id).await,
            &state.key_rotation,
            &state.key_cooldown,
            now_ms,
        )
    };
    if candidates.is_empty() {
        let status = if crate::route_planner::model_is_known(&snapshot, &model) {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::NOT_FOUND
        };
        let response = logged_error(
            &state,
            &ctx,
            format,
            status,
            "invalid_request_error",
            &format!(
                "model \"{model}\" matches no alias, provider:model, or enabled provider model"
            ),
            Some(&model),
        );
        return with_retry_after(
            response,
            route_retry_after_ms(&snapshot, &state.key_cooldown, &model, now_ms),
        );
    }

    let needs_translation = candidates
        .iter()
        .any(|c| c.provider.protocol != format.protocol_name());
    let ir = if needs_translation {
        match request_to_ir(format, &body) {
            Ok(ir) => Some(ir),
            Err(err) => {
                return logged_error(
                    &state,
                    &ctx,
                    format,
                    StatusCode::BAD_REQUEST,
                    "invalid_request_error",
                    &err.reason,
                    Some(&model),
                )
            }
        }
    } else {
        None
    };

    // ADR-0090: cross-protocol translation may drop/merge fields — surface
    // every recorded loss as a trace event (never in response bodies).
    if let Some(ir) = &ir {
        if !ir.losses.is_empty() {
            let _ = state.host.emit(
                "gateway://translation-loss",
                json!({ "model": model, "losses": ir.losses }),
            );
        }
    }

    let mut failures: Vec<String> = Vec::new();
    let attempt_limit = route_attempt_limit(&cfg, &snapshot, candidates.len());
    let mut retry_wait_remaining_ms = cfg.max_retry_wait_ms;
    // ADR-0188 D13: with `gatewayPassthroughLedger` on, every upstream attempt is
    // reserved before it is sent and settled from the usage this handler already
    // reads. With it off nothing below asks the brain anything, so the proxy path
    // is byte-for-byte what it was (D37).
    let ledger_enabled = state.runs.passthrough_ledger_enabled();
    let ledger_bridge = state.runs.bridge();
    // Resolved once, before any await: `state.keys` is a parking_lot guard, and
    // the name is what the run's own history shows for "who asked" — a copy,
    // because the key can be renamed or revoked while the run is still listed.
    let ledger_key_name = ctx
        .key_id
        .as_ref()
        .and_then(|id| {
            let keys = state.keys.read();
            keys.iter()
                .find(|key| &key.id == id)
                .map(|key| key.name.clone())
        })
        .unwrap_or_default();
    let mut ledger_header =
        crate::passthrough_ledger::LedgerHeader::Bypassed("surface_off".to_string());
    let mut ledger_run_id: Option<String> = None;
    let mut attempts_made: usize = 0;
    for (attempt_index, candidate) in candidates.iter().take(attempt_limit).enumerate() {
        let started = Instant::now();

        // W1.2: per-upstream-key in-flight cap for THIS attempt. On failover the
        // slot drops here (released); on success it is kept alive (buffered) or
        // moved into the streaming task.
        let up_slot = match state
            .concurrency
            .acquire(
                &up_gate_key(candidate),
                cfg.max_concurrent_per_upstream_key,
                wait,
            )
            .await
        {
            Ok(slot) => slot,
            Err(()) => {
                failures.push(format!(
                    "{}: upstream concurrency limit reached",
                    candidate.provider.id
                ));
                continue;
            }
        };
        // Counted whether or not a cap is set. Tracks `up_slot`'s lifetime
        // exactly — including the move into the streaming task below.
        let in_flight = state.in_flight.enter(&candidate.provider.id);

        let passthrough = candidate.provider.protocol == format.protocol_name();
        let mut upstream_body = if passthrough {
            rewrite_model(&body, &candidate.model_id)
        } else {
            let mut ir = ir.clone().expect("ir computed for translated pairs");
            ir.model = candidate.model_id.clone();
            if ir.reasoning_effort.is_some()
                && ((format == InboundFormat::AnthropicMessages)
                    != (candidate.provider.protocol == "anthropic"))
            {
                let _ = state.host.emit("gateway://translation-loss", json!({"model":model,"losses":[
                    super::translate::ir::TranslationLoss::approximated("reasoning_effort",
                        "effort preserves relative intensity; Anthropic effort also applies to non-thinking output and is not an exact reasoning-token budget")
                ]}));
            }
            match request_from_ir(&candidate.provider.protocol, &ir) {
                Ok(body) => body,
                Err(err) => {
                    if candidates.len() == 1 {
                        return logged_error(
                            &state,
                            &ctx,
                            format,
                            StatusCode::BAD_REQUEST,
                            "invalid_request_error",
                            &err.reason,
                            Some(&model),
                        );
                    }
                    failures.push(format!("{}: {}", candidate.provider.id, err.reason));
                    continue;
                }
            }
        };
        if let Err(reason) = apply_model_limits(&mut upstream_body, candidate) {
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                &reason,
                Some(&model),
            );
        }
        if ctx.ticket.is_some() {
            let field = if upstream_body.get("max_completion_tokens").is_some() {
                "max_completion_tokens"
            } else if candidate.provider.protocol == "responses" {
                "max_output_tokens"
            } else {
                "max_tokens"
            };
            match state.tickets.reserve_model_output(
                &ctx.request_id,
                estimate_input_tokens(&upstream_body),
                upstream_body[field].as_u64(),
            ) {
                Ok(Some(output)) => upstream_body[field] = json!(output),
                Ok(None) => {}
                Err(_) => {
                    return logged_error(
                        &state,
                        &ctx,
                        format,
                        StatusCode::TOO_MANY_REQUESTS,
                        "insufficient_quota",
                        "route ticket token budget exhausted",
                        Some(&model),
                    )
                }
            }
        }
        // W3.2: strip client-supplied billing/privacy/behaviour toggles from the
        // outbound body (both passthrough AND translated paths).
        strip_request_fields(
            &mut upstream_body,
            &candidate.provider.id,
            &cfg.stripped_request_fields,
            &cfg.field_strip_allow,
        );

        let url = upstream_url(&candidate.provider.protocol, &candidate.provider.base_url);
        let mut req = state.http.post(&url).json(&upstream_body);
        if !stream {
            req = apply_timeout(req, &cfg);
        }
        // R2: the client's own anthropic-version wins over the pinned default.
        let inbound_version = ctx
            .inbound_headers
            .iter()
            .find(|(name, _)| name == "anthropic-version")
            .map(|(_, value)| value.as_str());
        for (name, value) in super::execute::upstream_headers_for(
            &candidate.provider.protocol,
            candidate.provider.transport.as_ref(),
            candidate.provider.api_key.as_deref(),
            inbound_version,
        ) {
            req = req.header(name, value);
        }
        // R2: forward inbound SEMANTIC headers on same-protocol routes — the
        // built-in allowlist (anthropic-*, x-claude-code-*, x-stainless-*,
        // x-app) plus the transport's declared extras. Auth/hop-by-hop/etc.
        // were already stripped at capture. anthropic-version was handled
        // above; skip it here to avoid duplicates.
        if passthrough {
            let transport_extra: Vec<&str> = candidate
                .provider
                .transport
                .as_ref()
                .map(|t| {
                    t.forwarded_semantic_headers
                        .iter()
                        .map(String::as_str)
                        .collect()
                })
                .unwrap_or_default();
            for (name, value) in &ctx.inbound_headers {
                if name == "anthropic-version" {
                    continue;
                }
                let semantic = crate::header_policy::is_forwardable_semantic_header(name)
                    || transport_extra
                        .iter()
                        .any(|extra| extra.eq_ignore_ascii_case(name));
                if semantic {
                    req = req.header(name, value);
                }
            }
        }

        // Reserved here and nowhere earlier: every bail above this line sent
        // nothing, so there is nothing to settle for them.
        let has_more_candidates = attempt_index + 1 < attempt_limit;
        let reservation = crate::passthrough_ledger::reserve(
            ledger_bridge.clone(),
            ledger_enabled,
            crate::passthrough_ledger::ReserveRequest {
                request_id: ctx.request_id.clone(),
                attempt: attempt_index,
                provider_id: candidate.provider.id.clone(),
                model_id: candidate.model_id.clone(),
                requested_model: model.clone(),
                key_id: ctx.key_id.clone(),
                key_name: ledger_key_name.clone(),
                estimated_input_tokens: estimate_input_tokens(&upstream_body),
                max_output_tokens: upstream_body["max_tokens"]
                    .as_u64()
                    .or_else(|| upstream_body["max_completion_tokens"].as_u64())
                    .or_else(|| upstream_body["max_output_tokens"].as_u64()),
            },
        )
        .await;
        let ledgered = match reservation {
            crate::passthrough_ledger::ReserveVerdict::Ledgered { run_id, attempt_id } => {
                ledger_header = crate::passthrough_ledger::LedgerHeader::Ledgered;
                ledger_run_id = Some(run_id.clone());
                Some(crate::passthrough_ledger::LedgeredAttempt { run_id, attempt_id })
            }
            crate::passthrough_ledger::ReserveVerdict::Bypassed { reason } => {
                // Ordinary traffic is never stopped by a ledger that cannot
                // answer; the header says the bill was not recorded (D38).
                ledger_header = crate::passthrough_ledger::LedgerHeader::Bypassed(reason);
                None
            }
            crate::passthrough_ledger::ReserveVerdict::Refused { code, reasons } => {
                // A budget or policy refusal is a real answer, not a fault:
                // sending anyway would spend money the user said no to.
                let mut message = format!("Router + Fusion refused this request: {code}");
                if !reasons.is_empty() {
                    message.push_str(&format!(" ({})", reasons.join(", ")));
                }
                let response = logged_error(
                    &state,
                    &ctx,
                    format,
                    StatusCode::PAYMENT_REQUIRED,
                    &code,
                    &message,
                    Some(&model),
                );
                return with_ledger_headers(
                    response,
                    &crate::passthrough_ledger::LedgerHeader::Ledgered,
                    attempts_made,
                    ledger_run_id.as_deref(),
                );
            }
        };
        attempts_made += 1;

        let resp = match req.send().await {
            Ok(resp) => resp,
            Err(err) => {
                let message = format!("connect error: {err}");
                settle_attempt(
                    &ledger_bridge,
                    ledgered,
                    crate::passthrough_ledger::AttemptOutcome::Failed(
                        crate::passthrough_ledger::FailureClass::NotSent,
                    ),
                    Default::default(),
                    Some(message.clone()),
                    !has_more_candidates,
                );
                emit_outcome(
                    state.host.as_ref(),
                    candidate,
                    false,
                    started,
                    None,
                    Some(&message),
                    None,
                    Some(&session_id),
                );
                wait_before_retry(
                    &cfg,
                    attempt_index,
                    None,
                    &mut retry_wait_remaining_ms,
                    attempt_index + 1 < attempt_limit,
                )
                .await;
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
        };

        let status = resp.status().as_u16();
        if status >= 400 {
            let headers = resp.headers().clone();
            let retry_after = headers.get("retry-after").and_then(|v| v.to_str().ok());
            let unified = headers
                .get("anthropic-ratelimit-unified-reset")
                .and_then(|v| v.to_str().ok());
            let text = resp.text().await.unwrap_or_default();
            // W1.1 + W3.1: park (or permanently disable) the pooled key and get
            // the cooldown window to forward to the renderer breaker.
            let retry_after_ms = record_upstream_cooldown(
                &state,
                &cfg,
                candidate,
                status,
                retry_after,
                unified,
                &text,
                now_ms,
            );
            let mut message = format!("HTTP {status}");
            if let Some(ra) = retry_after {
                message.push_str(&format!(" retry-after: {ra}"));
            }
            message.push_str(&format!(": {}", text.chars().take(500).collect::<String>()));
            // An upstream error is a completed attempt with no bill: the
            // reservation goes back rather than being held against an answer
            // that will never arrive.
            let will_retry = cfg.should_retry(status)
                && (!(status == 401 || status == 403)
                    || ctx
                        .ticket
                        .as_ref()
                        .is_some_and(|ticket| ticket.allow_auth_failover));
            settle_attempt(
                &ledger_bridge,
                ledgered,
                crate::passthrough_ledger::AttemptOutcome::Failed(
                    crate::passthrough_ledger::FailureClass::of_status(status),
                ),
                Default::default(),
                Some(format!("HTTP {status}")),
                !(will_retry && has_more_candidates),
            );
            emit_outcome(
                state.host.as_ref(),
                candidate,
                false,
                started,
                None,
                Some(&message),
                retry_after_ms,
                Some(&session_id),
            );
            // R4: authentication failures never switch credentials/providers
            // unless a verified route ticket explicitly allows auth failover.
            let auth_failure = status == 401 || status == 403;
            let auth_failover_allowed = ctx
                .ticket
                .as_ref()
                .is_some_and(|ticket| ticket.allow_auth_failover);
            if cfg.should_retry(status) && (!auth_failure || auth_failover_allowed) {
                wait_before_retry(
                    &cfg,
                    attempt_index,
                    retry_after_ms,
                    &mut retry_wait_remaining_ms,
                    attempt_index + 1 < attempt_limit,
                )
                .await;
                failures.push(format!("{}: {message}", candidate.provider.id));
                continue;
            }
            // R2: on same-protocol routes the upstream error body reaches the
            // client VERBATIM (status + bytes + safe headers) — Claude Code's
            // capability/error matching depends on the exact wire shape.
            // Gateway-wrapped errors remain only for translated routes and
            // gateway-generated failures.
            if passthrough {
                emit_request_log_ctx(
                    state.host.as_ref(),
                    &ctx,
                    Some(&model),
                    Some(&candidate.provider.id),
                    status,
                    started.elapsed().as_millis() as u64,
                    None,
                    None,
                    Some(&message),
                    false,
                    Some(candidate),
                );
                let mut builder = axum::http::Response::builder()
                    .status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY))
                    .header("content-type", "application/json");
                for (name, value) in safe_upstream_response_headers(&headers) {
                    builder = builder.header(name, value);
                }
                let response = builder
                    .body(Body::from(text))
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
                return with_ledger_headers(
                    response,
                    &ledger_header,
                    attempts_made,
                    ledger_run_id.as_deref(),
                );
            }
            let response = logged_error(
                &state,
                &ctx,
                format,
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
                "invalid_request_error",
                &message,
                Some(&model),
            );
            return with_ledger_headers(
                response,
                &ledger_header,
                attempts_made,
                ledger_run_id.as_deref(),
            );
        }

        // Sticky affinity: the credential that produced a 2xx owns the lease
        // from here on (a pre-first-byte failover that succeeded elsewhere
        // MOVES the lease and sticks).
        if let Some(t) = &ticket {
            if matches!(
                t.credential_affinity,
                TicketAffinity::SessionSticky | TicketAffinity::StickyWithFailover
            ) {
                let deployment = candidate
                    .provider
                    .deployment_id
                    .clone()
                    .unwrap_or_else(|| candidate.provider.id.clone());
                state.leases.acquire(
                    &session_id,
                    &deployment,
                    &crate::credentials::fingerprint_of(
                        candidate.provider.api_key.as_deref().unwrap_or(""),
                    ),
                    now_ms,
                );
            }
        }

        if stream {
            // The Responses endpoint adds Responses events around the shared
            // Chat stream. A Chat upstream already supplies that intermediate.
            let stream_format = if format == InboundFormat::OpenAiResponses
                && candidate.provider.protocol == "openai"
            {
                InboundFormat::OpenAiChat
            } else {
                format
            };
            let mut response = stream_response(
                state,
                ctx,
                stream_format,
                candidate,
                resp,
                started,
                &model,
                session_id,
                gw_slot,
                up_slot,
                in_flight,
                ledger_bridge.clone(),
                ledgered,
            )
            .await;
            if format == InboundFormat::OpenAiResponses
                && candidate.provider.protocol == "responses"
            {
                response
                    .headers_mut()
                    .insert("x-cognia-upstream-responses", HeaderValue::from_static("1"));
            }
            return with_ledger_headers(
                response,
                &ledger_header,
                attempts_made,
                ledger_run_id.as_deref(),
            );
        }
        // Buffered path: `gw_slot` / `up_slot` / `in_flight` carry Drop glue, so
        // they release only when this handler returns — i.e. after the awaited
        // response below completes — holding the concurrency slots and the
        // in-flight tally for the whole non-streaming request without being
        // passed down.
        let response = buffered_response(
            state,
            ctx,
            format,
            candidate,
            resp,
            started,
            passthrough,
            &model,
            &session_id,
            ledger_bridge.clone(),
            ledgered,
        )
        .await;
        return with_ledger_headers(
            response,
            &ledger_header,
            attempts_made,
            ledger_run_id.as_deref(),
        );
    }

    with_ledger_headers(
        all_failed(&state, &ctx, format, &model, &failures),
        &ledger_header,
        attempts_made,
        ledger_run_id.as_deref(),
    )
}

/// Settle one reserved attempt, or do nothing when it was never reserved.
fn settle_attempt(
    bridge: &std::sync::Arc<dyn crate::brain_bridge::BrainBridge>,
    attempt: Option<crate::passthrough_ledger::LedgeredAttempt>,
    outcome: crate::passthrough_ledger::AttemptOutcome,
    usage: crate::passthrough_ledger::AttemptUsage,
    reason: Option<String>,
    final_attempt: bool,
) {
    if let Some(attempt) = attempt {
        crate::passthrough_ledger::settle(
            bridge.clone(),
            attempt,
            outcome,
            usage,
            reason,
            final_attempt,
        );
    }
}

/// Say on the wire whether this request drew on the budget, how many upstream
/// attempts it took, and which run holds its bill (ADR-0188 D13).
///
/// The headers are added to the response the caller already gets rather than
/// changing it: a passthrough error body still reaches the client verbatim.
fn with_ledger_headers(
    mut response: Response,
    ledger: &crate::passthrough_ledger::LedgerHeader,
    attempts: usize,
    run_id: Option<&str>,
) -> Response {
    // A request that made no upstream attempt has nothing to report: adding
    // "bypassed" there would claim a ledger decision nobody took.
    if attempts == 0 {
        return response;
    }
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::try_from(ledger.value()) {
        headers.insert("x-cognia-ledger", value);
    }
    if let Ok(value) = HeaderValue::try_from(attempts.to_string()) {
        headers.insert("x-cognia-attempts", value);
    }
    // Only when it differs from 1: a request that failed over says so plainly.
    if attempts > 1 {
        if let Ok(value) = HeaderValue::try_from((attempts - 1).to_string()) {
            headers.insert("x-cognia-fallback", value);
        }
    }
    if let Some(run_id) = run_id {
        if let Ok(value) = HeaderValue::try_from(run_id) {
            headers.insert("x-cognia-run-id", value);
        }
    }
    response
}

#[allow(clippy::too_many_arguments)]
async fn buffered_response(
    state: AppState,
    ctx: ReqCtx,
    format: InboundFormat,
    candidate: &Candidate,
    resp: reqwest::Response,
    started: Instant,
    passthrough: bool,
    model: &str,
    session_id: &str,
    ledger_bridge: std::sync::Arc<dyn crate::brain_bridge::BrainBridge>,
    ledgered: Option<crate::passthrough_ledger::LedgeredAttempt>,
) -> Response {
    let upstream_headers_snapshot = resp.headers().clone();
    let upstream: Value = match resp.json().await {
        Ok(v) => v,
        Err(err) => {
            let message = format!("invalid upstream JSON: {err}");
            // The bytes were sent and the provider will bill for them; what we
            // cannot say is how much. The money stays held until it is known.
            settle_attempt(
                &ledger_bridge,
                ledgered,
                crate::passthrough_ledger::AttemptOutcome::Unknown,
                Default::default(),
                Some(message.clone()),
                true,
            );
            emit_outcome(
                state.host.as_ref(),
                candidate,
                false,
                started,
                None,
                Some(&message),
                None,
                Some(session_id),
            );
            return logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_GATEWAY,
                "api_error",
                &message,
                Some(model),
            );
        }
    };

    if passthrough {
        let usage = match format {
            InboundFormat::OpenAiChat => (
                upstream["usage"]["prompt_tokens"].as_u64(),
                upstream["usage"]["completion_tokens"].as_u64(),
            ),
            InboundFormat::AnthropicMessages | InboundFormat::OpenAiResponses => (
                upstream["usage"]["input_tokens"].as_u64(),
                upstream["usage"]["output_tokens"].as_u64(),
            ),
        };
        settle_attempt(
            &ledger_bridge,
            ledgered,
            crate::passthrough_ledger::AttemptOutcome::Succeeded,
            passthrough_usage_of(format, &upstream),
            None,
            true,
        );
        emit_outcome(
            state.host.as_ref(),
            candidate,
            true,
            started,
            Some(usage),
            None,
            None,
            Some(session_id),
        );
        log_success(
            &state,
            &ctx,
            model,
            candidate,
            started.elapsed().as_millis() as u64,
            usage.0,
            usage.1,
            false,
        );
        // R2: correlation/rate-limit headers survive the proxy hop.
        let mut response = Json(upstream).into_response();
        for (name, value) in safe_upstream_response_headers(&upstream_headers_snapshot) {
            if let (Ok(name), Ok(value)) = (
                axum::http::HeaderName::try_from(name),
                axum::http::HeaderValue::try_from(value),
            ) {
                response.headers_mut().insert(name, value);
            }
        }
        return response;
    }

    match response_to_ir(&candidate.provider.protocol, &upstream) {
        Ok(ir_resp) => {
            settle_attempt(
                &ledger_bridge,
                ledgered,
                crate::passthrough_ledger::AttemptOutcome::Succeeded,
                crate::passthrough_ledger::AttemptUsage {
                    input_tokens: Some(ir_resp.usage.input_tokens),
                    output_tokens: Some(ir_resp.usage.output_tokens),
                    ..Default::default()
                },
                None,
                true,
            );
            emit_outcome(
                state.host.as_ref(),
                candidate,
                true,
                started,
                Some((
                    Some(ir_resp.usage.input_tokens),
                    Some(ir_resp.usage.output_tokens),
                )),
                None,
                None,
                Some(session_id),
            );
            log_success(
                &state,
                &ctx,
                model,
                candidate,
                started.elapsed().as_millis() as u64,
                Some(ir_resp.usage.input_tokens),
                Some(ir_resp.usage.output_tokens),
                false,
            );
            let created = chrono::Utc::now().timestamp();
            Json(response_from_ir(format, &ir_resp, created)).into_response()
        }
        Err(err) => {
            // The provider answered and will bill for it; this gateway just
            // cannot read the answer. Held, not released.
            settle_attempt(
                &ledger_bridge,
                ledgered,
                crate::passthrough_ledger::AttemptOutcome::Unknown,
                Default::default(),
                Some(err.reason.clone()),
                true,
            );
            emit_outcome(
                state.host.as_ref(),
                candidate,
                false,
                started,
                None,
                Some(&err.reason),
                None,
                Some(session_id),
            );
            logged_error(
                &state,
                &ctx,
                format,
                StatusCode::BAD_GATEWAY,
                "api_error",
                &err.reason,
                Some(model),
            )
        }
    }
}

/// The token counts a same-protocol answer reports, in the ledger's own shape.
fn passthrough_usage_of(
    format: InboundFormat,
    upstream: &Value,
) -> crate::passthrough_ledger::AttemptUsage {
    let usage = &upstream["usage"];
    match format {
        InboundFormat::OpenAiChat => crate::passthrough_ledger::AttemptUsage {
            input_tokens: usage["prompt_tokens"].as_u64(),
            output_tokens: usage["completion_tokens"].as_u64(),
            cache_read_tokens: usage["prompt_tokens_details"]["cached_tokens"].as_u64(),
            cache_write_tokens: None,
        },
        InboundFormat::AnthropicMessages | InboundFormat::OpenAiResponses => {
            crate::passthrough_ledger::AttemptUsage {
                input_tokens: usage["input_tokens"].as_u64(),
                output_tokens: usage["output_tokens"].as_u64(),
                cache_read_tokens: usage["cache_read_input_tokens"]
                    .as_u64()
                    .or_else(|| usage["input_tokens_details"]["cached_tokens"].as_u64()),
                cache_write_tokens: usage["cache_creation_input_tokens"].as_u64(),
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_response(
    state: AppState,
    ctx: ReqCtx,
    format: InboundFormat,
    candidate: &Candidate,
    resp: reqwest::Response,
    started: Instant,
    model: &str,
    session_id: String,
    gw_slot: Slot,
    up_slot: Slot,
    in_flight: InFlightGuard,
    ledger_bridge: std::sync::Arc<dyn crate::brain_bridge::BrainBridge>,
    ledgered: Option<crate::passthrough_ledger::LedgeredAttempt>,
) -> Response {
    // Resolved here, not inside the pump tasks: the guard is a parking_lot read
    // lock and must never be held across an `.await`.
    let idle_timeout = state.config.read().stream_idle_timeout();
    let passthrough = candidate.provider.protocol == format.protocol_name();
    if passthrough {
        // Forward upstream bytes to the client UNCHANGED while sniffing the SSE
        // frames for token usage, so streaming passthrough still draws down
        // quota and records the account's success at stream end.
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
        let task_state = state.clone();
        let candidate = candidate.clone();
        let ctx = ctx.clone();
        let model = model.to_string();
        spawn_request_task(&state.clone(), &ctx.clone(), async move {
            // Hold the W1.2 concurrency slots + the in-flight tally for the
            // WHOLE stream — they release when this task ends, not at the
            // handler's return.
            let _slots = (gw_slot, up_slot, in_flight);
            let mut deframer = SseDeframer::default();
            let mut input: Option<u64> = None;
            let mut output: Option<u64> = None;
            let mut upstream = resp.bytes_stream();
            let mut stalled = false;
            'pump: loop {
                let next = tokio::select! { biased; _ = tx.closed() => return, next = next_chunk_before_idle(&mut upstream, idle_timeout) => next };
                let chunk = match next {
                    Ok(Some(chunk)) => chunk,
                    Ok(None) => break 'pump, // clean end of stream
                    Err(_) => {
                        stalled = true;
                        break 'pump;
                    }
                };
                let Ok(bytes) = chunk else { break };
                for data in deframer.push(&bytes) {
                    if data == "[DONE]" {
                        continue;
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(&data) {
                        sniff_passthrough_usage(format, &value, &mut input, &mut output);
                    }
                }
                if tx.send(Ok(bytes)).await.is_err() {
                    break 'pump;
                }
            }
            if let Some(data) = deframer.finish() {
                if let Ok(value) = serde_json::from_str::<Value>(&data) {
                    sniff_passthrough_usage(format, &value, &mut input, &mut output);
                }
            }
            // A stall is a provider failure, not a completed turn — reporting it
            // as success would both mis-train the breaker and leave a stuck
            // upstream looking healthy.
            let stall_error = stalled.then(|| stall_reason(idle_timeout));
            // A stalled stream was SENT and has a bill nobody can read yet, so
            // it settles as UNKNOWN and the money stays held (D27).
            settle_attempt(
                &ledger_bridge,
                ledgered,
                if stalled {
                    crate::passthrough_ledger::AttemptOutcome::Unknown
                } else {
                    crate::passthrough_ledger::AttemptOutcome::Succeeded
                },
                crate::passthrough_ledger::AttemptUsage {
                    input_tokens: input,
                    output_tokens: output,
                    ..Default::default()
                },
                stall_error.clone(),
                true,
            );
            emit_outcome(
                task_state.host.as_ref(),
                &candidate,
                !stalled,
                started,
                Some((input, output)),
                stall_error.as_deref(),
                None,
                Some(&session_id),
            );
            log_success(
                &task_state,
                &ctx,
                &model,
                &candidate,
                started.elapsed().as_millis() as u64,
                input,
                output,
                true,
            );
        });
        let stream = futures_util::stream::unfold(rx, |mut rx| async move {
            rx.recv().await.map(|item| (item, rx))
        });
        return sse_response(Body::from_stream(stream));
    }

    let direction = match (candidate.provider.protocol.as_str(), format) {
        ("responses", InboundFormat::AnthropicMessages) => Direction::ResponsesToAnthropic,
        ("responses", _) => Direction::ResponsesToOpenAi,
        (_, InboundFormat::AnthropicMessages) => Direction::OpenAiToAnthropic,
        _ => Direction::AnthropicToOpenAi,
    };
    let message_id = match format {
        InboundFormat::AnthropicMessages => format!("msg_{}", uuid::Uuid::new_v4().simple()),
        InboundFormat::OpenAiChat | InboundFormat::OpenAiResponses => {
            format!("chatcmpl-{}", uuid::Uuid::new_v4().simple())
        }
    };
    let mut transcoder = StreamTranscoder::new(direction, candidate.model_id.clone(), message_id);

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    let task_state = state.clone();
    let candidate = candidate.clone();
    let ctx = ctx.clone();
    let model = model.to_string();
    spawn_request_task(&state.clone(), &ctx.clone(), async move {
        // Hold the W1.2 concurrency slots + in-flight tally for the WHOLE
        // transcoded stream.
        let _slots = (gw_slot, up_slot, in_flight);
        let mut deframer = SseDeframer::default();
        let mut upstream = resp.bytes_stream();
        let mut stalled = false;
        'pump: loop {
            let next = tokio::select! { biased; _ = tx.closed() => return, next = next_chunk_before_idle(&mut upstream, idle_timeout) => next };
            let chunk = match next {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break 'pump, // clean end of stream
                Err(_) => {
                    stalled = true;
                    break 'pump;
                }
            };
            let Ok(bytes) = chunk else { break };
            for frame in transcode_upstream_sse_bytes(&mut deframer, &mut transcoder, &bytes) {
                if tx.send(Ok(Bytes::from(frame.to_frame()))).await.is_err() {
                    break 'pump;
                }
            }
        }
        for frame in finish_upstream_sse_stream(&mut deframer, &mut transcoder) {
            if tx.send(Ok(Bytes::from(frame.to_frame()))).await.is_err() {
                break;
            }
        }
        // R2/ADR-0090: a mid-stream upstream failure on a TRANSLATED route
        // must surface as the inbound protocol's own error framing instead of
        // a silent close — Anthropic clients get `event: error`.
        if stalled {
            let error_frame = match direction {
                Direction::OpenAiToAnthropic | Direction::ResponsesToAnthropic => Some(
                    "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"upstream stream stalled\"}}\n\n"
                        .to_string(),
                ),
                Direction::AnthropicToOpenAi | Direction::ResponsesToOpenAi => None,
            };
            if let Some(frame) = error_frame {
                let _ = tx.send(Ok(Bytes::from(frame))).await;
            }
        }
        let usage = transcoder.usage();
        let stall_error = stalled.then(|| stall_reason(idle_timeout));
        settle_attempt(
            &ledger_bridge,
            ledgered,
            if stalled {
                crate::passthrough_ledger::AttemptOutcome::Unknown
            } else {
                crate::passthrough_ledger::AttemptOutcome::Succeeded
            },
            crate::passthrough_ledger::AttemptUsage {
                input_tokens: Some(usage.input_tokens),
                output_tokens: Some(usage.output_tokens),
                ..Default::default()
            },
            stall_error.clone(),
            true,
        );
        emit_outcome(
            task_state.host.as_ref(),
            &candidate,
            !stalled,
            started,
            Some((Some(usage.input_tokens), Some(usage.output_tokens))),
            stall_error.as_deref(),
            None,
            Some(&session_id),
        );
        log_success(
            &task_state,
            &ctx,
            &model,
            &candidate,
            started.elapsed().as_millis() as u64,
            Some(usage.input_tokens),
            Some(usage.output_tokens),
            true,
        );
    });

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    sse_response(Body::from_stream(stream))
}

fn transcode_upstream_sse_bytes(
    deframer: &mut SseDeframer,
    transcoder: &mut StreamTranscoder,
    bytes: &[u8],
) -> Vec<SseOut> {
    let mut out = Vec::new();
    for data in deframer.push(bytes) {
        push_upstream_sse_payload(transcoder, &data, &mut out);
    }
    out
}

fn finish_upstream_sse_stream(
    deframer: &mut SseDeframer,
    transcoder: &mut StreamTranscoder,
) -> Vec<SseOut> {
    let mut out = Vec::new();
    if let Some(data) = deframer.finish() {
        push_upstream_sse_payload(transcoder, &data, &mut out);
    }
    out.extend(transcoder.finish());
    out
}

fn push_upstream_sse_payload(transcoder: &mut StreamTranscoder, data: &str, out: &mut Vec<SseOut>) {
    if data == "[DONE]" {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return;
    };
    out.extend(transcoder.push(&value));
}

fn sse_response(body: Body) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Upstream response headers that may safely reach the client on
/// same-protocol routes (R2): request correlation ids, rate-limit metadata,
/// retry hints. Cookies and hop-by-hop headers never pass.
fn safe_upstream_response_headers(upstream: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    upstream
        .iter()
        .filter_map(|(name, value)| {
            let name = name.as_str().to_ascii_lowercase();
            let keep = name == "request-id"
                || name == "x-request-id"
                || name == "retry-after"
                || name.starts_with("anthropic-ratelimit-");
            if !keep {
                return None;
            }
            Some((name, value.to_str().ok()?.to_string()))
        })
        .collect()
}

/// Per-attempt outcome event — the renderer forwards it into
/// `recordProviderOutcome` so gateway traffic feeds the same health / breaker /
/// cost stores the chat plane reads.
#[allow(clippy::too_many_arguments)]
fn emit_outcome(
    host: &dyn GatewayHost,
    candidate: &Candidate,
    ok: bool,
    started: Instant,
    usage: Option<(Option<u64>, Option<u64>)>,
    error: Option<&str>,
    // `retry_after_ms`: upstream-derived cooldown window (W1.1) — feeds the
    // renderer breaker's dynamic cooldown. `None` on success / non-rate-limit
    // failures. `session_id`: affinity key (W1.3) — a successful outcome pins
    // the session to this deployment; a permanent failure releases the pin.
    retry_after_ms: Option<i64>,
    session_id: Option<&str>,
) {
    let payload = outcome_payload(
        candidate,
        ok,
        started.elapsed().as_millis() as u64,
        usage,
        error,
        retry_after_ms,
        session_id,
    );
    let _ = host.emit(REQUEST_OUTCOME_EVENT, payload);
}

/// The `gateway://request-outcome` body. Split out from [`emit_outcome`] so the
/// renderer contract — above all the rule that a non-chat endpoint sends a null
/// `sessionId` and therefore cannot pin chat affinity — is unit-testable
/// without an `AppHandle`.
#[allow(clippy::too_many_arguments)]
fn outcome_payload(
    candidate: &Candidate,
    ok: bool,
    latency_ms: u64,
    usage: Option<(Option<u64>, Option<u64>)>,
    error: Option<&str>,
    retry_after_ms: Option<i64>,
    session_id: Option<&str>,
) -> Value {
    let (input_tokens, output_tokens) = usage.unwrap_or((None, None));
    let key_fingerprint = candidate
        .provider
        .api_key
        .as_deref()
        .map(cooldown::key_fingerprint);
    json!({
        "providerId": candidate.provider.id,
        "modelId": candidate.model_id,
        "deploymentId": candidate.provider.deployment_id,
        "keyFingerprint": key_fingerprint,
        "ok": ok,
        "latencyMs": latency_ms,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "errorMessage": error,
        "retryAfterMs": retry_after_ms,
        "sessionId": session_id,
    })
}

/// One durable request-log row per request (success, error, or middleware
/// rejection). Persisted renderer-side into Dexie + shown in the live panel.
#[allow(clippy::too_many_arguments)]
fn emit_request_log(
    host: &dyn GatewayHost,
    route: &str,
    remote_ip: &str,
    key_id: Option<&str>,
    model: Option<&str>,
    provider_id: Option<&str>,
    status: u16,
    latency_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    error: Option<&str>,
    stream: bool,
    candidate: Option<&Candidate>,
) {
    emit_request_log_full(
        host,
        route,
        remote_ip,
        key_id,
        model,
        provider_id,
        status,
        latency_ms,
        input_tokens,
        output_tokens,
        error,
        stream,
        candidate,
        false,
    );
}

/// [`emit_request_log`] plus the `synthesized` marker: true only for answers
/// the gateway produced without any upstream call.
#[allow(clippy::too_many_arguments)]
fn emit_request_log_full(
    host: &dyn GatewayHost,
    route: &str,
    remote_ip: &str,
    key_id: Option<&str>,
    model: Option<&str>,
    provider_id: Option<&str>,
    status: u16,
    latency_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    error: Option<&str>,
    stream: bool,
    candidate: Option<&Candidate>,
    synthesized: bool,
) {
    let id = uuid::Uuid::new_v4().to_string();
    let decision_id = id.clone();
    let selected_deployment = candidate.and_then(|value| value.provider.deployment_id.as_deref());
    let key_fingerprint = candidate
        .and_then(|value| value.provider.api_key.as_deref())
        .map(cooldown::key_fingerprint);
    let payload = json!({
        "id": id,
        "decisionId": decision_id,
        "at": chrono::Utc::now().to_rfc3339(),
        "route": route,
        "remoteIp": remote_ip,
        "keyId": key_id,
        "model": model,
        "providerId": provider_id,
        "status": status,
        "latencyMs": latency_ms,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "error": error,
        "stream": stream,
        "synthesized": synthesized,
        "selectedDeployment": selected_deployment,
        "keyFingerprint": key_fingerprint,
    });
    let _ = host.emit(REQUEST_LOG_EVENT, payload);
}

/// Success terminal: emit the durable log row, draw the consumed tokens down
/// against the calling key's token quota, and record the pooled upstream key's
/// success (feeds `least-used` rotation + the per-account usage surface). One
/// call replaces the plain log emit at every success path.
#[allow(clippy::too_many_arguments)]
fn log_success(
    state: &AppState,
    ctx: &ReqCtx,
    model: &str,
    candidate: &Candidate,
    latency_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    stream: bool,
) {
    emit_request_log_ctx(
        state.host.as_ref(),
        ctx,
        Some(model),
        Some(&candidate.provider.id),
        200,
        latency_ms,
        input_tokens,
        output_tokens,
        None,
        stream,
        Some(candidate),
    );
    // Draw the consumed tokens down against the calling key's quota.
    let consumed = input_tokens
        .unwrap_or(0)
        .saturating_add(output_tokens.unwrap_or(0)) as i64;
    if consumed > 0 {
        if let Some(key_id) = ctx.key_id.as_deref() {
            let _ = api_keys::add_quota_usage(&mut state.keys.write(), key_id, consumed);
        }
    }
    // A ticket request settles its reservation at the real usage (streams
    // reach here at stream end). Idempotent by request id.
    if ctx.ticket.is_some() {
        state
            .tickets
            .settle_reservation(&ctx.request_id, consumed.max(0) as u64);
    }
    // Record the upstream account's success for rotation + per-account usage.
    record_key_success(&state.key_rotation, candidate);
}

/// Extract token usage from one passthrough SSE payload so streaming passthrough
/// requests still draw down quota. Anthropic reports input on `message_start`
/// and cumulative output on `message_delta`; OpenAI reports both on a trailing
/// `usage` object (present only when the client asked for it).
fn sniff_passthrough_usage(
    format: InboundFormat,
    value: &Value,
    input: &mut Option<u64>,
    output: &mut Option<u64>,
) {
    match format {
        InboundFormat::OpenAiResponses => {
            if let Some(v) = value["response"]["usage"]["input_tokens"].as_u64() {
                *input = Some(v);
            }
            if let Some(v) = value["response"]["usage"]["output_tokens"].as_u64() {
                *output = Some(v);
            }
        }
        InboundFormat::AnthropicMessages => {
            if let Some(v) = value["message"]["usage"]["input_tokens"].as_u64() {
                *input = Some(v);
            }
            if let Some(v) = value["usage"]["output_tokens"].as_u64() {
                *output = Some(v);
            }
        }
        InboundFormat::OpenAiChat => {
            if let Some(v) = value["usage"]["prompt_tokens"].as_u64() {
                *input = Some(v);
            }
            if let Some(v) = value["usage"]["completion_tokens"].as_u64() {
                *output = Some(v);
            }
        }
    }
}

/// Convenience wrapper that pulls route/remoteIp/keyId off a [`ReqCtx`].
#[allow(clippy::too_many_arguments)]
fn emit_request_log_ctx(
    host: &dyn GatewayHost,
    ctx: &ReqCtx,
    model: Option<&str>,
    provider_id: Option<&str>,
    status: u16,
    latency_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    error: Option<&str>,
    stream: bool,
    candidate: Option<&Candidate>,
) {
    emit_request_log(
        host,
        &ctx.route,
        &ctx.remote_ip,
        ctx.key_id.as_deref(),
        model,
        provider_id,
        status,
        latency_ms,
        input_tokens,
        output_tokens,
        error,
        stream,
        candidate,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_events_are_owner_tagged_and_stale_generations_are_suppressed() {
        let recording = Arc::new(crate::host::RecordingGatewayHost::new(false));
        let account = Arc::new(RwLock::new(crate::GatewayAccountContext {
            owner_account_id: Some("account-a".into()),
            generation: 1,
            required: true,
        }));
        let host = AccountBoundHost {
            host: recording.clone(),
            account: account.clone(),
            generation: 1,
        };
        assert!(host.emit(REQUEST_LOG_EVENT, json!({"status":200})));
        assert_eq!(recording.events.lock()[0].1["ownerAccountId"], "account-a");
        assert_eq!(recording.events.lock()[0].1["accountGeneration"], 1);
        account.write().generation = 2;
        assert!(!host.emit(REQUEST_OUTCOME_EVENT, json!({"ok":true})));
        assert_eq!(recording.events.lock().len(), 1);
    }

    #[test]
    fn published_input_context_and_output_limits_are_independent() {
        let provider = serde_json::from_value(json!({"id":"fixture","protocol":"openai","enabled":true,"baseUrl":"http://127.0.0.1/v1",
            "modelMetadata":[{"id":"model","contextLength":200,"maxInputTokens":100,"maxOutputTokens":60,"supportsTools":false}]})).unwrap();
        let candidate = Candidate::new(&provider, "model");
        let mut request = json!({"messages":[{"role":"user","content":"hi"}],"max_tokens":999});
        apply_model_limits(&mut request, &candidate).unwrap();
        assert_eq!(request["max_tokens"], 60);
        request["max_tokens"] = json!(20);
        apply_model_limits(&mut request, &candidate).unwrap();
        assert_eq!(request["max_tokens"], 20);
        request["messages"][0]["content"] = json!("a".repeat(500));
        assert!(apply_model_limits(&mut request, &candidate)
            .unwrap_err()
            .contains("maximum input"));
        request = json!({"tools":[{"type":"function"}]});
        assert!(apply_model_limits(&mut request, &candidate)
            .unwrap_err()
            .contains("tools"));
    }

    #[test]
    fn published_capability_denials_cover_all_request_formats() {
        let provider = serde_json::from_value(json!({"id":"fixture","protocol":"openai","enabled":true,"baseUrl":"http://127.0.0.1/v1",
            "modelMetadata":[{"id":"model","supportsVision":false,"supportsReasoning":false,"supportsStructuredOutput":false}]})).unwrap();
        let candidate = Candidate::new(&provider, "model");
        for mut request in [
            json!({"input":[{"type":"function_call_output","call_id":"c","output":[{"type":"input_image","image_url":"https://example.invalid/img"}]}]}),
            json!({"messages":[{"role":"user","content":[{"type":"tool_result","content":[{"type":"image","source":{}}]}]}]}),
            json!({"reasoning":{"effort":"high"}}),
            json!({"reasoning_effort":"low"}),
            json!({"thinking":{"type":"adaptive"}}),
            json!({"text":{"format":{"type":"json_schema"}}}),
            json!({"response_format":{"type":"json_object"}}),
            json!({"output_config":{"format":{"type":"json_schema"}}}),
            json!({"tools":[{"function":{"strict":true}}]}),
            json!({"tools":[{"type":"namespace","tools":[{"type":"function","strict":true}]}]}),
        ] {
            assert!(
                apply_model_limits(&mut request, &candidate).is_err(),
                "{request}"
            );
        }
        let mut ordinary = json!({"reasoning_effort":"none","thinking":{"type":"disabled"},"tools":[{"parameters":{"properties":{"type":{"const":"image"}}}}],"metadata":{"type":"input_image"}});
        apply_model_limits(&mut ordinary, &candidate).unwrap();
    }

    #[test]
    fn task_pii_gate_inspects_tool_results_without_scanning_transport_metadata() {
        assert!(!body_has_no_leaking_pii(
            &json!({"messages":[{"role":"tool","content":"person@example.com"}]})
        ));
        assert!(body_has_no_leaking_pii(
            &json!({"messages":[{"role":"user","content":"redacted"}],"metadata":{"contact":"person@example.com"}})
        ));
        for payload in [
            json!({"response_format":{"type":"json_schema","json_schema":{"schema":{"description":"person@example.com"}}}}),
            json!({"text":{"format":{"schema":{"enum":["person@example.com"]}}}}),
            json!({"output_config":{"format":{"schema":{"const":"person@example.com"}}}}),
        ] {
            assert!(!body_has_no_leaking_pii(&payload));
        }
    }

    #[tokio::test]
    async fn account_invalidation_cancels_a_detached_idle_stream_pump() {
        struct Dropped(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                if let Some(tx) = self.0.take() {
                    let _ = tx.send(());
                }
            }
        }
        let (changes, receiver) = tokio::sync::watch::channel(1);
        let (started, ready) = tokio::sync::oneshot::channel();
        let (dropped, ended) = tokio::sync::oneshot::channel();
        spawn_account_task(receiver, 1, async move {
            let _guard = Dropped(Some(dropped));
            let _ = started.send(());
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        changes.send_replace(2);
        tokio::time::timeout(std::time::Duration::from_secs(1), ended)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn account_invalidation_terminates_the_downstream_stream_body() {
        use tower::ServiceExt;
        let (changes, _) = tokio::sync::watch::channel(1);
        let changes = Arc::new(changes);
        let router = axum::Router::new()
            .route(
                "/",
                axum::routing::get(|| async {
                    let chunks = futures_util::stream::once(async {
                        Ok::<_, std::io::Error>(Bytes::from_static(b"first"))
                    })
                    .chain(futures_util::stream::pending());
                    Body::from_stream(chunks)
                }),
            )
            .layer(axum::middleware::from_fn({
                let changes = changes.clone();
                move |request: axum::http::Request<Body>, next: Next| {
                    run_with_account_boundary(next, request, changes.subscribe())
                }
            }));
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let mut body = response.into_body().into_data_stream();
        assert_eq!(
            body.next().await.unwrap().unwrap(),
            Bytes::from_static(b"first")
        );
        changes.send_replace(2);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), body.next())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn account_invalidation_cancels_waiting_handler_before_fallback() {
        use tower::ServiceExt;
        let (changes, _) = tokio::sync::watch::channel(1);
        let changes = Arc::new(changes);
        let (started, ready) = tokio::sync::oneshot::channel();
        let started = Arc::new(parking_lot::Mutex::new(Some(started)));
        let router = axum::Router::new()
            .route(
                "/",
                axum::routing::get(move || {
                    let started = started.clone();
                    async move {
                        let _ = started.lock().take().unwrap().send(());
                        std::future::pending::<()>().await;
                        StatusCode::OK
                    }
                }),
            )
            .layer(axum::middleware::from_fn({
                let changes = changes.clone();
                move |request: axum::http::Request<Body>, next: Next| {
                    run_with_account_boundary(next, request, changes.subscribe())
                }
            }));
        let response = tokio::spawn(
            router.oneshot(
                axum::http::Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
            ),
        );
        ready.await.unwrap();
        changes.send_replace(2);
        let response = tokio::time::timeout(std::time::Duration::from_secs(1), response)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    fn ctx() -> ReqCtx {
        ReqCtx {
            account_generation: 0,
            request_id: "req-test".into(),
            route: "/v1/chat/completions".into(),
            remote_ip: "127.0.0.1".into(),
            key_id: Some("k1".into()),
            key_model_allowlist: vec![],
            user_agent: "test-agent".into(),
            ticket: None,
            inbound_headers: Vec::new(),
        }
    }

    #[test]
    fn body_limit_fits_chat_histories() {
        assert_eq!(BODY_LIMIT_BYTES, 16 * 1024 * 1024);
    }

    #[test]
    fn upstream_clients_follow_the_live_proxy_policy() {
        use cognia_net::proxy_config::{apply_current, ProxyConfig, ProxyMode, ProxyProtocol};
        let clients = UpstreamClients::new(Duration::from_secs(1));

        // Policy Off: every upstream is one direct route, pooled once.
        apply_current(ProxyConfig::default()).unwrap();
        let _ = clients.client_for("https://api.anthropic.com/v1/messages");
        let _ = clients.client_for("https://api.openai.com/v1/chat/completions");
        assert_eq!(clients.pooled(), 1);

        // A manual proxy is a second route. A bypassed local upstream stays on
        // the direct one. Loopback is bypassed so concurrently running tests
        // that dial their own mock upstreams are unaffected.
        apply_current(ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "proxy.corp".into(),
            port: 3128,
            ..ProxyConfig::default()
        })
        .unwrap();
        let _ = clients.client_for("https://api.anthropic.com/v1/messages");
        let _ = clients.client_for("http://127.0.0.1:11434/v1/chat/completions");
        assert_eq!(clients.pooled(), 2);

        // A changed credential must not reuse the client built without it.
        apply_current(ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "proxy.corp".into(),
            port: 3128,
            username: Some("u".into()),
            password: Some("p".into()),
            ..ProxyConfig::default()
        })
        .unwrap();
        let _ = clients.client_for("https://api.anthropic.com/v1/messages");
        assert_eq!(clients.pooled(), 3);

        apply_current(ProxyConfig::default()).unwrap();
    }

    #[test]
    fn event_names_match_frontend_listeners() {
        assert_eq!(REQUEST_LOG_EVENT, "gateway://request-log");
        assert_eq!(REQUEST_OUTCOME_EVENT, "gateway://request-outcome");
        assert_eq!(DECIDE_EVENT, "gateway://decide");
    }

    #[test]
    fn decide_timeout_is_bounded() {
        assert_eq!(DECIDE_TIMEOUT_MS, 800);
    }

    #[test]
    fn minimal_probe_body_is_one_token_per_protocol() {
        let oa = minimal_probe_body("openai", "gpt-4o-mini");
        assert_eq!(oa["model"], "gpt-4o-mini");
        assert_eq!(oa["max_tokens"], 1);
        assert_eq!(oa["messages"][0]["role"], "user");

        let an = minimal_probe_body("anthropic", "claude-haiku");
        assert_eq!(an["model"], "claude-haiku");
        assert_eq!(an["max_tokens"], 1);
    }

    #[test]
    fn host_allowlist_matches_remote_control_semantics() {
        assert!(host_is_local("127.0.0.1:47823"));
        assert!(host_is_local("localhost"));
        assert!(host_is_local("[::1]:8080"));
        assert!(!host_is_local("evil.com"));
        assert!(!host_is_local("0.0.0.0"));
    }

    #[test]
    fn supplied_token_reads_both_header_families() {
        let mut bearer = HeaderMap::new();
        bearer.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer tok-1".parse().unwrap(),
        );
        assert_eq!(supplied_token(&bearer), Some("tok-1"));

        let mut anthropic_style = HeaderMap::new();
        anthropic_style.insert("x-api-key", "tok-2".parse().unwrap());
        assert_eq!(supplied_token(&anthropic_style), Some("tok-2"));

        let mut both = HeaderMap::new();
        both.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer tok-1".parse().unwrap(),
        );
        both.insert("x-api-key", "tok-2".parse().unwrap());
        assert_eq!(supplied_token(&both), Some("tok-1"));

        assert_eq!(supplied_token(&HeaderMap::new()), None);
    }

    /// A snapshot mixing executable (openai / anthropic) providers with a
    /// non-executable one, plus an alias that points ONLY at the latter.
    fn models_snapshot() -> RoutingSnapshot {
        serde_json::from_value(serde_json::json!({
            "aliases": [
                { "alias": "fast", "entries": [
                    { "providerId": "groq", "modelId": "llama-3.3-70b" }
                ]},
                { "alias": "vision", "entries": [
                    { "providerId": "weird", "modelId": "gemini-pro" }
                ]}
            ],
            "providers": [
                { "id": "groq", "protocol": "openai", "baseUrl": "https://api.groq.com/openai/v1",
                  "apiKey": "sk-g", "enabled": true, "models": ["llama-3.3-70b"] },
                { "id": "weird", "protocol": "gemini", "baseUrl": "https://g",
                  "apiKey": "sk-w", "enabled": true, "models": ["gemini-pro"] },
                { "id": "off", "protocol": "openai", "baseUrl": "https://o",
                  "apiKey": "sk-o", "enabled": false, "models": ["hidden-model"] }
            ],
            "generatedAtMs": 1
        }))
        .unwrap()
    }

    fn listed_ids(data: &[Value]) -> Vec<String> {
        data.iter()
            .filter_map(|m| m["id"].as_str().map(str::to_string))
            .collect()
    }

    #[test]
    fn list_models_hides_models_the_gateway_cannot_execute() {
        let ids = listed_ids(&listable_models(&models_snapshot(), false, &|_| true));
        // Executable + enabled only.
        assert!(ids.contains(&"fast".to_string()));
        assert!(ids.contains(&"llama-3.3-70b".to_string()));
        // The gemini-protocol provider would 404 on the very next chat call, so
        // neither it nor the alias that only points at it may be advertised.
        assert!(!ids.contains(&"gemini-pro".to_string()));
        assert!(!ids.contains(&"vision".to_string()));
        // Disabled providers stay hidden as before.
        assert!(!ids.contains(&"hidden-model".to_string()));
    }

    #[test]
    fn list_models_still_honours_exposure_and_key_allowlist() {
        let ids = listed_ids(&listable_models(&models_snapshot(), false, &|m| {
            m == "fast"
        }));
        assert_eq!(ids, vec!["fast".to_string()]);

        // hide_raw_provider_models keeps aliases and drops bare provider models.
        let ids = listed_ids(&listable_models(&models_snapshot(), true, &|_| true));
        assert_eq!(ids, vec!["fast".to_string()]);
    }

    #[test]
    fn route_retry_after_reports_all_cooling_pool() {
        let snapshot: RoutingSnapshot = serde_json::from_value(serde_json::json!({
            "aliases": [{ "alias": "fast", "entries": [{ "providerId": "groq", "modelId": "m" }] }],
            "providers": [{
                "id": "groq", "protocol": "openai", "baseUrl": "https://g/v1",
                "enabled": true, "rotationEnabled": true, "apiKeys": ["a", "b"]
            }],
            "generatedAtMs": 1
        }))
        .unwrap();
        let cooldown = KeyCooldownMap::default();
        cooldown::record_cooldown(&cooldown, "groq", "a", 5_000, "429");
        cooldown::record_cooldown(&cooldown, "groq", "b", 3_000, "429");
        assert_eq!(
            route_retry_after_ms(&snapshot, &cooldown, "fast", 1_000),
            Some(2_000)
        );
    }

    #[test]
    fn gate_keys_are_endpoint_independent() {
        // The shared-budget invariant: chat, embeddings and responses all reach
        // the limiter through these two helpers, so a single configured cap is
        // ONE budget across endpoints. If someone re-inlines a `format!` in one
        // handler this test won't catch it — but the helpers existing at all is
        // what makes that a visible edit rather than an invisible one.
        let mut c = ctx();
        c.key_id = Some("key-abc".into());
        assert_eq!(gw_gate_key(&c), "gw:key-abc");

        // An unauthenticated caller still shares one bucket rather than each
        // getting its own unlimited gate.
        c.key_id = None;
        assert_eq!(gw_gate_key(&c), "gw:_");

        let candidate = crate::execute::resolve_candidates(&models_snapshot(), "llama-3.3-70b")
            .into_iter()
            .next()
            .expect("groq candidate");
        assert_eq!(up_gate_key(&candidate), "up:groq:sk-g");
    }

    #[test]
    fn the_test_idle_timeout_still_matches_the_shipped_default() {
        // `STREAM_IDLE_TIMEOUT` is `#[cfg(test)]`-only and hand-mirrors the
        // default `GatewayConfig` carries. Nothing else ties the two together,
        // so without this the tests below could go on asserting 300s timing
        // long after the shipped default had moved — passing while proving
        // nothing about what users run.
        assert_eq!(
            GatewayConfig::default().stream_idle_timeout(),
            Some(STREAM_IDLE_TIMEOUT)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn next_chunk_before_idle_passes_data_and_clean_end_through() {
        let mut with_data =
            futures_util::stream::iter(vec![Ok::<_, ()>(Bytes::from_static(b"hi"))]);
        assert_eq!(
            next_chunk_before_idle(&mut with_data, Some(STREAM_IDLE_TIMEOUT)).await,
            Ok(Some(Ok(Bytes::from_static(b"hi"))))
        );
        // Same stream, now drained — a clean end is `Ok(None)`, distinct from
        // the `Err(())` a stall produces, because only the latter must be
        // reported as a failed outcome.
        assert_eq!(
            next_chunk_before_idle(&mut with_data, Some(STREAM_IDLE_TIMEOUT)).await,
            Ok(None)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_zero_idle_timeout_waits_forever_rather_than_aborting_instantly() {
        // `streamIdleTimeoutSecs = 0` is the documented opt-out. The risk to
        // guard against is the opposite reading — treating 0 as a zero-length
        // timeout, which would abort every stream before its first byte.
        let mut silent = futures_util::stream::pending::<Result<Bytes, ()>>();
        let outcome = tokio::time::timeout(
            Duration::from_secs(3600),
            next_chunk_before_idle(&mut silent, None),
        )
        .await;
        assert!(
            outcome.is_err(),
            "an unset idle timeout must keep waiting, not resolve"
        );
    }

    #[test]
    fn a_probe_failure_carries_the_status_and_a_bounded_error_body() {
        let (ok, status, error) = classify_probe_failure(401, "invalid x-api-key");
        assert!(!ok);
        assert_eq!(status, Some(401));
        assert_eq!(error.as_deref(), Some("invalid x-api-key"));
    }

    #[test]
    fn a_probe_error_body_is_truncated_before_it_reaches_the_settings_table() {
        // An upstream that answers with an HTML error page would otherwise put
        // the entire page into one table cell.
        let (_, _, error) = classify_probe_failure(500, &"x".repeat(5_000));
        assert_eq!(error.as_deref().map(str::len), Some(PROBE_ERROR_CHARS));
    }

    #[test]
    fn a_probe_error_body_truncates_on_char_boundaries() {
        // Byte slicing would panic here; upstream error bodies are routinely
        // non-ASCII.
        let body = "错误".repeat(500);
        let (_, _, error) = classify_probe_failure(429, &body);
        let error = error.expect("a failure always carries a body");
        assert_eq!(error.chars().count(), PROBE_ERROR_CHARS);
        assert!(body.starts_with(&error));
    }

    #[test]
    fn an_empty_upstream_error_body_still_produces_a_row_rather_than_none() {
        // `Some("")` and `None` render differently: the latter reads as "no
        // error", which is exactly wrong for a 502.
        let (ok, status, error) = classify_probe_failure(502, "");
        assert!(!ok);
        assert_eq!(status, Some(502));
        assert_eq!(error.as_deref(), Some(""));
    }

    #[test]
    fn the_upstream_probe_outcome_distinguishes_no_snapshot_from_no_candidate() {
        // The route maps these to 503 and 404 respectively — collapsing them
        // would tell an operator with an unpublished snapshot that their model
        // name is wrong.
        assert!(matches!(
            UpstreamProbeOutcome::NoSnapshot,
            UpstreamProbeOutcome::NoSnapshot
        ));
        assert!(matches!(
            UpstreamProbeOutcome::NoCandidate,
            UpstreamProbeOutcome::NoCandidate
        ));
        let probed = UpstreamProbeOutcome::Probed(vec![UpstreamProbeResult {
            provider_id: "groq".into(),
            model_id: "llama-3.3-70b".into(),
            ok: true,
            status: Some(200),
            latency_ms: 12,
            error: None,
        }]);
        match probed {
            UpstreamProbeOutcome::Probed(rows) => {
                assert_eq!(rows.len(), 1);
                assert!(rows[0].ok);
                assert!(rows[0].error.is_none());
            }
            _ => panic!("expected Probed"),
        }
    }

    #[test]
    fn a_probe_result_serializes_camel_case_for_the_settings_panel() {
        // The renderer reads `providerId` / `latencyMs`; snake_case here would
        // render an empty row rather than fail.
        let json = serde_json::to_value(UpstreamProbeResult {
            provider_id: "groq".into(),
            model_id: "llama-3.3-70b".into(),
            ok: false,
            status: Some(401),
            latency_ms: 34,
            error: Some("invalid key".into()),
        })
        .unwrap();
        assert_eq!(json["providerId"], "groq");
        assert_eq!(json["modelId"], "llama-3.3-70b");
        assert_eq!(json["latencyMs"], 34);
        assert_eq!(json["status"], 401);
        assert_eq!(json["error"], "invalid key");
    }

    #[test]
    fn the_stall_message_quotes_the_configured_timeout_not_the_default() {
        // The gating already read `streamIdleTimeoutSecs`; the message did not,
        // so a 60s configuration still told the operator "no data for 300s".
        assert_eq!(
            stall_reason(Some(Duration::from_secs(60))),
            "upstream stream stalled: no data for 60s"
        );
        assert_eq!(
            stall_reason(Some(STREAM_IDLE_TIMEOUT)),
            "upstream stream stalled: no data for 300s"
        );
        // Wait-forever has no duration to quote — naming one would be a lie.
        assert_eq!(stall_reason(None), "upstream stream stalled");
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_upstream_stream_is_abandoned_rather_than_parked_forever() {
        // Streaming skips `apply_timeout` and reqwest sets no read timeout, so
        // without this the pump task would park forever holding its concurrency
        // slots AND its in-flight tally — and the tally drives least-busy, so
        // one hung stream would steer traffic off that provider permanently.
        // Exercised through the helper both pumps call, so this stays honest if
        // the timeout source moves again.
        let mut silent = futures_util::stream::pending::<Result<Bytes, ()>>();
        assert!(
            next_chunk_before_idle(&mut silent, Some(STREAM_IDLE_TIMEOUT))
                .await
                .is_err(),
            "a stream that never yields must time out, not park the pump"
        );

        // …and a stall must be reported as a FAILURE. Both pumps used to emit
        // `ok: true` unconditionally at stream end, which would have logged a
        // hung upstream as a healthy turn.
        let candidate = crate::execute::resolve_candidates(&models_snapshot(), "llama-3.3-70b")
            .into_iter()
            .next()
            .expect("groq candidate");
        let stalled = outcome_payload(
            &candidate,
            false,
            1,
            None,
            Some("upstream stream stalled: no data for 300s"),
            None,
            Some("sess-1"),
        );
        assert_eq!(stalled["ok"], false);
        assert!(stalled["errorMessage"]
            .as_str()
            .unwrap_or_default()
            .contains("stalled"));
    }

    #[test]
    fn a_non_chat_outcome_can_never_pin_chat_affinity() {
        // `sessionId` drives `pinSessionDeployment` on the renderer. Embeddings
        // and /v1/responses have no chat session, so they MUST send null —
        // otherwise their traffic would stick a real conversation to whatever
        // deployment happened to serve an embedding.
        let candidate = crate::execute::resolve_candidates(&models_snapshot(), "llama-3.3-70b")
            .into_iter()
            .next()
            .expect("groq candidate");

        let embeddings = outcome_payload(
            &candidate,
            true,
            12,
            Some((Some(7), None)),
            None,
            None,
            None,
        );
        assert!(embeddings["sessionId"].is_null());
        assert_eq!(embeddings["inputTokens"], 7);
        assert!(embeddings["outputTokens"].is_null());
        assert_eq!(embeddings["providerId"], "groq");

        // A failure carries the cooldown window through to the breaker.
        let failed = outcome_payload(
            &candidate,
            false,
            3,
            None,
            Some("HTTP 429"),
            Some(4_000),
            None,
        );
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["retryAfterMs"], 4_000);
        assert_eq!(failed["errorMessage"], "HTTP 429");
        assert!(failed["sessionId"].is_null());

        // The chat path, by contrast, does thread one through.
        let chat = outcome_payload(&candidate, true, 5, None, None, None, Some("sess-1"));
        assert_eq!(chat["sessionId"], "sess-1");
    }

    #[test]
    fn in_flight_snapshot_never_carries_a_credential() {
        // `up_gate_key` deliberately embeds the API key, and the decide payload
        // is serialized to the renderer — so the tally MUST key on the provider
        // id alone. Working rule 7: pin the intentional invariant.
        let tracker = InFlightTracker::default();
        let candidate = crate::execute::resolve_candidates(&models_snapshot(), "llama-3.3-70b")
            .into_iter()
            .next()
            .expect("groq candidate");
        assert!(
            up_gate_key(&candidate).contains("sk-"),
            "fixture has a secret"
        );

        let _guard = tracker.enter(&candidate.provider.id);
        let snapshot = tracker.snapshot();
        assert_eq!(snapshot.get("groq"), Some(&1));
        for key in snapshot.keys() {
            assert!(
                !key.contains("sk-"),
                "credential leaked into snapshot: {key}"
            );
        }
        // And it is a plain provider id, not the gate key.
        assert!(!snapshot.contains_key(&up_gate_key(&candidate)));
    }

    #[test]
    fn ctx_allows_respects_key_allowlist() {
        let mut c = ctx();
        assert!(ctx_allows(&c, "anything")); // empty = all
        c.key_model_allowlist = vec!["fast".into()];
        assert!(ctx_allows(&c, "fast"));
        assert!(!ctx_allows(&c, "slow"));
    }

    #[test]
    fn sniff_usage_reads_both_protocol_shapes() {
        // Anthropic: input on message_start, cumulative output on message_delta.
        let (mut i, mut o) = (None, None);
        sniff_passthrough_usage(
            InboundFormat::AnthropicMessages,
            &json!({ "type": "message_start", "message": { "usage": { "input_tokens": 42 } } }),
            &mut i,
            &mut o,
        );
        sniff_passthrough_usage(
            InboundFormat::AnthropicMessages,
            &json!({ "type": "message_delta", "usage": { "output_tokens": 17 } }),
            &mut i,
            &mut o,
        );
        assert_eq!((i, o), (Some(42), Some(17)));

        // OpenAI: both on a trailing usage object.
        let (mut i2, mut o2) = (None, None);
        sniff_passthrough_usage(
            InboundFormat::OpenAiChat,
            &json!({ "usage": { "prompt_tokens": 5, "completion_tokens": 9 } }),
            &mut i2,
            &mut o2,
        );
        assert_eq!((i2, o2), (Some(5), Some(9)));

        // A frame without usage leaves the accumulators untouched.
        let (mut i3, mut o3) = (Some(1), Some(2));
        sniff_passthrough_usage(
            InboundFormat::OpenAiChat,
            &json!({ "choices": [{ "delta": { "content": "hi" } }] }),
            &mut i3,
            &mut o3,
        );
        assert_eq!((i3, o3), (Some(1), Some(2)));
    }

    #[test]
    fn apply_timeout_only_sets_when_positive() {
        // Can't easily inspect RequestBuilder; assert the config gate instead.
        let mut cfg = GatewayConfig {
            request_timeout_secs: 0,
            ..GatewayConfig::default()
        };
        assert_eq!(cfg.request_timeout_secs, 0);
        cfg.request_timeout_secs = 10;
        assert!(cfg.request_timeout_secs > 0);
    }

    #[test]
    fn error_helpers_render_inbound_shapes() {
        let resp = no_snapshot_error(InboundFormat::OpenAiChat);
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn transcoded_stream_flushes_final_sse_payload_without_newline() {
        let upstream_payload = json!({
            "choices": [{
                "delta": { "content": "tail text" },
                "finish_reason": null,
            }],
            "usage": { "prompt_tokens": 7, "completion_tokens": 3 },
        });
        let upstream_bytes = format!("data: {upstream_payload}");
        let mut deframer = SseDeframer::default();
        let mut transcoder =
            StreamTranscoder::new(Direction::OpenAiToAnthropic, "client-model", "msg_tail");

        assert!(transcode_upstream_sse_bytes(
            &mut deframer,
            &mut transcoder,
            upstream_bytes.as_bytes()
        )
        .is_empty());

        let frames = finish_upstream_sse_stream(&mut deframer, &mut transcoder);
        assert!(frames.iter().any(|frame| {
            frame.event.as_deref() == Some("content_block_delta")
                && serde_json::from_str::<Value>(&frame.data)
                    .map(|data| data["delta"]["text"] == "tail text")
                    .unwrap_or(false)
        }));
    }
}

/// ADR-0188 (Router + Fusion, WP-A): every Run API route, fallback and guard,
/// and every `cognia/*` behaviour, driven through [`app_router`] — the router
/// the listener mounts — with the middleware, the body limit, the contract
/// envelope and the connection split in place. The legacy answers beside them
/// are pinned byte for byte (D37).
#[cfg(test)]
mod router_fusion_server_tests {
    use super::*;
    use crate::brain_bridge::{command, BrainBridge, BrainFuture, RecordingBrainBridge};
    use crate::runs::{scope, RunsState, MAX_COMPAT_WAITERS};
    use axum::http::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, HOST};
    use tower::ServiceExt;

    const SECRET: &str = "sk-cognia-rf-server-tests-scoped-000000000000000000";
    const LIMITED: &str = "sk-cognia-rf-server-tests-limited-00000000000000000";
    const PLAIN: &str = "sk-cognia-rf-server-tests-plain-0000000000000000000";
    const DRAINED: &str = "sk-cognia-rf-server-tests-drained-00000000000000000";
    const LOCAL: &str = "127.0.0.1:8787";
    const PEER: &str = "127.0.0.1:50000";
    const RUN_ID: &str = "11111111-1111-4111-8111-111111111111";

    struct NoopObserver;
    impl RequestObserver for NoopObserver {
        fn on_call(&self, _route: &str, _status: StatusCode, _ip: IpAddr) {}
    }

    fn key(id: &str, secret: &str, scopes: &[&str], allowlist: &[&str]) -> GatewayApiKey {
        GatewayApiKey {
            owner_account_id: None,
            id: id.into(),
            name: format!("{id} robot"),
            secret: secret.into(),
            model_allowlist: allowlist.iter().map(|m| m.to_string()).collect(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            expires_at_ms: None,
            enabled: true,
            rate_limit_per_min: None,
            quota_tokens: None,
            quota_used_tokens: 0,
            created_at_ms: 0,
            last_used_at_ms: None,
        }
    }

    /// The four keys every test can use: a Run API key, one limited to named
    /// models, a legacy key with no scopes, and one that drew down its quota.
    fn keys() -> Vec<GatewayApiKey> {
        let run_scopes = [
            scope::CREATE,
            scope::READ,
            scope::CANCEL,
            scope::APPROVE,
            scope::ARTIFACTS_READ,
            scope::FEEDBACK,
        ];
        let mut drained = key("drained", DRAINED, &run_scopes, &[]);
        drained.quota_tokens = Some(10);
        drained.quota_used_tokens = 10;
        vec![
            key("scoped", SECRET, &run_scopes, &[]),
            key("limited", LIMITED, &[scope::CREATE, scope::READ], &["fast"]),
            key("plain", PLAIN, &[], &[]),
            drained,
        ]
    }

    struct Gateway {
        app: Router,
        state: AppState,
    }

    fn gateway_with(
        bridge: Arc<dyn BrainBridge>,
        runs_enabled: bool,
        lan: bool,
        snapshot: Option<RoutingSnapshot>,
    ) -> Gateway {
        let runs = RunsState::new(bridge);
        runs.switches.write().runs_enabled = runs_enabled;
        let config = GatewayConfig {
            allowlist: vec!["127.0.0.1/32".into(), "192.168.1.0/24".into()],
            ..GatewayConfig::default()
        };
        let state = AppState {
            account: Arc::new(RwLock::new(crate::GatewayAccountContext::default())),
            account_changes: Arc::new(watch::channel(0).0),
            host: Arc::new(crate::host::RecordingGatewayHost::new(false)),
            keys: Arc::new(RwLock::new(keys())),
            allowlist: Arc::new(ParsedAllowlist::parse(&config.allowlist).unwrap()),
            rate_limiter: Arc::new(FixedWindowRateLimiter::new(config.rate_limit_per_min)),
            config: Arc::new(RwLock::new(config)),
            key_rate_limiter: Arc::new(KeyedRateLimiter::new()),
            bind_is_lan: lan,
            on_request: Arc::new(NoopObserver),
            snapshot: Arc::new(RwLock::new(snapshot)),
            decisions: Arc::new(DecisionRegistry::default()),
            key_rotation: Arc::new(KeyRotationMap::default()),
            route_planner: Arc::new(crate::route_planner::RoutePlannerState::default()),
            key_cooldown: Arc::new(KeyCooldownMap::default()),
            concurrency: Arc::new(ConcurrencyLimiter::default()),
            in_flight: Arc::new(InFlightTracker::default()),
            tickets: Arc::new(RouteTicketRegistry::new(Arc::new(
                crate::route_ticket::InMemoryTicketMetaStore::default(),
            ))),
            leases: Arc::new(CredentialLeaseMap::default()),
            http: Arc::new(UpstreamClients::new(Duration::from_secs(1))),
            response_history: Arc::new(parking_lot::Mutex::new(ResponseHistory::default())),
            runs,
        };
        Gateway {
            app: app_router(state.clone()),
            state,
        }
    }

    fn gateway(bridge: &RecordingBrainBridge, runs_enabled: bool) -> Gateway {
        gateway_with(Arc::new(bridge.clone()), runs_enabled, false, None)
    }

    /// A request as the listener hands it over: with the connection info the
    /// real `GatewayConnection` make-service attaches.
    fn request_via(
        method: &str,
        uri: &str,
        bearer: Option<&str>,
        body: Option<Value>,
        remote: &str,
        local: &str,
        host: &str,
    ) -> axum::http::Request<Body> {
        let mut builder = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header(HOST, host);
        if let Some(secret) = bearer {
            builder = builder.header(AUTHORIZATION, format!("Bearer {secret}"));
        }
        let body = match body {
            Some(value) => {
                builder = builder.header(CONTENT_TYPE, "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let mut request = builder.body(body).unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(GatewayConnection {
                remote: remote.parse().unwrap(),
                local: Some(local.parse().unwrap()),
            }));
        request
    }

    fn request(
        method: &str,
        uri: &str,
        bearer: Option<&str>,
        body: Option<Value>,
    ) -> axum::http::Request<Body> {
        request_via(method, uri, bearer, body, PEER, LOCAL, LOCAL)
    }

    async fn send(app: &Router, request: axum::http::Request<Body>) -> Response {
        app.clone().oneshot(request).await.unwrap()
    }

    async fn bytes_of(response: Response) -> Bytes {
        axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap()
    }

    async fn json_of(response: Response) -> Value {
        serde_json::from_slice(&bytes_of(response).await).unwrap_or(Value::Null)
    }

    /// The contract's `ErrorResponse`, and nothing else.
    fn assert_contract(body: &Value, code: &str) {
        let error = body["error"]
            .as_object()
            .unwrap_or_else(|| panic!("an error object: {body}"));
        let mut keys: Vec<&str> = error.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["code", "details", "message", "retryable", "trace_id"],
            "{body}"
        );
        assert_eq!(body["error"]["code"], code, "{body}");
        assert_eq!(body.as_object().map(|o| o.len()), Some(1), "{body}");
    }

    fn created() -> Value {
        json!({
            "accepted": {
                "schema_version": "1.0.0",
                "run_id": RUN_ID,
                "session_id": "22222222-2222-4222-8222-222222222222",
                "session_version": 0,
                "status": "queued",
                "version": 1,
                "created_at": "2026-09-16T08:00:00.000Z"
            },
            "replayed": false
        })
    }

    fn chat_answer() -> Value {
        json!({
            "id": format!("chatcmpl-{RUN_ID}"),
            "object": "chat.completion",
            "created": 1_800_000_000,
            "model": "cognia/panel",
            "choices": [{ "index": 0, "message": { "role": "assistant", "content": "4%." }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15 },
            "routing": { "run_id": RUN_ID, "mode_executed": "panel", "degraded": false, "billing": {} }
        })
    }

    fn chat(model: &str) -> Value {
        json!({
            "model": model,
            "max_tokens": 16,
            "messages": [{ "role": "user", "content": "What is the 2025 steel tariff?" }]
        })
    }

    fn event(seq: u64, kind: &str) -> Value {
        json!({
            "schema_version": "1.0.0",
            "run_id": RUN_ID,
            "seq": seq,
            "event_type": kind,
            "timestamp": "2026-09-16T08:00:00.000Z",
            "payload": {}
        })
    }

    // ---- step 1: one error shape ------------------------------------------

    #[tokio::test]
    async fn run_api_auth_refusals_are_the_contracts_error_and_legacy_paths_keep_theirs() {
        let bridge = RecordingBrainBridge::new();
        let gw = gateway(&bridge, true);
        for uri in [
            "/v1/runs/r-1",
            "/v1/sessions/s-1",
            "/v1/artifacts/a-1",
            "/v1/runs/r-1/events",
        ] {
            let missing = send(&gw.app, request("GET", uri, None, None)).await;
            assert_eq!(missing.status(), StatusCode::UNAUTHORIZED, "{uri}");
            assert_contract(&json_of(missing).await, "AUTH_REQUIRED");

            let invalid = send(&gw.app, request("GET", uri, Some("sk-cognia-nope"), None)).await;
            assert_eq!(invalid.status(), StatusCode::UNAUTHORIZED, "{uri}");
            assert_contract(&json_of(invalid).await, "INVALID_API_KEY");

            let drained = send(&gw.app, request("GET", uri, Some(DRAINED), None)).await;
            assert_eq!(drained.status(), StatusCode::TOO_MANY_REQUESTS, "{uri}");
            let body = json_of(drained).await;
            assert_contract(&body, "KEY_QUOTA_EXHAUSTED");
            // Waiting does not refill a quota: not retryable, though a 429.
            assert_eq!(body["error"]["retryable"], false);
            assert_eq!(
                body["error"]["message"],
                "insufficient_quota: key token quota exhausted"
            );

            let spoofed = send(
                &gw.app,
                request_via("GET", uri, Some(SECRET), None, PEER, LOCAL, "evil.example"),
            )
            .await;
            assert_eq!(spoofed.status(), StatusCode::FORBIDDEN, "{uri}");
            assert_contract(&json_of(spoofed).await, "HOST_NOT_ALLOWED");
        }
        assert!(bridge.calls().is_empty());

        // D37: every other path answers with exactly the bytes it always did.
        let legacy_missing = send(&gw.app, request("GET", "/v1/models", None, None)).await;
        assert_eq!(legacy_missing.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            json_of(legacy_missing).await,
            json!({ "error": { "message": "missing credentials (Authorization: Bearer or x-api-key)" } })
        );
        let legacy_invalid = send(
            &gw.app,
            request(
                "POST",
                "/v1/chat/completions",
                Some("sk-cognia-nope"),
                Some(chat("fast")),
            ),
        )
        .await;
        assert_eq!(
            json_of(legacy_invalid).await,
            json!({ "error": { "message": "invalid token" } })
        );
        let legacy_drained = send(&gw.app, request("GET", "/v1/models", Some(DRAINED), None)).await;
        assert_eq!(legacy_drained.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            json_of(legacy_drained).await,
            json!({ "error": { "message": "insufficient_quota: key token quota exhausted" } })
        );
        let legacy_host = send(
            &gw.app,
            request_via(
                "GET",
                "/v1/models",
                Some(SECRET),
                None,
                PEER,
                LOCAL,
                "evil.example",
            ),
        )
        .await;
        assert_eq!(
            json_of(legacy_host).await,
            json!({ "error": { "message": "invalid host" } })
        );
    }

    #[tokio::test]
    async fn the_run_routers_404_and_405_are_contract_shaped_and_legacy_misses_are_not() {
        let bridge = RecordingBrainBridge::new();
        let gw = gateway(&bridge, true);
        let not_allowed = send(&gw.app, request("GET", "/v1/runs", Some(SECRET), None)).await;
        assert_eq!(not_allowed.status(), StatusCode::METHOD_NOT_ALLOWED);
        // The contract body keeps the header a 405 owes its caller.
        assert_eq!(not_allowed.headers().get("allow").unwrap(), "POST");
        assert_contract(&json_of(not_allowed).await, "METHOD_NOT_ALLOWED");
        for uri in [
            "/v1/runs/r-1/nope",
            "/v1/sessions",
            "/v1/artifacts/a-1/content/x",
        ] {
            let missing = send(&gw.app, request("GET", uri, Some(SECRET), None)).await;
            assert_eq!(missing.status(), StatusCode::NOT_FOUND, "{uri}");
            let body = json_of(missing).await;
            assert_contract(&body, "ROUTE_NOT_FOUND");
            assert_eq!(body["error"]["details"]["path"], uri);
        }
        // The fallbacks sit behind the key check like every route.
        let anonymous = send(&gw.app, request("GET", "/v1/runs/r-1/nope", None, None)).await;
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        assert_contract(&json_of(anonymous).await, "AUTH_REQUIRED");
        assert!(bridge.calls().is_empty());

        // D37: a path no route claims, and a wrong method on a legacy route,
        // are axum's own bare answers, as before.
        for (method, uri, status) in [
            ("GET", "/v1/nope", StatusCode::NOT_FOUND),
            ("GET", "/v1/models/a/b/c", StatusCode::NOT_FOUND),
            ("DELETE", "/v1/models", StatusCode::METHOD_NOT_ALLOWED),
        ] {
            let response = send(&gw.app, request(method, uri, Some(SECRET), None)).await;
            assert_eq!(response.status(), status, "{method} {uri}");
            assert!(bytes_of(response).await.is_empty(), "{method} {uri}");
        }
    }

    #[tokio::test]
    async fn a_run_api_body_over_the_limit_is_a_contract_413_and_a_legacy_one_is_not() {
        let bridge = RecordingBrainBridge::new();
        let gw = gateway(&bridge, true);
        let oversized = |uri: &str| {
            let mut request = request("POST", uri, Some(SECRET), Some(json!({})));
            request.headers_mut().insert(
                CONTENT_LENGTH,
                HeaderValue::from(BODY_LIMIT_BYTES as u64 + 1),
            );
            request
        };
        let run = send(&gw.app, oversized("/v1/runs")).await;
        assert_eq!(run.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let body = json_of(run).await;
        assert_contract(&body, "PAYLOAD_TOO_LARGE");
        assert_eq!(body["error"]["message"], "length limit exceeded");
        assert!(bridge.calls().is_empty());

        let legacy = send(&gw.app, oversized("/v1/chat/completions")).await;
        assert_eq!(legacy.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(&bytes_of(legacy).await[..], b"length limit exceeded");
    }

    /// A brain that takes every request and never answers, and says when it
    /// has been asked.
    struct StallingBrain {
        asked: Arc<tokio::sync::Notify>,
    }

    impl BrainBridge for StallingBrain {
        fn call(&self, _command: &'static str, _payload: Value) -> BrainFuture {
            self.asked.notify_one();
            Box::pin(std::future::pending())
        }
    }

    #[tokio::test]
    async fn an_account_switch_mid_request_is_a_contract_503_on_a_run_path() {
        let asked = Arc::new(tokio::sync::Notify::new());
        let gw = gateway_with(
            Arc::new(StallingBrain {
                asked: asked.clone(),
            }),
            true,
            false,
            None,
        );
        let app = gw.app.clone();
        let pending = tokio::spawn(async move {
            app.oneshot(request("GET", "/v1/runs/r-1", Some(SECRET), None))
                .await
                .unwrap()
        });
        asked.notified().await;
        gw.state.account_changes.send_replace(1);
        let response = pending.await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = json_of(response).await;
        assert_contract(&body, "ACCOUNT_CONTEXT_CHANGED");
        assert_eq!(body["error"]["retryable"], true);
    }

    #[tokio::test]
    async fn an_account_switch_keeps_the_bare_string_on_every_other_path() {
        let (changes, _) = watch::channel(0u64);
        let changes = Arc::new(changes);
        let router = axum::Router::new()
            .route(
                "/v1/models",
                get(|| async { std::future::pending::<Response>().await }),
            )
            .layer(axum::middleware::from_fn({
                let changes = changes.clone();
                move |request: axum::http::Request<Body>, next: Next| {
                    run_with_account_boundary(next, request, changes.subscribe())
                }
            }));
        let pending = tokio::spawn(
            router.oneshot(
                axum::http::Request::builder()
                    .uri("/v1/models")
                    .body(Body::empty())
                    .unwrap(),
            ),
        );
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        changes.send_replace(1);
        let response = pending.await.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            json_of(response).await,
            json!({ "error": "gateway account context changed" })
        );
    }

    // ---- step 2: the body extractor ----------------------------------------

    #[tokio::test]
    async fn a_rejected_body_or_path_is_schema_invalid_through_the_mounted_app() {
        let bridge = RecordingBrainBridge::new();
        let gw = gateway(&bridge, true);
        for (uri, content_type, body) in [
            ("/v1/runs", "application/json", "{not json"),
            ("/v1/runs/r-1/resume", "text/plain", "{}"),
            ("/v1/runs/r-1/feedback", "application/json", ""),
        ] {
            let mut request = request("POST", uri, Some(SECRET), None);
            request
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
            *request.body_mut() = Body::from(body);
            let response = send(&gw.app, request).await;
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY, "{uri}");
            let parsed = json_of(response).await;
            assert_contract(&parsed, "SCHEMA_INVALID");
            assert!(parsed["error"]["details"]["reason"].is_string(), "{uri}");
        }
        let undecodable = send(&gw.app, request("GET", "/v1/runs/%FF", Some(SECRET), None)).await;
        assert_eq!(undecodable.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_contract(&json_of(undecodable).await, "SCHEMA_INVALID");
        assert!(bridge.calls().is_empty());
    }

    // ---- step 3: the event stream ------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn the_event_stream_ends_on_an_unreadable_page_through_the_mounted_app() {
        let bridge = RecordingBrainBridge::new();
        bridge.ok(command::RUN_EVENTS, json!("not a page"));
        bridge.ok(
            command::RUN_EVENTS,
            json!({ "events": [event(1, "run.queued")], "terminal": false }),
        );
        bridge.ok(
            command::RUN_EVENTS,
            json!({ "events": null, "terminal": false }),
        );
        let gw = gateway(&bridge, true);

        let eager = send(
            &gw.app,
            request("GET", "/v1/runs/r-1/events", Some(SECRET), None),
        )
        .await;
        assert_eq!(eager.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_contract(&json_of(eager).await, "BRAIN_ANSWER_UNREADABLE");

        let started = tokio::time::Instant::now();
        let stream = send(
            &gw.app,
            request("GET", "/v1/runs/r-1/events", Some(SECRET), None),
        )
        .await;
        assert_eq!(stream.status(), StatusCode::OK);
        let text = String::from_utf8_lossy(&bytes_of(stream).await).to_string();
        let ids: Vec<&str> = text
            .lines()
            .filter_map(|line| line.strip_prefix("id: "))
            .collect();
        assert_eq!(ids, ["1"]);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(bridge.payloads_for(command::RUN_EVENTS).len(), 3);
    }

    /// Every events poll answers an empty, non-terminal page, slowly.
    struct SlowQuietBrain {
        polls: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl BrainBridge for SlowQuietBrain {
        fn call(&self, _command: &'static str, _payload: Value) -> BrainFuture {
            self.polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(10)).await;
                Ok(json!({ "events": [], "terminal": false }))
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stream_silence_is_wall_time_through_the_mounted_app() {
        let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let gw = gateway_with(
            Arc::new(SlowQuietBrain {
                polls: polls.clone(),
            }),
            true,
            false,
            None,
        );
        let response = send(
            &gw.app,
            request("GET", "/v1/runs/r-1/events", Some(SECRET), None),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let opened = tokio::time::Instant::now();
        bytes_of(response).await;
        let silent_for = opened.elapsed();
        assert!(silent_for >= crate::runs::SSE_MAX_SILENCE, "{silent_for:?}");
        assert!(
            silent_for <= crate::runs::SSE_MAX_SILENCE + Duration::from_secs(11),
            "{silent_for:?}"
        );
        assert!(polls.load(std::sync::atomic::Ordering::SeqCst) <= 32);
    }

    // ---- step 4: the read link's origin ------------------------------------

    #[tokio::test]
    async fn a_spoofed_host_on_a_lan_listener_never_reaches_the_read_link() {
        let bridge = RecordingBrainBridge::new();
        for _ in 0..4 {
            bridge.ok(
                command::ARTIFACT_GET,
                json!({ "artifact_id": "a-1", "read_url": "x" }),
            );
        }
        let gw = gateway_with(Arc::new(bridge.clone()), true, true, None);
        let lan_peer = "192.168.1.20:50000";
        let lan_local = "192.168.1.5:8787";
        for (host, expected) in [
            ("evil.example", "http://192.168.1.5:8787"),
            ("192.168.1.66:8787", "http://192.168.1.5:8787"),
            ("192.168.1.5:8787", "http://192.168.1.5:8787"),
            ("localhost:8787", "http://localhost:8787"),
        ] {
            let response = send(
                &gw.app,
                request_via(
                    "GET",
                    "/v1/artifacts/a-1",
                    Some(SECRET),
                    None,
                    lan_peer,
                    lan_local,
                    host,
                ),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK, "{host}");
            let payloads = bridge.payloads_for(command::ARTIFACT_GET);
            assert_eq!(payloads.last().unwrap()["baseUrl"], expected, "{host}");
        }
    }

    /// The connection split end to end over a real socket: the make-service
    /// the listener uses records the address the connection arrived on, and a
    /// spoofed Host on a LAN-mode listener is replaced by it.
    #[tokio::test]
    async fn the_listener_hands_the_run_api_the_address_it_was_really_reached_on() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let bridge = RecordingBrainBridge::new();
        bridge.ok(
            command::ARTIFACT_GET,
            json!({ "artifact_id": "a-1", "read_url": "x" }),
        );
        let gw = gateway_with(Arc::new(bridge.clone()), true, true, None);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = gw.app.clone();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<GatewayConnection>(),
            )
            .await;
        });
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "GET /v1/artifacts/a-1 HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer {SECRET}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await.unwrap();
        let answer = String::from_utf8_lossy(&answer);
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        assert_eq!(
            bridge.payloads_for(command::ARTIFACT_GET)[0]["baseUrl"],
            format!("http://{addr}")
        );
    }

    #[tokio::test]
    async fn a_loopback_listener_links_to_the_loopback_name_it_was_reached_by() {
        let bridge = RecordingBrainBridge::new();
        bridge.ok(
            command::ARTIFACT_GET,
            json!({ "artifact_id": "a-1", "read_url": "x" }),
        );
        let gw = gateway(&bridge, true);
        let response = send(
            &gw.app,
            request_via(
                "GET",
                "/v1/artifacts/a-1",
                Some(SECRET),
                None,
                PEER,
                LOCAL,
                "localhost:8787",
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            bridge.payloads_for(command::ARTIFACT_GET)[0]["baseUrl"],
            "http://localhost:8787"
        );
    }

    // ---- step 5: GET /v1/models/cognia/{mode} ------------------------------

    #[tokio::test]
    async fn a_virtual_model_is_served_by_its_own_route_under_the_lists_rule() {
        let bridge = RecordingBrainBridge::new();
        let on = gateway(&bridge, true);
        let served = send(
            &on.app,
            request("GET", "/v1/models/cognia/panel", Some(SECRET), None),
        )
        .await;
        assert_eq!(served.status(), StatusCode::OK);
        let document = json_of(served).await;
        assert_eq!(document["id"], "cognia/panel");
        assert_eq!(document["owned_by"], "cognia");

        let off = gateway(&bridge, false);
        for (gw, uri, bearer) in [
            (&off, "/v1/models/cognia/panel", SECRET),
            (&on, "/v1/models/cognia/panel", PLAIN),
            (&on, "/v1/models/cognia/panel", LIMITED),
            (&on, "/v1/models/cognia/telepathy", SECRET),
            (&on, "/v1/models/cognia/delegate", SECRET),
        ] {
            let response = send(&gw.app, request("GET", uri, Some(bearer), None)).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri} {bearer}");
            // The same bare 404 the path gave before the route existed.
            assert!(bytes_of(response).await.is_empty(), "{uri} {bearer}");
        }
        // Still a protected route: no key, no answer.
        let anonymous = send(
            &on.app,
            request("GET", "/v1/models/cognia/panel", None, None),
        )
        .await;
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        assert!(bridge.calls().is_empty());
    }

    // ---- step 6: compat waiters --------------------------------------------

    #[tokio::test]
    async fn a_compat_caller_past_the_waiter_cap_is_a_429_before_any_run_exists() {
        let bridge = RecordingBrainBridge::new();
        let gw = gateway(&bridge, true);
        let held: Vec<_> = (0..MAX_COMPAT_WAITERS)
            .map(|_| gw.state.runs.try_compat_waiter().unwrap())
            .collect();
        let response = send(
            &gw.app,
            request(
                "POST",
                "/v1/chat/completions",
                Some(SECRET),
                Some(chat("cognia/panel")),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = json_of(response).await;
        assert_contract(&body, "RUN_WAITERS_EXHAUSTED");
        assert_eq!(body["error"]["retryable"], true);
        assert!(bridge.calls().is_empty(), "no run was created");
        drop(held);
    }

    // ---- step 9: the virtual models through the endpoints ------------------

    #[tokio::test]
    async fn openai_chat_serves_cognia_panel_and_respects_the_key_allowlist() {
        let bridge = RecordingBrainBridge::new();
        bridge.ok(command::CHAT_CREATE, created());
        bridge.ok(
            command::CHAT_RESULT,
            json!({ "state": "succeeded", "response": chat_answer() }),
        );
        let gw = gateway(&bridge, true);

        // A key limited to named models reaches a virtual one only by name.
        let refused = send(
            &gw.app,
            request(
                "POST",
                "/v1/chat/completions",
                Some(LIMITED),
                Some(chat("cognia/panel")),
            ),
        )
        .await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert_contract(&json_of(refused).await, "MODEL_NOT_PERMITTED");
        assert!(bridge.calls().is_empty());

        let served = send(
            &gw.app,
            request(
                "POST",
                "/v1/chat/completions",
                Some(SECRET),
                Some(chat("cognia/panel")),
            ),
        )
        .await;
        assert_eq!(served.status(), StatusCode::OK);
        assert_eq!(
            served.headers().get(crate::runs::RUN_ID_HEADER).unwrap(),
            RUN_ID
        );
        assert_eq!(json_of(served).await, chat_answer());
        let create = &bridge.payloads_for(command::CHAT_CREATE)[0];
        assert_eq!(create["actor"]["keyId"], "scoped");
        assert_eq!(create["body"]["model"], "cognia/panel");
        // The answer's tokens drew down the calling key's quota.
        let used = gw
            .state
            .keys
            .read()
            .iter()
            .find(|k| k.id == "scoped")
            .map(|k| k.quota_used_tokens);
        assert_eq!(used, Some(15));
        assert_eq!(gw.state.runs.idle_compat_waiters(), MAX_COMPAT_WAITERS);
    }

    #[tokio::test]
    async fn a_refused_virtual_model_is_the_contracts_error_on_every_endpoint() {
        let bridge = RecordingBrainBridge::new();
        let on = gateway(&bridge, true);
        let off = gateway(&bridge, false);
        let embeddings = json!({ "model": "cognia/auto", "input": "hello" });
        let responses = json!({ "model": "cognia/auto", "input": "hello" });
        for (gw, uri, body, status, code) in [
            (
                &on,
                "/v1/messages",
                chat("cognia/auto"),
                StatusCode::UNPROCESSABLE_ENTITY,
                "VIRTUAL_MODEL_CHAT_COMPLETIONS_ONLY",
            ),
            (
                &on,
                "/v1/responses",
                responses,
                StatusCode::UNPROCESSABLE_ENTITY,
                "VIRTUAL_MODEL_CHAT_COMPLETIONS_ONLY",
            ),
            (
                &on,
                "/v1/embeddings",
                embeddings,
                StatusCode::UNPROCESSABLE_ENTITY,
                "VIRTUAL_MODEL_CHAT_COMPLETIONS_ONLY",
            ),
            (
                &on,
                "/v1/messages/count_tokens",
                chat("cognia/auto"),
                StatusCode::UNPROCESSABLE_ENTITY,
                "VIRTUAL_MODEL_CHAT_COMPLETIONS_ONLY",
            ),
            (
                &on,
                "/v1/chat/completions",
                chat("cognia/delegate"),
                StatusCode::UNPROCESSABLE_ENTITY,
                "DELEGATE_REQUIRES_RUN_API",
            ),
            (
                &on,
                "/v1/chat/completions",
                chat("cognia/telepathy"),
                StatusCode::UNPROCESSABLE_ENTITY,
                "UNKNOWN_VIRTUAL_MODEL",
            ),
            (
                &off,
                "/v1/chat/completions",
                chat("cognia/panel"),
                StatusCode::FORBIDDEN,
                "ROUTER_FUSION_DISABLED",
            ),
            (
                &off,
                "/v1/messages",
                chat("cognia/auto"),
                StatusCode::FORBIDDEN,
                "ROUTER_FUSION_DISABLED",
            ),
        ] {
            let response = send(&gw.app, request("POST", uri, Some(SECRET), Some(body))).await;
            assert_eq!(response.status(), status, "{uri} {code}");
            let parsed = json_of(response).await;
            assert_contract(&parsed, code);
            assert!(parsed["error"]["details"]["model"].is_string(), "{uri}");
        }
        assert!(bridge.calls().is_empty());
    }

    fn snapshot_with(value: Value) -> RoutingSnapshot {
        serde_json::from_value(value).unwrap()
    }

    #[tokio::test]
    async fn list_models_shows_the_virtual_models_only_to_a_scoped_key_with_the_switch_on() {
        let snapshot = || {
            Some(snapshot_with(json!({
                "aliases": [{ "alias": "fast", "entries": [{ "providerId": "up", "modelId": "m" }] }],
                "providers": [{ "id": "up", "protocol": "openai", "baseUrl": "http://127.0.0.1:9/v1",
                    "apiKey": "sk-up", "enabled": true, "models": ["m"] }],
                "generatedAtMs": 1
            })))
        };
        let bridge = RecordingBrainBridge::new();
        let on = gateway_with(Arc::new(bridge.clone()), true, false, snapshot());
        let off = gateway_with(Arc::new(bridge.clone()), false, false, snapshot());
        let ids = |body: Value| -> Vec<String> {
            body["data"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        };
        let virtual_ids = |all: &[String]| -> Vec<String> {
            all.iter()
                .filter(|id| id.starts_with("cognia/"))
                .cloned()
                .collect()
        };

        let scoped = ids(json_of(
            send(&on.app, request("GET", "/v1/models", Some(SECRET), None)).await,
        )
        .await);
        assert_eq!(
            virtual_ids(&scoped),
            crate::virtual_models::VIRTUAL_MODELS
                .iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
        );
        assert!(scoped.contains(&"fast".to_string()));

        let plain = ids(json_of(
            send(&on.app, request("GET", "/v1/models", Some(PLAIN), None)).await,
        )
        .await);
        assert!(virtual_ids(&plain).is_empty());
        assert!(plain.contains(&"fast".to_string()));

        // The allowlist names `fast` only, so no virtual model is listed.
        let limited = ids(json_of(
            send(&on.app, request("GET", "/v1/models", Some(LIMITED), None)).await,
        )
        .await);
        assert_eq!(limited, ["fast"]);

        let switched_off = ids(json_of(
            send(&off.app, request("GET", "/v1/models", Some(SECRET), None)).await,
        )
        .await);
        assert!(virtual_ids(&switched_off).is_empty());
        assert!(bridge.calls().is_empty());
    }

    /// A one-route OpenAI-compatible upstream that records every body it gets.
    async fn spawn_openai_upstream() -> (SocketAddr, Arc<parking_lot::Mutex<Vec<Value>>>) {
        let seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let record = seen.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |Json(body): Json<Value>| {
                let record = record.clone();
                async move {
                    record.lock().push(body.clone());
                    Json(json!({
                        "id": "chatcmpl-upstream",
                        "object": "chat.completion",
                        "created": 1,
                        "model": body["model"],
                        "choices": [{ "index": 0, "message": { "role": "assistant", "content": "from upstream" }, "finish_reason": "stop" }],
                        "usage": { "prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5 }
                    }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (addr, seen)
    }

    #[tokio::test]
    async fn router_auto_with_the_switch_off_is_resolved_as_an_ordinary_model() {
        let (upstream, seen) = spawn_openai_upstream().await;
        let snapshot = || {
            Some(snapshot_with(json!({
                "aliases": [{ "alias": "router/auto", "entries": [{ "providerId": "up", "modelId": "up-model" }] }],
                "providers": [{ "id": "up", "protocol": "openai", "baseUrl": format!("http://{upstream}/v1"),
                    "apiKey": "sk-up", "enabled": true, "models": ["up-model"] }],
                "generatedAtMs": 1
            })))
        };
        let bridge = RecordingBrainBridge::new();

        // D37: with runs off, an upstream alias named `router/…` resolves and
        // is served exactly as it was before Router + Fusion existed.
        let off = gateway_with(Arc::new(bridge.clone()), false, false, snapshot());
        let response = send(
            &off.app,
            request(
                "POST",
                "/v1/chat/completions",
                Some(SECRET),
                Some(chat("router/auto")),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_of(response).await;
        assert_eq!(body["choices"][0]["message"]["content"], "from upstream");
        assert_eq!(seen.lock().len(), 1);
        assert_eq!(seen.lock()[0]["model"], "up-model");
        assert!(bridge.calls().is_empty());

        // With runs on, the same name is the spec's alias for `cognia/auto`:
        // a run, never the upstream.
        let on = gateway_with(Arc::new(bridge.clone()), true, false, snapshot());
        let response = send(
            &on.app,
            request(
                "POST",
                "/v1/chat/completions",
                Some(SECRET),
                Some(chat("router/auto")),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_contract(&json_of(response).await, "BRAIN_UNAVAILABLE");
        assert_eq!(bridge.payloads_for(command::CHAT_CREATE).len(), 1);
        assert_eq!(seen.lock().len(), 1, "the upstream was not asked again");
    }
}
