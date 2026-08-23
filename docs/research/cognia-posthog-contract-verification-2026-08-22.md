# Cognia ↔ PostHog contract verification

Date: 2026-08-23

Scope: external-contract verification for Cognia's direct PostHog product capture and PostHog AI Observability OTLP export. This note does not audit event coverage or Tea/ByteIO. It compares the current worktree and `docs/research/posthog-integration-audit-2026-08-22.md` with current official PostHog documentation, SDK specifications, and first-party source.

## Verdict and remediation status

The endpoint, token, request-shape, product retry/deduplication, and OTLP count-limit claims are confirmed. The review identified four implementation gaps; all four were remediated on 2026-08-22:

1. Product Analytics now persists a product-only `distinct_id`; AI Observability keeps its separate installation identity. Unsafe or AI-equal Product IDs are rejected or rotated, and the final `/batch/` JSON passes a shared PII gate. Headless deployments accept `COGNIA_POSTHOG_PRODUCT_DISTINCT_ID` and otherwise derive a separate `.product` identity from the stable observability ID.
2. Renderer PostHog AI export now enforces the 4 MB serialized UTF-8 request limit and recursively splits batches; a single oversized span is dropped with transport-health diagnostics.
3. Renderer AI flushes are serialized. `close()` waits for earlier threshold/timer exports, while consent withdrawal aborts active fetches and prevents retries from an obsolete consent epoch.
4. Renderer AI retries only connection failures plus `429`, `502`, `503`, and `504`, honors `Retry-After`, and applies jittered exponential backoff otherwise.

Product delivery received an additional hardening pass on 2026-08-23: every serialized `/batch/` request is capped at 19 MiB, multi-event payloads are recursively split before sending, and a PostHog `413` response triggers the same split-and-resubmit behavior without regenerating event UUIDs. A single event that cannot fit, or that PostHog still rejects with `413`, is dropped with transport-health diagnostics instead of being retried indefinitely. Delivery limits are part of the live-exporter reuse key, so a settings reapply cannot leave an older limit dormant.

The transport also treats a PostHog host/token change as a destination-epoch change: pending work is discarded before the reused transport receives the new endpoint and credential closure, preventing an old batch from crossing projects.

Product capture now carries an `AbortSignal` through the exporter. Consent withdrawal aborts an in-flight web fetch; on Tauri, the renderer sends the request's opaque ID to a registered native cancel command, which aborts the matching reqwest task. Both paths prevent later retries and recursive child sends from the obsolete consent epoch. As with any telemetry system, a request that already reached the ingestion service cannot be recalled.

The source-IP requirement remains operational: Cognia can suppress GeoIP enrichment on product events, but only the PostHog organization/project setting can discard the request IP. No live project access was available for this review.

## Confirmed contracts

### Product `/batch/` capture

- PostHog documents `/batch` as a public POST ingestion endpoint authenticated by a public project token in `api_key`. The correct Cloud origins are `https://us.i.posthog.com` and `https://eu.i.posthog.com`, with the instance origin used for self-hosting. Cognia normalizes a configured host to its origin, rejects embedded URL credentials, sends to `{origin}/batch/`, and puts the project token in the JSON body rather than an authorization header. [PostHog capture API](https://posthog.com/docs/api/capture)
- PostHog requires `event` and a non-empty `distinct_id`; `distinct_id` is limited to 200 characters. Cognia's event names come from a typed catalog and exporter construction rejects blank or over-200-character installation IDs. PostHog may still answer `200 OK` for a missing/empty event name or ID while dropping the event, so HTTP success means request acceptance, not an ingestion query result. [PostHog capture API — invalid events](https://posthog.com/docs/api/capture#invalid-events)
- PostHog's default `/batch` request-body limit is 20 MB. Cognia enforces a 19 MiB serialized UTF-8 ceiling as a safety margin: it recursively splits multi-event batches before sending and records an individually oversized event as a transport drop. The behavior-event boundary additionally limits each event to 32 scalar attributes and each string to 512 characters. [PostHog capture API — batch events](https://posthog.com/docs/api/capture#batch-events)

Implementation evidence: `lib/telemetry/posthog-product.ts:106-138`, `lib/telemetry/posthog-product.ts:127-128`, `lib/telemetry/posthog-product.ts:246-296`, and `lib/telemetry/events/track-event.ts`.

### Endpoint and authorization separation

- Product analytics correctly uses `/batch/` with `api_key` in the body.
- AI Observability correctly uses the traces-specific `{origin}/i/v0/ai/otel` URL with `Authorization: Bearer <project-token>`. PostHog's official exporter constructs the same URL/header pair and normalizes the configured host to its origin. [PostHog OpenTelemetry setup](https://posthog.com/docs/ai-observability/installation/opentelemetry), [official `PostHogTraceExporter`](https://github.com/PostHog/posthog-js/blob/main/packages/ai/src/otel/exporter.ts#L70-L84)
- Cognia's web renderer installs the Bearer header in `createWebPostHogFetch`; its Tauri command injects the header from a typed `Posthog` credential and refuses that credential on any endpoint other than `/i/v0/ai/otel`. The sidecar uses the official exporter. Renderer-supplied sensitive headers are rejected before the Rust request is built.

Implementation evidence: `lib/logging/bootstrap.ts:931-960`, `lib/logging/bootstrap.ts:1096-1105`, `crates/cognia-observability/src/telemetry.rs:198-250`, `crates/cognia-observability/src/telemetry.rs:272-312`, and `sidecar/telemetry.mjs:88-99`.

### Product retry, deduplication, and lifecycle

- Cognia serializes a product batch once, then reuses the identical event names, timestamps, distinct IDs, and UUIDs across bounded retry attempts. That matches PostHog's deduplication key: events sharing `uuid`, `event`, `timestamp`, and `distinct_id` are eventually deduplicated. Deduplication is asynchronous, so duplicate rows can temporarily appear and downstream destinations may fire more than once. [PostHog event deduplication](https://posthog.com/docs/data/events#event-deduplication)
- The product queue is bounded, flushes are serialized in FIFO batch order, and retry is limited to network/unknown-status failures, `408`, `429`, and `5xx`. Consent withdrawal increments an epoch and prevents a failed in-flight batch from retrying after withdrawal. This matches the current first-party Node/core retry status policy. PostHog's canonical retry-queue spec requires retaining events after transient failure and bounding queue growth; its flush spec describes FIFO draining and serialization of concurrent flushes. [official core retry policy](https://github.com/PostHog/posthog-js/blob/9b2a1b18db64f9f6b331cbded543c5ead3ccf0cb/packages/core/src/posthog-core-stateless.ts#L208-L216), [retry-queue spec](https://github.com/PostHog/sdk-specs/blob/main/openspec/specs/retry-queue/spec.md), [flush spec](https://github.com/PostHog/sdk-specs/blob/main/openspec/specs/flush/spec.md)
- If PostHog rejects a multi-event product batch with `413`, Cognia bisects it recursively and resubmits the original wire events with their UUIDs unchanged. An individually rejected event is terminal and appears in transport health. This supplements the pre-send 19 MiB guard and preserves PostHog's deduplication identity across every child request.
- Normal headless shutdown stops new product work and awaits the serialized drain. Renderer `pagehide` is only best-effort, using `keepalive` on the direct web fetch; an abrupt renderer/desktop exit has no synchronous drain guarantee. That limitation is accurately described in the existing audit. PostHog's shutdown spec treats final flush and awaiting in-flight work as the normal shutdown contract where the runtime supports it. [shutdown spec](https://github.com/PostHog/sdk-specs/blob/main/openspec/specs/shutdown/spec.md)

Implementation evidence: `lib/telemetry/posthog-product.ts:274-326`, `lib/telemetry/posthog-product.ts:350-371`, `lib/telemetry/events/track-event.ts:52-78`, and `lib/headless/runtimes/behavior-telemetry.ts:199`.

### AI OTLP count limits and partial-success behavior

- Current PostHog source caps the endpoint at 4 MB, 1,000 raw spans before AI filtering, and 100 accepted AI spans after filtering; excess count is rejected with non-retryable `400`. Cognia batches 32 renderer spans and 16 sidecar spans, so both count limits are satisfied. [PostHog OTLP handler limits](https://github.com/PostHog/posthog/blob/1e8be28c056c0a3f3606328593988de4e2693aa3/rust/capture/src/otel/mod.rs#L35-L67)
- PostHog's official AI exporter filters to recognized AI spans and reports success when no AI span remains. The server likewise returns `200` when all raw spans are filtered, and can shed an individually oversized span while still returning success. Therefore a `2xx` proves protocol acceptance, not that every submitted span persisted. [official exporter filtering](https://github.com/PostHog/posthog-js/blob/main/packages/ai/src/otel/exporter.ts#L42-L54), [official exporter result behavior](https://github.com/PostHog/posthog-js/blob/main/packages/ai/src/otel/exporter.ts#L92-L109), [server filtering and success behavior](https://github.com/PostHog/posthog/blob/1e8be28c056c0a3f3606328593988de4e2693aa3/rust/capture/src/otel/mod.rs#L170-L240), [oversized-span shedding](https://github.com/PostHog/posthog/blob/1e8be28c056c0a3f3606328593988de4e2693aa3/rust/capture/src/otel/mod.rs#L286-L310)
- PostHog's handler and the upstream OTLP specification permit HTTP retry only for `429`, `502`, `503`, and `504` (plus connection/no-response failure). All other HTTP `4xx` and `5xx` responses must not be retried. Cognia's renderer transport now uses that exact classifier, honors `Retry-After`, and adds jitter to exponential backoff. [PostHog OTLP response policy](https://github.com/PostHog/posthog/blob/1e8be28c056c0a3f3606328593988de4e2693aa3/rust/capture/src/otel/mod.rs#L60-L67), [OTLP failure specification](https://opentelemetry.io/docs/specs/otlp/#failures-1)

## Pre-fix discrepancies and resolved gaps

### 1. Shared installation ID breaks the strict personless-product guarantee

PostHog's backend API captures identified events by default. `$process_person_profile: false` makes an event anonymous only while that `distinct_id` has not already been used for an identified event; the capture guide explicitly warns that a previously identified ID remains identified. [anonymous versus identified events](https://posthog.com/docs/data/anonymous-vs-identified-events), [capture API warning](https://posthog.com/docs/api/capture#anonymous-event-capture)

Before remediation, Cognia:

- sends product events with `distinct_id = installationId` and `$process_person_profile: false`;
- puts the same `installationId` in `posthog.distinct_id` on renderer and sidecar AI spans;
- sends both scopes to the same managed/BYO project when both toggles are enabled.

PostHog resolves AI identity from span/resource attributes including `posthog.distinct_id` and `user.id`. Its OTLP event builder creates normal AI events with person processing skipped only when a project restriction explicitly requests that behavior. [AI distinct-ID precedence](https://github.com/PostHog/posthog/blob/1e8be28c056c0a3f3606328593988de4e2693aa3/rust/capture/src/otel/identity.rs#L5-L50), [AI event construction/person-processing flag](https://github.com/PostHog/posthog/blob/1e8be28c056c0a3f3606328593988de4e2693aa3/rust/capture/src/otel/filtering.rs#L93-L144)

Consequently, the pre-fix shared identity could not guarantee personless Product events after an AI event identified the ID.

Implemented contract: Cognia chose strict personless Product Analytics and now uses a distinct product-only ID that is never sent through the identified AI path.

### 2. Renderer AI export is not provably below 4 MB

The sidecar is structurally bounded: batch size 16, at most 32 allowlisted attributes, string values capped at 512 characters, arrays capped at 16 values, and resource attributes allowlisted.

Before remediation, the renderer capped batches at 32 and stripped content/metadata/events, but did not check final UTF-8 byte length. PostHog rejects request bodies beyond 4 MB. [PostHog OpenTelemetry limit](https://posthog.com/docs/ai-observability/installation/opentelemetry#troubleshooting)

Resolved: `OtlpHttpTransport` now checks the final serialized body, splits multi-span batches recursively, and drops a single oversized span with health diagnostics.

Implementation evidence: `lib/logging/transports/otlp-http-transport.ts:90-112`, `lib/logging/transports/otlp-http-transport.ts:216-273`, `packages/agent-trace/src/span-to-otlp.ts`, and `sidecar/telemetry.mjs:157-198`.

### 3. Renderer AI `close()` does not await earlier in-flight exports

Before remediation, threshold and timer flushes called `void this.flush()` without retaining an in-flight promise, so a later `close()` could resolve while a previous request was still exporting or backing off.

Resolved: renderer flushes now share a serialized promise chain, and `close()` awaits that chain. Consent withdrawal aborts active requests and invalidates their retry epoch.

Implementation evidence: `lib/logging/transports/otlp-http-transport.ts:151-179`, `lib/logging/transports/otlp-http-transport.ts:207-214`, and `lib/logging/transports/otlp-http-transport.ts:216-273`.

### 4. Renderer AI retry policy is not OTLP-conformant

Before remediation, the renderer retried `408`, `429`, and every `5xx`. OTLP/HTTP designates only `429`, `502`, `503`, and `504` as retryable responses; other HTTP failures are permanent. Clients SHOULD honor `Retry-After` when present; connection-retry intervals MUST include random jitter. PostHog intentionally returns `400` for count, quota, and restriction failures so clients permanently drop them.

Resolved: Cognia now treats only `429`, `502`, `503`, and `504` as retryable HTTP responses, follows `Retry-After`, and uses jittered backoff for retryable responses without that header and for connection failures. Product `/batch/` retry remains a separate contract matching PostHog's first-party Node/core behavior.

Implementation evidence: `lib/logging/transports/otlp-http-transport.ts:238-267`.

## Source-IP controls

`$geoip_disable: true` is confirmed to skip GeoIP enrichment; it does not itself discard the request IP. PostHog's first-party core sender implements `disableGeoip` by adding that property, while the ingestion pipeline separately owns IP discard. [official core GeoIP-disable behavior](https://github.com/PostHog/posthog-js/blob/9b2a1b18db64f9f6b331cbded543c5ead3ccf0cb/packages/core/src/posthog-core-stateless.ts#L1288-L1294)

PostHog exposes IP capture/discard as an organization default plus a project-level override. Existing projects retain their project setting when the organization default changes. Internally, the project setting is `anonymize_ips`, and the event-processing step deletes `$ip` when it is enabled. [PostHog IP data capture controls](https://posthog.com/docs/privacy/data-collection#ip-data-capture), [project setting source](https://github.com/PostHog/posthog/blob/1e8be28c056c0a3f3606328593988de4e2693aa3/frontend/src/scenes/settings/environment/IPCapture.tsx#L6-L12), [ingestion discard step](https://github.com/PostHog/posthog/blob/1e8be28c056c0a3f3606328593988de4e2693aa3/nodejs/src/ingestion/common/steps/event-processing/prepare-event-step.ts#L38-L43)

The AI OTLP handler explicitly extracts the request client IP and passes it into the captured event before downstream project controls apply. Its fan-out defaults `$geoip_disable` to true, so AI GeoIP enrichment is disabled unless the sender opts in; the raw source IP still requires the same project-level discard setting. [AI OTLP client-IP extraction](https://github.com/PostHog/posthog/blob/1e8be28c056c0a3f3606328593988de4e2693aa3/rust/capture/src/otel/mod.rs#L243-L280), [AI captured-event IP field](https://github.com/PostHog/posthog/blob/1e8be28c056c0a3f3606328593988de4e2693aa3/rust/capture/src/otel/filtering.rs#L104-L130), [AI GeoIP-disable default](https://github.com/PostHog/posthog/blob/1e8be28c056c0a3f3606328593988de4e2693aa3/rust/capture/src/otel/fan_out.rs#L98-L106)

Required operational checks for every Cognia-managed project, and owner checks for every BYO project:

1. Verify **Settings → Project → General → IP data capture → discard client IP**.
2. Verify the organization default for future managed projects, but do not treat it as proof for existing projects.
3. After any project migration or environment creation, repeat the project-level check.

## Unknown operational checks

These cannot be proven from the repository or public ingestion responses:

- Whether the current managed US/EU PostHog project has client-IP discard enabled.
- Whether each BYO project has client-IP discard enabled.
- Whether managed/BYO destinations accept and persist one current Cognia product smoke event; verify by the exact event UUID/name after ingestion, not only by `2xx`.
- Whether each AI destination persists a current Cognia span and has no `NoAiSpans` or `MessageSizeTooLarge` ingestion warning.
- Whether the chosen identity policy matches live data: query a shared installation ID after sending product-only, AI-only, and combined events and confirm whether a person profile exists.
- Whether transient retry produces only eventual duplicate collapse for product events and acceptable at-least-once behavior for AI spans in the live project/destinations.

## Bottom line

The direct PostHog integration is mostly contract-correct, but “complete” currently requires an explicit identity decision, a renderer OTLP size/drain hardening decision, and live project verification of source-IP discard plus smoke-event persistence. The identity issue is the only finding that directly contradicts the existing audit's personless-product conclusion.
