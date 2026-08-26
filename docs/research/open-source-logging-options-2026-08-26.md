# Open-source logging options for Cognia

**Date:** 2026-08-26  
**Scope:** Browser/Next.js renderer, Tauri/Rust host, Node sidecars, local-first diagnostics, and optional remote observability.  
**Sources:** Primary sources only: official specifications, documentation, and repositories.

## Executive recommendation

Do **not** replace Cognia's logging stack wholesale.

The strongest near-term design is:

1. Keep `@cognia/logging` as the application-facing, local-first policy layer.
2. Keep IndexedDB/native spools, the versioned `ObservabilityEventV1` envelope, consent controls, and the shared PII gate as Cognia-owned behavior.
3. Make OpenTelemetry Logs/OTLP the canonical **remote interoperability boundary**, not the application logging API.
4. Keep Rust on `tracing`/`tracing-subscriber` and `tauri-plugin-log`; converge new Rust instrumentation on `tracing` while retaining `log` compatibility.
5. If maintaining the TypeScript logger core becomes costly, evaluate **LogTape** as the only credible core replacement candidate. Retain Cognia-specific sinks and policy around it.
6. Add **Grafana Faro** or **Sentry** only as optional RUM/error-monitoring integrations. Neither replaces Cognia's offline diagnostic store or cross-runtime event contract.
7. Put an OpenTelemetry Collector or equivalent gateway between clients and the selected backend. Choose the backend independently: SigNoz for an OTel-native all-in-one experience, OpenObserve for simple/lightweight operations, HyperDX for ClickHouse-centric investigation and session replay, or Grafana for Faro/Loki/Tempo integration.

This is also consistent with the accepted local ADRs: ADR-0102 explicitly preserves the existing logger/crash monitor and adopts compatibility adapters, while ADR-0074 treats OTLP as an export boundary and keeps desktop network/secrets in Rust.

## Why a wholesale replacement is a poor fit

Cognia's custom code is doing more than formatting log lines. It owns product semantics that general-purpose loggers normally do not:

- local persistence and bounded crash-safe spooling;
- offline inspection and export in `/logs`;
- one privacy manifest before persistence, IPC, export, or upload;
- user consent and independent destination switches;
- W3C trace propagation across renderer, Tauri IPC, sidecars, CLI, plugins, and mobile;
- transport health, batching, retry, and lifecycle behavior;
- backward readability of persisted `StructuredLogEntry` data and the versioned `ObservabilityEventV1` contract;
- Tauri-specific secret isolation and network egress through Rust.

Replacing the facade still leaves most of these facilities as custom sinks, processors, adapters, and policy. The migration would therefore be large while deleting relatively little Cognia-owned code.

## OpenTelemetry: adopt the standard, not yet the browser logger SDK

OpenTelemetry is the right common data model and wire protocol. Its stable LogRecord model includes timestamps, severity, body, attributes, resource, instrumentation scope, `TraceId`, `SpanId`, and trace flags, which directly matches Cognia's cross-runtime correlation needs. The Logs SDK specification also defines processors, batching, exporters, and automatic population of trace context from the current context. The project explicitly describes the Logs API as a bridge for existing logging libraries, noting that established logging libraries usually provide a richer developer experience. ([OpenTelemetry Logs overview](https://opentelemetry.io/docs/specs/otel/logs/), [Logs data model](https://opentelemetry.io/docs/specs/otel/logs/data-model/), [Logs SDK specification](https://opentelemetry.io/docs/specs/otel/logs/sdk/))

However, the current OpenTelemetry JavaScript implementation lists Logs as **Development**, while Traces and Metrics are stable. Its browser instrumentation is also described as experimental and mostly unspecified. This makes `@opentelemetry/api-logs` plus `@opentelemetry/sdk-logs` a risky choice for Cognia's primary browser logging facade in 2026, even though it is suitable behind an adapter or exporter. ([OpenTelemetry JavaScript status](https://opentelemetry.io/docs/languages/js/), [browser instrumentation](https://opentelemetry.io/docs/languages/js/getting-started/browser/))

Browser OTLP also has unavoidable deployment constraints: gRPC export is unsupported, CSP and CORS must allow the endpoint, and a public collector should be protected by a reverse proxy. Cognia's current Tauri/Rust egress boundary avoids exposing credentials and avoids broadening renderer CSP, so it should remain the desktop path. ([OpenTelemetry JS exporters](https://opentelemetry.io/docs/languages/js/exporters/))

**Recommendation:** Map `ObservabilityEventV1` to OTel LogRecords at remote export boundaries. Preserve the Cognia event as the local source of truth and include `trace_id`/`span_id` using the OTel model. Do not make the OTel JS Logs SDK the renderer's public logging API until its Logs and browser status are stable enough for the product's compatibility requirements.

## TypeScript logger candidates

### LogTape: the best replacement candidate, but not an urgent migration

LogTape is the closest match to Cognia's current facade. Its official repository documents zero runtime dependencies, browser/Node/Deno/Bun/edge support, structured records, hierarchical categories, child/context loggers, built-in field/pattern redaction, extensible sinks, and official OpenTelemetry and Sentry sink packages. ([LogTape repository](https://github.com/dahlia/logtape))

Those capabilities could replace parts of Cognia's logger registry, category filtering, redaction wrappers, and generic sink fan-out. Its OTel sink also reduces maintenance at the LogRecord mapping boundary.

It does **not** remove the need for Cognia-owned code for IndexedDB retention/querying, crash-safe spools, Tauri IPC/native routing, destination consent, transport health UI, the privacy manifest, or backward-compatible persisted envelopes. A direct migration would also touch essentially every call site and every transport contract.

**Verdict:** Run a small proof of concept only if core logger maintenance is demonstrably expensive. The safe migration shape is an adapter that implements the current `createLogger()` contract over LogTape, followed by one transport at a time. Do not rewrite call sites first.

### Pino: excellent server logger, weak fit for the renderer core

Pino's own repository says it is built to run on Node.js. In browsers it defaults to corresponding `console` methods; remote recording is supplied through a user-provided `browser.transmit.send` function. Its main transport architecture is based on Node streams and Worker Threads. ([Pino repository](https://github.com/pinojs/pino), [Pino Browser API](https://github.com/pinojs/pino/blob/main/docs/browser.md), [Pino transports](https://github.com/pinojs/pino/blob/main/docs/transports.md))

Pino is a good option for conventional Node services and may be useful inside a standalone sidecar, but it would turn Cognia's browser persistence, privacy, transport health, and trace-context behavior back into custom `transmit` code. It therefore provides little leverage as the cross-runtime core.

**Verdict:** Do not replace `@cognia/logging` with Pino. Consider it only for an isolated Node service whose output is already collected out of process.

### tslog: capable universal DX, but still misses Cognia's core requirements

tslog v5 documents universal runtimes, zero runtime dependencies, masking, child loggers, pluggable transports, and tree-shakeable builds. The full browser-oriented build is approximately 20.7 KB gzip and the slim build approximately 9.8 KB gzip, but the slim build deliberately omits masking, pretty output, and stack capture. It also states that async-context propagation does not work in browsers because `AsyncLocalStorage` is unavailable there. ([tslog repository and v5 documentation](https://github.com/fullstack-build/tslog))

tslog is attractive for developer-console ergonomics and source-mapped call sites, but the bundle trade-off conflicts with Cognia's requirement that redaction happen before every sink, and browser correlation would still need Cognia's immutable scoped context. Like LogTape, it has no drop-in replacement for the IndexedDB/local diagnostic model.

**Verdict:** Lower priority than LogTape for a production core migration. It could be a development-only console formatter, but adding a second logging abstraction is probably not worth the maintenance.

## Browser observability and error monitoring

### Grafana Faro: best open-source RUM add-on

Faro is designed specifically for browser frontend observability. Its SDK captures errors, logs, Web Vitals, sessions, views, and optional OpenTelemetry traces. It is modular: core/web, React, and the larger tracing package can be installed separately. It can export to Grafana Alloy, Grafana Cloud, or a custom receiver; Alloy can route data to Loki and Tempo. ([Faro repository](https://github.com/grafana/faro-web-sdk), [Faro Web SDK](https://github.com/grafana/faro-web-sdk/blob/main/packages/web-sdk/README.md), [browser quick start](https://github.com/grafana/faro-web-sdk/blob/main/docs/sources/tutorials/quick-start-browser.md))

Faro is a good answer to "we need RUM, Web Vitals, uncaught errors, sessions, and browser-to-backend trace continuity." It is not a replacement for Cognia's local logger: the documented built-in transports are console and fetch, and its supported environment is a normal browser page, not Node, workers, or other runtimes. ([Faro supported environments](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/frontend-observability/introduction/supported-environments/))

Its tracing package is intentionally separate because of its larger size. Faro supports a `beforeSend` hook for filtering or dropping data, but Cognia should still apply its PII gate before handing anything to Faro rather than relying on destination-specific filtering. ([Faro browser quick start](https://github.com/grafana/faro-web-sdk/blob/main/docs/sources/tutorials/quick-start-browser.md), [Grafana data privacy](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/session-replay/data-privacy/))

**Verdict:** Strong optional RUM transport/instrumentation. Keep it behind explicit consent and do not enable console capture or session replay by default. Preserve IndexedDB as the durable offline store.

### Sentry: best optional error workflow, not a unified local logger

Sentry's official JavaScript SDK supports browser and React applications, structured logs, tracing, errors, breadcrumbs, and source-map-based diagnostics; the official Rust SDK integrates with both `log` and `tracing`. ([Sentry JavaScript SDK](https://github.com/getsentry/sentry-javascript), [Sentry Rust SDK](https://github.com/getsentry/sentry-rust))

Sentry also has a browser offline transport wrapper; its published browser transport types describe IndexedDB envelope storage with a default maximum queue of 30. That is useful for remote delivery reliability, but it is not an inspectable seven-day/10,000-entry local log database or a crash bundle workflow. The older `Offline` integration was removed in favor of the transport wrapper, illustrating that this is SDK transport behavior rather than a stable Cognia data contract. ([Sentry v7-to-v8 migration](https://github.com/getsentry/sentry-javascript/blob/develop/docs/migration/v7-to-v8.md), [browser offline transport API](https://app.unpkg.com/%40sentry/browser%407.100.0/files/types-ts3.8/transports/offline.d.ts))

Sentry is also a vendor-shaped event model. Even when self-hosted, replacing Cognia's facade with the Sentry logger would couple application logs, sampling, privacy hooks, and issue workflows to Sentry. Browser and Rust SDKs would still require explicit cross-runtime correlation and Cognia-specific consent policy.

**Verdict:** Use only as an optional crash/error destination if its issue grouping, release health, and source-map workflow are desired. Send a bounded, redacted subset from the existing pipeline; do not use Sentry as the canonical local log store or event contract.

## Rust and Tauri

The current Rust choice is already the strongest open-source fit.

`tracing` is a structured, event-based diagnostics framework that models events inside spans; `tracing-subscriber` provides filtering and composable collection, while `tracing-opentelemetry` translates spans, child/parent relationships, and in-span events into OpenTelemetry. ([Tokio tracing repository](https://github.com/tokio-rs/tracing), [`tracing` documentation](https://docs.rs/tracing/latest/tracing/), [`tracing-opentelemetry` layer](https://docs.rs/tracing-opentelemetry/latest/tracing_opentelemetry/fn.layer.html))

The official Tauri logging plugin supports Rust `log` records, JavaScript guest logging, stdout/stderr, WebView, and persistent file targets, plus target filters and custom formatting. It is maintained in Tauri's official plugins workspace. ([Tauri logging plugin](https://v2.tauri.app/plugin/logging/), [official plugins repository](https://github.com/tauri-apps/plugins-workspace))

**Recommendation:** Keep both during migration: make `tracing` the preferred API for new native async work, consume legacy `log` records through the subscriber/plugin compatibility layer, and retain `tauri-plugin-log` for Tauri lifecycle/file/WebView integration. Replacing it with `fern`, `slog`, or another formatter would not improve cross-runtime correlation or product diagnostics.

## Backends are a separate decision

Changing the backend should not force another application logger migration. Emit OTLP through a collector/gateway and keep destination adapters narrow.

| Backend                             | Best fit                                                                                           | Main trade-off                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| SigNoz                              | OTel-native logs/traces/metrics and a documented browser frontend-monitoring path                  | Adds a full observability service; the browser still needs CORS/TLS or a gateway                                                      |
| OpenObserve                         | Simple self-hosting and unified OTLP ingestion; official repo documents a single-binary deployment | Less purpose-built RUM/error workflow than Faro or Sentry                                                                             |
| HyperDX / ClickStack                | ClickHouse search, logs/traces/session replay correlation, and strong investigation UX             | Heavier stack: ClickHouse, Collector, MongoDB, and HyperDX; official quick start recommends at least 4 GB RAM and 2 cores for testing |
| Grafana Faro + Alloy + Loki + Tempo | Most composable open-source browser RUM plus Grafana ecosystem                                     | More moving pieces to deploy and operate                                                                                              |

SigNoz documents browser-side OTel logs, traces, metrics, Web Vitals, and self-hosted ingestion. ([SigNoz frontend monitoring](https://signoz.io/docs/frontend-monitoring/), [sending browser logs](https://signoz.io/docs/frontend-monitoring/sending-logs-with-opentelemetry/)) OpenObserve supports OTLP logs, metrics, and traces and provides a single-binary self-hosted deployment. ([OpenObserve OTLP ingestion](https://openobserve.ai/docs/ingestion/logs/otlp/), [OpenObserve repository](https://github.com/openobserve/openobserve/blob/main/README.md?plain=1)) HyperDX's official repository describes an OTel/ClickHouse stack with logs, traces, metrics, session replay, and an all-in-one deployment. ([HyperDX repository](https://github.com/hyperdxio/hyperdx))

For Cognia's local-first desktop product, **OpenObserve** is the lowest-operations default for an internal deployment; **SigNoz** is the strongest OTel-first product choice; **HyperDX** is preferable when session replay and fast ClickHouse-centric investigation justify the larger stack. None should be embedded into the desktop application.

## Proposed migration sequence

1. Freeze and document the `ObservabilityEventV1` → OTel LogRecord mapping, including severity, resource, scope, trace/span IDs, privacy classification, and truncation limits.
2. Route generic remote logs through one OTLP/HTTP exporter and collector/gateway; keep Tauri exports in Rust and browser/web exports behind CSP/CORS-safe endpoints.
3. Add conformance tests asserting that every remote adapter receives already-redacted events and preserves trace correlation.
4. Pilot one self-hosted backend without changing call sites or local persistence.
5. If RUM is a goal, pilot Faro with errors/Web Vitals only; leave console capture and session replay off until consent/privacy review is complete.
6. If error triage is a goal, pilot Sentry as a bounded error transport only.
7. Only if logger-core maintenance remains a measured burden, prototype a `createLogger()` compatibility adapter backed by LogTape and compare bundle size, throughput, redaction equivalence, and transport-health behavior before any migration decision.

## Decision summary

There are better open-source **components**, but no better drop-in open-source **system** for Cognia's complete requirements.

- Best standard: OpenTelemetry LogRecord + OTLP at boundaries.
- Best TypeScript core candidate: LogTape, with moderate benefit and high migration risk.
- Best browser RUM add-on: Grafana Faro.
- Best error-monitoring add-on: Sentry.
- Best native foundation: keep `tracing` + `tauri-plugin-log`.
- Best architectural choice: preserve Cognia's local-first storage, privacy, consent, and cross-runtime envelope; replace or add transports independently.
