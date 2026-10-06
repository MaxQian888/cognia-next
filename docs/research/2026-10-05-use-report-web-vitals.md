# useReportWebVitals feasibility in Cognia

Date: 2026-10-05. Status: implemented in the working tree; collection and reporting remain off by default. The research sections below describe the baseline inspected before implementation.

## Implementation status — 2026-10-05

- `app/layout.tsx` mounts `WebVitalsReporter` outside account/onboarding gates. The Next.js hook starts only after collection is enabled. Its callback identity and mounted subscription remain stable across toggle changes.
- `lib/perf/web-vitals.ts` owns device-local persisted settings, a collection master switch, a separate reporting switch, and six per-metric switches. FID defaults off; all collection/reporting defaults off. The summary retains at most six scalar records in memory.
- Turning off collection clears displayed values, ignores subsequent callbacks, and aborts pending reporting. Turning off a metric clears that metric and cancels its sends. Turning off reporting preserves local values and cancels sends; turning it back on does not replay old values. Already delivered events cannot be recalled. Next.js provides no observer-disconnect API: installed observers remain until reload, as explained in the panel.
- Strict Mode can register duplicate underlying observers. Records use one canonical metric identity per document visit and suppress equal updates. BFCache resets run in capture phase before the bundled library emits restored TTFB.
- Settings synchronize across tabs. Behavior telemetry consent changes invalidate pending sends, including a rapid OFF/ON transition. Storage failures still apply the current-page choice and display a persistence warning.
- `PerfWebVitalsPanel` is mounted in `/performance` Overview. English and Chinese copy includes supported/pending/off/failure states, metric ratings, unitless CLS, clear controls, and the link to `/me/logs?logsPanel=telemetry`.
- `app.web_vital` uses the existing `app` category and scalar/PII/consent/sampling/destination gates. PostHog sends these events without waiting for its normal batch timer. Cancellation is scoped so unrelated events are retained; desktop delivery retains the native transport. No new ingestion endpoint, SDK, or attribution flag was added.

Verification: 13 focused Jest suites passed (144 tests), including the real Next.js hook under Strict Mode and a BFCache listener-order regression. Changed-file ESLint and bilingual generation/parity checks passed. A Chromium component harness exercised the actual panel, store, and Next hook, observed real FCP/TTFB values, and checked the Chinese layout at 390px without horizontal overflow. Opting out cleared the values; after reload, collection/reporting remained off, observers had not started, and the summary was empty. The harness substitutes the remote transport and does not establish live OTLP/PostHog delivery or full-app integration.

Full repository TypeScript checks remain blocked by errors outside this change (CLI/agent session contracts, identity tests, push timer types, and the build config's Cloudflare service types). No diagnostics were reported for the Web Vitals changes. Full-app browser validation encountered a Turbopack panic (`Parent client reference not found for next/dynamic import`) and then disk exhaustion during Webpack compilation; the verification server was stopped and its regenerable Webpack development cache removed. A complete production build and real-device WebView verification are still unverified.

## Decision

Yes. Cognia can use `useReportWebVitals` as a small client-side source of document performance measurements. It fits the App Router and production static export. The useful addition is standardized LCP, INP, CLS, FCP, and TTFB measurements alongside the existing renderer and chat timings. It is not a replacement for those measurements, and adding a `next.config.ts` flag alone does not connect reporting to Cognia.

Start with the existing `next/web-vitals` hook, one stable root-mounted reporter, and Cognia's existing consent-gated telemetry path. Keep attribution disabled until a separately verified implementation is needed.

## Framework facts checked against the installed version

The installed `next/package.json` reports **16.3.6**. The matching upstream tag pins its build dependency to **web-vitals 4.2.1**. The installed compiled package omits a version field, but its metric IDs begin with `v4-`; do not infer a newer dependency from current upstream documentation. [Next.js 16.3.6 package source](https://github.com/vercel/next.js/blob/v16.3.6/packages/next/package.json)

The installed `node_modules/next/dist/client/web-vitals.js` matches the upstream hook: it invokes `onCLS`, `onFID`, `onLCP`, `onINP`, `onFCP`, and `onTTFB` in a React effect whose dependency is the callback. It exposes no options argument and returns no cleanup function. It does not register Next.js custom route/hydration timings. Consequently, changing the callback or remounting the reporter can register additional observers; unmounting is not an observer-disconnect or consent-revocation mechanism. Use a stable callback and a stable mount; verify Strict Mode/HMR behavior rather than assuming callback stability alone handles remounts. [Versioned hook source](https://github.com/vercel/next.js/blob/v16.3.6/packages/next/src/client/web-vitals.ts)

The official App Router integration uses a dedicated Client Component imported by the root layout. The layout need not become a Client Component. No Vercel analytics service is required; the callback chooses the destination. [Next.js hook reference](https://nextjs.org/docs/app/api-reference/functions/use-report-web-vitals)

| Metric | Meaning and unit                       | Recommended use                                          |
| ------ | -------------------------------------- | -------------------------------------------------------- |
| LCP    | Largest contentful paint, ms           | Initial document loading                                 |
| INP    | Interaction to next paint, ms          | Document interaction responsiveness                      |
| CLS    | Cumulative layout shift, dimensionless | Visual stability                                         |
| FCP    | First contentful paint, ms             | Initial visible content                                  |
| TTFB   | Navigation time to first byte, ms      | Document delivery; interpret separately for local assets |
| FID    | First input delay, ms                  | Legacy compatibility only                                |

LCP, INP, and CLS are the Core Web Vitals; FID was removed from upstream web-vitals in v5, although the installed Next.js hook still registers it. [Upstream v5 migration](https://github.com/GoogleChrome/web-vitals/blob/main/docs/upgrading-to-v5.md)

Static export supports browser effects and Client Components. A client reporter therefore does not require a Next.js server. A new Next.js POST ingestion route would not work as a dynamic backend in the exported app; use Cognia's existing transports or a separately hosted collector. This compatibility conclusion follows from the hook source and static-export constraints, not a production build performed during this research. [Static export reference](https://nextjs.org/docs/app/guides/static-exports)

## Attribution: documented flag versus installed wiring

The official configuration reference documents `experimental.webVitalsAttribution`, disabled by default, and identifies it as experimental. It can expose diagnostic attribution such as the element or resource behind LCP. [Next.js attribution configuration](https://nextjs.org/docs/app/api-reference/config/next-config-js/webVitalsAttribution)

The local implementation does not establish that this flag works with the hook:

- `node_modules/next/dist/server/config-schema.js` accepts all six metric names.
- `node_modules/next/dist/build/define-env.js` emits `__NEXT_HAS_WEB_VITALS_ATTRIBUTION` and `__NEXT_WEB_VITALS_ATTRIBUTION`.
- A literal search of installed `next/dist`, excluding source maps, finds those identifiers only in the CommonJS/ESM define-env files, with no runtime consumers.
- The hook imports the standard compiled `web-vitals` implementation directly. It neither selects an attribution build nor reads these flags.
- The installed client directory has no `performance-relayer.js`; historical Pages Router examples must not be assumed to describe this installation.

Therefore, **do not promise that toggling this flag adds attribution to Cognia's App Router callback**. This is a source-level finding; no browser test of the flag was performed. If attribution becomes necessary, explicitly integrate and pin `web-vitals/attribution` through a reviewed collector, use it instead of duplicate collectors, and verify its actual payload and browser behavior.

## Lifecycle, navigation, and WebView limits

Some measurements arrive only after interaction or when the page becomes hidden. No interaction may mean no INP/FID; background-loaded pages may omit several paint metrics. Callbacks can recur, and BFCache restores create a new visit/metric identity. Registering collectors repeatedly adds page-lifetime observers. Raw entries may include DOM/resource details, and parent-document metrics do not automatically measure iframe content. The upstream v4 browser matrix is historical, so capability detection and device testing must determine current support. [Versioned web-vitals usage and limitations](https://github.com/GoogleChrome/web-vitals/blob/v4.2.1/README.md)

The installed bundle has no soft-navigation option or soft-navigation metric type. Its normal document lifecycle must not be presented as a fresh measurement for every Cognia route or chat switch. Newer upstream v6 adds soft-navigation support, but that functionality is not inherited by Next's bundled v4 collector. [Upstream changelog](https://github.com/GoogleChrome/web-vitals/blob/main/CHANGELOG.md)

Practical consequences for Cognia, inferred from those constraints:

- Record document-start route separately from the route visible when a late callback arrives. Reuse the route normalization helper and omit query/hash values.
- Represent unsupported and not-yet-observed metrics explicitly; missing INP is not a zero-latency interaction.
- Tauri/Capacitor results depend on the actual embedded engine and available performance entry types. Test Chromium and WebKit separately; do not promise six metrics on every device.
- Local-asset TTFB is not cloud API latency, model first-token latency, or native process startup time. Keep runtime and app version dimensions so those populations are not mixed.
- Long-running chat streaming and SPA transitions still need Cognia's custom timings. Core Web Vitals do not describe all of their behavior.

## Existing Cognia integration points

Repository source was inspected on 2026-10-05; these are local-code findings, not claims of deployed behavior.

| Existing area                                                      | What exists                                                                                                       | Integration consequence                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `next.config.ts`; `app/layout.tsx`                                 | Production `output: 'export'`; root `AppRuntime` mount                                                            | Add a tiny reporter beside `AppRuntime`, without widening the root client boundary             |
| `components/runtime/app-runtime.tsx`                               | `TelemetrySessionInitializer` and `RendererPerfInitializer` sit under hydration/recovery/account/onboarding gates | A gated initializer alone can miss early boot reporting                                        |
| `lib/perf/renderer-collector.ts`                                   | Demand-leased FPS, long-task, heap, and User Timing collection                                                    | Reuse surrounding infrastructure, but do not start another unconditional renderer polling loop |
| `lib/perf/metric-catalog.ts`                                       | Interval/frame-oriented metrics; no CLS dimensionless unit                                                        | Do not repeat document metrics as per-second frame samples                                     |
| `lib/perf/chat-turn-performance.ts`                                | Dispatch, first response, streaming, persistence, and total-turn timings                                          | Preserve these as complementary product metrics                                                |
| `lib/telemetry/events/catalog.ts`, `track-event.ts`, `settings.ts` | Event catalog, scalar constraints, consent/category/sampling/local/remote/PII gates                               | Register a reviewed `app.web_vital` event and send through `trackEvent`                        |
| `lib/telemetry/app-session.ts`                                     | `toReportableRoute` normalization                                                                                 | Reuse route sanitization rather than emitting full URLs                                        |
| `lib/logging/bootstrap.ts`                                         | OTLP log exporter and PostHog product exporter; injected desktop native transport                                 | Reuse existing egress; OTLP log events are not native metric histograms                        |
| `lib/telemetry/posthog-product.ts`                                 | Manual capture, batching at 20 events or 2 seconds, content-key filtering                                         | No additional PostHog SDK is needed; normal batching does not guarantee delivery during close  |

Telemetry's master switch and remote reporting default to off. Local logging being enabled does not override the master switch. A reporter must honor current consent at delivery time, including revocation after observers have registered.

## Suggested implementation scope

First implement collection and a scalar adapter. Keep `name`, `id`, `value`, `delta`, `rating`, `navigationType`, sanitized document route, runtime, and app version. Add a document identity for local aggregation. Discard raw `entries`, DOM references, full resource URLs, and attribution payloads. Decide explicitly whether local diagnostic observation is always available or consent-gated; neither policy should silently enable remote reporting.

Deduplicate repeated observations without discarding legitimate metric updates. A bounded latest-value map keyed by document/metric identity can support diagnostics, while the telemetry contract must define whether it sends updates or final values. Backend percentile calculations must account for repeated metric IDs instead of treating updates as independent page visits. Late visibility/pagehide delivery needs a tested flush path through existing transports; do not copy a direct `sendBeacon` example that bypasses Cognia's consent/native egress rules.

A second step can add a separate document-summary panel to the existing performance UI, with explicit supported/pending/unavailable states and dimensionless CLS formatting. Keep document measurements separate from frame time-series data. Attribution and soft-navigation support are separate enhancements requiring explicit package/version selection and additional verification.

## Acceptance checks before implementation is called complete

1. Unit checks for scalar adaptation, correct CLS units, metric updates/deduplication, route sanitization, bounded storage, and consent changes after registration.
2. Integration checks for a stable root mount, no duplicate registration across normal rerenders, and documented Strict Mode/HMR behavior.
3. Verify catalog/category/sampling gates, local-only settings, opt-in remote delivery, revocation, and the native desktop transport path.
4. Production static-export build plus a real browser flow: foreground initial load, interaction, visibility changes, reload, route transition, and BFCache back/forward where supported.
5. Real Chromium and WebKit/WebView capability checks; unsupported or absent observations remain distinguishable from measured zero.
6. Transport verification for late-page lifecycle events; distinguish queued events from acknowledged delivery.

The initial research phase performed source/document inspection only. Implementation verification and its remaining limits are recorded at the beginning of this document.

## Sources

- [Next.js useReportWebVitals reference](https://nextjs.org/docs/app/api-reference/functions/use-report-web-vitals)
- [Next.js 16.3.6 hook implementation](https://github.com/vercel/next.js/blob/v16.3.6/packages/next/src/client/web-vitals.ts)
- [Next.js 16.3.6 dependency manifest](https://github.com/vercel/next.js/blob/v16.3.6/packages/next/package.json)
- [Next.js webVitalsAttribution reference](https://nextjs.org/docs/app/api-reference/config/next-config-js/webVitalsAttribution)
- [Next.js static export reference](https://nextjs.org/docs/app/guides/static-exports)
- [web-vitals v4.2.1 documentation](https://github.com/GoogleChrome/web-vitals/blob/v4.2.1/README.md)
- [web-vitals v5 migration](https://github.com/GoogleChrome/web-vitals/blob/main/docs/upgrading-to-v5.md)
- [web-vitals changelog](https://github.com/GoogleChrome/web-vitals/blob/main/CHANGELOG.md)
