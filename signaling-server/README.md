# cognia-signaling-server

Stateless WebRTC signaling rendezvous for the cognia mobile↔desktop WAN
transport. Implements ADR-0021.

## What it does

- Exposes `GET /v1/signaling` as a WebSocket endpoint.
- Maintains an in-memory `HashMap<rendezvousId, Vec<PeerSocket>>` of
  subscribed peers per room.
- Forwards opaque base64 envelopes between peers in the same room. The
  server **does not** inspect, log, or persist payload content.
- Returns `200 OK` JSON from `GET /healthz` for liveness probes.

It does **not** do:

- Authentication or authorization. Rooms are identified by an unguessable
  UUIDv4. Auth is end-to-end between desktop and mobile via HMAC-SHA256
  using a 32-byte secret minted at pair time and shared out-of-band.
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

## Resource expectations

A single process comfortably hosts thousands of rooms because per-message
cost is `O(peers in room)` — typically 2. Memory is dominated by per-WS
buffers (~64 frames × ~1 KiB each) and bounded by the OS file-descriptor
limit. The reference deployment uses a `shared-cpu-1x` Fly machine with
256 MB RAM.

## Protocol summary

```
Client → Server
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
- Frame size cap: 8 KiB (`tower_http::limit::RequestBodyLimitLayer`). SDP and
  ICE messages are typically well under 2 KiB.
- Maximum simultaneous peers per room: unbounded by the server; in normal
  usage exactly 2 (the desktop and one mobile). Multiple subscribers are
  tolerated; receivers HMAC-validate to pick the legitimate counterpart.
