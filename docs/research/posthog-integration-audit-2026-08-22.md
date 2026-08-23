# PostHog integration audit

Date: 2026-08-22

Scope: Cognia's direct product-event capture and AI Observability OpenTelemetry export. This note uses only current official PostHog documentation and source code. It separates correctness/completeness gaps from optional PostHog features.

## Executive result

Cognia uses the correct PostHog hosts, capture paths, token types, and AI OTLP authorization. Product events are intentionally personless and disable GeoIP enrichment. AI spans are metadata-only and use the dedicated AI Observability OTLP endpoint.

The code-level integration is complete after the remediation in this change. Product capture now has bounded transient retry, consent-aware discard, headless-shutdown drain, shared destination/identity validation, and destination-specific test results. Both AI transports already cap exports below PostHog's request-count limit: the renderer uses 32 spans and the sidecar uses 16. Both AI paths now apply a final fail-closed PII gate after structural sanitization.

One operational requirement remains outside the codebase: the Cognia-managed PostHog project must enable **discard client IP**. Bring-your-own project owners control the equivalent setting for their own project. Cognia disables GeoIP enrichment in product events, but a client cannot prove or enforce a server-side project setting from the capture request.

## Required correctness and completeness gaps

### 1. Product retry and lifecycle handling — remediated

`lib/telemetry/posthog-product.ts` now preserves each serialized batch and event UUID across bounded retries for network errors, `408`, `429`, and `5xx` responses. Terminal `4xx` responses fail immediately. Batches are capped at 20 reviewed, scalar-only events, leaving substantial headroom below PostHog's 20 MB batch limit.

Lifecycle behavior is deliberately split:

- Consent withdrawal increments an exporter epoch and rejects queued work, preventing an in-flight failed batch from retrying after consent changes.
- Destination removal permanently closes that destination.
- Normal headless shutdown stops accepting events and awaits the serialized queue drain. Renderer shutdown remains best-effort: `pagehide` triggers a flush and web fetch uses `keepalive`, but an abrupt desktop/window exit cannot synchronously await renderer IPC.

This follows PostHog's SDK behavior and SDK specifications: transient requests are retried, `413` batches are reduced, and shutdown drains pending work with a timeout. Event UUIDs make retried captures safely deduplicable.

Sources: [Node SDK](https://posthog.com/docs/libraries/node), [retry queue specification](https://github.com/PostHog/sdk-specs/blob/main/openspec/specs/retry-queue/spec.md), [flush specification](https://github.com/PostHog/sdk-specs/blob/main/openspec/specs/flush/spec.md), [shutdown specification](https://github.com/PostHog/sdk-specs/blob/main/openspec/specs/shutdown/spec.md), [core SDK implementation](https://github.com/PostHog/posthog-js/blob/main/packages/core/src/posthog-core-stateless.ts), [event deduplication](https://github.com/PostHog/posthog.com/blob/master/contents/docs/data/events.mdx)

### 2. AI OTLP request limits — already satisfied

PostHog's AI OTLP endpoint rejects a request containing more than 100 accepted AI spans or 1,000 raw spans with a non-retryable `400`. The public setup guide separately documents a 4 MB request limit.

The renderer transport batches at 32 spans. The sidecar explicitly installs a `BatchSpanProcessor` with `maxExportBatchSize: 16`; it does not rely on `NodeSDK`'s default processor. Both are safely below PostHog's 100 accepted-AI-span / 1,000 raw-span request limits. Cognia's metadata-only attribute policy and per-attribute caps also keep normal payloads well below the 4 MB request limit.

Also retain current endpoint separation: AI Observability is `/i/v0/ai/otel`; general distributed tracing uses `/i/v1/traces` and is not interchangeable.

Sources: [AI OTLP server limits and response policy](https://github.com/PostHog/posthog/blob/a8f477d81470dfa18151977819708520950ea7a7/rust/capture/src/otel/mod.rs#L36-L67), [AI OTLP ingestion behavior](https://github.com/PostHog/posthog/blob/a8f477d81470dfa18151977819708520950ea7a7/rust/capture/src/otel/mod.rs#L251-L327), [OpenTelemetry installation](https://posthog.com/docs/ai-observability/installation/opentelemetry), [official JS processor](https://github.com/PostHog/posthog-js/blob/main/packages/ai/src/otel/processor.ts), [distributed tracing endpoint](https://posthog.com/docs/distributed-tracing/start-here)

### 3. Capture validation and test-event truthfulness — remediated

PostHog requires a non-empty event name and a non-empty `distinct_id` for every event. A `distinct_id` is limited to 200 characters; longer values are truncated. Invalid events can still receive an HTTP `200` while not being ingested, so an accepted request is not sufficient validation.

Cognia's catalog provides non-empty, compile-time event names. Exporter construction now rejects a blank or over-200-character installation ID, including operator-provided headless values. Host/token URL validation is shared by the settings UI and runtime, including rejection of credential-bearing URLs.

The Settings test action now bypasses random sampling while retaining every consent, category, and privacy gate. Its success message requires delivery to every enabled PostHog destination; a successful local Dexie write can no longer mask a failed PostHog request.

Sources: [capture API](https://posthog.com/docs/api/capture), [identity resolution](https://posthog.com/docs/product-analytics/identity-resolution), [identify guidance](https://posthog.com/docs/product-analytics/identify)

### 4. Source-IP discard — operational requirement

Product events set `$geoip_disable: true`, which correctly disables GeoIP enrichment. That property does not itself guarantee that the request's source IP is discarded. PostHog controls source-IP collection through an organization/project setting.

For Cognia-managed PostHog projects, deployment owners must verify and operationally enforce **discard client IP**. For bring-your-own PostHog projects, the UI now discloses that the operator owns this setting and Cognia cannot guarantee server-side IP discard. AI OTLP exports rely on the same project-level control because they do not carry the product-event GeoIP property.

Sources: [PostHog privacy and IP collection](https://posthog.com/docs/privacy/data-collection), [official GeoIP plugin behavior](https://github.com/PostHog/posthog-plugin-geoip)

### 5. AI identity semantics — documented contract

Raw/backend PostHog captures are identified by default. A product event becomes personless only when it includes `$process_person_profile: false`, and an ID previously used for an identified event cannot later be made anonymous by setting that property. Cognia correctly sets the property on product events.

For AI Observability, `posthog.distinct_id` is optional; PostHog instructs clients to omit it for anonymous AI events. Cognia currently attaches the installation ID to AI spans, so those spans are identified, pseudonymous events even though they contain no account identity. This is not inherently wrong, but it conflicts with any blanket statement that all PostHog telemetry is personless.

Cognia intentionally retains the opaque installation ID for cross-span correlation and now describes AI events as identified but pseudonymous. Product events remain personless. The integration does not call `$identify`, create aliases, or reuse the installation ID for human identity.

PostHog resolves AI identity from span/resource attributes including `posthog.distinct_id` and `user.id`; otherwise it assigns a request-scoped fallback ID.

Sources: [anonymous versus identified events](https://posthog.com/docs/data/anonymous-vs-identified-events), [AI OpenTelemetry onboarding source](https://github.com/PostHog/posthog/blob/master/docs/onboarding/ai-observability/opentelemetry.tsx), [AI OTLP identity resolution](https://github.com/PostHog/posthog/blob/master/rust/capture/src/otel/identity.rs)

## Contracts already satisfied

- Direct capture uses `POST /batch` with a public project token and the correct regional/self-hosted origin. PostHog accepts `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or the self-hosted domain. The batch body must remain below 20 MB. [Capture API](https://posthog.com/docs/api/capture)
- Product events set `$process_person_profile: false` and `$geoip_disable: true`, matching the intended personless/no-GeoIP-enrichment behavior.
- Event UUIDs are generated before transmission, which is the right basis for safe retry deduplication.
- Renderer and sidecar AI export use `<client-api-origin>/i/v0/ai/otel` with `Authorization: Bearer <project-token>`. The endpoint must be configured as a traces-specific URL because a generic OTLP endpoint normally appends `/v1/traces`. HTTP JSON or protobuf is supported; gRPC is not. [OpenTelemetry installation](https://posthog.com/docs/ai-observability/installation/opentelemetry)
- PostHog host normalization to the URL origin matches the official exporter. [Official AI exporter](https://github.com/PostHog/posthog-js/blob/main/packages/ai/src/otel/exporter.ts)
- Cognia's AI transports filter/redact content and then apply a final fail-closed PII scan before export. The sidecar also reduces resource attributes to an explicit allowlist. PostHog's official exporter selects AI spans by known AI attribute prefixes. [Official AI span filter](https://github.com/PostHog/posthog-js/blob/main/packages/ai/src/otel/spans.ts)
- Renderer AI export has bounded retry and close-time flush; sidecar telemetry shutdown is awaited. A `2xx` response still does not prove every span persisted because the server may intentionally discard non-AI or oversized spans. [AI ingestion behavior](https://github.com/PostHog/posthog/blob/a8f477d81470dfa18151977819708520950ea7a7/rust/capture/src/otel/mod.rs#L286-L327)
- The sidecar's `maxExportBatchSize: 16` and renderer's 32-span queue are both below the AI ingestion count limits.

## Optional features, not integration gaps

The following PostHog capabilities are deliberately outside Cognia's manual, consent-gated export design and are not required for a complete integration:

- Browser autocapture, automatic pageviews/pageleave, and session replay
- Surveys, feature flags, experiments, and exception autocapture
- `$identify`, person properties, aliases, groups, and person-profile enrichment
- PostHog-managed sessions and cookieless web analytics
- Persistent on-disk event queues, compression, and product-event health dashboards

Operationally useful but optional hardening includes an exporter health/retry counter, an ingestion smoke event for each configured destination, and an explicit product-batch byte-size guard well below 20 MB.

## Documentation and dependency cleanup

`docs/tracking/cognia-behavior-tracking-design.md` now describes the actual direct `/batch` sender, retry behavior, lifecycle distinction, identity semantics, and project-level IP boundary. The unused `posthog-js` loader, its tests, and the runtime dependency were removed so there is one product-capture implementation rather than a dormant second path.
