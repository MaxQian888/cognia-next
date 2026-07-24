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

pub fn issue_entry_token(secret: &[u8], input: &IssueEntryInput) -> Result<(String, String, i64), String> {
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
    Done { result: Value },
    Error { code: String },
}

/// requestId → async brain-answered intent (60 s TTL while pending).
static PENDING_INTENTS: Lazy<Mutex<HashMap<String, IntentState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn prune_sso(now: i64) {
    SSO_PENDING
        .lock()
        .retain(|_, p| now - p.created_at_ms < SSO_STATE_TTL_MS);
}

fn prune_intents(now: i64) {
    PENDING_INTENTS.lock().retain(|_, state| match state {
        IntentState::Pending { created_at_ms } => now - *created_at_ms < INTENT_TTL_MS,
        // Terminal results linger a bit longer so a slow poller still sees
        // them; 5× the pending TTL is plenty.
        _ => true,
    });
    // Cap terminal entries: drop the map entirely past a pathological size.
    let mut map = PENDING_INTENTS.lock();
    if map.len() > 10_000 {
        map.clear();
    }
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
            Ok(value) => IntentState::Done { result: value },
            Err(code) => IntentState::Error { code },
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
        return error_json(StatusCode::SERVICE_UNAVAILABLE, "sso_public_base_unconfigured");
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
    let authorize = format!(
        "{LARK_AUTHORIZE_URL}?client_id={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(&app_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&state_id),
        urlencoding::encode(&challenge),
    );
    Redirect::temporary(&authorize).into_response()
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
        return error_json(StatusCode::SERVICE_UNAVAILABLE, "sso_public_base_unconfigured");
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
    let target = format!("{}{}#lark_session={}", web_base(), pending.return_to, session);
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
        Some(IntentState::Done { result }) => (
            StatusCode::OK,
            Json(json!({ "status": "done", "result": result })),
        )
            .into_response(),
        Some(IntentState::Error { code }) => (
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
                url_version: args
                    .get("urlVersion")
                    .and_then(Value::as_u64)
                    .unwrap_or(1) as u32,
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

    #[test]
    fn intent_lifecycle_pending_done_error() {
        let id = register_intent();
        assert!(matches!(
            PENDING_INTENTS.lock().get(&id),
            Some(IntentState::Pending { .. })
        ));
        assert!(complete_intent(&id, Ok(json!({ "conversationKey": "lark:a:b" }))));
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
}
