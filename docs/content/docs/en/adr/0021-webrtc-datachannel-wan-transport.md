---
title: ADR 0021 — WebRTC DataChannel WAN transport
description: Add a third transport tier between cognia mobile clients and the home desktop using a separate signaling rendezvous service and WebRTC DataChannel — preserving the existing HTTPS+WS path on every regression.
---

# ADR 0021 — WebRTC DataChannel WAN transport

> **Status**: Accepted on 2026-05-15. Wave 1 (pair-flow extension,
> signaling-server, TypeScript client) shipped 2026-05-15. Wave 2
> (Rust `webrtc-rs` peer in `src-tauri/src/companion_api/signaling/`,
> `CompanionTransport.enableWebRtcTier`, renderer-side controllers
> wired into `CompanionEventBridgeProvider`) shipped 2026-05-16.

## Context

Today's mobile → desktop transport (ADR-0014, ADR-0015) has three reach
mechanisms, all of which terminate at the same HTTPS+WS endpoint hosted
on the desktop's `axum` server (`src-tauri/src/companion_api/server.rs`):

1. **mDNS LAN.** Works on the same Wi-Fi. Fast, no relay.
2. **Cloudflared tunnel.** Public reachability _via Cloudflare_. Single
   vendor; non-trivial latency tax; subprocess overhead on the desktop.
3. **Cached baseUrl.** Last-known address; fails on IP changes.

The user wants the mobile app to reach the home desktop **from the
public Internet** (cellular, hotel Wi-Fi, …) without depending on
cloudflared. ICE-based UDP hole punching can bypass that vendor dependency
for the common NAT topologies, and falls back gracefully when it can't.

The existing `/ws/v1/events` endpoint can not be reused for WebRTC
signaling: on WAN, the mobile client cannot reach that endpoint until
WebRTC is _already_ up (the same NAT closes the path). The signaling
rendezvous must therefore be a **separate, always-on, public** service.

## Decision

Add a third transport tier — a WebRTC `RTCDataChannel` — between the
home desktop and each paired mobile client. The tier is **additive**:
the existing HTTPS+WS path stays byte-for-byte unchanged on the success
path, and the WebRTC tier is consulted only when LAN is unavailable.

### Transport priority (from `lib/connectivity/connection-strategy.ts`)

1. mDNS LAN (HTTPS+WS) — fastest, preferred when available.
2. **NEW — WebRTC DataChannel** via public signaling + STUN/TURN.
3. Cloudflared tunnel (HTTPS+WS) — ultimate fallback when ICE fails.
4. Cached baseUrl.

### Signaling rendezvous (standalone Rust binary)

A new repo subdirectory, `signaling-server/`, hosts a tiny axum +
tokio-tungstenite WebSocket router (~250 LOC). It is **stateless** with
respect to application logic: rooms keyed by `rendezvousId` hold a
`Vec<PeerHandle>`; relay frames fan out to other members. No persistence,
no app secrets, no business knowledge. Deploys as a Docker image; the
sample `fly.toml` targets Fly.io's free `shared-cpu-1x` tier.

Default hosted endpoint (project-operated):
`wss://signaling.cognia.app/v1/signaling`. Users with a privacy or
operational preference may run their own — `AppSettings.signalingUrl`
overrides the default.

### Pair-flow extension

`POST /api/v1/auth/pair` returns two additional fields when the desktop
supports WebRTC (older clients ignore them):

```
{
  deviceId, deviceJwt, serverVersion,
  rendezvousId,       // UUIDv4 public room id
  rendezvousSecret    // 32-byte HMAC key, URL-safe base64 (unpadded)
}
```

Both fields ride the existing `companion://device-paired` Tauri event,
land in `PairedDeviceRow` on the desktop and in `CompanionConfig` on the
mobile client (mobile uses the existing
`capacitor-secure-storage-plugin` entry — same keychain blob as
`deviceJwt`).

### End-to-end authentication

The signaling rendezvous is **untrusted**. Every application-level
signaling payload is wrapped in an `Envelope`:

```
type Envelope = {
  ver: 1, ts, nonce, seq, kind, body,
  mac: HMAC-SHA256(rendezvousSecret, canonicalJSON({...this, mac: ""}))
}
```

The receiver:

1. checks `|ts − now| ≤ 5 min` (clock-skew window),
2. verifies the HMAC with constant-time compare,
3. runs the `(rendezvousId, role, seq)` and `(role, nonce)` tuples
   through a 256-entry replay LRU.

The signaling server cannot impersonate either peer, replay an old
envelope, or read the SDP/ICE traffic — it only sees opaque base64.

### Where things live

```
signaling-server/                       (Rust, standalone deployable)
  Cargo.toml, Dockerfile, fly.toml, README.md
  src/{proto,room,limits,ws,server,lib,main}.rs
  tests/room_routing.rs

src-tauri/src/companion_api/
  auth.rs                                + rendezvous tuple in PairResponse
  rpc.rs                                 dispatch made pub(super), allowlist +4 keys
  signaling/                             webrtc-rs peer + envelope sign/verify
    {mod,client,peer,envelope,dispatch}.rs
  commands.rs                            SignalingHub::bind() wired into companion_server_start

src-tauri/src/lib.rs                     SignalingHub managed; commands registered

lib/signaling/                           (TS, framework-agnostic)
  types.ts, envelope.ts, client.ts, index.ts
  envelope.test.ts, client.test.ts
  desktop-controller.{ts,test.ts}        Dexie + AppSettings → SignalingHub
  mobile-controller.{ts,test.ts}         Settings → CompanionTransport.enableWebRtcTier

lib/tauri/
  transport-rtc.{ts,test.ts}             RTCPeerConnection driver + tests
  companion-storage.ts                   + rendezvousId/Secret optional fields
  transport-companion.ts                 enableWebRtcTier + getActiveTier

components/providers/companion-event-bridge-provider.tsx  mounts the two controllers

components/settings/companion/
  webrtc-card.{tsx,test.tsx}             Settings UI (toggle + ICE/TURN editors)

types/mobile/paired-device.ts            + rendezvousId/Secret optional fields
lib/db/{paired-devices,schema}.ts        + Dexie v33 (audit-trail-only)
i18n/messages/{en,zh-CN}.json            mobile.companion.webrtc.* keys

docs/content/docs/en/adr/0021-...md      (this file)
```

### AppSettings additions

Four optional keys, allowlisted in `src-tauri/src/companion_api/rpc.rs`
for `app_settings_update`:

| Key             | Default                                     | Purpose                            |
| --------------- | ------------------------------------------- | ---------------------------------- | ---- | ------------- |
| `webrtcEnabled` | `true`                                      | Master toggle. Off → tier skipped. |
| `signalingUrl`  | `"wss://signaling.cognia.app/v1/signaling"` | Override for self-hosters.         |
| `iceServers`    | Google + Cloudflare STUN                    | Augment / replace default STUN.    |
| `turnServers`   | `[]`                                        | Optional TURN relays (URL `        | user | credential`). |

### Backward compatibility

- A device paired before this ADR has neither `rendezvousId` nor
  `rendezvousSecret` in its `PairedDeviceRow` / `CompanionConfig`. The
  WebRTC tier is silently disabled for that device; cloudflared remains
  the WAN fallback. Re-pairing opts in.
- Older mobile clients ignore the two new pair-response fields.
- A pre-WebRTC desktop running against a new mobile fails the
  pair-response shape check gracefully (Wave 2 mobile transport guards
  the lookup behind `if (config.rendezvousId)`).

## Consequences

**Positive**

- Removes Cloudflare as a single-vendor dependency for WAN access; the
  hosted signaling endpoint is much smaller and easier to self-host
  (~256 MB RAM, no business logic).
- Lower latency for the common NAT scenarios where ICE succeeds.
- No change to existing LAN/local paths — zero regression surface for
  the most common case.

**Negative**

- A new operational responsibility (the hosted signaling endpoint).
- WebRTC support matrix has known sharp edges (symmetric NAT, CGNAT)
  that require TURN; default ships without TURN credentials — the
  cloudflared fallback covers those cases.
- `webrtc-rs` adds a heavyweight crate (~50 transitive deps,
  measurable build-time cost) to the Tauri Rust side. We accept this
  cost; the alternative (a sans-io stack like `str0m`) would require
  writing the IO + scheduling glue from scratch.

**Operational**

- Project owner deploys `cognia-signaling-server` to a public host.
  Sample `fly.toml` provided; any platform with WebSocket support works.
- Telemetry / abuse: rate limit is per-connection (20 frames cap, refill
  10/sec). Persistent abuse is mitigated by IP-level platform limits
  (Fly proxy, Cloudflare in front, etc.).
- No persistent state — a redeploy or migration drops all rooms; peers
  reconnect and resubscribe transparently (state lives in
  desktop/mobile, not in the rendezvous).

## Alternatives considered

- **Reuse `/ws/v1/events` for signaling.** Rejected — the chicken-and-egg
  loop on WAN makes this unworkable. The mobile can't reach the desktop
  WS until WebRTC is up.
- **`str0m` instead of `webrtc-rs`.** Better long-term ergonomics but
  current ergonomics worse for our tokio + axum stack; reserved as a
  Wave 3 option if `webrtc-rs` becomes the bottleneck.
- **Bundle coturn.** Rejected — only useful on the desktop's LAN, which
  defeats the purpose. Self-hosted TURN is a paid feature gate; the
  project ships configuration-only and users supply credentials.
- **Reactivate `devicePubkey` for end-to-end signing.** Considered but
  deferred — the existing `pubkey` field on `PairedDeviceRow` is
  plumbing-only today and a Wave 3 ADR can promote it without
  invalidating this design.

## Verification

Each component ships with co-located tests; the project gate
(`pnpm test:coverage`) holds them to ≥90% lines/branches/functions:

- `signaling-server/tests/room_routing.rs` — boot the server, drive a
  two-client subscribe→relay→leave dance, assert ordering.
- `src-tauri/src/companion_api/auth.rs` `#[cfg(test)]` — pair response
  carries valid `rendezvousId` (UUID) + `rendezvousSecret` (32 bytes
  base64url); two pair flows produce distinct tuples.
- `lib/signaling/envelope.test.ts` — canonical JSON, sign/verify
  round-trip, replay window, tamper detection, ±5 min skew window.
- `lib/signaling/client.test.ts` — subscribe→relay→peer-left lifecycle
  with a `WebSocket` double; HMAC + replay rejection.
- `lib/tauri/transport-rtc.test.ts` — SDP/ICE exchange, DataChannel RPC,
  event dispatch, timeout-to-failed, ICE-failure-to-failed.
- `components/settings/companion/webrtc-card.test.tsx` — parser /
  stringifier round-trip, default population, validation toast.

End-to-end WAN smoke (manual, per Wave 2): mobile on cellular pairs
with desktop on home Wi-Fi without cloudflared; `claude_send` traverses
WebRTC; switching mobile to Wi-Fi restores LAN; toggling
`webrtcEnabled = false` forces cloudflared.

## Operational verification (Wave 2.5 addendum, 2026-05-17)

The Wave 1–2 implementation has been hardened with mid-session reconnect
on the TS side, a per-device "Reconnect" affordance on both desktop and
mobile, and observability on the standalone rendezvous. The verification
loop is split into two halves:

- **Automated:** `pnpm webrtc:smoke` boots a local
  `cognia-signaling-server` on an ephemeral port and exercises
  subscribe → relay → unsubscribe, malformed-frame, rate-limited burst,
  and the `/healthz` + `/metrics` shape. Pure server smoke — does not
  exercise the application-layer envelope (covered by
  `lib/signaling/envelope.test.ts`).
- **Manual real-device:** the public-NAT smoke checklist lives in
  [companion/webrtc-verification](../companion/webrtc-verification). Run
  the checklist after every change that touches the SDP/ICE handshake or
  the signaling envelope schema.

### Production observability

The signaling rendezvous now exposes:

- `GET /healthz` — JSON probe used by fly.io's `[[http_service.checks]]`.
  Returns `{ ok, rooms, peers, uptimeSeconds, version }`.
- `GET /metrics` — Prometheus 0.0.4 text exposition. Counters:
  `signaling_frames_in_total`, `signaling_frames_relayed_total`,
  `signaling_frames_rejected_total{reason="…"}` (replay / hmac /
  malformed / rate / not_subscribed), `signaling_rooms_active`,
  `signaling_peers_active`, `signaling_uptime_seconds`.

Both endpoints are cheap (lock-free counters; no Dexie/DB touch) and
safe to scrape at 30 s intervals. The fly.io probe is wired in
`signaling-server/fly.toml`.

### Defensive limits

Two layers gate misbehaving clients:

- **Per-connection token bucket** (`limits.rs`) — 20-frame capacity,
  10-frame/sec refill. Bounds the rate at which one socket can flood a
  room.
- **Per-source connection cap** (`ip_limits.rs`) — at most
  `SIGNALING_MAX_CONN_PER_IP` (default `50`) concurrent WebSocket
  upgrades per client IP. Beyond that, the upgrade is rejected with
  `429 Too Many Requests`. The cap is set at process boot from the
  env var; behind a Fly.io / Cloudflare proxy the client IP is read
  from `Fly-Client-IP` / `X-Forwarded-For` first, falling back to the
  raw TCP peer when no proxy header is present.

Malformed-frame error messages were also redacted to a static string
(`"frame did not match expected schema"`) so an opportunistic client
can't reverse-engineer the wire format from verbose serde output. The
detailed parse error stays in the server-side trace log.

### TURN credentials

Wave 1 deliberately ships without bundled TURN. Users on symmetric NAT
should follow [companion/turn-byo](../companion/turn-byo) to plug in
Twilio Network Traversal Service, Cloudflare Calls TURN, or a self-hosted
coturn. Credentials are stored unencrypted in Dexie — bring keys you can
rotate.

## References

- [ADR-0014: Capacitor mobile shell](./0014-capacitor-mobile-shell.md)
- [ADR-0015: Mobile V2 completion](./0015-mobile-v2-completion.md)
- `signaling-server/README.md`
- [webrtc.rs documentation](https://docs.rs/webrtc/latest/webrtc/)
