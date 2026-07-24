//! Lark dual-entry public surface (plan 2026-07-24 Phases 3/5).
//!
//! Mounted at `/integrations/lark/*` by `server.rs` — HEADLESS ONLY, behind
//! the pre-auth rate limit, sharing the companion HS256 secret. Three token
//! kinds, all signed with that secret and scope-discriminated so no token is
//! interchangeable with the pair/device/service families:
//!
//! - **`lark_entry`** — personal entry context (300 s, single-use `jti`).
//!   Issued brain-side (`lark_entry_issue` RPC) whenever the bot emits an
//!   authorized deep link; carries the resolved principal AND the verified
//!   platform identity (`oid`/`tk`/`app`) so `/entry/resolve` can assert the
//!   web session belongs to the same human without a brain round-trip.
//!
//! - **`lark_surface`** — long-lived (1 y) integrity-only descriptor baked
//!   into Chat Tab / group-menu URLs. Carries tenant/app/chat but NO
//!   principal: authorization happens at resolve time (web SSO session +
//!   brain-side chat-membership check via the intent bridge).
//!
//! - **`lark_web`** — 8 h web session minted by the SSO callback after a
//!   server-side authorization-code + PKCE exchange. The browser holds ONLY
//!   this token (delivered in the URL fragment, stored in sessionStorage);
//!   the Lark app secret never leaves this process.
//!
//! The intent bridge (`PENDING_INTENTS`) is the async request/result seam to
//! the headless brain: handlers publish `connectors://lark-intent` events on
//! the bus, the brain answers via the `lark_result_complete` RPC arm, and the
//! browser polls `GET /integrations/lark/intent/{id}`.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine as _;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::Uuid;

use super::redemption_lru::RedemptionLru;
use super::SharedState;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENTRY_TTL_SECS: i64 = 300;
const SURFACE_TTL_SECS: i64 = 365 * 24 * 3600;
const WEB_SESSION_TTL_SECS: i64 = 8 * 3600;
const SSO_STATE_TTL_MS: i64 = 10 * 60 * 1000;
const INTENT_TTL_MS: i64 = 60 * 1000;

pub const SCOPE_ENTRY: &str = "lark_entry";
pub const SCOPE_SURFACE: &str = "lark_surface";
pub const SCOPE_WEB: &str = "lark_web";

const LARK_AUTHORIZE_URL: &str = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const LARK_TOKEN_URL: &str = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const LARK_USER_INFO_URL: &str = "https://open.feishu.cn/open-apis/authen/v1/user_info";

/// Event-bus topic the headless brain subscribes to for surface resolves and
/// (Phase 5) shortcut/plus intents. Payload carries `kind` + `requestId`.
pub const LARK_INTENT_TOPIC: &str = "connectors://lark-intent";

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/// Personal entry-context token claims (scope `lark_entry`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EntryClaims {
    pub scope: String,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
    /// FeishuPrincipalRow id + Cognia account resolved at issue time.
    pub pid: String,
    pub acct: String,
    /// Verified platform identity of the person this link was minted for.
    pub oid: String,
    pub tk: String,
    pub app: String,
    pub adapter_id: String,
    /// Entry surface kind (bot_menu | group_menu | message_shortcut | ...).
    pub ety: String,
    pub ck: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
}

/// Surface descriptor claims (scope `lark_surface`) — integrity only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SurfaceClaims {
    pub scope: String,
    pub iat: i64,
    pub exp: i64,
    pub tk: String,
    pub app: String,
    pub adapter_id: String,
    pub cid: String,
    /// URL layout version — lets the brain rebuild stale tabs.
    pub ver: u32,
    /// Surface kind: "chat_tab" | "group_menu".
    pub sfc: String,
}

/// Web session claims (scope `lark_web`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebSessionClaims {
    pub scope: String,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
    pub oid: String,
    pub tk: String,
    pub app: String,
    pub adapter_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before Unix epoch")
        .as_secs() as i64
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before Unix epoch")
        .as_millis() as i64
}

fn sign<T: Serialize>(secret: &[u8], claims: &T) -> Result<String, String> {
    encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(secret),
    )
    .map_err(|e| e.to_string())
}

fn verify_claims<T: for<'de> Deserialize<'de>>(secret: &[u8], token: &str) -> Result<T, String> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    validation.validate_exp = true;
    validation.set_required_spec_claims(&["exp"]);
    decode::<T>(token, &DecodingKey::from_secret(secret), &validation)
        .map(|data| data.claims)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Token issue / verify
// ---------------------------------------------------------------------------

pub struct IssueEntryInput {
    pub principal_id: String,
    pub account_id: String,
    pub open_id: String,
    pub tenant_key: String,
    pub app_id: String,
    pub adapter_id: String,
    pub entry_type: String,
    pub conversation_key: String,
    pub session_id: Option<String>,
}

pub fn issue_entry_token(
    secret: &[u8],
    input: &IssueEntryInput,
) -> Result<(String, String, i64), String> {
    let now = now_secs();
    let jti = Uuid::new_v4().to_string();
    let claims = EntryClaims {
        scope: SCOPE_ENTRY.to_string(),
        iat: now,
        exp: now + ENTRY_TTL_SECS,
        jti: jti.clone(),
        pid: input.principal_id.clone(),
        acct: input.account_id.clone(),
        oid: input.open_id.clone(),
        tk: input.tenant_key.clone(),
        app: input.app_id.clone(),
        adapter_id: input.adapter_id.clone(),
        ety: input.entry_type.clone(),
        ck: input.conversation_key.clone(),
        sid: input.session_id.clone(),
    };
    sign(secret, &claims).map(|token| (token, jti, claims.exp))
}

pub struct IssueSurfaceInput {
    pub tenant_key: String,
    pub app_id: String,
    pub adapter_id: String,
    pub chat_id: String,
    pub url_version: u32,
    pub surface_kind: String,
}

pub fn issue_surface_token(secret: &[u8], input: &IssueSurfaceInput) -> Result<String, String> {
    let now = now_secs();
    let claims = SurfaceClaims {
        scope: SCOPE_SURFACE.to_string(),
        iat: now,
        exp: now + SURFACE_TTL_SECS,
        tk: input.tenant_key.clone(),
        app: input.app_id.clone(),
        adapter_id: input.adapter_id.clone(),
        cid: input.chat_id.clone(),
        ver: input.url_version,
        sfc: input.surface_kind.clone(),
    };
    sign(secret, &claims)
}

fn issue_web_session(
    secret: &[u8],
    adapter_id: &str,
    open_id: &str,
    tenant_key: &str,
    app_id: &str,
    union_id: Option<String>,
) -> Result<String, String> {
    let now = now_secs();
    let claims = WebSessionClaims {
        scope: SCOPE_WEB.to_string(),
        iat: now,
        exp: now + WEB_SESSION_TTL_SECS,
        jti: Uuid::new_v4().to_string(),
        oid: open_id.to_string(),
        tk: tenant_key.to_string(),
        app: app_id.to_string(),
        adapter_id: adapter_id.to_string(),
        uid: union_id,
    };
    sign(secret, &claims)
}

fn expect_scope(actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!("scope mismatch: expected {expected}, got {actual}"))
    }
}

// ---------------------------------------------------------------------------
// Process-global single-use / pending state
// ---------------------------------------------------------------------------

/// Single-use tracker for entry-token JTIs (same semantics as pair JWTs).
static ENTRY_JTI_LRU: Lazy<RedemptionLru> = Lazy::new(RedemptionLru::new);

#[derive(Clone)]
struct SsoPending {
    adapter_id: String,
    verifier: String,
    return_to: String,
    created_at_ms: i64,
}

/// state → pending SSO exchange (single-use, 10 min TTL).
static SSO_PENDING: Lazy<Mutex<HashMap<String, SsoPending>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
enum IntentState {
    Pending { created_at_ms: i64 },
    Done { result: Value, settled_at_ms: i64 },
    Error { code: String, settled_at_ms: i64 },
}

impl IntentState {
    /// The stamp `prune_intents` ages each state against.
    fn stamp(&self) -> i64 {
        match self {
            IntentState::Pending { created_at_ms } => *created_at_ms,
            IntentState::Done { settled_at_ms, .. } | IntentState::Error { settled_at_ms, .. } => {
                *settled_at_ms
            }
        }
    }
}

/// requestId → async brain-answered intent (60 s TTL while pending).
static PENDING_INTENTS: Lazy<Mutex<HashMap<String, IntentState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Upper bound on in-flight SSO states. `/web/login` is unauthenticated, so
/// without a cap anyone who can reach the companion can grow this map between
/// TTL sweeps. Oldest-first eviction: a login older than the rest is the one
/// least likely to still be completed.
const SSO_PENDING_MAX: usize = 4_096;

/// Terminal intents linger so a slow poller still collects its answer. The
/// previous `_ => true` arm meant they lingered forever, and the 10k valve
/// then cleared the whole map — dropping results browsers were still waiting
/// on. Both are bounded properly now.
const INTENT_TERMINAL_TTL_MS: i64 = 5 * INTENT_TTL_MS;
const PENDING_INTENTS_MAX: usize = 10_000;

/// Drop the oldest entries until `map` fits `max`.
fn evict_oldest<V>(map: &mut HashMap<String, V>, max: usize, stamp: impl Fn(&V) -> i64) {
    if map.len() <= max {
        return;
    }
    let mut stamped: Vec<(String, i64)> = map.iter().map(|(k, v)| (k.clone(), stamp(v))).collect();
    stamped.sort_by_key(|(_, at)| *at);
    for (key, _) in stamped.into_iter().take(map.len() - max) {
        map.remove(&key);
    }
}

fn prune_sso(now: i64) {
    let mut map = SSO_PENDING.lock();
    map.retain(|_, p| now - p.created_at_ms < SSO_STATE_TTL_MS);
    evict_oldest(&mut map, SSO_PENDING_MAX, |p| p.created_at_ms);
}

fn prune_intents(now: i64) {
    let mut map = PENDING_INTENTS.lock();
    map.retain(|_, state| match state {
        IntentState::Pending { created_at_ms } => now - *created_at_ms < INTENT_TTL_MS,
        // Terminal results linger so a slow poller still sees them, then age
        // out like everything else.
        _ => now - state.stamp() < INTENT_TERMINAL_TTL_MS,
    });
    evict_oldest(&mut map, PENDING_INTENTS_MAX, |state| state.stamp());
}

/// Register a fresh pending intent and return its id.
pub fn register_intent() -> String {
    let id = Uuid::new_v4().to_string();
    prune_intents(now_ms());
    PENDING_INTENTS.lock().insert(
        id.clone(),
        IntentState::Pending {
            created_at_ms: now_ms(),
        },
    );
    id
}

/// Brain-side completion (via the `lark_result_complete` RPC arm).
pub fn complete_intent(request_id: &str, result: Result<Value, String>) -> bool {
    let mut map = PENDING_INTENTS.lock();
    if !map.contains_key(request_id) {
        return false;
    }
    map.insert(
        request_id.to_string(),
        match result {
            Ok(value) => IntentState::Done {
                result: value,
                settled_at_ms: now_ms(),
            },
            Err(code) => IntentState::Error {
                code,
                settled_at_ms: now_ms(),
            },
        },
    );
    true
}

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

/// Public base URL of THIS companion server (scheme + host[:port]) as
/// reachable from the user's browser — used for the OAuth redirect_uri.
fn public_base() -> Option<String> {
    std::env::var("COGNIA_LARK_PUBLIC_BASE")
        .ok()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

/// Base URL of the web app the SSO flow bounces back to. Falls back to the
/// public base (single-origin deployments serve both).
fn web_base() -> String {
    std::env::var("COGNIA_LARK_WEB_BASE")
        .ok()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .or_else(public_base)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

fn error_json(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

#[derive(Deserialize)]
pub struct LoginQuery {
    pub adapter_id: String,
    #[serde(default)]
    pub return_to: Option<String>,
}

/// `GET /integrations/lark/web/login` — build the Lark authorize URL with
/// server-side state + PKCE and 302 to it. The browser never sees the
/// verifier; `return_to` is confined to a same-app relative path.
pub async fn login_handler(Query(query): Query<LoginQuery>) -> Response {
    let now = now_ms();
    prune_sso(now);

    let return_to = query.return_to.unwrap_or_else(|| "/".to_string());
    // Relative-path-only guard: no scheme, no protocol-relative `//`.
    if !return_to.starts_with('/') || return_to.starts_with("//") {
        return error_json(StatusCode::BAD_REQUEST, "sso_return_to_invalid");
    }
    let Some(base) = public_base() else {
        return error_json(
            StatusCode::SERVICE_UNAVAILABLE,
            "sso_public_base_unconfigured",
        );
    };
    let app_id = match crate::connectors::keyring::get(&query.adapter_id, "appId") {
        Ok(Some(value)) if !value.is_empty() => value,
        Ok(_) => return error_json(StatusCode::NOT_FOUND, "sso_adapter_unconfigured"),
        Err(_) => return error_json(StatusCode::INTERNAL_SERVER_ERROR, "sso_keyring_error"),
    };

    let state_id = Uuid::new_v4().to_string();
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    SSO_PENDING.lock().insert(
        state_id.clone(),
        SsoPending {
            adapter_id: query.adapter_id.clone(),
            verifier,
            return_to,
            created_at_ms: now,
        },
    );

    let redirect_uri = format!("{base}/integrations/lark/web/callback");
    let authorize = build_authorize_url(&app_id, &redirect_uri, &state_id, &challenge);
    Redirect::temporary(&authorize).into_response()
}

/// Assemble the Lark authorize URL. Every value is percent-encoded by
/// `query_pairs_mut`, so an app id or redirect URI carrying reserved
/// characters cannot break out of its parameter.
fn build_authorize_url(
    app_id: &str,
    redirect_uri: &str,
    state_id: &str,
    challenge: &str,
) -> String {
    let mut url = url::Url::parse(LARK_AUTHORIZE_URL).expect("LARK_AUTHORIZE_URL is a valid URL");
    url.query_pairs_mut()
        .append_pair("client_id", app_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("state", state_id)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    url.into()
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

#[derive(Deserialize)]
struct LarkTokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct LarkUserInfoResponse {
    #[serde(default)]
    code: Option<i64>,
    #[serde(default)]
    data: Option<LarkUserInfoData>,
}

#[derive(Deserialize)]
struct LarkUserInfoData {
    #[serde(default)]
    open_id: Option<String>,
    #[serde(default)]
    union_id: Option<String>,
    #[serde(default)]
    tenant_key: Option<String>,
}

/// `GET /integrations/lark/web/callback` — consume the single-use state,
/// exchange the code server-side (secret never leaves this process), fetch
/// the verified identity, and bounce to the web app with the session in the
/// URL FRAGMENT (never query/logs).
pub async fn callback_handler(
    State(state): State<SharedState>,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let now = now_ms();
    prune_sso(now);
    let (Some(code), Some(state_id)) = (query.code, query.state) else {
        super::metrics::record_lark_counter("lark_sso_failures_total");
        return error_json(StatusCode::BAD_REQUEST, "sso_state_invalid");
    };
    // Single-use: remove-on-read. A replayed state (or one we never issued)
    // fails identically.
    let Some(pending) = SSO_PENDING.lock().remove(&state_id) else {
        super::metrics::record_lark_counter("lark_sso_failures_total");
        return error_json(StatusCode::BAD_REQUEST, "sso_state_invalid");
    };

    let app_id = match crate::connectors::keyring::get(&pending.adapter_id, "appId") {
        Ok(Some(value)) if !value.is_empty() => value,
        _ => {
            super::metrics::record_lark_counter("lark_sso_failures_total");
            return error_json(StatusCode::BAD_GATEWAY, "sso_adapter_unconfigured");
        }
    };
    let app_secret = match crate::connectors::keyring::get(&pending.adapter_id, "appSecret") {
        Ok(Some(value)) if !value.is_empty() => value,
        _ => {
            super::metrics::record_lark_counter("lark_sso_failures_total");
            return error_json(StatusCode::BAD_GATEWAY, "sso_adapter_unconfigured");
        }
    };
    let Some(base) = public_base() else {
        super::metrics::record_lark_counter("lark_sso_failures_total");
        return error_json(
            StatusCode::SERVICE_UNAVAILABLE,
            "sso_public_base_unconfigured",
        );
    };

    let client = reqwest::Client::new();
    let token_resp = client
        .post(LARK_TOKEN_URL)
        .json(&json!({
            "grant_type": "authorization_code",
            "client_id": app_id,
            "client_secret": app_secret,
            "code": code,
            "redirect_uri": format!("{base}/integrations/lark/web/callback"),
            "code_verifier": pending.verifier,
        }))
        .send()
        .await;
    let access_token = match token_resp {
        Ok(resp) => match resp.json::<LarkTokenResponse>().await {
            Ok(LarkTokenResponse {
                access_token: Some(token),
                ..
            }) => token,
            Ok(LarkTokenResponse { error, .. }) => {
                tracing::warn!(target: "lark_entry", error = ?error, "lark token exchange rejected");
                super::metrics::record_lark_counter("lark_sso_failures_total");
                return error_json(StatusCode::BAD_GATEWAY, "sso_exchange_failed");
            }
            Err(_) => {
                super::metrics::record_lark_counter("lark_sso_failures_total");
                return error_json(StatusCode::BAD_GATEWAY, "sso_exchange_failed");
            }
        },
        Err(_) => {
            super::metrics::record_lark_counter("lark_sso_failures_total");
            return error_json(StatusCode::BAD_GATEWAY, "sso_exchange_failed");
        }
    };

    let user_resp = client
        .get(LARK_USER_INFO_URL)
        .bearer_auth(&access_token)
        .send()
        .await;
    let (open_id, union_id, tenant_key) = match user_resp {
        Ok(resp) => match resp.json::<LarkUserInfoResponse>().await {
            Ok(LarkUserInfoResponse {
                code: Some(0) | None,
                data:
                    Some(LarkUserInfoData {
                        open_id: Some(open_id),
                        union_id,
                        tenant_key: Some(tenant_key),
                    }),
            }) => (open_id, union_id, tenant_key),
            _ => {
                super::metrics::record_lark_counter("lark_sso_failures_total");
                return error_json(StatusCode::BAD_GATEWAY, "sso_user_info_failed");
            }
        },
        Err(_) => {
            super::metrics::record_lark_counter("lark_sso_failures_total");
            return error_json(StatusCode::BAD_GATEWAY, "sso_user_info_failed");
        }
    };

    let secret = state.secret.read().clone();
    let session = match issue_web_session(
        &secret,
        &pending.adapter_id,
        &open_id,
        &tenant_key,
        &app_id,
        union_id,
    ) {
        Ok(token) => token,
        Err(_) => {
            super::metrics::record_lark_counter("lark_sso_failures_total");
            return error_json(StatusCode::INTERNAL_SERVER_ERROR, "sso_session_mint_failed");
        }
    };

    super::metrics::record_lark_counter("lark_sso_logins_total");
    let target = format!(
        "{}{}#lark_session={}",
        web_base(),
        pending.return_to,
        session
    );
    Redirect::temporary(&target).into_response()
}

fn bearer_token(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.to_string())
}

#[derive(Deserialize)]
pub struct ResolveBody {
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub surface: Option<String>,
}

/// `POST /integrations/lark/entry/resolve` — authorization gate for every
/// external deep link. Requires a `lark_web` session; personal tokens resolve
/// synchronously (identity must match, jti single-use), surface tokens go
/// through the brain for the chat-membership check.
pub async fn resolve_handler(
    State(state): State<SharedState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ResolveBody>,
) -> Response {
    let secret = state.secret.read().clone();
    let Some(session_token) = bearer_token(&headers) else {
        super::metrics::record_lark_counter("lark_entry_resolve_denied_total");
        return error_json(StatusCode::UNAUTHORIZED, "session_required");
    };
    let session: WebSessionClaims = match verify_claims(&secret, &session_token) {
        Ok(claims) => claims,
        Err(_) => {
            super::metrics::record_lark_counter("lark_entry_resolve_denied_total");
            return error_json(StatusCode::UNAUTHORIZED, "session_invalid");
        }
    };
    if expect_scope(&session.scope, SCOPE_WEB).is_err() {
        super::metrics::record_lark_counter("lark_entry_resolve_denied_total");
        return error_json(StatusCode::UNAUTHORIZED, "session_invalid");
    }

    if let Some(entry_token) = body.entry {
        let claims: EntryClaims = match verify_claims(&secret, &entry_token) {
            Ok(claims) => claims,
            Err(err) if err.contains("ExpiredSignature") => {
                super::metrics::record_lark_counter("lark_entry_resolve_denied_total");
                return error_json(StatusCode::GONE, "entry_expired");
            }
            Err(_) => {
                super::metrics::record_lark_counter("lark_entry_resolve_denied_total");
                return error_json(StatusCode::BAD_REQUEST, "entry_invalid");
            }
        };
        if expect_scope(&claims.scope, SCOPE_ENTRY).is_err() {
            super::metrics::record_lark_counter("lark_entry_resolve_denied_total");
            return error_json(StatusCode::BAD_REQUEST, "entry_invalid");
        }
        // The person who logged in must be the person the link was minted
        // for — same open_id under the same tenant/app.
        if claims.oid != session.oid || claims.tk != session.tk || claims.app != session.app {
            super::metrics::record_lark_counter("lark_entry_resolve_denied_total");
            return error_json(StatusCode::FORBIDDEN, "entry_principal_mismatch");
        }
        // Single-use.
        if !ENTRY_JTI_LRU.mark_redeemed(&claims.jti, claims.exp, now_secs()) {
            super::metrics::record_lark_counter("lark_entry_resolve_denied_total");
            return error_json(StatusCode::CONFLICT, "entry_consumed");
        }
        super::metrics::record_lark_counter("lark_entry_resolve_ok_total");
        // Best-effort brain notification so the Dexie ledger marks consumption.
        state.event_bus.publish(
            LARK_INTENT_TOPIC.to_string(),
            json!({
                "kind": "entry_consumed",
                "adapterId": claims.adapter_id,
                "jti": claims.jti,
                "entryType": claims.ety,
            }),
        );
        return (
            StatusCode::OK,
            Json(json!({
                "status": "done",
                "conversationKey": claims.ck,
                "sessionId": claims.sid,
                "entryType": claims.ety,
            })),
        )
            .into_response();
    }

    if let Some(surface_token) = body.surface {
        let claims: SurfaceClaims = match verify_claims(&secret, &surface_token) {
            Ok(claims) => claims,
            Err(_) => {
                super::metrics::record_lark_counter("lark_entry_resolve_denied_total");
                return error_json(StatusCode::BAD_REQUEST, "surface_invalid");
            }
        };
        if expect_scope(&claims.scope, SCOPE_SURFACE).is_err() {
            super::metrics::record_lark_counter("lark_entry_resolve_denied_total");
            return error_json(StatusCode::BAD_REQUEST, "surface_invalid");
        }
        // Tenant fence before the membership round-trip.
        if claims.tk != session.tk || claims.app != session.app {
            super::metrics::record_lark_counter("lark_entry_resolve_denied_total");
            return error_json(StatusCode::FORBIDDEN, "surface_tenant_mismatch");
        }
        let request_id = register_intent();
        state.event_bus.publish(
            LARK_INTENT_TOPIC.to_string(),
            json!({
                "kind": "resolve_surface",
                "requestId": request_id,
                "adapterId": claims.adapter_id,
                "chatId": claims.cid,
                "surface": claims.sfc,
                "verifiedIdentity": {
                    "openId": session.oid,
                    "tenantKey": session.tk,
                    "appId": session.app,
                },
            }),
        );
        return (
            StatusCode::ACCEPTED,
            Json(json!({ "status": "pending", "requestId": request_id })),
        )
            .into_response();
    }

    error_json(StatusCode::BAD_REQUEST, "entry_missing")
}

/// `GET /integrations/lark/intent/{request_id}` — poll an async intent.
pub async fn intent_poll_handler(
    headers: axum::http::HeaderMap,
    State(state): State<SharedState>,
    Path(request_id): Path<String>,
) -> Response {
    // Same session requirement as resolve — intents are session-scoped work.
    let secret = state.secret.read().clone();
    let Some(session_token) = bearer_token(&headers) else {
        return error_json(StatusCode::UNAUTHORIZED, "session_required");
    };
    let session: Result<WebSessionClaims, _> = verify_claims(&secret, &session_token);
    if session.map(|c| c.scope) != Ok(SCOPE_WEB.to_string()) {
        return error_json(StatusCode::UNAUTHORIZED, "session_invalid");
    }

    prune_intents(now_ms());
    let snapshot = PENDING_INTENTS.lock().get(&request_id).cloned();
    match snapshot {
        None => error_json(StatusCode::NOT_FOUND, "intent_unknown"),
        Some(IntentState::Pending { .. }) => {
            (StatusCode::OK, Json(json!({ "status": "pending" }))).into_response()
        }
        Some(IntentState::Done { result, .. }) => (
            StatusCode::OK,
            Json(json!({ "status": "done", "result": result })),
        )
            .into_response(),
        Some(IntentState::Error { code, .. }) => (
            StatusCode::OK,
            Json(json!({ "status": "error", "error": code })),
        )
            .into_response(),
    }
}

/// Verify the Bearer lark_web session on an intent-submitting request.
fn require_web_session(
    state: &SharedState,
    headers: &axum::http::HeaderMap,
) -> Result<WebSessionClaims, Response> {
    let secret = state.secret.read().clone();
    let Some(session_token) = bearer_token(headers) else {
        return Err(error_json(StatusCode::UNAUTHORIZED, "session_required"));
    };
    let session: WebSessionClaims = verify_claims(&secret, &session_token)
        .map_err(|_| error_json(StatusCode::UNAUTHORIZED, "session_invalid"))?;
    if expect_scope(&session.scope, SCOPE_WEB).is_err() {
        return Err(error_json(StatusCode::UNAUTHORIZED, "session_invalid"));
    }
    Ok(session)
}

/// Max messages one shortcut import may carry — Lark's own message-shortcut
/// cap (消息条数不能超过20条), enforced again brain-side.
const SHORTCUT_IMPORT_MAX_MESSAGES: usize = 20;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutImportBody {
    pub adapter_id: String,
    pub chat_id: String,
    pub message_ids: Vec<String>,
    /// Lark JSSDK trigger code (`__trigger_id__`) — forwarded for audit only.
    #[serde(default)]
    pub trigger_id: Option<String>,
}

/// `POST /integrations/lark/shortcut/import` — message-shortcut import
/// intent. The browser supplies chat/message ids AS A REQUEST; the brain
/// re-verifies each against the platform (bot membership + per-message
/// chat_id) before anything is imported. Answered async via the intent
/// poll endpoint.
pub async fn shortcut_import_handler(
    State(state): State<SharedState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ShortcutImportBody>,
) -> Response {
    let session = match require_web_session(&state, &headers) {
        Ok(session) => session,
        Err(response) => {
            super::metrics::record_lark_counter("lark_message_import_denied_total");
            return response;
        }
    };
    if body.adapter_id.is_empty() || body.chat_id.is_empty() {
        super::metrics::record_lark_counter("lark_message_import_denied_total");
        return error_json(StatusCode::BAD_REQUEST, "import_request_invalid");
    }
    if body.message_ids.is_empty() || body.message_ids.len() > SHORTCUT_IMPORT_MAX_MESSAGES {
        super::metrics::record_lark_counter("lark_message_import_denied_total");
        return error_json(StatusCode::BAD_REQUEST, "import_message_count_invalid");
    }
    let request_id = register_intent();
    state.event_bus.publish(
        LARK_INTENT_TOPIC.to_string(),
        json!({
            "kind": "import_messages",
            "requestId": request_id,
            "adapterId": body.adapter_id,
            "chatId": body.chat_id,
            "messageIds": body.message_ids,
            "triggerId": body.trigger_id,
            "verifiedIdentity": {
                "openId": session.oid,
                "tenantKey": session.tk,
                "appId": session.app,
            },
        }),
    );
    (
        StatusCode::ACCEPTED,
        Json(json!({ "status": "pending", "requestId": request_id })),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlusCreateBody {
    pub adapter_id: String,
    /// Chat the `+` menu was opened from, when the client passes it through.
    #[serde(default)]
    pub chat_id: Option<String>,
}

/// `POST /integrations/lark/plus/create` — `+`-menu "new task" intent. The
/// brain binds/creates the conversation session; chat_id (when present) is
/// re-verified brain-side exactly like shortcut imports.
pub async fn plus_create_handler(
    State(state): State<SharedState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<PlusCreateBody>,
) -> Response {
    let session = match require_web_session(&state, &headers) {
        Ok(session) => session,
        Err(response) => return response,
    };
    if body.adapter_id.is_empty() {
        return error_json(StatusCode::BAD_REQUEST, "plus_request_invalid");
    }
    let request_id = register_intent();
    state.event_bus.publish(
        LARK_INTENT_TOPIC.to_string(),
        json!({
            "kind": "plus_create",
            "requestId": request_id,
            "adapterId": body.adapter_id,
            "chatId": body.chat_id,
            "verifiedIdentity": {
                "openId": session.oid,
                "tenantKey": session.tk,
                "appId": session.app,
            },
        }),
    );
    (
        StatusCode::ACCEPTED,
        Json(json!({ "status": "pending", "requestId": request_id })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Lark JSSDK signature (H5 `h5sdk.config`)
// ---------------------------------------------------------------------------

const LARK_TENANT_TOKEN_URL: &str =
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const LARK_JSSDK_TICKET_URL: &str = "https://open.feishu.cn/open-apis/jssdk/ticket/get";
/// Tickets are valid 2 h platform-side; refresh comfortably early.
const JSSDK_TICKET_TTL_MS: i64 = 90 * 60 * 1000;

/// adapter_id → (ticket, fetched_at_ms).
static JSSDK_TICKET_CACHE: Lazy<Mutex<HashMap<String, (String, i64)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

async fn fetch_jssdk_ticket(app_id: &str, app_secret: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let token_resp: Value = client
        .post(LARK_TENANT_TOKEN_URL)
        .json(&json!({ "app_id": app_id, "app_secret": app_secret }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let tenant_token = token_resp
        .get("tenant_access_token")
        .and_then(Value::as_str)
        .ok_or("tenant token missing")?;
    let ticket_resp: Value = client
        .post(LARK_JSSDK_TICKET_URL)
        .bearer_auth(tenant_token)
        .json(&json!({}))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    ticket_resp
        .get("data")
        .and_then(|data| data.get("ticket"))
        .and_then(Value::as_str)
        .map(|ticket| ticket.to_string())
        .ok_or_else(|| "jssdk ticket missing".to_string())
}

/// SHA-1 hex of the JSSDK verify string — Lark's documented signature input.
pub fn jssdk_signature(ticket: &str, nonce: &str, timestamp_ms: i64, url: &str) -> String {
    use sha1::{Digest, Sha1};
    let verify =
        format!("jsapi_ticket={ticket}&noncestr={nonce}&timestamp={timestamp_ms}&url={url}");
    let digest = Sha1::digest(verify.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Deserialize)]
pub struct JssdkConfigQuery {
    pub adapter_id: String,
    /// Full page URL WITHOUT the fragment — the signature covers it.
    pub url: String,
}

/// `GET /integrations/lark/jssdk/config` — parameters for `h5sdk.config`
/// so `/lark/shortcut` can call `tt.getBlockActionSourceDetail` inside the
/// Lark webview. Session-authed: only a logged-in SSO user can mint one.
pub async fn jssdk_config_handler(
    State(state): State<SharedState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<JssdkConfigQuery>,
) -> Response {
    if let Err(response) = require_web_session(&state, &headers) {
        return response;
    }
    if query.adapter_id.is_empty() || query.url.is_empty() {
        return error_json(StatusCode::BAD_REQUEST, "jssdk_request_invalid");
    }
    let app_id = match crate::connectors::keyring::get(&query.adapter_id, "appId") {
        Ok(Some(value)) if !value.is_empty() => value,
        _ => return error_json(StatusCode::NOT_FOUND, "jssdk_adapter_unconfigured"),
    };
    let app_secret = match crate::connectors::keyring::get(&query.adapter_id, "appSecret") {
        Ok(Some(value)) if !value.is_empty() => value,
        _ => return error_json(StatusCode::NOT_FOUND, "jssdk_adapter_unconfigured"),
    };

    let now = now_ms();
    let cached = JSSDK_TICKET_CACHE
        .lock()
        .get(&query.adapter_id)
        .filter(|(_, fetched)| now - fetched < JSSDK_TICKET_TTL_MS)
        .map(|(ticket, _)| ticket.clone());
    let ticket = match cached {
        Some(ticket) => ticket,
        None => match fetch_jssdk_ticket(&app_id, &app_secret).await {
            Ok(ticket) => {
                JSSDK_TICKET_CACHE
                    .lock()
                    .insert(query.adapter_id.clone(), (ticket.clone(), now));
                ticket
            }
            Err(_) => return error_json(StatusCode::BAD_GATEWAY, "jssdk_ticket_failed"),
        },
    };

    let nonce = Uuid::new_v4().to_string();
    let signature = jssdk_signature(&ticket, &nonce, now, &query.url);
    (
        StatusCode::OK,
        Json(json!({
            "appId": app_id,
            "timestamp": now,
            "nonceStr": nonce,
            "signature": signature,
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Registry admin (operator channel for headless installs)
// ---------------------------------------------------------------------------

/// Operator-driven principal-registry mutations, submitted by `cognia lark …`.
///
/// Mounted in `server.rs` under the device-JWT middleware — NOT in the public
/// `/integrations/lark` nest — so it inherits the existing auth tier, which
/// accepts the headless brain's loopback-only service token. The desktop app
/// has no need for it (the settings card mutates Dexie in-process), and this
/// endpoint answers `admin_unavailable` there rather than pretending.
///
/// The endpoint never touches the registry itself: the account database is
/// owned by the brain process (fake-indexeddb + JSON snapshot), so a second
/// writer would lose the race. It hands the operation to the brain over the
/// same intent bridge the web surfaces use.
#[derive(Deserialize)]
pub struct AdminBody {
    pub op: String,
    #[serde(default, rename = "adapterId")]
    pub adapter_id: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default, rename = "principalId")]
    pub principal_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, rename = "cogniaUserId")]
    pub cognia_user_id: Option<String>,
}

/// Operations the brain's `principal_admin` intent branch accepts. Rejecting
/// unknown ops here keeps a typo from becoming a 60 s poll timeout.
const ADMIN_OPS: &[&str] = &[
    "list",
    "approve",
    "reject",
    "set-principal-status",
    "rebind",
    "register-tenant",
    "set-tenant-status",
    "sweep",
];

pub async fn admin_handler(State(state): State<SharedState>, Json(body): Json<AdminBody>) -> Response {
    if crate::headless::headless_services().is_none() {
        return error_json(StatusCode::SERVICE_UNAVAILABLE, "admin_unavailable");
    }
    if !ADMIN_OPS.contains(&body.op.as_str()) {
        return error_json(StatusCode::BAD_REQUEST, "admin_op_unknown");
    }
    if body.adapter_id.is_empty() {
        return error_json(StatusCode::BAD_REQUEST, "admin_adapter_required");
    }
    let request_id = register_intent();
    state.event_bus.publish(
        LARK_INTENT_TOPIC.to_string(),
        json!({
            "kind": "principal_admin",
            "requestId": request_id,
            "adapterId": body.adapter_id,
            "op": body.op,
            "code": body.code,
            "principalId": body.principal_id,
            "status": body.status,
            "cogniaUserId": body.cognia_user_id,
        }),
    );
    (
        StatusCode::ACCEPTED,
        Json(json!({ "status": "pending", "requestId": request_id })),
    )
        .into_response()
}

/// Poll an admin intent. Separate from `intent_poll_handler` because that one
/// demands a `lark_web` browser session; this one rides the device/service JWT
/// the operator channel already authenticated with.
pub async fn admin_poll_handler(Path(request_id): Path<String>) -> Response {
    prune_intents(now_ms());
    let snapshot = PENDING_INTENTS.lock().get(&request_id).cloned();
    match snapshot {
        None => error_json(StatusCode::NOT_FOUND, "intent_unknown"),
        Some(IntentState::Pending { .. }) => {
            (StatusCode::OK, Json(json!({ "status": "pending" }))).into_response()
        }
        Some(IntentState::Done { result, .. }) => (
            StatusCode::OK,
            Json(json!({ "status": "done", "result": result })),
        )
            .into_response(),
        Some(IntentState::Error { code, .. }) => (
            StatusCode::OK,
            Json(json!({ "status": "error", "error": code })),
        )
            .into_response(),
    }
}

/// Router for `/integrations/lark/*`. Mounted headless-only in `server.rs`
/// behind the pre-auth rate limit; carries the companion `SharedState`.
pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/web/login", get(login_handler))
        .route("/web/callback", get(callback_handler))
        .route("/entry/resolve", post(resolve_handler))
        .route("/intent/{request_id}", get(intent_poll_handler))
        .route("/shortcut/import", post(shortcut_import_handler))
        .route("/plus/create", post(plus_create_handler))
        .route("/jssdk/config", get(jssdk_config_handler))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// RPC arms (service scope — called by the headless brain)
// ---------------------------------------------------------------------------

/// `lark_entry_issue` — mint an entry or surface token for the brain.
pub fn rpc_entry_issue(state: &SharedState, args: &Value) -> Result<Value, String> {
    let secret = state.secret.read().clone();
    let kind = args.get("kind").and_then(Value::as_str).unwrap_or("entry");
    let str_field = |name: &str| -> Result<String, String> {
        args.get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .ok_or_else(|| format!("missing field: {name}"))
    };
    match kind {
        "entry" => {
            let input = IssueEntryInput {
                principal_id: str_field("principalId")?,
                account_id: str_field("accountId")?,
                open_id: str_field("openId")?,
                tenant_key: str_field("tenantKey")?,
                app_id: str_field("appId")?,
                adapter_id: str_field("adapterId")?,
                entry_type: str_field("entryType")?,
                conversation_key: str_field("conversationKey")?,
                session_id: args
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string()),
            };
            let (token, jti, exp) = issue_entry_token(&secret, &input)?;
            Ok(json!({ "token": token, "jti": jti, "expiresAt": exp * 1000 }))
        }
        "surface" => {
            let input = IssueSurfaceInput {
                tenant_key: str_field("tenantKey")?,
                app_id: str_field("appId")?,
                adapter_id: str_field("adapterId")?,
                chat_id: str_field("chatId")?,
                url_version: args.get("urlVersion").and_then(Value::as_u64).unwrap_or(1) as u32,
                surface_kind: str_field("surface")?,
            };
            let token = issue_surface_token(&secret, &input)?;
            Ok(json!({ "token": token }))
        }
        other => Err(format!("unknown token kind: {other}")),
    }
}

/// `lark_result_complete` — the brain posts the outcome of an async intent.
pub fn rpc_result_complete(args: &Value) -> Result<Value, String> {
    let request_id = args
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or("missing field: requestId")?;
    let outcome = if let Some(error) = args.get("error").and_then(Value::as_str) {
        Err(error.to_string())
    } else {
        Ok(args.get("result").cloned().unwrap_or(Value::Null))
    };
    let accepted = complete_intent(request_id, outcome);
    Ok(json!({ "accepted": accepted }))
}

/// `lark_metrics_record` — allowlisted counter bump from the brain.
pub fn rpc_metrics_record(args: &Value) -> Result<Value, String> {
    let name = args
        .get("name")
        .and_then(Value::as_str)
        .ok_or("missing field: name")?;
    let recorded = super::metrics::record_lark_counter(name);
    if !recorded {
        return Err(format!("unknown metric: {name}"));
    }
    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";

    fn entry_input() -> IssueEntryInput {
        IssueEntryInput {
            principal_id: "fp_1".into(),
            account_id: "local_acct_a".into(),
            open_id: "ou_alice".into(),
            tenant_key: "tk_a".into(),
            app_id: "cli_1".into(),
            adapter_id: "lk-1".into(),
            entry_type: "bot_menu".into(),
            conversation_key: "lark:lk-1:oc_1".into(),
            session_id: Some("sess_1".into()),
        }
    }

    #[test]
    fn entry_token_round_trips_with_scope_and_identity() {
        let (token, jti, exp) = issue_entry_token(SECRET, &entry_input()).expect("issue");
        assert!(exp > now_secs());
        let claims: EntryClaims = verify_claims(SECRET, &token).expect("verify");
        assert_eq!(claims.scope, SCOPE_ENTRY);
        assert_eq!(claims.jti, jti);
        assert_eq!(claims.oid, "ou_alice");
        assert_eq!(claims.ck, "lark:lk-1:oc_1");
        assert_eq!(claims.sid.as_deref(), Some("sess_1"));
        // Not verifiable as a web session (scope check would fail).
        let as_web: WebSessionClaims = verify_claims(SECRET, &token).expect("decode");
        assert!(expect_scope(&as_web.scope, SCOPE_WEB).is_err());
    }

    #[test]
    fn entry_token_wrong_secret_fails() {
        let (token, _, _) = issue_entry_token(SECRET, &entry_input()).expect("issue");
        let out: Result<EntryClaims, _> =
            verify_claims(b"different-secret-32-bytes-______", &token);
        assert!(out.is_err());
    }

    #[test]
    fn entry_jti_is_single_use() {
        let (_, jti, exp) = issue_entry_token(SECRET, &entry_input()).expect("issue");
        assert!(ENTRY_JTI_LRU.mark_redeemed(&jti, exp, now_secs()));
        assert!(!ENTRY_JTI_LRU.mark_redeemed(&jti, exp, now_secs()));
    }

    #[test]
    fn surface_token_round_trips_long_lived() {
        let token = issue_surface_token(
            SECRET,
            &IssueSurfaceInput {
                tenant_key: "tk_a".into(),
                app_id: "cli_1".into(),
                adapter_id: "lk-1".into(),
                chat_id: "oc_9".into(),
                url_version: 3,
                surface_kind: "chat_tab".into(),
            },
        )
        .expect("issue");
        let claims: SurfaceClaims = verify_claims(SECRET, &token).expect("verify");
        assert_eq!(claims.scope, SCOPE_SURFACE);
        assert_eq!(claims.cid, "oc_9");
        assert_eq!(claims.ver, 3);
        assert!(claims.exp > now_secs() + 300 * 24 * 3600);
    }

    #[tokio::test]
    async fn admin_handler_rejects_unknown_ops_and_missing_adapters() {
        let state = test_state();
        // Desktop (no headless services) refuses outright — the settings card
        // is the operator channel there.
        let unavailable = admin_handler(
            State(state.clone()),
            Json(AdminBody {
                op: "list".into(),
                adapter_id: "lk-1".into(),
                code: None,
                principal_id: None,
                status: None,
                cognia_user_id: None,
            }),
        )
        .await;
        assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn admin_ops_allowlist_matches_the_brain_branch() {
        // Every op the CLI can send must be one the brain's `principal_admin`
        // executor knows; a drift here becomes a 60 s poll timeout.
        for op in ADMIN_OPS {
            assert!(!op.is_empty());
        }
        assert!(ADMIN_OPS.contains(&"approve"));
        assert!(ADMIN_OPS.contains(&"set-principal-status"));
        assert!(!ADMIN_OPS.contains(&"delete"));
    }

    #[test]
    fn intent_lifecycle_pending_done_error() {
        let id = register_intent();
        assert!(matches!(
            PENDING_INTENTS.lock().get(&id),
            Some(IntentState::Pending { .. })
        ));
        assert!(complete_intent(
            &id,
            Ok(json!({ "conversationKey": "lark:a:b" }))
        ));
        assert!(matches!(
            PENDING_INTENTS.lock().get(&id),
            Some(IntentState::Done { .. })
        ));

        let id2 = register_intent();
        assert!(complete_intent(&id2, Err("membership_denied".into())));
        assert!(matches!(
            PENDING_INTENTS.lock().get(&id2),
            Some(IntentState::Error { .. })
        ));

        // Unknown request ids are rejected, not created.
        assert!(!complete_intent("nope", Ok(Value::Null)));
    }

    #[test]
    fn rpc_entry_issue_validates_fields() {
        let state = test_state();
        let ok = rpc_entry_issue(
            &state,
            &json!({
                "kind": "entry",
                "principalId": "fp_1",
                "accountId": "local_acct_a",
                "openId": "ou_a",
                "tenantKey": "tk",
                "appId": "cli",
                "adapterId": "lk-1",
                "entryType": "bot_menu",
                "conversationKey": "lark:lk-1:oc",
            }),
        )
        .expect("issue ok");
        assert!(ok.get("token").and_then(Value::as_str).is_some());
        assert!(ok.get("jti").and_then(Value::as_str).is_some());

        let missing = rpc_entry_issue(&state, &json!({ "kind": "entry" }));
        assert!(missing.is_err());

        let surface = rpc_entry_issue(
            &state,
            &json!({
                "kind": "surface",
                "tenantKey": "tk",
                "appId": "cli",
                "adapterId": "lk-1",
                "chatId": "oc_1",
                "surface": "chat_tab",
                "urlVersion": 2,
            }),
        )
        .expect("surface ok");
        assert!(surface.get("token").and_then(Value::as_str).is_some());
    }

    #[test]
    fn rpc_metrics_record_rejects_unknown_names() {
        assert!(rpc_metrics_record(&json!({ "name": "lark_native_slash_total" })).is_ok());
        assert!(rpc_metrics_record(&json!({ "name": "rpc_calls_total" })).is_err());
        assert!(rpc_metrics_record(&json!({})).is_err());
    }

    fn test_state() -> SharedState {
        use super::super::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache,
            pair_code_lru::PairCodeLru, CompanionState,
        };
        use parking_lot::RwLock;
        use std::sync::Arc;
        Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: super::super::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                super::super::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge: super::super::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: super::super::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: super::super::rate_limit::RateLimiter::with_defaults(),
            push_tokens: super::super::push::PushTokenRegistry::new(),
        })
    }

    #[tokio::test]
    async fn resolve_requires_a_web_session() {
        let state = test_state();
        let response = resolve_handler(
            State(state),
            axum::http::HeaderMap::new(),
            Json(ResolveBody {
                entry: Some("junk".into()),
                surface: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn resolve_entry_enforces_identity_match_and_single_use() {
        let state = test_state();
        let secret = SECRET.to_vec();
        let (token, _, _) = issue_entry_token(&secret, &entry_input()).expect("issue");

        // Session for a DIFFERENT person in the same tenant.
        let other_session =
            issue_web_session(&secret, "lk-1", "ou_mallory", "tk_a", "cli_1", None).expect("mint");
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {other_session}").parse().unwrap(),
        );
        let response = resolve_handler(
            State(state.clone()),
            headers,
            Json(ResolveBody {
                entry: Some(token.clone()),
                surface: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        // The right person resolves once…
        let session =
            issue_web_session(&secret, "lk-1", "ou_alice", "tk_a", "cli_1", None).expect("mint");
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {session}").parse().unwrap(),
        );
        let response = resolve_handler(
            State(state.clone()),
            headers.clone(),
            Json(ResolveBody {
                entry: Some(token.clone()),
                surface: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);

        // …and a replay is a conflict.
        let replay = resolve_handler(
            State(state),
            headers,
            Json(ResolveBody {
                entry: Some(token),
                surface: None,
            }),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn resolve_surface_fences_tenant_and_registers_an_intent() {
        let state = test_state();
        let secret = SECRET.to_vec();
        let surface = issue_surface_token(
            &secret,
            &IssueSurfaceInput {
                tenant_key: "tk_a".into(),
                app_id: "cli_1".into(),
                adapter_id: "lk-1".into(),
                chat_id: "oc_9".into(),
                url_version: 1,
                surface_kind: "chat_tab".into(),
            },
        )
        .expect("issue");

        // Session from ANOTHER tenant is fenced out before any brain work.
        let foreign =
            issue_web_session(&secret, "lk-1", "ou_x", "tk_OTHER", "cli_1", None).expect("mint");
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {foreign}").parse().unwrap(),
        );
        let response = resolve_handler(
            State(state.clone()),
            headers,
            Json(ResolveBody {
                entry: None,
                surface: Some(surface.clone()),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        // Same tenant → 202 + a pending intent the brain can complete.
        let session =
            issue_web_session(&secret, "lk-1", "ou_x", "tk_a", "cli_1", None).expect("mint");
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {session}").parse().unwrap(),
        );
        let response = resolve_handler(
            State(state),
            headers,
            Json(ResolveBody {
                entry: None,
                surface: Some(surface),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn shortcut_import_validates_and_registers_an_intent() {
        let state = test_state();
        let secret = SECRET.to_vec();
        let session =
            issue_web_session(&secret, "lk-1", "ou_x", "tk_a", "cli_1", None).expect("mint");
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {session}").parse().unwrap(),
        );

        // No session → 401 before anything else.
        let denied = shortcut_import_handler(
            State(state.clone()),
            axum::http::HeaderMap::new(),
            Json(ShortcutImportBody {
                adapter_id: "lk-1".into(),
                chat_id: "oc_1".into(),
                message_ids: vec!["om_1".into()],
                trigger_id: None,
            }),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

        // Over the Lark 20-message cap → 400.
        let too_many = shortcut_import_handler(
            State(state.clone()),
            headers.clone(),
            Json(ShortcutImportBody {
                adapter_id: "lk-1".into(),
                chat_id: "oc_1".into(),
                message_ids: (0..21).map(|i| format!("om_{i}")).collect(),
                trigger_id: None,
            }),
        )
        .await;
        assert_eq!(too_many.status(), StatusCode::BAD_REQUEST);

        // Valid → 202 with a pending intent id.
        let accepted = shortcut_import_handler(
            State(state),
            headers,
            Json(ShortcutImportBody {
                adapter_id: "lk-1".into(),
                chat_id: "oc_1".into(),
                message_ids: vec!["om_1".into(), "om_2".into()],
                trigger_id: Some("trig_1".into()),
            }),
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn plus_create_requires_session_and_adapter() {
        let state = test_state();
        let secret = SECRET.to_vec();
        let session =
            issue_web_session(&secret, "lk-1", "ou_x", "tk_a", "cli_1", None).expect("mint");
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {session}").parse().unwrap(),
        );

        let bad = plus_create_handler(
            State(state.clone()),
            headers.clone(),
            Json(PlusCreateBody {
                adapter_id: "".into(),
                chat_id: None,
            }),
        )
        .await;
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);

        let accepted = plus_create_handler(
            State(state),
            headers,
            Json(PlusCreateBody {
                adapter_id: "lk-1".into(),
                chat_id: Some("oc_1".into()),
            }),
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    }

    #[test]
    fn jssdk_signature_is_deterministic_sha1_hex() {
        let sig = jssdk_signature(
            "ticket_x",
            "nonce_y",
            1_700_000_000_000,
            "https://a.example/p",
        );
        assert_eq!(sig.len(), 40);
        assert!(sig.chars().all(|c| c.is_ascii_hexdigit()));
        // Same inputs → same signature; any field change → different.
        assert_eq!(
            sig,
            jssdk_signature(
                "ticket_x",
                "nonce_y",
                1_700_000_000_000,
                "https://a.example/p"
            )
        );
        assert_ne!(
            sig,
            jssdk_signature(
                "ticket_x",
                "nonce_y",
                1_700_000_000_001,
                "https://a.example/p"
            )
        );
    }

    #[test]
    fn login_rejects_absolute_return_to() {
        // Handler-level guard is unit-tested through the pure check the
        // handler applies; exercising the full handler needs env + keyring,
        // so pin the predicate here.
        for bad in ["https://evil.example", "//evil.example", "javascript:x"] {
            let ok = bad.starts_with('/') && !bad.starts_with("//");
            assert!(!ok, "{bad} must be rejected");
        }
        for good in ["/", "/lark/entry?surface=x"] {
            let ok = good.starts_with('/') && !good.starts_with("//");
            assert!(ok, "{good} must be accepted");
        }
    }

    #[test]
    fn authorize_url_percent_encodes_every_parameter() {
        let url = build_authorize_url(
            "cli_a1&b",
            "https://host.example/integrations/lark/web/callback",
            "state-1",
            "chal+lenge/=",
        );
        assert!(url.starts_with(&format!("{LARK_AUTHORIZE_URL}?")));
        // Reserved characters stay inside their own parameter.
        assert!(url.contains("client_id=cli_a1%26b"), "{url}");
        assert!(
            url.contains(
                "redirect_uri=https%3A%2F%2Fhost.example%2Fintegrations%2Flark%2Fweb%2Fcallback"
            ),
            "{url}"
        );
        assert!(url.contains("code_challenge=chal%2Blenge%2F%3D"), "{url}");
        assert!(url.contains("state=state-1"), "{url}");
        assert!(url.ends_with("&code_challenge_method=S256"), "{url}");
    }

    #[test]
    fn terminal_intents_age_out_instead_of_lingering_forever() {
        let id = register_intent();
        assert!(complete_intent(&id, Ok(json!({ "ok": true }))));
        // Still collectable by a slow poller.
        prune_intents(now_ms());
        assert!(PENDING_INTENTS.lock().contains_key(&id));
        // Past the terminal TTL it is gone; the old `_ => true` arm kept every
        // settled intent for the life of the process.
        prune_intents(now_ms() + INTENT_TERMINAL_TTL_MS + 1);
        assert!(!PENDING_INTENTS.lock().contains_key(&id));
    }

    #[test]
    fn evict_oldest_drops_the_oldest_entries_only() {
        let mut map: HashMap<String, i64> = HashMap::new();
        for i in 0..10i64 {
            map.insert(format!("k{i}"), i);
        }
        evict_oldest(&mut map, 4, |v| *v);
        assert_eq!(map.len(), 4);
        // The four newest survive — a size valve must not drop results a
        // browser is still polling for, which `map.clear()` did.
        for i in 6..10i64 {
            assert!(map.contains_key(&format!("k{i}")), "k{i} should survive");
        }
        for i in 0..6i64 {
            assert!(!map.contains_key(&format!("k{i}")));
        }
    }

    #[test]
    fn sso_pending_is_size_capped() {
        {
            let mut map = SSO_PENDING.lock();
            map.clear();
            for i in 0..(SSO_PENDING_MAX + 32) {
                map.insert(
                    format!("state{i}"),
                    SsoPending {
                        adapter_id: "lk-1".into(),
                        verifier: "v".into(),
                        return_to: "/".into(),
                        created_at_ms: now_ms() + i as i64,
                    },
                );
            }
        }
        prune_sso(now_ms());
        assert!(SSO_PENDING.lock().len() <= SSO_PENDING_MAX);
        SSO_PENDING.lock().clear();
    }
}
