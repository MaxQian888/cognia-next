---
title: "0211 — The public status page measures the relay it names"
description: "The public `/status` page reports the official hosted relay (`signaling.cognia.cn`) from real protocol probes: health, an authenticated two-peer signaling round trip and the explicit data lane, recorded as immutable minute slots in a separate `cognia-status` Worker with D1. Missing evidence is unknown, never 100 %; availability is counted, coverage is shown beside it, and observer health is published apart from service health. Incidents, maintenance, Atom/RSS and double-opt-in email are operator- and consent-controlled. One contract module (`lib/status/`) is bundled into the page, the Worker, the external Node probe and the operator CLI."
---

# ADR 0211 — The public status page measures the relay it names

**Status:** Accepted
**Date:** 2026-10-02
**Related:** [ADR-0170](./0170-cognia-relay-and-connectivity-center) (relay and connectivity center), [ADR-0021](./0021-webrtc-datachannel-wan-transport) (WebRTC/WAN transport), [ADR-0037](./0037-public-share-links) (public standalone Worker pattern), [ADR-0092](./0092-official-website-workspace) (static public sites)
**Plan:** [`docs/plans/2026-10-02-signaling-public-status-implementation.md`](https://github.com/MaxQian888/cognia-next/blob/dev/docs/plans/2026-10-02-signaling-public-status-implementation.md)

## Context

`/status` shipped as a designed page over deterministic preview data: five fictional
service categories, three invented regions and sample incidents. `calculateUptime([])`
returned 100 and an empty component list derived "operational". Meanwhile the one
public service users actually depend on from outside their LAN, the signaling
rendezvous and relay at `signaling.cognia.cn`, had no history at all. Its `/healthz`
is static liveness; it does not prove that two peers can authenticate into a room or
that the `lane: "data"` relay carries bytes intact.

## Decision

### 1. Measure what users use, through the route they use

Three components with stable IDs: `signalingHttp` (health body is a Cognia relay of
the expected protocol), `signalingAuth` (two fresh synthetic P-256 identities
authenticate into a fresh room through challenge-bound proofs, see each other, and
exchange a signal plus acknowledgement) and `relayData` (≈1 KiB payload on the
explicit data lane in both directions, byte-equal, then ping/pong). If auth fails,
data is `unknown` with `dependency_failed`, never a separately observed failure.
Probes use no accounts, user rooms or device keys, stay under 1 MiB per room and
always close their sockets. Simulated Origin profiles (`web`, `ios`, `android`)
send exact Origin headers and are labelled as simulation, not device evidence.

The shared synthetic-room helpers live in the signaling test seam
(`services/signaling-server/worker/tests/synthetic-room.mjs`) and the protocol run
in a portable core (`services/status-server/probe/src/core`) that both the
Cloudflare Cron observer and the external Node probe bundle.

### 2. A separate Worker owns monitoring

`cognia-status` (Worker + D1 + the status-only static export) is never on the relay's
admission path. It fetches the relay's public route (`global_fetch_strictly_public`).
An external Node probe on a non-Cloudflare host signs observations with per-probe
HMAC keys and also serves an independent read-only mirror. Until such a host exists,
the Cron observer is the registry's reference and the page says "single observer".

### 3. Unknown is a value, and availability is counted

Every expected reference minute has exactly one `pass`, `fail` or `unknown` per
component. Availability is `pass / (pass + fail)` from summed counts. Coverage is
`observed / expected` and is always shown beside it. No observation means a null
availability and a `no_data` cell. Maintenance exclusions are reported separately
from raw counts. Evidence goes stale after 180 s (900 s for 300 s profiles), and the
snapshot itself goes stale after 180 s in the browser, calibrated by server time.
Overall status is the worst failing component; otherwise any unknown component makes
it unknown. Observer health (`healthy | limited | degraded | unknown`) is published
separately and never becomes an outage.

### 4. One contract, many bundles

`lib/status/{contract,derive,validate,signing,config}.ts` is a leaf: no `@/`, React,
Dexie or Node built-ins. The page, the Worker, the probe and the CLI import it by
relative path, so they cannot drift. Schema version 1 is frozen. An unsupported
version renders "unavailable", never a preview. Fixtures (`fixtures.ts`) exist only
for tests and stories.

### 5. Writes are scoped

Probe ingestion is HMAC-signed over method, exact path, timestamp, run ID and body
digest, with a ±120 s window. A run is immutable: an exact replay is a no-op and a
conflicting replay is 409. Runs older than 10 minutes are refused. The first
observation of a minute wins. Operator writes require a Cloudflare Access JWT
validated inside the Worker (issuer, audience, signature, expiry, allowlisted email)
and use operation IDs and revision CAS. Subscriptions are double opt-in with hashed,
purpose-scoped tokens carried in URL fragments. GET never changes consent. Addresses
are stored only as an HMAC index plus AES-GCM ciphertext.

### 6. Jobs are leased and fenced

Aggregation, delivery and retention take separate D1 leases with monotonic fences,
and every committing statement checks the fence. Rollups are rebuilt from dirty hours
whose marks clear only if their sequence did not move.

## Consequences

- The page can show red, grey and "no data", and will. That is the point.
- With one observer, a Cloudflare-wide failure takes the page and its witness down
  together; the external probe and mirror are the planned remedy, delivered as code
  and deployment manifests (`services/status-server/probe/deploy/`).
- Mail uses Cloudflare Email Sending, which requires Workers Paid and has neither an
  idempotency key nor a bounce webhook. Ambiguous sends are `uncertain` and need an
  audited operator retry. Suppression comes from `E_RECIPIENT_SUPPRESSED`.
- A Cron minute issues about 50–70 D1 statements; `src/budget.test.ts` bounds it. The
  service is sized for Workers Paid.
- Settings → Connectivity links to the public page and says it covers the official
  relay only; a self-hosted relay is never shown as "officially green".

## Verification

- Contract: `pnpm test -- lib/status lib/signaling/relay-health.test.ts`.
- Worker, probe and CLI: `pnpm -C services/status-server/{worker,probe,admin} test`.
- Live protocol evidence: `pnpm -C services/status-server/probe test:live`.
- Static distribution: `node scripts/build/build-status-site.mjs` after `pnpm build`.
