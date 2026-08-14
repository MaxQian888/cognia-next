//! Cloudflare Worker entry for the WebRTC signaling rendezvous (ADR-0021).
//!
//! This is the stateless router half of the deployment. The stateful relay
//! lives in [`RoomDurableObject`] (`room.rs`): one Durable Object instance per
//! `rendezvous_id`, which is exactly what the native axum server's
//! `RoomRegistry` did in a single process — here the platform shards it.
//!
//! Flow: the client connects to `wss://<host>/signaling?rid=<rendezvousId>`.
//! The `rid` query param picks the room's Durable Object via `id_from_name`;
//! the upgrade request is forwarded to that DO's stub, which terminates the
//! WebSocket (hibernatable) and returns the client end back through here.
//!
//! The application-level ECDSA-authenticated AES-GCM envelope inside
//! `Relay.payload` is opaque to the Worker and verified end-to-end by peers.

use cognia_signaling_core::policy::{is_origin_allowed, is_valid_allowed_origin};
use worker::*;

mod room;
pub use room::RoomDurableObject;

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();

    match req.path().as_str() {
        // Shape aligned with the axum server's `/healthz` (`ok` + `version`).
        // Global rooms/peers counts are NOT available here — they live in the
        // per-rid Durable Objects with no cross-DO view; query Analytics Engine
        // (the `METRICS` dataset) for fleet-wide totals.
        "/healthz" => Response::from_json(&serde_json::json!({
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
            "backend": "worker",
        })),
        // `/v2/signaling` is the pre-rename path, still baked into the endpoint
        // that already-paired devices dial. Keep serving it.
        "/signaling" | "/v2/signaling" => route_signaling(req, env).await,
        _ => Response::error("not found", 404),
    }
}

/// Parse the comma-separated `SIGNALING_ALLOWED_ORIGINS` env var into a list.
/// Unset / blank yields an empty list (same-origin only).
fn allowed_origins(env: &Env) -> Result<Vec<String>> {
    let origins = env
        .var("SIGNALING_ALLOWED_ORIGINS")
        .map(|v| {
            v.to_string()
                .split(',')
                .map(|o| o.trim().to_string())
                .filter(|o| !o.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if let Some(invalid) = origins
        .iter()
        .find(|origin| !is_valid_allowed_origin(origin))
    {
        return Err(Error::RustError(format!(
            "SIGNALING_ALLOWED_ORIGINS entry must be an exact HTTPS origin: {invalid}"
        )));
    }
    Ok(origins)
}

/// Resolve the room Durable Object from `?rid=` and forward the WebSocket
/// upgrade to it. The DO accepts the socket; its 101 response carrying the
/// client end propagates back to the original caller.
async fn route_signaling(req: Request, env: Env) -> Result<Response> {
    let upgrade = req.headers().get("Upgrade")?.unwrap_or_default();
    if !upgrade.eq_ignore_ascii_case("websocket") {
        return Response::error("expected websocket upgrade", 426);
    }

    // Native clients omit Origin. Browser clients must be same-origin or match
    // the explicit HTTPS split-origin allowlist. Mirrors the axum server.
    let origin = req.headers().get("Origin")?;
    let request_origin = req.url()?.origin().ascii_serialization();
    if !is_origin_allowed(
        origin.as_deref(),
        Some(&request_origin),
        &allowed_origins(&env)?,
    ) {
        return Response::error("origin not allowed", 403);
    }

    let rid = req
        .url()?
        .query_pairs()
        .find(|(k, _)| k == "rid")
        .map(|(_, v)| v.into_owned())
        .filter(|s| !s.is_empty());
    let Some(rid) = rid else {
        return Response::error("missing rid query parameter", 400);
    };

    let stub = env.durable_object("ROOM")?.id_from_name(&rid)?.get_stub()?;
    stub.fetch_with_request(req).await
}
