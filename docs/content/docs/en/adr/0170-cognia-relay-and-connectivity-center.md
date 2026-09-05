---
title: "0170: The relay is the WAN, and connectivity is one surface"
description: "The hosted signaling rendezvous carries the application data lane, an invitation carries a relay room so first pairing works from anywhere, the Host's connectivity configuration lives on an owner-authenticated RPC plane, and Settings has one Connectivity section."
---

# ADR 0170: The relay is the WAN, and connectivity is one surface

**Status:** Accepted
**Date:** 2026-09-05
**Amends:** ADR-0021 (WebRTC WAN transport), ADR-0059 (headless server), ADR-0082 (remote hosts)

## Context

Three things broke a phone or a browser that was not on the Host's LAN.

1. First pairing (`/api/auth/device/challenge` and `register`) was direct
   HTTPS only. A phone had to pair on the LAN first, and a browser could never
   pair across the WAN because it cannot pin the Host's self-signed
   certificate.
2. There is no hosted TURN, so a symmetric NAT on either side killed the
   WebRTC upgrade and left nothing underneath it.
3. The cloudflared tunnel is user-installed and desktop-only.

The one hosted component is the signaling rendezvous at
`wss://signaling.cognia.cn/signaling` (a Cloudflare Worker and an axum build,
sharing `cognia-signaling-core`). It already forwarded an opaque `Relay` frame
between the two peers of a room. Only the peers restricted the envelope kinds
to `hello` and SDP/ICE, so an application relay was peer-side work plus a
budget on the server, not a new service. "Cognia Cloud" therefore means this
rendezvous, upgraded.

Backend equivalence had a second gap. The desktop renderer configured
signaling, the browser-origin allowlist, push credentials and invitations
through Tauri commands. A headless `cognia-server` took the same decisions
from environment variables at boot and offered no way to change them from a
paired device. And Settings split one question across two sections, "Mobile
companion" (fifteen cards in five collapsible groups) and "Remote hosts", with
`/devices` and `/pair` beside them.

## Decision

### The relay is isomorphic to the DataChannel

`EnvelopeKind::Data` carries one DataChannel frame exactly as
`datachannel_framing.rs` produces it: the JSON RPC frame, `event` and
`event-batch`, `binary-resource*` and its chunks. The same dispatcher, the same
idempotency ledger, the same event cursor and the same 1 MiB message bound
serve both carriers. On the Host, `carrier.rs` holds a `DataCarrier` that
prefers an open DataChannel and falls back to the relay. On the client,
`TransportRtc` opens over the relay the moment the Host's `hello` acknowledges
it (`relay: true`), reports `open`, and negotiates ICE in the background. A
DataChannel that opens promotes the carrier. A DataChannel that drops demotes
it without a reconnect. The tier vocabulary gains `relay`.

The server buckets `Relay` frames by a `lane` field the sender sets without
the server decrypting anything: the `signal` lane keeps the 20-frame bucket
and the 8 KiB soft cap, the `data` lane has its own bucket (256 frames,
refilling at 64 per second) and a 64 KiB cap. Per-lane frame and byte counters
are exported on `/metrics`. There is no hard quota this round.

### An invitation carries a relay room

`cgnp4` adds `relay: { url, room, mobilePrivateKeyJwk }` to the pair payload.
The Host mints a one-shot P-256 key for the invitee, sits in a pairing room
on the rendezvous for the invitation's lifetime, and answers `pair.http` RPC
frames by driving its own axum router in-process against the four pairing
routes and nothing else. The client probes the direct address for four
seconds first and falls back to the relay. `cgnp3` stays decodable, and a
Host with no rendezvous still mints one.

### Backend equivalence through a host-admin plane

Fourteen commands moved from `target: client` to `target: host-admin`
(`capability: host.admin`, HTTP, WebSocket and WebRTC): signaling status,
configuration, device status and reconnect, browser access get and set, push
status, the four credential writes, the test push, invitation issue and server
status. One Rust implementation serves the Tauri command and the RPC arm
(`rpc/host_admin.rs`). A headless Host persists the signaling configuration
in `signaling.json` beside its other files. `cognia-server pair` asks a
running server for its invitation so the relay room is real.

What stays desktop-only is labelled so in place rather than hidden: the
tunnel (a child process) and mDNS (a LAN multicast socket).
`lib/connectivity/host-admin-reach.ts` answers "can this control run from
here, and if not why" for every control, and every block renders the answer.

### One Connectivity section

Settings gains one master/detail section with seven topics: Overview, Local
host, Cloud & relay, Pairing, Remote hosts, Push, Sync. The two retired
sections' deep links redirect into it. The pair steps moved to
`components/connectivity/pair/` and are the same component on the desktop
"Add host" form, the web `/pair` route and the mobile `/pair` route, with
re-export shims left at the old paths. `/devices` stays a route.

### Dead wires closed in the same change

Pause, resume and revoke on `/devices` reach a Host over its owner routes
from any paired companion. Push has a "Send test" that reports how many
offline devices it reached. The presence registry produces `degraded` when a
device keeps making requests after losing every event stream for longer than
one lease renewal interval, and both the Connectivity overview and the status
bar render it.

## Non-goals

Hosted TURN. A hosted headless service. Relay byte quotas. Tunnel or mDNS on
a headless Host. Mobile proxy settings. Deploying the Worker, which is the
operator's action (`wrangler deploy` in `services/signaling-server/worker`).

## Consequences

- A device pairs from any network with nothing installed on either side.
- A browser configures a headless Host exactly as the desktop renderer does.
- The relay is the floor, not the ceiling: P2P is still attempted and still
  wins when it lands.
- The rendezvous now carries application traffic, so its lane budgets are the
  abuse control. Watch `signaling_relay_bytes_total{lane="data"}`.

## Registration points

- Wire: `services/signaling-server/core/src/{proto,limits}.rs`, the axum
  `ws.rs` and `metrics.rs`, the Worker `room.rs`.
- Host: `src-tauri/src/companion_api/signaling/{carrier,pairing,client,dispatch,mod}.rs`,
  `companion_api/{signaling_config,rpc/host_admin}.rs`, `bin/cognia-server.rs`.
- Client: `lib/tauri/{transport-rtc,transport-companion,relay-pair-fetch}.ts`,
  `lib/qr/pair-payload.ts`, `components/connectivity/pair/`.
- Contract: `protocol/companion-commands.json`,
  `protocol/companion-response-schemas.json`,
  `protocol/headless-command-dispositions.json`, `pnpm companion-api:gen`.
- Settings: `components/settings/connectivity/`, `lib/connectivity/host-admin-reach.ts`,
  `hooks/connectivity/use-host-admin-reach.ts`.
- Devices: `lib/devices/lifecycle-http.ts`, `lib/companion/device-presence-registry.ts`.
