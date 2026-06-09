//! HTTP handlers — the self-hosted analog of `share-server/worker/src/index.ts`.
//!
//! Each handler maps 1:1 to a Worker function and preserves its observable
//! contract: status codes, JSON error bodies, CORS headers, `Cache-Control:
//! no-store`, and the lifecycle gates. The blind-store invariant holds — the
//! envelope is stored and served as opaque JSON text and never decrypted.

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
        (ACCESS_CONTROL_ALLOW_HEADERS, "Authorization, Content-Type"),
        (ACCESS_CONTROL_MAX_AGE, "86400"),
    ]
}

fn cors_only() -> [(HeaderName, &'static str); 4] {
    [
        (ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        (ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, DELETE, OPTIONS"),
        (ACCESS_CONTROL_ALLOW_HEADERS, "Authorization, Content-Type"),
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
    let ip = crate::ip_limits::extract_client_ip(peer, headers);
    if !state.rate.check(ip, now_ms_f64()) {
        state.metrics.rejected(RejectReason::Rate);
        return Some(err(StatusCode::TOO_MANY_REQUESTS, "rate limited"));
    }
    None
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
    rand::thread_rng().fill_bytes(&mut bytes);
    code_from_bytes(&bytes)
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
    if !authorized(&headers, &state.upload_secret) {
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
    let ttl_seconds = parsed
        .get("ttlSeconds")
        .and_then(Value::as_f64)
        .filter(|n| *n > 0.0);
    let expires_at = ttl_seconds.map(|t| now + (t * 1000.0) as i64);
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
    let envelope_text = serde_json::to_string(envelope).unwrap_or_default();
    let meta = ShareMeta {
        created_at: now,
        expires_at,
        max_views,
        burn_after_read,
        view_count: 0,
        revoked: false,
    };

    let store = state.store.clone();
    let code_for_store = code.clone();
    let written = tokio::task::spawn_blocking(move || {
        store.create(&code_for_store, &envelope_text, &meta)
    })
    .await;
    match written {
        Ok(Ok(())) => {}
        other => {
            tracing::error!(target: "share", ?other, "store.create failed");
            return err(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    }

    state.metrics.created();
    let mut payload = json!({ "code": code });
    if let Some(exp) = expires_at {
        payload["expiresAt"] = json!(exp);
    }
    json_response(StatusCode::CREATED, payload)
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
    if !authorized(&headers, &state.upload_secret) {
        state.metrics.rejected(RejectReason::Unauthorized);
        return err(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let now = now_ms_i64();
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || store.stats(&code, now)).await;
    match result {
        Ok(Ok(Some(meta))) => json_response(
            StatusCode::OK,
            serde_json::to_value(StatsView::from(&meta)).unwrap_or_else(|_| json!({})),
        ),
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
    if !authorized(&headers, &state.upload_secret) {
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
}
