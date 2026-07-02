# cognia-signaling-server

Stateless WebRTC signaling rendezvous for the cognia mobile↔desktop WAN
transport. Implements ADR-0021.

## What it does

- Exposes `GET /v1/signaling` as a WebSocket endpoint.
- Maintains an in-memory `HashMap<rendezvousId, Vec<PeerSocket>>` of
  subscribed peers per room.
- Enforces room admission policy: default 4 peers per room and 1 desktop
  peer per room, with environment overrides.
- Applies opt-in WebSocket `Origin` allowlisting and a per-source-IP
  concurrent connection cap.
- Forwards opaque base64 envelopes between peers in the same room. The
  server **does not** inspect, log, or persist payload content.
- Returns `200 OK` JSON from `GET /healthz` for liveness probes.
- Returns Prometheus text from `GET /metrics` for scrape-based observability.

It does **not** do:

- Channel-level authentication or authorization. Rooms are identified by an
  unguessable UUIDv4 and admitted by room policy. Application authenticity is
  end-to-end between desktop and mobile via HMAC-SHA256 using a 32-byte secret
  minted at pair time and shared out-of-band.
- TLS termination. Deploy behind a platform that handles TLS (Fly.io,
  Railway, an nginx fronting box).
- Persistence. A restart drops every room; peers reconnect and resubscribe.

## Run locally

```bash
cd signaling-server
cargo run -- --bind 127.0.0.1:7892
# or:
PORT=7892 cargo run
```

## Run tests

```bash
cd signaling-server
cargo test
```

## Deploy to Fly.io

```bash
cd signaling-server
flyctl launch --no-deploy --copy-config
flyctl deploy
```

The container listens on `$PORT` (default 7892). Fly's edge serves TLS so
clients connect with `wss://<app>.fly.dev/v1/signaling`.

## Deploy from CI

`.github/workflows/deploy.yml` deploys both the Worker (`worker/`, via
`wrangler deploy`, staging = `--env staging` → `cognia-signaling-staging` on
`*.workers.dev`) and the Fly app — manual dispatch only, gated by the
`DEPLOY_ENABLED` repo variable plus environment-scoped
`CLOUDFLARE_API_TOKEN` / `FLY_API_TOKEN` secrets and the `FLY_SIGNALING_APP`
variable. See `CI_CD.md` → "Deploy (services)" for the full matrix and the
one-time provisioning steps.

## Resource expectations

A single process comfortably hosts thousands of rooms because per-message
cost is `O(peers in room)` — typically 2. Memory is dominated by per-WS
buffers (~64 frames × ~1 KiB each) and bounded by the OS file-descriptor
limit. The reference deployment uses a `shared-cpu-1x` Fly machine with
256 MB RAM.

## Protocol summary

```
Client → Server
  connect ws(s)://host/v1/signaling?rid=<rendezvousId>  # required by Worker, room-bound by axum when present
  { kind: "subscribe", rendezvousId, role: "desktop"|"mobile", clientNonce }
  { kind: "unsubscribe", rendezvousId }
  { kind: "relay", rendezvousId, payload: <base64url> }   # opaque
  { kind: "ping" }

Server → Client
  { kind: "subscribed", rendezvousId, peers: [{role, joinedAtMs}, ...] }
  { kind: "peerJoined", rendezvousId, role }
  { kind: "peerLeft",   rendezvousId, role }
  { kind: "relay",      rendezvousId, fromRole, payload }
  { kind: "pong" }
  { kind: "error", code, message }
```

The opaque `payload` carries the HMAC-signed `Envelope` defined in
`src/proto.rs` (mirrored on the TypeScript side at `lib/signaling/types.ts`).

## Operational notes

- Per-connection rate limit: 20-frame token bucket, refills at 10 frames/sec.
  Exceeding triggers `error{code:"rate_limited"}` followed by a disconnect.
- Per-source-IP connection cap: `SIGNALING_MAX_CONN_PER_IP`, default `50`.
  By default the raw TCP peer address is used. Set
  `SIGNALING_TRUST_PROXY_HEADERS=1` only behind a trusted proxy that overwrites
  `Fly-Client-IP` / `X-Forwarded-For`; otherwise direct clients could spoof the
  rate-limit key.
- Room admission caps: `SIGNALING_MAX_PEERS_PER_ROOM`, default `4`, and
  `SIGNALING_MAX_DESKTOPS`, default `1`. Rejections return stable
  `room_full` or `role_taken` error frames.
- Origin allowlist: `SIGNALING_ALLOWED_ORIGINS` is a comma-separated list.
  Blank/unset allows all origins; missing `Origin` remains allowed for native
  desktop clients.
- Frame size cap: 8 KiB per WS frame, enforced in `ws::handle_socket`
  (oversized frames get a graceful `error{code:"frame_too_large"}`), backed by
  a hard 64 KiB `max_message_size` on the upgrade as a memory bound.
  `tower_http`'s `RequestBodyLimitLayer` only caps the pre-upgrade handshake.
  SDP and ICE messages are typically well under 2 KiB.
- Malformed JSON/schema errors are redacted to a stable
  `error{code:"malformed_frame"}` response. Detailed parse errors stay in
  server logs only.
- When a socket upgrades with `?rid=<rendezvousId>`, later `subscribe`,
  `relay`, and `unsubscribe` frames must repeat the same `rendezvousId`; a
  mismatch returns `error{code:"room_mismatch"}` and is never admitted or
  fanned out. This keeps the axum server aligned with the Worker Durable
  Object binding.
- `GET /metrics` exposes `signaling_frames_in_total`,
  `signaling_frames_relayed_total`, `signaling_frames_rejected_total{reason}`,
  `signaling_rooms_active`, `signaling_peers_active`, and
  `signaling_uptime_seconds`.
