//! HTTP handlers — the self-hosted analog of `share-server/worker/src/index.ts`.
//!
//! Each handler maps 1:1 to a Worker function and preserves its observable
//! contract: status codes, JSON error bodies, CORS headers, `Cache-Control:
//! no-store`, and the lifecycle gates. The blind-store invariant holds — the
//! envelope is stored and served as opaque JSON text and never decrypted.

use std::fmt::Write as _;
use std::net::SocketAddr;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_MAX_AGE, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, ORIGIN,
};
use axum::http::{HeaderMap, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use cognia_share_core::codegen::{code_from_bytes, CODE_LENGTH};
use cognia_share_core::policy::{is_origin_allowed, looks_like_envelope, timing_safe_eq};
use cognia_share_core::proto::{ShareMeta, StatsView};
use rand::RngCore;

use crate::metrics::RejectReason;
use crate::server::{now_ms_f64, now_ms_i64, AppState};
use crate::store::ReadOutcome;

const OWNER_TOKEN_HEADER: &str = "x-owner-token";
const OWNER_TOKEN_BYTES: usize = 32;
const CORS_ALLOW_HEADERS: &str = "Authorization, Content-Type, X-Owner-Token";

// ---------------------------------------------------------------------------
// Response builders — every response carries the same CORS posture as the
// Worker (wildcard origin; the bearer secret, not cookies, gates writes).
// ---------------------------------------------------------------------------

fn full_headers() -> [(HeaderName, &'static str); 6] {
    [
        (CONTENT_TYPE, "application/json"),
        (CACHE_CONTROL, "no-store"),
        (ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        (ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, DELETE, OPTIONS"),
        (ACCESS_CONTROL_ALLOW_HEADERS, CORS_ALLOW_HEADERS),
        (ACCESS_CONTROL_MAX_AGE, "86400"),
    ]
}

fn cors_only() -> [(HeaderName, &'static str); 4] {
    [
        (ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        (ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, DELETE, OPTIONS"),
        (ACCESS_CONTROL_ALLOW_HEADERS, CORS_ALLOW_HEADERS),
        (ACCESS_CONTROL_MAX_AGE, "86400"),
    ]
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let body = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
    (status, full_headers(), body).into_response()
}

fn err(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({ "error": message }))
}

/// `204 No Content` with only CORS headers (delete / preflight).
pub fn no_content() -> Response {
    (StatusCode::NO_CONTENT, cors_only()).into_response()
}

// ---------------------------------------------------------------------------
// Shared gates
// ---------------------------------------------------------------------------

/// Origin allowlist + per-IP rate limit, run before any handler work. Returns
/// `Some(response)` to short-circuit with, or `None` to proceed.
fn precheck(state: &AppState, peer: SocketAddr, headers: &HeaderMap) -> Option<Response> {
    let origin = headers.get(ORIGIN).and_then(|v| v.to_str().ok());
    if !is_origin_allowed(origin, &state.allowed_origins) {
        return Some(err(StatusCode::FORBIDDEN, "origin not allowed"));
    }
    let ip = crate::ip_limits::extract_client_ip(peer, headers, state.trust_proxy_headers);
    if !state.rate.check(ip, now_ms_f64()) {
        state.metrics.rejected(RejectReason::Rate);
        return Some(err(StatusCode::TOO_MANY_REQUESTS, "rate limited"));
    }
    None
}

/// The org and person behind a verified grant — ADR-0149 §8.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub org_id: String,
    pub user_id: String,
}

/// Verify the `Authorization: Bearer …` header as a collaboration-plane grant.
///
/// `None` covers every negative case on purpose — no header, no configured
/// key, a bad signature, an expired grant. The caller's next move is the same
/// for all of them (401 with a body that says nothing more), and separating
/// them here would only invite a handler to leak which one it was.
fn grant_caller(headers: &HeaderMap, state: &AppState) -> Option<Caller> {
    let verifier = state.grants.as_ref()?;
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())?
        .strip_prefix("Bearer ")?;
    let claims = verifier.verify(token, now_ms_i64() / 1000).ok()?;
    Some(Caller {
        org_id: claims.org_id,
        user_id: claims.user_id,
    })
}

/// Constant-time bearer check, mirroring the Worker's `isAuthorized`: an unset
/// secret rejects everything.
fn authorized(headers: &HeaderMap, secret: &str) -> bool {
    let header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let Some(token) = header.strip_prefix("Bearer ") else {
        return false;
    };
    if secret.is_empty() {
        return false;
    }
    timing_safe_eq(token, secret)
}

fn generate_code() -> String {
    let mut bytes = [0u8; CODE_LENGTH];
    rand::rng().fill_bytes(&mut bytes);
    code_from_bytes(&bytes)
}

fn generate_owner_token() -> String {
    let mut bytes = [0u8; OWNER_TOKEN_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    let mut out = String::with_capacity(OWNER_TOKEN_BYTES * 2);
    for byte in bytes {
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn owner_authorized(headers: &HeaderMap, meta: &ShareMeta, state: &AppState) -> bool {
    // ADR-0149 §8 — an org grant reaches its own org's shares. This is the
    // off-boarding case the ADR is for: revoking what a departing person
    // shared cannot depend on still holding their per-share tokens.
    if let (Some(org_id), Some(caller)) = (meta.org_id.as_deref(), grant_caller(headers, state)) {
        if caller.org_id == org_id {
            return true;
        }
    }
    if let Some(owner_token) = meta.owner_token.as_deref().filter(|s| !s.is_empty()) {
        let supplied = headers
            .get(OWNER_TOKEN_HEADER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        return timing_safe_eq(supplied, owner_token);
    }
    authorized(headers, &state.upload_secret)
}

// ---------------------------------------------------------------------------
// POST /v1/share
// ---------------------------------------------------------------------------

pub async fn create(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(resp) = precheck(&state, peer, &headers) {
        return resp;
    }
    // A grant first, the legacy secret second. Order matters: the grant is the
    // credential that says WHO is asking, and a deployment that has both
    // should attribute the share rather than fall back to the anonymous path.
    let caller = grant_caller(&headers, &state);
    if caller.is_none() && !authorized(&headers, &state.upload_secret) {
        state.metrics.rejected(RejectReason::Unauthorized);
        return err(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    // Declared-size precheck (the tower body-limit layer is the hard backstop
    // for chunked / undeclared bodies).
    if let Some(declared) = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
    {
        if declared > state.max_body_bytes {
            state.metrics.rejected(RejectReason::TooLarge);
            return err(StatusCode::PAYLOAD_TOO_LARGE, "payload too large");
        }
    }
    if body.len() > state.max_body_bytes {
        state.metrics.rejected(RejectReason::TooLarge);
        return err(StatusCode::PAYLOAD_TOO_LARGE, "payload too large");
    }

    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            state.metrics.rejected(RejectReason::Invalid);
            return err(StatusCode::BAD_REQUEST, "invalid json");
        }
    };

    let envelope = parsed.get("envelope");
    let Some(envelope) = envelope.filter(|e| looks_like_envelope(e)) else {
        state.metrics.rejected(RejectReason::Invalid);
        return err(StatusCode::BAD_REQUEST, "invalid envelope");
    };

    let now = now_ms_i64();
    let requested_ttl_seconds = parsed
        .get("ttlSeconds")
        .and_then(Value::as_f64)
        .filter(|n| *n > 0.0);
    let max_ttl_seconds = state.max_ttl_seconds.max(1) as f64;
    let ttl_seconds = requested_ttl_seconds
        .unwrap_or(max_ttl_seconds)
        .min(max_ttl_seconds);
    let expires_at = now + (ttl_seconds * 1000.0) as i64;
    let burn_after_read = parsed
        .get("burnAfterRead")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let max_views = if burn_after_read {
        Some(1u64)
    } else {
        parsed
            .get("maxViews")
            .and_then(Value::as_f64)
            .filter(|n| *n > 0.0)
            .map(|n| n.floor() as u64)
    };

    let code = generate_code();
    let owner_token = generate_owner_token();
    let envelope_text = serde_json::to_string(envelope).unwrap_or_default();
    let meta = ShareMeta {
        created_at: now,
        expires_at: Some(expires_at),
        max_views,
        burn_after_read,
        view_count: 0,
        revoked: false,
        owner_token: Some(owner_token.clone()),
        // Both, or neither. They come from one verified grant, and half of
        // them would be a claim nobody made.
        org_id: caller.as_ref().map(|caller| caller.org_id.clone()),
        creator_user_id: caller.as_ref().map(|caller| caller.user_id.clone()),
    };

    let store = state.store.clone();
    let code_for_store = code.clone();
    let written =
        tokio::task::spawn_blocking(move || store.create(&code_for_store, &envelope_text, &meta))
            .await;
    match written {
        Ok(Ok(())) => {}
        other => {
            tracing::error!(target: "share", ?other, "store.create failed");
            return err(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    }

    state.metrics.created();
    let payload = json!({ "code": code, "ownerToken": owner_token, "expiresAt": expires_at });
    json_response(StatusCode::CREATED, payload)
}

// ---------------------------------------------------------------------------
// GET /v1/orgs/:org_id/shares          (grant-only)
// DELETE /v1/orgs/:org_id/shares/:code (grant-only)
//
// ADR-0149 §8. Neither accepts the legacy upload secret, and that is the
// point: one global bearer says nothing about which org is asking, so honouring
// it here would let any holder list and delete every tenant's links.
// ---------------------------------------------------------------------------

/// The caller, if their grant is for the org named in the path.
///
/// A grant for a different org is refused identically to no grant at all. The
/// alternative — a distinguishable "wrong org" — would confirm that the org in
/// the path exists, which is exactly what an enumeration wants.
fn org_caller(headers: &HeaderMap, state: &AppState, org_id: &str) -> Option<Caller> {
    grant_caller(headers, state).filter(|caller| caller.org_id == org_id)
}

pub async fn list_org_shares(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
) -> Response {
    if let Some(resp) = precheck(&state, peer, &headers) {
        return resp;
    }
    if org_caller(&headers, &state, &org_id).is_none() {
        state.metrics.rejected(RejectReason::Unauthorized);
        return err(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    let now = now_ms_i64();
    let store = state.store.clone();
    let listed = tokio::task::spawn_blocking(move || store.list_by_org(&org_id, now)).await;
    match listed {
        Ok(Ok(shares)) => json_response(
            StatusCode::OK,
            json!({ "shares": serde_json::to_value(&shares).unwrap_or_else(|_| json!([])) }),
        ),
        other => {
            tracing::error!(target: "share", ?other, "store.list_by_org failed");
            err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
    }
}

pub async fn delete_org_share(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path((org_id, code)): Path<(String, String)>,
) -> Response {
    if let Some(resp) = precheck(&state, peer, &headers) {
        return resp;
    }
    if org_caller(&headers, &state, &org_id).is_none() {
        state.metrics.rejected(RejectReason::Unauthorized);
        return err(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    let store = state.store.clone();
    let deleted = tokio::task::spawn_blocking(move || store.delete_in_org(&org_id, &code)).await;
    match deleted {
        // A code in another org answers exactly like a code that never
        // existed: anything else is an oracle for which codes are real.
        Ok(Ok(true)) => json_response(StatusCode::OK, json!({ "ok": true })),
        Ok(Ok(false)) => {
            state.metrics.rejected(RejectReason::NotFound);
            err(StatusCode::NOT_FOUND, "not found")
        }
        other => {
            tracing::error!(target: "share", ?other, "store.delete_in_org failed");
            err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET /v1/share/:code  (public)
// ---------------------------------------------------------------------------

pub async fn read(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Response {
    if let Some(resp) = precheck(&state, peer, &headers) {
        return resp;
    }
    let now = now_ms_i64();
    let store = state.store.clone();
    let outcome = tokio::task::spawn_blocking(move || store.read_and_advance(&code, now)).await;
    match outcome {
        Ok(Ok(ReadOutcome::Served { envelope })) => {
            state.metrics.read();
            // Serve the opaque envelope verbatim, matching the Worker's
            // `{"envelope":<text>}` string assembly (no re-parse).
            let body = format!("{{\"envelope\":{envelope}}}");
            (StatusCode::OK, full_headers(), body).into_response()
        }
        Ok(Ok(ReadOutcome::NotFound)) => {
            state.metrics.rejected(RejectReason::NotFound);
            err(StatusCode::NOT_FOUND, "not found")
        }
        other => {
            tracing::error!(target: "share", ?other, "store.read_and_advance failed");
            err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
    }
}

// ---------------------------------------------------------------------------
// GET /v1/share/:code/stats  (owner)
// ---------------------------------------------------------------------------

pub async fn stats(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Response {
    if let Some(resp) = precheck(&state, peer, &headers) {
        return resp;
    }
    let now = now_ms_i64();
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || store.stats(&code, now)).await;
    match result {
        Ok(Ok(Some(meta))) => {
            if !owner_authorized(&headers, &meta, &state) {
                state.metrics.rejected(RejectReason::Unauthorized);
                return err(StatusCode::UNAUTHORIZED, "unauthorized");
            }
            json_response(
                StatusCode::OK,
                serde_json::to_value(StatsView::from(&meta)).unwrap_or_else(|_| json!({})),
            )
        }
        Ok(Ok(None)) => {
            state.metrics.rejected(RejectReason::NotFound);
            err(StatusCode::NOT_FOUND, "not found")
        }
        other => {
            tracing::error!(target: "share", ?other, "store.stats failed");
            err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
    }
}

// ---------------------------------------------------------------------------
// DELETE /v1/share/:code  (owner)
// ---------------------------------------------------------------------------

pub async fn delete(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Response {
    if let Some(resp) = precheck(&state, peer, &headers) {
        return resp;
    }
    let stats_store = state.store.clone();
    let stats_code = code.clone();
    let now = now_ms_i64();
    let meta = tokio::task::spawn_blocking(move || stats_store.stats(&stats_code, now)).await;
    let meta = match meta {
        Ok(Ok(Some(meta))) => meta,
        Ok(Ok(None)) => return no_content(),
        other => {
            tracing::error!(target: "share", ?other, "store.stats before delete failed");
            return err(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    };
    if !owner_authorized(&headers, &meta, &state) {
        state.metrics.rejected(RejectReason::Unauthorized);
        return err(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || store.delete(&code)).await;
    match result {
        Ok(Ok(())) => {
            state.metrics.deleted();
            no_content()
        }
        other => {
            tracing::error!(target: "share", ?other, "store.delete failed");
            err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
    }
}

// ---------------------------------------------------------------------------
// CORS preflight + method-not-allowed + fallback
// ---------------------------------------------------------------------------

/// `OPTIONS` preflight for the `/v1/share*` routes → `204` + CORS.
pub async fn options() -> Response {
    no_content()
}

/// Method-not-allowed fallback for a known path with an unsupported method.
pub async fn method_not_allowed() -> Response {
    err(StatusCode::METHOD_NOT_ALLOWED, "method not allowed")
}

/// Router-level fallback. `OPTIONS` on any unmatched path still answers the
/// preflight (matching the Worker, which handles `OPTIONS` before routing);
/// everything else is `404`.
pub async fn fallback(method: axum::http::Method) -> Response {
    if method == axum::http::Method::OPTIONS {
        no_content()
    } else {
        err(StatusCode::NOT_FOUND, "not found")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_codes_have_expected_length_and_alphabet() {
        let code = generate_code();
        assert_eq!(code.chars().count(), CODE_LENGTH);
        assert!(code
            .bytes()
            .all(|b| cognia_share_core::codegen::CODE_ALPHABET.contains(&b)));
    }

    #[test]
    fn generated_codes_are_not_constant() {
        // Vanishingly small chance of collision; guards against a broken RNG.
        assert_ne!(generate_code(), generate_code());
    }

    #[test]
    fn authorized_requires_matching_bearer() {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer s3cret".parse().unwrap());
        assert!(authorized(&h, "s3cret"));
        assert!(!authorized(&h, "other"));
        // Empty configured secret rejects everything.
        assert!(!authorized(&h, ""));
    }

    #[test]
    fn authorized_rejects_missing_or_malformed_header() {
        let h = HeaderMap::new();
        assert!(!authorized(&h, "s3cret"));
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Basic abc".parse().unwrap());
        assert!(!authorized(&h, "s3cret"));
    }

    #[test]
    fn generated_owner_tokens_are_hex_32_bytes() {
        let token = generate_owner_token();
        assert_eq!(token.len(), 64);
        assert!(token
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(token, generate_owner_token());
    }

    /// A real `AppState` over a temp database, so the owner-authorization
    /// tests exercise the same function the routes do rather than a
    /// stand-in that could drift from it.
    fn test_state() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("shares.sqlite");
        let mut config = crate::server::Config::for_test(path.to_str().expect("utf8 path"));
        config.upload_secret = "global".to_string();
        (crate::server::build_state(&config).expect("state"), dir)
    }

    /// A grant signed with the test config's key, expiring well in the future.
    fn grant_for(org_id: &str) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        use hmac::{Hmac, KeyInit, Mac};
        use sha2::Sha256;

        let expires_at = now_ms_i64() / 1000 + 300;
        let claims =
            format!(r#"{{"userId":"usr_ada","orgId":"{org_id}","expiresAt":{expires_at}}}"#);
        let payload = URL_SAFE_NO_PAD.encode(claims.as_bytes());
        let mut mac = Hmac::<Sha256>::new_from_slice(b"0123456789abcdef0123456789abcdef")
            .expect("key length");
        mac.update(payload.as_bytes());
        format!(
            "{payload}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    #[test]
    fn owner_authorized_prefers_share_token_over_global_secret() {
        let meta = ShareMeta {
            created_at: 0,
            expires_at: Some(1),
            max_views: None,
            burn_after_read: false,
            view_count: 0,
            revoked: false,
            owner_token: Some("owner-secret".to_string()),
            org_id: None,
            creator_user_id: None,
        };
        let (state, _dir) = test_state();
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer global".parse().unwrap());
        assert!(!owner_authorized(&h, &meta, &state));
        h.insert(OWNER_TOKEN_HEADER, "owner-secret".parse().unwrap());
        assert!(owner_authorized(&h, &meta, &state));
    }

    #[test]
    fn owner_authorized_falls_back_to_global_secret_for_legacy_rows() {
        let meta = ShareMeta {
            created_at: 0,
            expires_at: Some(1),
            max_views: None,
            burn_after_read: false,
            view_count: 0,
            revoked: false,
            owner_token: None,
            org_id: None,
            creator_user_id: None,
        };
        let (state, _dir) = test_state();
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer global".parse().unwrap());
        assert!(owner_authorized(&h, &meta, &state));
    }

    fn owned_by(org_id: &str) -> ShareMeta {
        ShareMeta {
            created_at: 0,
            expires_at: Some(1),
            max_views: None,
            burn_after_read: false,
            view_count: 0,
            revoked: false,
            owner_token: Some("owner-secret".to_string()),
            org_id: Some(org_id.to_string()),
            creator_user_id: Some("usr_ada".to_string()),
        }
    }

    /// ADR-0149 §8's motivating case: revoking what a person shared when they
    /// leave, without still holding their per-share tokens.
    #[test]
    fn an_org_grant_reaches_its_own_org_s_share() {
        let (state, _dir) = test_state();
        let mut h = HeaderMap::new();
        h.insert(
            AUTHORIZATION,
            format!("Bearer {}", grant_for("org_acme")).parse().unwrap(),
        );
        assert!(owner_authorized(&h, &owned_by("org_acme"), &state));
    }

    #[test]
    fn an_org_grant_does_not_reach_another_org_s_share() {
        let (state, _dir) = test_state();
        let mut h = HeaderMap::new();
        h.insert(
            AUTHORIZATION,
            format!("Bearer {}", grant_for("org_other"))
                .parse()
                .unwrap(),
        );
        assert!(!owner_authorized(&h, &owned_by("org_acme"), &state));
    }

    /// The legacy secret must not become an org credential by accident. It
    /// proves nothing about who is asking, which is why ADR-0149 §8 calls it
    /// out: one leak would otherwise be every tenant's leak.
    #[test]
    fn the_global_secret_does_not_reach_an_owned_share() {
        let (state, _dir) = test_state();
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer global".parse().unwrap());
        assert!(!owner_authorized(&h, &owned_by("org_acme"), &state));
    }
}
