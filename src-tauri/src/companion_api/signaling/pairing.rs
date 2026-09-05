//! WAN pairing through the relay (ADR-0170, `cgnp4`).
//!
//! Before the relay, the very first thing a new device did was a direct
//! HTTPS request to the Host: `/api/auth/device/challenge`, then
//! `/register`, then `/token`. A phone therefore had to be on the LAN (or
//! reach a tunnel) once before any WAN path could exist, and a browser could
//! never pair at all: it cannot pin the Host's self-signed certificate.
//!
//! A `cgnp4` invitation carries a **pairing room** instead: a one-shot
//! rendezvous room whose desktop key the Host minted for this invitation and
//! whose mobile key travels inside the invitation as a JWK. The device joins
//! that room with the invitation's key, opens the relay data lane, and sends
//! the same four public requests as `pair.http` RPC frames. The Host answers
//! each by driving its own axum router in-process, so the handlers, the
//! rate limit, and every validation run exactly as they do for a direct
//! request. Only the four public pairing paths are reachable this way. Once
//! registered, the device holds its own room and the pairing room expires
//! with the invitation.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderName, HeaderValue, Method, Request};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cognia_signaling_core::proto::RoomDescriptor;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::OnceCell;
use tower::ServiceExt as _;

use super::envelope::{build_room_descriptor, SignalingIdentity};
use crate::companion_api::SharedState;

/// The RPC method a pairing peer sends over the relay data lane.
pub const PAIR_HTTP_METHOD: &str = "pair.http";

/// The only paths a pairing room may drive. Everything a device needs before
/// it has an identity of its own, and nothing else: no RPC, no sync, no
/// events. Order matters nowhere. This is an allowlist.
pub const PAIRING_PATHS: [&str; 4] = [
    "/api/auth/config",
    "/api/auth/device/challenge",
    "/api/auth/device/register",
    "/api/auth/token",
];

/// Largest request body a pairing peer may push through the room. The
/// register request is a few KiB (two PEM keys and a proof). Anything past
/// this is not a pairing request.
pub const MAX_PAIR_HTTP_BODY_BYTES: usize = 64 * 1024;

/// Largest response body relayed back. `/api/auth/config` is the biggest of
/// the four and is well under this.
pub const MAX_PAIR_HTTP_RESPONSE_BYTES: usize = 256 * 1024;

/// What the invitation carries (mirror of `PairRelay` in
/// `lib/qr/pair-payload.ts`). The mobile private key is the only secret and
/// it is worth exactly what the one-shot invitation next to it is worth.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingRoomIssue {
    /// The rendezvous the Host is sitting in.
    pub url: String,
    pub room: RoomDescriptor,
    /// P-256 private key as a JWK (`kty`/`crv`/`d`/`x`/`y`) so a browser can
    /// import it with WebCrypto without any DER glue.
    pub mobile_private_key_jwk: Value,
}

/// Per-session state of a pairing room on the Host.
pub struct PairingRoom {
    pub expires_at_ms: i64,
    /// Built lazily on the first request and reused: the router is a stack
    /// of layers, cheap to clone and not free to build.
    router: OnceCell<axum::Router>,
}

impl PairingRoom {
    pub fn new(expires_at_ms: i64) -> Arc<Self> {
        Arc::new(Self {
            expires_at_ms,
            router: OnceCell::new(),
        })
    }

    async fn router(&self, state: &SharedState) -> axum::Router {
        self.router
            .get_or_init(|| async { crate::companion_api::server::build_router(state.clone()) })
            .await
            .clone()
    }
}

/// Mint a pairing room: a fresh desktop identity (kept only in memory for the
/// room's lifetime), a fresh mobile identity handed out in the invitation,
/// and the descriptor both derive the room id from.
pub fn mint_pairing_room(
    signaling_url: &str,
    now_ms: i64,
    ttl_ms: i64,
) -> (PairingRoomIssue, SignalingIdentity) {
    let host = SignalingIdentity::generate();
    let mobile = SignalingIdentity::generate();
    let room_nonce = {
        let mut bytes = [0_u8; 16];
        rand::fill(&mut bytes);
        URL_SAFE_NO_PAD.encode(bytes)
    };
    let room = build_room_descriptor(
        room_nonce,
        host.public_key_base64(),
        mobile.public_key_base64(),
        now_ms.saturating_add(ttl_ms),
    );
    (
        PairingRoomIssue {
            url: signaling_url.to_string(),
            room,
            mobile_private_key_jwk: mobile.to_jwk(),
        },
        host,
    )
}

/// One `pair.http` request as the peer sends it (`params` of the RPC frame).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairHttpRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// Request body as text (JSON for all four paths).
    #[serde(default)]
    pub body: Option<String>,
}

/// The answer: enough for the peer to rebuild a `Response`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

/// Why a `pair.http` request was refused before reaching the router.
#[derive(Debug, PartialEq, Eq)]
pub enum PairHttpRefusal {
    PathNotAllowed,
    MethodNotAllowed,
    BodyTooLarge,
    Expired,
}

impl PairHttpRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::PathNotAllowed => "pair_path_not_allowed",
            Self::MethodNotAllowed => "pair_method_not_allowed",
            Self::BodyTooLarge => "pair_body_too_large",
            Self::Expired => "pair_room_expired",
        }
    }
}

/// Pure admission check, pinned by tests: only the four public paths, only
/// `GET`/`POST`, bounded body, unexpired room.
pub fn admit(
    request: &PairHttpRequest,
    room_expires_at_ms: i64,
    now_ms: i64,
) -> Result<(), PairHttpRefusal> {
    if now_ms >= room_expires_at_ms {
        return Err(PairHttpRefusal::Expired);
    }
    let path = request.path.split('?').next().unwrap_or("");
    if !PAIRING_PATHS.contains(&path) {
        return Err(PairHttpRefusal::PathNotAllowed);
    }
    if !matches!(request.method.to_ascii_uppercase().as_str(), "GET" | "POST") {
        return Err(PairHttpRefusal::MethodNotAllowed);
    }
    if request
        .body
        .as_ref()
        .is_some_and(|b| b.len() > MAX_PAIR_HTTP_BODY_BYTES)
    {
        return Err(PairHttpRefusal::BodyTooLarge);
    }
    Ok(())
}

/// Drive one admitted request through the Host's own router.
pub async fn answer(
    room: &PairingRoom,
    state: &SharedState,
    request: PairHttpRequest,
    advertised_host: &str,
) -> Result<PairHttpResponse, String> {
    let method = Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
        .map_err(|_| "invalid method".to_string())?;
    let mut builder = Request::builder().method(method).uri(&request.path);
    builder = builder.header(header::HOST, advertised_host);
    let mut saw_content_type = false;
    for (name, value) in &request.headers {
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        // The peer's own authorization (OIDC bearer) and content type are the
        // only headers with a meaning here. Anything else could only be an
        // attempt to spoof a forwarded address.
        if name != header::AUTHORIZATION && name != header::CONTENT_TYPE {
            continue;
        }
        if name == header::CONTENT_TYPE {
            saw_content_type = true;
        }
        if let Ok(value) = HeaderValue::from_str(value) {
            builder = builder.header(name, value);
        }
    }
    if !saw_content_type && request.body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    let body = request.body.unwrap_or_default();
    let mut http_request = builder
        .body(Body::from(body))
        .map_err(|error| error.to_string())?;
    // The pre-auth rate limiter keys on the peer address. A relayed request
    // has no socket of its own, so it is charged to the loopback bucket.
    http_request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            0,
        ))));
    let response = room
        .router(state)
        .await
        .oneshot(http_request)
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .filter(|(name, _)| *name == header::CONTENT_TYPE)
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect();
    let bytes = axum::body::to_bytes(response.into_body(), MAX_PAIR_HTTP_RESPONSE_BYTES)
        .await
        .map_err(|error| error.to_string())?;
    Ok(PairHttpResponse {
        status,
        headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// A refusal as the RPC error the peer's fetch shim turns into an HTTP-ish
/// failure.
pub fn refusal_error(refusal: &PairHttpRefusal) -> Value {
    json!({ "code": refusal.code(), "message": "pairing request refused" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str, method: &str, body: Option<&str>) -> PairHttpRequest {
        PairHttpRequest {
            method: method.into(),
            path: path.into(),
            headers: Vec::new(),
            body: body.map(str::to_string),
        }
    }

    #[test]
    fn only_the_public_pairing_paths_are_admitted() {
        for path in PAIRING_PATHS {
            assert_eq!(admit(&request(path, "POST", Some("{}")), 10, 0), Ok(()));
        }
        assert_eq!(
            admit(&request("/api/_rpc/sessions_list", "POST", Some("{}")), 10, 0),
            Err(PairHttpRefusal::PathNotAllowed)
        );
        assert_eq!(
            admit(&request("/api/devices", "GET", None), 10, 0),
            Err(PairHttpRefusal::PathNotAllowed)
        );
        // A query string does not smuggle a different path.
        assert_eq!(
            admit(&request("/api/auth/config?x=1", "GET", None), 10, 0),
            Ok(())
        );
    }

    #[test]
    fn method_body_and_expiry_are_bounded() {
        assert_eq!(
            admit(&request("/api/auth/config", "DELETE", None), 10, 0),
            Err(PairHttpRefusal::MethodNotAllowed)
        );
        let big = "x".repeat(MAX_PAIR_HTTP_BODY_BYTES + 1);
        assert_eq!(
            admit(
                &request("/api/auth/device/register", "POST", Some(&big)),
                10,
                0
            ),
            Err(PairHttpRefusal::BodyTooLarge)
        );
        assert_eq!(
            admit(&request("/api/auth/config", "GET", None), 10, 10),
            Err(PairHttpRefusal::Expired)
        );
    }

    #[test]
    fn minted_room_is_self_certifying_and_hands_out_a_jwk() {
        let (issue, host) = mint_pairing_room("wss://relay.test/signaling", 1_000, 5_000);
        assert_eq!(issue.url, "wss://relay.test/signaling");
        assert_eq!(issue.room.not_after, 6_000);
        assert_eq!(issue.room.desktop_signing_key, host.public_key_base64());
        assert_eq!(issue.mobile_private_key_jwk["kty"], "EC");
        assert_eq!(issue.mobile_private_key_jwk["crv"], "P-256");
        assert!(issue.mobile_private_key_jwk["d"].is_string());
        // The JWK's public half is the room's mobile key.
        let x = issue.mobile_private_key_jwk["x"].as_str().unwrap();
        let y = issue.mobile_private_key_jwk["y"].as_str().unwrap();
        let mut point = vec![0x04];
        point.extend(URL_SAFE_NO_PAD.decode(x).unwrap());
        point.extend(URL_SAFE_NO_PAD.decode(y).unwrap());
        assert_eq!(URL_SAFE_NO_PAD.encode(point), issue.room.mobile_signing_key);
        assert_eq!(
            cognia_signaling_core::protocol::derive_room_id(&issue.room),
            issue.room.room_id
        );
    }

    #[test]
    fn refusal_codes_are_stable() {
        assert_eq!(PairHttpRefusal::Expired.code(), "pair_room_expired");
        assert_eq!(
            refusal_error(&PairHttpRefusal::PathNotAllowed)["code"],
            "pair_path_not_allowed"
        );
    }
}
