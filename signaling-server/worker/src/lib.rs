//! Cloudflare Worker entry for the WebRTC signaling rendezvous (ADR-0021).
//!
//! This is the stateless router half of the deployment. The stateful relay
//! lives in [`RoomDurableObject`] (`room.rs`): one Durable Object instance per
//! `rendezvous_id`, which is exactly what the native axum server's
//! `RoomRegistry` did in a single process — here the platform shards it.
//!
//! Flow: the client connects to `wss://<host>/v1/signaling?rid=<rendezvousId>`.
//! The `rid` query param picks the room's Durable Object via `id_from_name`;
//! the upgrade request is forwarded to that DO's stub, which terminates the
//! WebSocket (hibernatable) and returns the client end back through here.
//!
//! The application-level HMAC envelope inside `Relay.payload` is opaque to the
//! Worker exactly as it was to the axum server — it is forwarded verbatim and
//! verified end-to-end by the two peers.

use worker::*;

mod room;
pub use room::RoomDurableObject;

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();

    match req.path().as_str() {
        "/healthz" => Response::from_json(&serde_json::json!({ "status": "ok" })),
        "/v1/signaling" => route_signaling(req, env).await,
        _ => Response::error("not found", 404),
    }
}

/// Resolve the room Durable Object from `?rid=` and forward the WebSocket
/// upgrade to it. The DO accepts the socket; its 101 response carrying the
/// client end propagates back to the original caller.
async fn route_signaling(req: Request, env: Env) -> Result<Response> {
    let upgrade = req.headers().get("Upgrade")?.unwrap_or_default();
    if !upgrade.eq_ignore_ascii_case("websocket") {
        return Response::error("expected websocket upgrade", 426);
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
