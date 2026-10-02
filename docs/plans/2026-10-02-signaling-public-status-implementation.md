# Cognia public signaling status: implementation and agent handoff

| Field                       | Value                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| Status                      | Implementation-ready proposal; no feature implementation or deployment performed by this document |
| Date                        | 2026-10-02                                                                                        |
| Product decision            | Public status page, with an entry in Cognia Settings → Connectivity → Cloud & relay               |
| Depth                       | Heavy: shared contracts, frontend, probes, D1, administration, notifications, deployment          |
| Canonical source            | This document; agents should record deviations here before changing a frozen contract             |
| Research                    | [Current-code and option research](../research/signaling-uptime-panel-2026-10-02.md)              |
| Related architecture        | ADR-0021, ADR-0170, ADR-0037, ADR-0092                                                            |
| Implementation coordination | One integrating agent, with six work-package owners defined in section 14                         |

## 1. Reuse `/status`, and measure the public relay through real protocol probes

Build on the existing public status UI. Replace its preview-only data with a separate Cloudflare status Worker, D1 history, and authenticated probe ingestion. Host the exported status assets in that Worker at the proposed `https://status.cognia.cn/status/`, with `/` redirecting to `/status/`. Keep monitoring and administration outside the signaling Worker.

Run a continuous Node probe on an external host outside Cloudflare. Its one-minute measurements are the reference history. Cloudflare Cron supplies corroborating checks and runs aggregation, incident reconciliation, delivery and retention jobs. Provide an externally hosted, read-only status mirror with an independent HTTPS hostname for Cloudflare-wide failures.

The complete delivery includes real history and latency, observer freshness, incidents, scheduled maintenance, RSS/Atom, double-opt-in email subscriptions and unsubscribe, operator commands, diagnostics, deployment/rollback, and acceptance evidence. These are separate milestones, not permission to leave preview behavior in production.

Three questions must remain distinguishable:

1. **Public service:** Can a probe reach the hosted HTTP, authenticated signaling and data relay paths?
2. **Monitoring:** Is evidence arriving, and from which actual locations and client-origin profiles?
3. **My connection:** Can this particular Cognia device reach its configured relay and host?

### Outcomes and explicit boundaries

| Outcome                                                        | Acceptance                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Users can distinguish HTTP liveness from working relay traffic | HTTP succeeds while authenticated signaling or explicit `lane: data` fails; only the affected components fail           |
| Missing evidence never fabricates availability                 | Zero samples display unknown and no percentage; stopped probes become stale; coverage is visible                        |
| History reflects actual observation time                       | No synthetic 90-day backfill; weighted counts, UTC boundaries, partial days and maintenance exclusions are tested       |
| Public access works without a Cognia account                   | Fresh browser, desktop and mobile route checks never initialize account-gated/background runtime                        |
| Cognia provides a useful entry                                 | Existing connection check remains usable; public status link opens through the existing cross-platform opener           |
| Incidents and maintenance are operable                         | Authorized CLI creates/updates them; concurrent edits cannot overwrite newer revisions; changes appear in UI/feed/email |
| Subscription means a real subscription                         | Confirmation, delivery, retry, bounce suppression, preference management and unsubscribe pass end-to-end checks         |
| Monitoring survives service/platform failure                   | External probe and mirror remain available when signaling or the status Worker is unreachable                           |

This plan monitors the hosted rendezvous and opaque application data relay. It does not promise arbitrary phone-to-PC WebRTC connectivity, TURN availability, a working user host, full RPC execution, or mainland cellular coverage. Add such claims only after matching real-device/operator tests. A probe using a mobile Origin header is a simulated client profile, not a physical mobile-network test. A generic private operations dashboard, exact online-user counters, billing charts and a new TURN service are outside this delivery.

## 2. The existing code provides the UI and protocol seams, but not live status

The following facts were checked in the current shared worktree on 2026-10-02. Files may have concurrent changes; implementation owners must anchor their own baseline.

| Evidence                                                                                                                      | Status                            | Required treatment                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `app/status/page.tsx` mounts `PublicStatusPage`                                                                               | Confirmed                         | Extend this route; do not create a parallel public page                                            |
| `components/status/public-status-page.tsx` has history, latency, region, incident, maintenance and subscription UI            | Confirmed                         | Reuse presentation; its default snapshot and subscription submission are previews                  |
| `lib/status/public-status.ts` fixes `mode: preview`, five fictional service categories, three regions and sample incident IDs | Confirmed                         | Generalize identifiers/content; move fixtures to explicit tests/stories/dev preview                |
| `calculateUptime([])` returns 100 and `deriveOverallStatus([])` returns operational                                           | Confirmed                         | Change live semantics to unknown/null and count-based availability                                 |
| `components/runtime/lightweight-route-shell.tsx` treats `/status` as public/lightweight                                       | Confirmed                         | Preserve behavior for static `.html`, trailing slash, nested token routes and account-less access  |
| `CloudRelayPanel` mounts `RelayCheckBlock`; `use-remote-access` runs the manual relay probe                                   | Confirmed                         | Extend this seam for the link; do not replace device checks with public status                     |
| `lib/signaling/relay-probe.ts` has reusable pure health/protocol logic plus platform-specific fetch                           | Confirmed                         | Extract/share the pure seam only; do not bundle native imports into the Worker                     |
| `lib/connectivity/healthz.ts` describes host TLS/identity health                                                              | Confirmed                         | Do not confuse it with public signaling health                                                     |
| Signaling Worker routes are `/healthz`, `/signaling`, `/v2/signaling`                                                         | Confirmed                         | `/healthz` is static capability/liveness evidence, not a DO/auth/data check                        |
| Worker test `tests/integration.mjs` already creates P256 rooms and authenticates roles                                        | Confirmed                         | Extract reusable happy-path helpers; periodically test explicit data lane                          |
| Worker `METRICS` Analytics Engine binding is commented out                                                                    | Confirmed                         | AE is optional operational telemetry; sampled events are not authoritative uptime or online gauges |
| Axum alternative exposes process/room metrics                                                                                 | Confirmed                         | Do not assume these endpoints exist on the deployed Worker                                         |
| Public `/healthz` and a synthetic integration run succeeded during research                                                   | Point-in-time evidence            | No historical SLO, deployed-SHA or real-device/cellular acceptance follows from this               |
| No continuous status backend was found in the reviewed paths                                                                  | Inferred from repository research | A standalone status service is justified; recheck before creating it                               |

Root application and `web/` builds are static exports. `web/` is the marketing workspace; do not import product runtime into it or use its output as if it contained the product `/status` route. No Next.js API route, server action or runtime database connection belongs in the public frontend.

## 3. A separate status Worker is the default; an external observer provides independence

```text
External Node probe ──public HTTPS/WS──> signaling.cognia.cn
        │                                      ▲
        │ signed observations                  │ public checks
        ▼                                      │
status Worker ──Cron checks / reconciliation────┘
        │
        ├── D1: observations, aggregates, incidents, subscribers, outbox
        ├── /api/status/v1/*: sanitized public reads + scoped writes
        ├── static assets: exported existing /status UI
        └── email provider: confirmation + incident/maintenance notifications
             ▲
             │ verified delivery webhooks
Operator CLI ──Access JWT──> administrative API

Cognia Settings ──existing opener──> primary public status URL
External host ──independent HTTPS──> read-only assets + last public snapshot
```

The status Worker isolates monitoring failures and database/mail dependencies from signaling traffic. The external probe and mirror avoid making Cloudflare the sole witness of Cloudflare availability. The diagram describes separate execution/trust paths; it does not imply separate Cloudflare accounts or global multi-region redundancy.

| Alternative                                                             | Decision and rationale                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uptime Kuma plus custom Cognia probes                                   | Good if an already maintained Kuma deployment exists. No deployment was established during research. Default to the small dedicated service; do not operate two authoritative histories. Kuma WebSocket upgrade alone does not authenticate or relay data |
| Upptime as sole monitor                                                 | Reject for the one-minute protocol target: scheduled Actions can be delayed/missed and still need custom auth/data checks. It can be a supplementary HTTP witness                                                                                         |
| Monitoring routes inside signaling Worker                               | Reject: shared failure and attack surface; monitoring DB/mail must never affect relay admission                                                                                                                                                           |
| Separate Pages frontend plus API Worker                                 | Valid but adds routing/CORS/deploy coordination. Default to one status Worker with static assets; keep frontend export separable for the external mirror                                                                                                  |
| Analytics Engine as the history database                                | Reject: existing telemetry is sampled/best-effort. D1 owns exact observation/incident/subscription records                                                                                                                                                |
| Rebuild the page in `web/` or embed an operations dashboard in Settings | Reject: existing `/status` and connectivity UI already own the relevant user paths                                                                                                                                                                        |

### Deployment/resource defaults

- Proposed production status Worker: `cognia-status`; D1: `cognia-status`; separate staging resources, no production secrets/bindings inherited implicitly.
- Primary public URL: `https://status.cognia.cn/status/`; API base: `https://status.cognia.cn/api/status/v1`. Resolve public URLs in the existing constants/config seam, with explicit self-host overrides.
- Worker serves API paths first, redirects `/`, and serves only the exported public status assets for remaining approved paths. Unknown API paths return JSON 404, never SPA HTML. Disable unprotected administrative access through alternate hostnames.
- External runner: continuous Node process, supervised by systemd or the existing container platform; outbound-only ingestion credentials. Deployment owner selects the actual provider and location before production acceptance.
- External mirror: serve the same public export and periodically copied sanitized snapshot through an independent provider/DNS HTTPS hostname. It has no admin/ingest/email writes. A second hostname behind the same Cloudflare proxy is insufficient for the independence claim.
- Mail: default Resend HTTP API with a verified sender domain and verified webhook. No provider abstraction hierarchy for this single integration. If a portable existing provider module is found, reuse it and amend the contract before implementation.

## 4. Components describe checks, and probe locations describe evidence

Use stable component IDs: `signalingHttp`, `signalingAuth`, `relayData`. UI labels are bilingual. Do not present fictional agent runtime/storage/control-plane health without corresponding service checks.

| Check                             | Default cadence             | Timeout / pass condition                                                                                                                    |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| External reference HTTP           | 60 s                        | 6 s; public DNS/TLS/HTTP 200; validated signaling health schema, expected protocol and lane capabilities                                    |
| External reference auth + signal  | 60 s                        | One shared protocol run, at most 20 s; two WS upgrades, challenge-bound role authentication, peer acknowledgement and verified signal relay |
| External reference data           | 60 s                        | Same authenticated room; explicit `lane: data`, bounded bytes in both directions, nonce/payload equality and ping/pong                      |
| Cloudflare corroborating HTTP     | 60 s                        | Same HTTP contract; evidence source clearly marked Cloudflare                                                                               |
| Cloudflare corroborating protocol | 300 s                       | Same auth/data contract; staged deployed Cron smoke must verify outbound WS and crypto support                                              |
| External Origin profiles          | 300 s per supported profile | Current configured exact web/iOS/Android Origins; results identify simulated profiles                                                       |
| External monitoring-plane checks  | 60 s                        | Primary status HTML and API reachable/schema-valid; observer health is separate from relay service status                                   |

Default external region is the real host location. Do not invent North America/Europe/Asia-Pacific results. Later enrolled probes have independent IDs, enrollment timestamps and explicit geographic/network metadata. Do not equate two runners in one provider with two independent providers.

### Probe execution contract

1. Share canonical room/signature helpers from `services/signaling-server/worker/tests/integration.mjs`; preserve its negative integration tests. Reuse the pure health parser from `lib/signaling/relay-probe.ts`. Use a portable core with Node and Worker transport adapters only where runtime APIs differ.
2. Generate fresh temporary P256 keys, nonce, room descriptor and short expiry per run. No Cognia accounts, invitations, user rooms, real device keys or user traffic.
3. Register listeners before sending; filter messages by room/role/nonce/phase. Enforce per-phase and overall deadlines. A later phase must not consume a stale earlier message.
4. Wait for both subscriptions/peer readiness, verify signal delivery, then a roughly 1 KiB data payload and acknowledgement in both directions. Keep total per-room relay traffic below 1 MiB. Do not merely check HTTP 101 or capabilities.
5. Return independent check results. If auth fails, data is `unknown` with `dependency_failed`, not an independently measured data failure. An overall reference slot may still fail because auth was observed failing.
6. In `finally`, unsubscribe/close both sockets; force-close Node sockets after a short close deadline. No overlapping run per probe/profile; skipped overlap is an observer gap, not a service failure. On shutdown, cancel current work and persist bounded pending ingestion.
7. Ingestion retry uses the same run/body identity, exponential jitter and a bounded local disk spool: at most 10 minutes or 1 MiB, whichever is reached first. Exhaustion increments observer-loss metrics and produces history gaps. Never replay ancient observations as current health.
8. Originless native, current browser and WebView origins are separate profiles. Explicitly distinguish header simulation from an actual browser/Capacitor run. Run full tamper/takeover/forbidden-Origin tests in CI/staging, not every production minute.

The current Worker persists relay quota when crossing 1 MiB, resetting its window or exceeding quota; tiny fresh-room probes normally avoid that write. Verify this and socket/alarm quiescence under a fixed soak test. Do not add privileged synthetic bypasses, delete-room endpoints or reset live quotas on close. If a real persistence leak is demonstrated, design expiry cleanup with existing quota-window semantics as a separately reviewed signaling change.

Cloudflare checks must fetch the public route. Verify `global_fetch_strictly_public` and deployed routing; a service binding/direct origin call is useful internal evidence but cannot replace the public route check. Handler network work belongs inside the invocation. Failure of a Worker runtime feature must report observer failure rather than assert target outage.

## 5. Unknown evidence and observed availability have precise semantics

### Observation and freshness

Separate `pass | fail | unknown` check evidence from public `operational | degraded | partial_outage | major_outage | maintenance | unknown` display status. Record bounded reason codes such as `dns_error`, `tls_error`, `http_status`, `schema_mismatch`, `ws_upgrade`, `auth_timeout`, `relay_mismatch`, `dependency_failed`, `runner_error`, `missing` and `stale`. Do not publish raw exceptions or payloads.

- External/HTTP results are fresh for 180 s; 300 s profiles are fresh for 900 s. Server config publishes those thresholds. Judge age from the check timestamp, not the API request time.
- Snapshot generation defaults to every 60 s. A snapshot older than 180 s becomes stale in the browser even if HTTP/cache keeps serving it.
- A recent `runner_error` is unknown service evidence and unhealthy observer evidence. No new result after its expected cadence counts as missing; it does not silently prolong green.
- Page age calculations use server time offset when available; implausible client clock skew must show uncertain freshness. Timer wake/visibility change recomputes freshness immediately.

### Public current state

For each component, corroborate only the same check/profile class; keep Origin-specific failures visible separately.

| Fresh evidence                                                                 | Display                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No usable result                                                               | Unknown; monitoring coverage explanation                                                                                                                                       |
| Passing reference, corroboration absent                                        | Operational, with limited-observer badge; do not claim corroborated/global availability                                                                                        |
| One isolated failure before three consecutive failures                         | Degraded / checking, with affected probe detail; no major outage or immediate incident notification                                                                            |
| Fresh success and fresh repeated failure disagree                              | Partial outage, naming observed locations/profiles without inventing a root cause                                                                                              |
| Reference fails for three consecutive expected slots; no fresh passing witness | Major outage, explicitly labelled single-witness if only one observer exists                                                                                                   |
| Two independent witnesses repeatedly fail                                      | Major outage with corroborated evidence                                                                                                                                        |
| Recovery                                                                       | Show monitoring after two consecutive fresh reference passes; resolve automated incident after corroboration also passes, or mark recovery uncorroborated if it is unavailable |

Two expected slots with no data break a consecutive-failure/pass sequence; delayed batches must not retrospectively open duplicate live incidents. Overall service status is the worst known critical component status; if any critical component is unknown and none is failing, overall is unknown. Show observer status separately. Unknown is not a numeric severity that can be hidden behind operational.

Manual incidents can add declared impact/context, but cannot turn failing probes green. Maintenance is a scoped overlay; failures on unrelated components remain visible. A fully unknown monitored service stays unknown even inside maintenance.

### Availability calculation

Use the designated external reference probe for all three component histories. Corroborating probes affect confidence/current diagnostics, not denominator weights. Freeze reference selection in a versioned registry; a replacement is effective at a UTC minute boundary and never rewrites prior history.

For every expected reference minute from enrollment to the selected end time, each component has exactly one `pass`, `fail` or `unknown` slot. Exact repeats do not add slots. Use `floor(scheduledAt / 60_000)` with allowed timestamp skew; do not choose the slot from ingestion time. Profiles at five-minute cadence have their own series and are not expanded into five invented passes.

```text
observed = passCount + failCount
observedAvailability = observed == 0 ? null : 100 * passCount / observed
coverage = expectedEligibleSlots == 0 ? null : 100 * observed / expectedEligibleSlots
unknownCount = expectedEligibleSlots - observed
```

Display observed availability and coverage together; never label the first as a guaranteed global SLA. Calculate totals from summed counts, not averages of daily percentages. Rounding occurs only for display. Empty/pre-enrollment days are no-data cells.

For an overall series, join the three reference checks by minute: any observed critical failure → fail; all three pass → pass; otherwise unknown. This avoids reporting data success when auth was never attempted. Low coverage is always visible beside a high percentage.

Maintenance-excluded availability excludes slots whose scheduled UTC minute start lies in a published half-open `[startsAt, endsAt)` window for that component. Preserve raw counts and show the exclusion rule and excluded count. Require minute-aligned windows. Retroactive edits rebuild eligible aggregates with a new revision and audit entry; they never delete raw observations or silently erase outages.

History selectors: 24 h, 7 d, 30 d, 90 d. Latency: successful attempts only, with HTTP/auth/data phase definitions; failed attempts are gaps, not zero milliseconds. Publish p50/p95 over bounded buckets with sample counts; no percentile of already aggregated percentiles. Insufficient samples display no-data, with the minimum count documented in the UI.

## 6. One portable contract owns every consumer

Owner A extends `lib/status/public-status.ts` and adds only necessary pure contract/config/parser modules next to it. Node/Worker/frontend all consume the same schema, identifiers and derivation functions; no copied DTO definitions. No React, Zustand, Dexie, native platform or Node built-ins in this leaf. Standalone service tsconfig/build must explicitly prove these cross-directory imports bundle correctly, following existing share-service leaf imports.

Freeze contract v1 with representative pass/fail/unknown/stale/empty fixtures before parallel implementation. Contract additions are optional; changes in meaning require a new version. Unsupported versions fail visibly to unknown; never fall back to preview. Validate at public API, ingestion and provider/admin boundaries.

### Public snapshot minimum fields

| Field                                               | Meaning                                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `revision`, `mode: live`           | Contract and monotonic aggregate revision; preview is permitted only in explicit fixtures/stories                                                         |
| `generatedAt`, `serverTime`, `observationStartedAt` | UTC timestamps; generation is distinct from last successful check                                                                                         |
| `overallStatus`, `monitoringStatus`, `staleAfterMs` | Service state, observer health and snapshot freshness policy                                                                                              |
| `components[]`                                      | ID, current status, latest evidence time, counts/coverage/availability, raw and maintenance-adjusted history, latency buckets, evidence/profile summaries |
| `probes[]`                                          | Sanitized registered location/source/profile, cadence, last attempted/successful times, freshness and bounded reason; no keys/IPs/room IDs                |
| `activeIncidents`, `pastIncidents`                  | Stable opaque IDs, component scope, impact, localized title/updates, UTC lifecycle times and revision                                                     |
| `scheduledMaintenance`                              | Scope, localized description, state, start/end, revision and actual completion time                                                                       |
| `capabilities`                                      | Email/feed availability, supported locales/history ranges and configured mirror URL                                                                       |

Incident content uses `{ en, "zh-CN" }` fields with an explicit documented locale fallback. UI chrome belongs in next-intl split sources; dynamic incident text does not become generated translation keys. Store/render text safely, with no raw HTML. Restrict external links to validated HTTPS URLs.

### Probe ingestion minimum fields

`schemaVersion`, `probeId`, `runId`, `registryRevision`, `scheduledAt`, `startedAt`, `finishedAt`, `profileId`, `checks[]` containing check ID, result, duration, bounded reason and attempted/dependency information. Region/provider metadata come from the server registry, not arbitrary payload claims. Validate finite non-negative durations, ordered UTC times, check/profile allowlists and body size ≤32 KiB. Synthetic secrets/payloads never enter this schema.

## 7. D1 stores immutable observations and rebuildable projections

Owner B owns all schema migrations; owner E requests incident/subscription additions before the migration freeze. No destructive changes to other service databases or app Dexie.

| Table / entity                             | Keys and invariants                                                                                                            | Retention                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Probe registry / registry revisions        | Stable probe/profile IDs, cadence, enrollment/retirement, reference effective boundaries; secret key IDs separate              | Configuration audit retained                                                        |
| Probe runs and check samples               | Unique `(probeId, runId)` body digest and `(probeId, runId, checkId)`; insert once; conflicting replay rejected                | 14 d raw by default                                                                 |
| Reference minute slots                     | Unique `(referenceRevision, minute, checkId)`; pass/fail/unknown and source run; never mix reference epochs                    | 90 d                                                                                |
| Daily / latency aggregates                 | Counts, histogram buckets, eligible/excluded slots, revision; deterministic rebuild from slots                                 | 400 d daily, 7 d latency buckets                                                    |
| Public snapshots                           | Precomputed JSON per approved range, monotonically increasing revision                                                         | Current + bounded last-known snapshots                                              |
| Incidents and append-only updates          | Revision/CAS, bounded bilingual text, source/manual override and optional fingerprint                                          | 400 d public history; audit per retention policy                                    |
| Maintenance and updates                    | Component scope, minute-aligned interval, revision/CAS and lifecycle                                                           | 400 d                                                                               |
| Subscribers and confirmation/manage tokens | Unique HMAC email index; encrypted email, consent version, locale/components; token hash and expiry                            | Unconfirmed 24 h; unsubscribe purge within 30 d; suppression HMAC policy documented |
| Notification outbox / webhook receipts     | Unique `(subscriberId, eventId, channel, consentVersion)`; stable message payload/digest/provider key; unique webhook event ID | Delivery metadata 30 d, no body/recipient in logs                                   |
| Leases / audit events                      | Bounded job keys, owner and monotonic fence; append-only admin mutation records                                                | Bounded leases; admin audit 180 d                                                   |

The D1 API is the execution constraint: use parameterized prepared statements, supported batch semantics and SQL conditional updates. Do not assume a Node SQLite connection or an interactive transaction spanning a network call. Prove multi-statement atomicity/rollback with the deployed test pool. A batch must not treat a zero-row CAS as successful mutation and append an unrelated update; guard all statements on the same expected revision/operation identity.

Ingestion transactionally records the immutable run and marks affected slots dirty. A replay of exactly the same digest is a no-op success; same identity/different digest is 409. Late observations are accepted only within 10 minutes, rebuild corresponding recent slots, and cannot replace a newer live observation. A signed request timestamp is current; old check timestamps remain old.

Aggregation/reconciliation/delivery/retention use separate bounded leases. Acquire with atomic conditional SQL, increment a fence and check it in every committing write. A stale runner must not publish snapshots or mark mail sent after losing its lease. Mark dirty work clean only if the processed source revision still matches; crash/replay must preserve newly arrived work. No whole-history scan on every request or minute.

## 8. APIs separate anonymous reads, probe writes and operator authority

All paths below are relative to `/api/status/v1`. Owner A defines their DTOs; B owns routing/composition; E owns incident/subscription handlers. Return JSON error envelopes `{ code, requestId }`, without SQL/errors/secrets. Default body limit 32 KiB; public reads have bounded range/limit/cursor validation.

| Method / path                                                                      | Authority                       | Behavior                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /snapshot?range=24h\|7d\|30d\|90d`                                            | Anonymous                       | Precomputed sanitized snapshot; ETag/revision; cache ≤30 s                                                       |
| `GET /incidents?cursor=&limit=`                                                    | Anonymous                       | Stable cursor pagination, limit ≤50; recent order with ID tie-breaker                                            |
| `GET /incidents/:id`                                                               | Anonymous                       | Safe localized detail and ordered append-only updates; 404 for absent ID                                         |
| `GET /feed.atom`, `GET /feed.rss`                                                  | Anonymous                       | Stable entry/update IDs, escaped content, bounded history, links to public incident/maintenance                  |
| `GET /healthz`                                                                     | Anonymous                       | Status backend liveness/version/build identity and limited readiness; not signaling service health               |
| `POST /observations`                                                               | Per-probe HMAC                  | Scoped immutable ingestion; ≤10 min late acceptance, exact replay no-op, conflict 409                            |
| `POST /subscriptions`                                                              | Anonymous + anti-abuse          | Generic 202; create/reuse pending consent and queue confirmation; no email existence disclosure                  |
| `POST /subscriptions/confirm`                                                      | One-use confirmation token      | Confirm selected locale/components and queue confirmed notification if specified; idempotent retry of same token |
| `POST /subscriptions/manage`                                                       | Scoped manage token             | Read/change own preferences via operation and consent revision; no arbitrary subscriber lookup                   |
| `POST /subscriptions/unsubscribe`                                                  | Scoped token                    | Idempotent suppression/revoke; cancel pending event deliveries                                                   |
| `POST /webhooks/resend`                                                            | Verified provider signature     | Raw-body signature/timestamp validation, receipt dedup, delivery/bounce/complaint handling                       |
| `/admin/incidents`, `/admin/maintenance`, `/admin/probes`, `/admin/delivery/retry` | Access identity + operator role | Create/update/list; revision checks, idempotent operation ID, bounded audit; no unauthenticated fallback         |

Probe HMAC canonical input: version, HTTP method, exact path, current timestamp, run ID and SHA-256 of raw body bytes, with newline delimiters and a fixed encoding. Reject path/query ambiguities. Key ID chooses a registered probe secret; compare signatures safely, timestamp window ±120 s. Key rotations allow two explicit versions during a bounded window. A probe cannot change enrollment/reference rules or ingest for another ID.

Validate Cloudflare Access JWT issuer, configured audience, signature and expiry inside the Worker, using fixed configured JWKS issuer and an explicit operator identity allowlist. Do not trust a client-provided issuer/JWKS URL or the presence of an Access header. Protect administrative paths at the edge and at the handler; alternate workers.dev/staging routes must not bypass authorization. Operator CLI obtains credentials through the chosen Access identity flow; service tokens require explicit scoped verification, not treating client-secret headers as an already validated identity.

Writes accept an operation ID and expected revision. Stale incident/maintenance edits return 409 and the safe current revision. OPTIONS only covers approved origins/methods; public GET can be cross-origin and credentials-free, while administrative mutations have no wildcard credentialed CORS. Validate Origin on browser subscription writes; absence of browser Origin is not an authentication mechanism. Static content uses CSP, safe referrer policy and no unnecessary third-party tracking.

Use ephemeral salted IP buckets, per-email-HMAC cooldown and a global confirmation-send budget to prevent mail abuse. Default start limit: 5 subscription attempts/IP/10 min, one confirmation/email/10 min, 100 confirmations/hour total; all operator-configurable, with verified enforcement in the chosen edge/store. No raw IP retention. Turnstile is an escalation option if abuse defeats these limits, not a fictitious claim of existing protection.

## 9. Incidents and maintenance have controlled lifecycles

### Incident lifecycle

```text
investigating → identified → monitoring → resolved
      │              │          │
      └──── updated evidence / renewed failure ──→ investigating
resolved → new incident (linked predecessor), never silently reopen old history
```

Public updates are append-only, with source `manual | automated`, scope, evidence timestamps, impact, title/message and monotonic revision. Corrections append a correction record; admin audit preserves the original. Notifications use update event IDs, so repeated reconciliation cannot resend the same update.

Automated incidents open only after three consecutive expected reference failures for the same component/profile fingerprint. Unknown/runner-error does not open a target outage; instead alert the operator through the fixed monitoring channel. Corroboration is reflected in severity/detail, not an invented cause. Dependency-skipped checks do not each open incidents. Default low-traffic latency policy shows degradation after three observed windows with p95 >1,500 ms and ≥20 samples/window; no automatic latency incident until the operator enables a measured baseline. This threshold is a proposed guardrail, not a measured Cognia SLO.

After two passing reference slots, enter monitoring. Resolve after a further three stable minutes and compatible fresh corroboration; if corroboration is unavailable, allow an explicitly labelled uncorroborated recovery. A manual owner can pin or resolve an incident with an audited reason; automatic reconciliation must not overwrite manual ownership. A fresh failure after monitoring returns to investigating and emits one new update. Reconcile delayed history without firing historical notification storms.

### Maintenance lifecycle

`scheduled → in_progress → completed`, or `scheduled → cancelled`; explicit authorized extension, cancellation or completion creates an update. If time expires without operator completion, show `awaiting_confirmation` and stop excluding future slots; do not claim success solely because the clock passed. Record actual end separately from planned end.

Windows specify affected components, bilingual description, UTC times and whether availability exclusion applies. Continue probes. Suppress expected scoped outage emails during the window but retain evidence; send one start/end/change notice to matching subscribers. Overlapping windows produce a union of excluded slots, not double exclusion. Unrelated failures and an outage continuing beyond the end use normal incident rules. Validate scheduling/past edits and audit every change to historical exclusions.

The administrative deliverable is a documented CLI with `incident create/update/resolve/list`, `maintenance schedule/extend/complete/cancel/list`, `probe list/disable/set-reference`, and `delivery inspect/retry`. Preview the operation, use an explicit revision, and print safe IDs/results. A broad private web console is not required for the public product.

## 10. Email subscriptions are consented, revocable and observable

Reuse the current subscription dialog but implement its full lifecycle. Avoid importing local app account/notification runtime into the public Worker. Review existing `lib/notifications/` delivery/policy conventions and portable helpers before adding service-specific delivery code; native SMTP service code is not automatically Worker-compatible.

```text
email + preferences → pending → confirmation queued/sent
                                  │ token POST
                                  ▼
                               confirmed → preference revision
                                  │               │
                                  └─ unsubscribe ─┴─→ suppressed / pending deliveries cancelled
provider bounce/complaint ──────────────────────────→ suppressed
```

- Support locale `en | zh-CN` and chosen service components. Email covers new incidents, substantive incident updates/resolution, maintenance scheduling/change/start/end. Do not email every probe failure or every poll.
- Normalize whitespace/domain casing and IDNA consistently; do not silently rewrite provider-specific local parts or strip plus tags. Use a keyed HMAC lookup index and encrypted email at rest. Keys remain server secrets; document key-ID rotation and re-encryption. Avoid email-address logs, public lists or analytics.
- Confirmation tokens expire after 24 h; store only a secure hash. Pending entries expire with them. Tokens are purpose-scoped; preference/manage/unsubscribe tokens cannot confirm another address or change a recipient. Preference revisions invalidate old write authority as documented; emails carry fresh management links.
- Put tokens in the URL fragment, clear it promptly and POST token bodies. GET navigation must not confirm or unsubscribe, so mail scanner previews do not change consent. Token landing flows stay within lightweight `/status` routes and explain expired/used/malformed links safely.
- Repeated signup returns the same generic response, with bounded confirmation resend. Verified confirmation retry succeeds idempotently. Requesting a new email creates a new double-opt-in; it cannot silently replace a confirmed recipient.
- `POST /subscriptions/unsubscribe` suppresses immediately, increments consent version and cancels unsent outbox rows. Recheck active consent before delivery. A provider-accepted message cannot be recalled if unsubscribe races with the final HTTP call; document that precise cutoff and test it.
- Delivery states: `pending → leased → provider_accepted → delivered`, with retryable/terminal failure, suppressed and uncertain states. Provider acceptance is not delivery. Persist immutable payloads and stable idempotency keys; do not rebuild changing incident text under the same key.
- Default bounded retry: 1 min, 5 min, 30 min, 2 h with jitter, then capped repeats within 24 h; honor 429 Retry-After. Lease release/crash recovery cannot create a second outbox event. A timeout after possible provider acceptance is uncertain: retry only within provider idempotency validity or reconcile with provider event evidence.
- Resend currently retains idempotency keys for 24 h. Beyond that window, do not blindly replay an uncertain send or claim exactly-once delivery. An operator retry must create an audited deliberate attempt only after checking acceptance/delivery evidence.
- Verify signed webhooks against raw bytes and timestamp using a documented supported verifier; deduplicate event IDs and tolerate out-of-order delivered/bounced events. Bounce/complaint suppress future sends; retain only necessary suppression metadata under the published policy.
- Include bilingual plain text and escaped HTML, service scope, UTC/user-local date formatting, public detail link and unsubscribe/manage links. Configure sender/domain authentication; test actual receipt and unsubscribe in an operator-controlled mailbox.

If mail credentials/domain verification are unavailable, release the monitoring milestone with the subscription action explicitly unavailable and RSS functional. That milestone is not completion of this full plan; email remains an owned blocked deployment item until its real acceptance passes.

## 11. The frontend displays live evidence without starting the application runtime

Owner D extends the current component and may extract smaller presentation pieces only when the existing file becomes impractical. Reuse installed shadcn and chart components; no second design system.

### Page behavior

- Keep the exported `/status/` page as the static entry. Select incident detail with a validated query ID and process subscription actions with purpose-scoped fragment tokens on that page. Do not introduce unbounded dynamic App Router paths that would require generating every future incident/token at build time. Worker API incident IDs remain dynamic API paths.
- First load: skeleton then validated live snapshot; no implicit preview fallback. Explicit fixtures remain available only to stories/tests/development.
- Poll every 60 s while visible. Abort on unmount/config/range change; pause hidden polling and refresh/recompute age on visibility restore. Deduplicate requests with the repository's existing query/fetch seam if suitable. A superseded request must not overwrite a newer range/revision.
- GET timeout 8 s; bounded jitter retry/backoff up to 5 min after failures. Retain the last validated snapshot with an error banner, original timestamps and client-computed staleness. With no snapshot, display unknown and retry action.
- Render missing/future/invalid fields safely: unsupported schema becomes unavailable; absent history is not 100%; no synthetic regional cards. Day details show counts, coverage and maintenance exclusions.
- History/filter changes, probe metadata and incident detail work at narrow mobile widths. Use keyboard-accessible selectors, status labels beyond color, chart text summaries, reduced-motion support, focus-safe dialogs and announced submission errors.
- Subscription UI handles submitting/pending-confirmation/confirmed/preferences/expired/unsubscribed/error states. Success text follows server success and distinguishes queued confirmation from confirmed subscription. Do not use a local state toggle as evidence.
- All chrome, aria, placeholders/toasts/errors and new Settings text use next-intl keys in both `i18n/messages/en/publicStatus.json` and `i18n/messages/zh-CN/publicStatus.json`, plus both `settings/connectivity.json` sources where needed. Dynamic incident content follows its own bilingual API model.

### Cognia entry and self-hosted targets

Add the public status link beside `RelayCheckBlock` in Cloud & relay, using existing `openExternal` from `lib/tauri/opener.ts`. Keep manual checks, their timestamp/backend/protocol details and host-readiness semantics. A failed status lookup never prevents configuring/reconnecting a relay.

Show the official status link as official-hosted-service information. If the user configured another relay, do not attach official green status to that relay: label the distinction, and show a self-host status URL only if explicitly configured/validated. Optional inline public summary uses the same status client and unknown/stale rules, not a second polling implementation. Default delivery is a link, so Settings does not create continuous background polling.

Keep URL validation/config in one shared seam with `lib/constants/external-urls.ts`; HTTPS production endpoints only, with explicit localhost development exceptions. No local auth secrets, admin tokens or probe keys in `NEXT_PUBLIC_*`.

## 12. Build, rollout and rollback are separate from feature coding

Owner F coordinates build/config/workflow changes and production evidence. Follow the existing standalone TypeScript Worker package pattern in `services/update-server/worker/` and `services/share-server/worker/`; inspect lock/workspace ownership first. Do not casually add another root workspace or copy incompatible dependency versions.

### Artifact and resource contract

1. Add `services/status-server/worker/` with package scripts for local dev, tests, typecheck, dry-run build, local/remote migration and deploy. New files are justified by the absence of a live backend; reuse Worker testing/migration conventions.
2. Put the external runner under `services/status-server/probe/`, and operator CLI under `services/status-server/admin/`. Shared protocol helpers remain in the owning signaling test seam, not a second protocol implementation.
3. Build root `/status` export through the existing production build. Extract its HTML, required `_next/static` chunks/CSS/fonts and referenced assets into a status-only distribution. Determine actual `status.html`/`status/index.html` output rather than guessing. Validate direct reload with incident query IDs and token fragments, preserving existing public-route variants without requiring a server-side Next.js router.
4. Configure status Worker static asset binding and API precedence; external server maps the same static route paths. Prove exported HTML hydration, fonts/chunks, locale switch, CSP and API URLs work on both origins. Do not bundle account initialization or accidentally expose the complete app export as a status-only service.
5. Separate staging/prod D1, Worker names, public hostnames, Access audience/issuer, probe keys, encryption/HMAC/mail/webhook keys and limits. Record non-secret config and build SHA; secret values belong in provider secret stores, never source/logs.
6. Add scoped CI and a manual gated deployment workflow, or a reviewed status target in existing `.github/workflows/deploy.yml`. One owner edits deployment routing/config. Preserve current deployment gates and do not redeploy signaling as a side effect.
7. Apply additive D1 migrations before enabling the new API; seed only registered probes/config, not fake health. Run shadow probes against staging; then production with notifications disabled until rehearsals pass.
8. Enable public live page, then incident automation, then confirmed mail delivery. Mail setup and external mirror are mandatory completion gates for the requested full delivery.

### Rollback

- Disable notification/automation flags first if they misbehave; continue observation ingestion and public reads where safe.
- Roll back Worker/assets together to a version supporting the stored schema; additive migrations stay in place. Never restore the preview page as a healthy production fallback.
- Disable a broken probe by registry revision; retain history and show coverage/unknown until a replacement is enrolled. Reference changes do not rewrite earlier series.
- A status-service failure leaves signaling traffic unchanged. The external mirror serves last known sanitized data with its original time and a prominent stale/unavailable label; it never upgrades an old green snapshot to current health.
- Export D1 backups using the current supported tool before irreversible schema work. Restore rehearsal uses staging; record recovery point and replay limitation. Forward-only destructive changes require a separate migration review.

### External mirror behavior

Every five minutes, the external runner fetches a validated public snapshot and atomically replaces the mirror file after schema/size/sanitization checks. Publish no subscriptions, operator data or probe credentials. On failure, retain the previous file and recompute staleness in the UI; before the first copy show unknown. Limit the mirror's API capability flags to read-only/no signup. Update assets through versioned atomic releases so old HTML does not reference deleted chunks.

Set an explicit read-only mirror runtime mode. It disables signup/admin/ingest actions even if a fetched primary snapshot advertises email support. The mirror can offer a labelled link back to the primary subscription page when reachable, but must not accidentally POST consent changes through its own origin or silently switch trust/configuration.

Failure of the external host loses one witness and the mirror; it cannot be marketed as complete disaster recovery. Its last heartbeat exposes that failure. Adding a second external provider is a later reliability expansion, not a fabricated first-release region.

## 13. Operational budgets and acceptance must be measured

### Initial load estimate, not a production bill

One external reference run/minute with three checks produces 4,320 samples/day. Three Origin profiles each run every five minutes add 2,592. Cloudflare HTTP/minute plus two protocol checks/five minutes add 2,016. Total: approximately 8,928 check samples/day before retries/extra monitors; 267,840/month at 30 days. Distinguish samples from invocations, SQL rows written (including indexes/projections/retention), target WS messages and email messages.

At 14 days, raw samples alone are about 125,000 rows. Three reference checks over 90 days are about 388,800 minute slots. Estimate byte size by loading representative rows and indexes, then measure `D1` storage and read/write metadata. Do not assume row count equals the Free allowance or that account-wide 5 GB means a single Free database supports 5 GB: the current single Free D1 database limit is 500 MB. Set warning at 60% and intervention at 80% of the actual configured allowance.

Precompute snapshots rather than querying 90-day history for every visitor. A sample traffic budget of 1,000 visits/day × 10 polls/visit is 10,000 dynamic reads/day before feeds/probes/abuse. Continuous concurrent viewers multiply this sharply. Measure cache hit rates, per-POP misses, rows read/written, scheduled CPU, WS/DO costs and provider email usage; publish an operator budget sheet from a fixed 24-hour staging workload. No guaranteed Free-plan cost claim.

Initial performance guardrails are proposed, not measured: snapshot JSON ≤256 KiB, one snapshot read rather than a history scan per cache miss, status API p95 ≤500 ms in a named fixed staging region at 50 concurrent viewers, and fault-to-visible major-outage ≤6 minutes under uninterrupted reference scheduling. The latter includes three one-minute attempts, up to 20 s run time, aggregation, cache and frontend polling; it is not an instant detection promise. Process at most 100 delivery rows per invocation, cap page/read batches, and yield remaining durable work. F records the actual workload, CPU/memory and measured results; revise an unrealistic guardrail explicitly before acceptance.

Workers Paid may help P256/Cron CPU and quota headroom. It does not provide the external host, mail service, phone connectivity or TURN. Keep all processing bounded; benchmark CPU under the selected plan. Do not change production relay quotas just to accommodate monitoring.

### Metrics and operator actions

| Metric / event                          | Proposed threshold                       | Action                                                                            |
| --------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| Required external heartbeat age         | >180 s                                   | Observer warning; inspect process/network/ingestion, do not declare target outage |
| Status snapshot age                     | >180 s                                   | Public stale/unknown; operator checks Cron/lease/D1                               |
| Consecutive target failures             | 3 expected slots                         | Incident reconciliation; preserve witness/profile context                         |
| Delivery backlog age                    | >10 min                                  | Check provider/lease/budget; no blind uncertain resend                            |
| API error rate                          | >1% over 5 min with ≥100 requests        | Alert; for low traffic use repeated external check failures instead               |
| Raw row/storage growth                  | >configured 60%/80%                      | Warn/intervene, confirm retention, capacity plan; retain aggregate semantics      |
| Probe run deadline/overlap              | Repeated 3 times                         | Runner diagnosis; bound retry/concurrency                                         |
| Signature rejects / conflicting replays | Sustained rate above configured baseline | Check rotation/timestamps/abuse; scoped key revoke                                |

Log `requestId`, non-secret probe/check/profile ID, build SHA, aggregate revision, bounded reason, job fence and elapsed/row counts. Never log raw bodies, room/device IDs, IPs, email addresses, tokens or SMTP/provider credentials. Alerts go only to an operator-configured fixed destination; public users cannot supply arbitrary webhook URLs. A status service cannot be its own sole alert path: the external runner sends its own platform/status failure alert through that configured channel.

### Mandatory verification matrix

| Case                                                                    | Required evidence / owner                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Health 200 but wrong schema/protocol                                    | Parser rejects; HTTP not operational — A/C                                                          |
| WS opens but authentication fails                                       | Auth failure observed, data dependency unknown — C/B                                                |
| Signal succeeds, explicit data lane fails/corrupts                      | Data component fails independently — C/B                                                            |
| Probe runtime error / stopped process / expired credentials             | Observer unhealthy, service unknown or limited confidence; no false major outage — B/C              |
| Fresh conflicting external/Cloudflare or Origin results                 | Partial/profile degradation with truthful source labels — A/B/D                                     |
| Empty history, partial day, leap/date boundary, missing slots           | Null availability, exact counts/coverage, UTC aggregation — A/B                                     |
| Uneven daily counts and late observations                               | Weighted totals, bounded rebuild, no doubled slot/notification — B                                  |
| Maintenance overlap, extension, cancellation, past edit, unfinished end | Scoped union/exclusions, audited revisions, actual completion distinct — B/E/D                      |
| Duplicate/tampered/wrong-key/out-of-window ingestion                    | Exact no-op vs 409/401; no cross-probe or registry privilege — B/C                                  |
| Two Crons / lease expiry / crash between writes                         | No lost dirty slots or stale snapshot/event commits — B/E                                           |
| Access missing/forged/wrong audience/expired; alternate host access     | Administrative writes denied; allowed identity audited — E/F                                        |
| Incident competing edits/manual pin/recovery/re-failure                 | Revision conflict; deterministic lifecycle; event dedup — E                                         |
| Subscription double-opt-in and link scanner GET                         | No GET consent mutation; one-use/idempotent confirmation; no enumeration — E/D                      |
| Confirmation/send abuse and unavailable mail configuration              | Enforced budgets; explicit unavailable UI; no false success — E/D                                   |
| Email timeout/crash/429/webhook duplicate/out of order                  | Provider-limited idempotency, uncertain handling, delivered ≠ accepted — E                          |
| Unsubscribe/bounce races with outbox and provider call                  | Pending cancelled, consent gates respected, accepted-send cutoff documented — E                     |
| Encryption/HMAC/token rotation                                          | Old allowed version expires, lookup remains consistent, no secret logs — E/F                        |
| Hidden tab/unmount/range race/bad JSON/offline/stale cache/clock skew   | Abort, no stale overwrite, age recompute, honest fallback — D                                       |
| Public route with no account/direct nested reload                       | Web/Tauri/Capacitor lightweight route; no application/background startup — D/F                      |
| Configured self-host relay                                              | Official status not represented as its status; local check unaffected — D                           |
| Static build and mirror with primary API blocked                        | Assets/hydration work; old evidence stale; writes disabled — F/D                                    |
| Fixed-volume probe soak                                                 | Socket/alarm/quota state bounded; no synthetic auth bypass or user state — C/F                      |
| Real email and public external protocol test                            | Operator mailbox received and unsubscribed; independent host passed signed auth + data — E/F        |
| Real desktop/browser/iOS/Android and cellular trial                     | Record actual device, network, build, timestamp and result; cloud/header simulation is separate — F |

The final cellular trial tests opening the status link and, separately, an actual Cognia pairing/remote operation. A failure in user host/transport is an acceptance finding with its own owner; do not alter public uptime to conceal it or claim that the status feature repaired remote access.

Verification commands must use current scripts and `rtk`. Root affected tests use Jest; standalone Worker uses its configured Workers/Vitest pool; probe/CLI use their package scripts. Add co-located tests for every edited/new governed source. Run focused tests, relevant typecheck/lint, static export, asset smoke and `i18n:build`, `i18n:build:check`, `lint:i18n`. No coverage command unless requested. Read installed Next.js guides before modifying routes/export. UI verification uses the available agent-browser flow and real shell tests where needed.

The following root commands exist now. Run after implementation, adding new affected tests to the focused selection. Run commands individually; save exit code and scoped output. Check available disk/memory before the heavy build/typecheck and distinguish unrelated shared-tree failures from feature failures.

```bash
rtk pnpm test --runInBand lib/status/public-status.test.ts components/status/public-status-page.test.tsx app/status/page.test.tsx
rtk pnpm i18n:build
rtk pnpm i18n:build:check
rtk pnpm lint:i18n
rtk pnpm lint:static-export
rtk pnpm typecheck
rtk pnpm build
```

Owner F adds a focused public status E2E suite under `tests/e2e/status/` plus mobile-shell coverage under the existing mobile test tree, then runs the matching current `test:e2e`/static/mobile scripts. Use the E2E-specific build when the static harness requires its bridge, and separately smoke the production status-only export without that bridge. The configured Tauri Playwright project is Windows-only; on this macOS workspace use the available actual Tauri debug/smoke flow or record the native gap and obtain Windows CI/device evidence. Mobile browser emulation is not an iOS/Android native acceptance result.

Proposed new package scripts, to be implemented by their owners and then executed:

```bash
rtk pnpm -C services/status-server/worker test
rtk pnpm -C services/status-server/worker typecheck
rtk pnpm -C services/status-server/worker build
rtk pnpm -C services/status-server/probe test
rtk pnpm -C services/status-server/admin test
```

Run path-scoped ESLint/Prettier and diff checks for the owned changes; CI also runs required repository gates. Do not deploy or run remote migrations just to satisfy a local test. No new Tauri command/ACL, app account migration, model call or embedding path is expected; if implementation adds one, update this plan and the corresponding registration/permission/PII-gate verification before proceeding.

Record four distinct evidence levels: source/unit; local integrated service; exact build/SHA deployment; real public host/device/mailbox. Test fixtures/mocks cannot be labelled production acceptance. All commands above are implementation requirements, not tests executed for this proposal.

## 14. Six owners can implement in parallel after contracts freeze

The integrating agent coordinates boundaries and owns final evidence. Each worker is not alone in the codebase: preserve concurrent changes, use scoped diffs/worktrees, never reset/stage others' work, and route cross-owned edits to the owner. No shared-file edits by multiple workers.

| Owner                          | Exclusive ownership / responsibility                                                                                                                                          | Depends on                                     | Independent completion proof                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A — Contracts                  | `lib/status/**`, pure shared health extraction agreed with C, status config/URL additions in `lib/constants/external-urls.ts`, co-located tests; no UI edits                  | Current research                               | v1 schemas/fixtures validate; unknown/availability/freshness rules pass; Node + Worker + frontend import/bundle checks         |
| B — Status backend             | `services/status-server/worker/src` routing, ingestion, storage, registry, aggregates, leases, public reads; all D1 migrations; Worker package/config excluding E's modules   | A freeze; E schema requests                    | Ingestion/security/aggregation/replay/concurrency/retention tests; deployed Cron smoke                                         |
| C — Probes                     | `services/status-server/probe/**`; shared synthetic helper extraction and tests under signaling `worker/tests/`; portable runtime adapters owned here                         | A; B ingestion                                 | Positive/negative local tests, explicit data round trip, supported Origin profiles, cleanup/load soak; external deployment log |
| D — Product UI                 | `app/status/**`, `components/status/**`, necessary `hooks/status/**`; connectivity page/block changes and tests; lightweight-route changes if needed; both split locale files | A; B public endpoint; E subscription contracts | Live/error/stale/empty/history/incident/token flows; account-less/static/mobile UI; connection entry/local-check regression    |
| E — Incidents and delivery     | Worker `src/incidents/**`, `src/maintenance/**`, `src/subscriptions/**`, `src/notifications/**`, `src/admin/**`; `services/status-server/admin/**`; module tests              | A; B storage/lease seam                        | Lifecycle/CAS/consent/token/mail/outbox/auth tests; actual controlled mailbox receipt/unsubscribe                              |
| F — Integration and operations | Scoped build/export scripts, CI/deploy workflows, external runner/mirror deployment manifests, public E2E tests, runbooks/docs/ADR/changeset coordination                     | A first; final B–E                             | Exact artifact build, independent mirror/fault rehearsals, capacity report, real-shell/public acceptance evidence              |

B owns Worker entrypoint/package dependencies and composes E modules from agreed exported handler/job interfaces. E never edits B migrations or router directly; migration/route requests are resolved before freeze or through B. A owns all DTO changes. C requests pure parser changes through A. D owns split translations; F runs their generator once after coordination and owns generated artifacts for integration. F alone owns CI/deploy/global build config changes. Owners may create new necessary modules within their exclusive trees, with reuse justification and tests.

### Phase graph and gates

```text
P0 baseline + resources + contract/schema freeze (A, B, E, F)
     ├─ P1 storage/API/aggregation (B)
     ├─ P2 protocol runners (C)
     ├─ P3 live public UI + Cognia link (D)
     └─ P4 incidents/maintenance/consent/delivery (E)
          ↓ integrated staging (F with all owners)
P5 shadow/soak + security + budget + email rehearsals
          ↓ production deployment and external mirror
P6 public-host/device evidence + operating handoff
```

| Phase | Deliverable / verification gate                                                                                                                     | Rollback or stop condition                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| P0    | Baseline owned-file diffs; resource inventory; A contracts and fixtures; B migrations after E requests; F build/route strategy proven               | Rediscovered conflicting implementation or broken shared import/asset boundary: resolve before splitting workers      |
| P1–P4 | Independent tested packages against frozen fixtures; modules wired, no dormant jobs/buttons or preview fallback                                     | Contract ambiguity addressed by A; backend schema changes by B; missing credentials do not block local implementation |
| P5    | Staging end-to-end, 24-hour fixed workload/soak, outage/unknown/maintenance/lease/mail/mirror rehearsals; safe production flags                     | Wrong green/duplicate notification/auth bypass/unbounded growth: stop activation and fix                              |
| P6    | Additive production migration; exact SHA assets/backend/probe; real independent checks and mailbox; supported-shell link; disclosed cellular result | Rollback flags/version as section 12; no declaration of full completion without external/mail/mirror gates            |

Planning estimate: approximately 12–20 engineering person-days across six owners, plus the 24-hour soak and resource setup. This is an estimate from the boundary count, not a promised date. The integrating owner sets actual ISO milestone dates from resource availability and records them before kickoff.

### Completion report required from every owner

Return owned changed paths, behavior delivered, commands/results, exact evidence level, dependency/remaining resource gaps, and risks. Point to test/contract fixtures and include source-to-runtime wiring proof. Do not claim done after creating an unused module, a passing preview UI or a mail mock. The integrator reports which gates remain, preserves the research/proposal, and updates only relevant documentation/ADR/changeset according to current repository policy.

## 15. Resolve resource questions without reopening the architecture

These defaults allow local implementation immediately. Operator resource choices are required before their dependent production gates; an unanswered question is not permission to invent credentials, domains or acceptance evidence.

| Decision                                              | Options                                                                                                          | Recommendation / owner                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Q1 — Domain and independent host                      | Existing `cognia.cn` status subdomain plus real external host/hostname; or explicit self-host domain replacement | `status.cognia.cn` and one non-Cloudflare continuous runner/mirror; F records provider/location/independent DNS/HTTPS before P5 |
| Q2 — Mail and operator authority                      | Verified Resend sender + Access identity; reuse a demonstrated portable existing provider                        | Resend + validated Access JWT/explicit operator allowlist; E/F configure resources before email production gate                 |
| Q3 — Reliability/cost tier                            | One external witness + Cloudflare corroboration; add second independent external region                          | Start with one external witness and honest confidence; measure before purchasing extra capacity; F records allowance/budget     |
| Q4 — Which physical clients/networks can be certified | Available desktop/browser/iOS/Android and cellular devices; cloud profiles only                                  | Run available physical devices; mark unavailable network claims unverified, never fabricate region/carrier success; F           |

### Review record

| Date              | Reviewer                         | Result                                                                                                                                                                          |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-02        | Proposal author                  | Reviewed against current `/status`, connectivity, signaling Worker/protocol tests, standalone Worker patterns, static export, ADRs and primary provider docs                    |
| 2026-10-02        | Proposal author                  | Contracts, unknown/history semantics, privacy/auth, retry/recovery, migration/rollback, ownership and acceptance paths specified; ASCII diagrams inspected for direction/labels |
| Not yet scheduled | Integrating implementation owner | Record contract/schema/resource review and deviations at P0; no implementation acceptance inferred from proposal review                                                         |

### P0 integration record (2026-10-02)

The integrating agent froze contract v1 in `lib/status/{contract,derive,validate,signing,config,fixtures}.ts` and the core schema in `services/status-server/worker/migrations/0001_core.sql`, then ran owners C (probes), D (UI) and E (incidents/delivery/admin) in parallel against `services/status-server/worker/src/seams.ts`. Deviations from the sections above, each decided before implementation:

| Deviation                                                                                                                                                                                                                                                                       | Reason                                                                                                                               | Consequence                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mail uses Cloudflare Email Sending (`send_email` binding), not Resend (§3, §10)                                                                                                                                                                                                 | User decision. Keeps mail inside the existing Cloudflare account with no third-party key                                             | Workers Paid + sender-domain onboarding required. No provider idempotency key and no bounce webhook: `E_RECIPIENT_SUPPRESSED` suppresses; timeouts/5xx are `uncertain` and never auto-retried; there is no `/webhooks/resend` route |
| No external host yet; the Cloudflare Cron observer `cf-cron` is the registry's first reference (§3, §4)                                                                                                                                                                         | User decision: ship the external runner and mirror as code + deployment manifests now                                                | Production is honestly single-witness (`monitoringStatus: limited`). `probe enroll` + `probe set-reference` move the reference at a future minute without rewriting history                                                         |
| Cron runs every check at 60 s on the native profile and the three Origin profiles at 300 s (§4 table: Cloudflare protocol 300 s)                                                                                                                                                | The reference must produce all three results every minute                                                                            | Revisit cadence after an external reference is enrolled                                                                                                                                                                             |
| Compact D1 layout: run checks inline (`probe_runs.checks_json`), one `reference_slots` row per minute with three result columns, JSON rollups (§7)                                                                                                                              | D1 Free allows 100k rows written/day; the normalized layout would spend ~3× the writes                                               | Uniqueness is unchanged in meaning: one run per `(probeId, runId)`, one result per minute per component; first observation of a minute wins                                                                                         |
| Latency buckets are always the last 24 hourly buckets; the summary spans `min(range, 7 d)` (§5)                                                                                                                                                                                 | Latency histograms are retained 7–8 days by plan                                                                                     | Longer ranges show availability history but a 7-day latency summary                                                                                                                                                                 |
| An overall minute is excluded when any component's maintenance window covers it (§5)                                                                                                                                                                                            | The joined series cannot claim an outage-free minute the operator declared                                                           | Per-component exclusions remain exact                                                                                                                                                                                               |
| Probe enrollment is an operator command (`/admin/probes/enroll`, contract `ProbeEnrollRequest`) in addition to §9's list                                                                                                                                                        | External probes need a registered key ID without hand-written SQL                                                                    | Secrets still go only to the `PROBE_SECRETS` Worker secret                                                                                                                                                                          |
| Probe reason mapping (owner C): a refused frame surfaces as `relay_timeout`; a mobile snapshot without the desktop proof is `relay_mismatch`; a WebSocket open timeout is `timeout`; a relay without the data lane is `schema_mismatch`, a wrong generation `protocol_mismatch` | The relay sends its refusal to the sender, so the receiver only observes absence; the rest follow `classifyHealthz`                  | Reason codes stay inside the frozen v1 list                                                                                                                                                                                         |
| Node runner retries 408/429 honouring `Retry-After` (other 4xx are dropped with an alert); the external probe bundles `ws`                                                                                                                                                      | Node's built-in WebSocket cannot report the HTTP status of a refused upgrade, so 403 and DNS/TLS failures would be indistinguishable | Single bundled file `dist/cognia-status-probe.mjs`                                                                                                                                                                                  |
| D1 created with `--location apac`                                                                                                                                                                                                                                               | Most readers and the relay's users are in Asia                                                                                       | Production `database_id` is committed like the update Worker's                                                                                                                                                                      |

### Owned follow-up and dates

| Item                                                                 | Single accountable owner | ISO DDL / gate                                                        |
| -------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| Set actual milestone dates and engineering assignees                 | Integrating agent        | Unscheduled; enter ISO dates at P0 before implementation kickoff      |
| Confirm production/staging resource and independent mirror inventory | F                        | Unscheduled; ISO DDL set at P0, required before P5                    |
| Freeze v1 contracts, fixtures and health parser ownership            | A                        | Unscheduled; ISO DDL set at P0, required before parallel P1–P4        |
| Freeze schema and module/router boundaries after delivery requests   | B                        | Unscheduled; ISO DDL set at P0, required before P1                    |
| Configure sender/Access identities and retention/consent policy      | E                        | Unscheduled; ISO DDL set at P0, required before real email activation |
| Collect exact-SHA production, mail, mirror and device evidence       | F                        | Unscheduled; ISO DDL set at P0, required for P6 completion            |

No deadlines or deployment identities were supplied by the user, so this document does not fabricate them. These are scheduling/resource gates with named owners, not unfinished behavior hidden behind TODO code.

## 16. Sources and evidence

Repository evidence is current-worktree evidence and may differ from the deployed build. Research links include point-in-time public checks; implementation must record its own exact-SHA results.

- UI/model: `app/status/page.tsx`, `components/status/public-status-page.tsx`, `lib/status/public-status.ts` and their co-located tests; `i18n/messages/{en,zh-CN}/publicStatus.json`.
- Public runtime: `components/runtime/lightweight-route-shell.tsx`, `components/feature-shell/background-target-coverage.test.ts`, root `next.config.ts`.
- Connectivity: `components/settings/connectivity/panels/cloud-relay-panel.tsx`, `components/settings/connectivity/blocks/relay-check-block.tsx`, `hooks/connectivity/use-remote-access.ts`, `lib/signaling/relay-probe.ts`, `lib/constants/external-urls.ts`, `lib/tauri/opener.ts`.
- Protocol/backend: `services/signaling-server/worker/src/{lib,room}.rs`, `services/signaling-server/worker/tests/integration.mjs`, `services/signaling-server/worker/wrangler.toml`, `services/signaling-server/core/src/{proto,limits}.rs`, `services/signaling-server/src/server.rs`.
- Service/build patterns: `services/update-server/worker/package.json`, `services/share-server/worker/`, `.github/workflows/deploy.yml`, `pnpm-workspace.yaml`, `web/next.config.ts`.
- Existing notification seams to inspect before implementation: `lib/notifications/delivery/`, `lib/notifications/policy/`, `services/diagnostic-server/`.
- Architecture: [ADR-0170](../content/docs/en/adr/0170-cognia-relay-and-connectivity-center.md), [ADR-0021](../content/docs/en/adr/0021-webrtc-datachannel-wan-transport.md), [ADR-0037](../content/docs/en/adr/0037-public-share-links.md), [ADR-0092](../content/docs/en/adr/0092-official-website-workspace.md). Current code supersedes stale ADR details such as historical quota non-goals or workspace counts.
- Primary runtime docs checked on 2026-10-02: [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [outbound WebSockets](https://developers.cloudflare.com/workers/examples/websockets/#write-a-websocket-client), [public fetch compatibility](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public), [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Worker pricing](https://developers.cloudflare.com/workers/platform/pricing/), [static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).
- Authority/delivery docs: [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys), [Resend signed webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests). Provider retention/version-sensitive behavior must be rechecked when implementation begins.
- Alternatives: [Kuma 2.5.5](https://github.com/louislam/uptime-kuma/tree/2.5.5), [Upptime](https://upptime.js.org/docs/), [GitHub scheduled-workflow constraints](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## 17. Copyable brief for the implementing coordinator

> Implement `docs/plans/2026-10-02-signaling-public-status-implementation.md` completely, using the current repository rules. Re-anchor the shared worktree baseline and inspect existing implementations before editing. Reuse the existing `/status`, lightweight public route, relay-check settings and canonical signaling test helpers. Begin with P0 contracts/schema/resource inventory; assign one owner per work package A–F and enforce exclusive file ownership. Preserve concurrent changes and coordinate every shared contract/router/migration/config edit. Complete actual HTTP/authenticated-signal/explicit-data probes, count-based real history with coverage/unknown semantics, live bilingual UI and Cognia entry, incident/maintenance operator flows, RSS/Atom, consented email delivery/unsubscribe, independent external probe/mirror, secure deployment/runbooks and the verification matrix. Do not replace missing behavior with previews, mocks, sample regions or unchecked green. No coverage run unless requested. Report focused checks, wiring, exact deployment build and real host/mailbox/device evidence separately, and identify required external resource gaps without pretending they passed.
