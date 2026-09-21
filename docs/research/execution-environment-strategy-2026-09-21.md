# Execution environment strategy review

Date: 2026-09-21

The input was `run-execution-environments-public.md`. Its examples describe
another execution system; they are design evidence, not instructions or a
feature specification for Cognia. This note concerns Cognia's environment
selection and session binding paths. The separate
[container preparation review](./sandbox-container-preparation-optimization-2026-09-21.md)
covers existing Rust container preparation work and its own validation.

## Which ideas transfer

| Reference idea                                    | Cognia interpretation                                                                                                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate configuration from an allocated instance | Keep project selection, immutable `EnvironmentSpec`, spawn placement and session runtime refs distinct. A catalog page is not an allocation.                                                                                  |
| Refresh bindings before reuse                     | Continue checking mutable connection capabilities at use time. Coalesce identical concurrent preparation only while it is pending; do not cache host catalogs or approvals across turns.                                      |
| Pin identity to a generation                      | In the client runtime, a superseded or released bind loses publication authority even if provider preparation later succeeds or fails. This is process-local coordination, not a replacement for a host/daemon boot identity. |
| Retry by operation semantics                      | Share an in-flight bind and preserve the existing cleanup ledger. Do not add automatic retries to resource creation, execution or resume. Failed cleanup remains available for an explicit release retry.                     |
| Distinguish supported lifecycle capabilities      | Keep Docker pause/resume distinct from stop/start. Keep microVM release with the adapter that owns the resource. A configured provider without an adapter still refuses execution.                                            |
| Pool and schedule expensive resources             | Reuse Cognia's current pool implementation. Distributed admission queues, personal cloud-computer slots and Mac VM/FaaS backends need their own product requirements and measured bottlenecks.                                |

The reference's permissive configuration fallback is not a universal rule.
Cognia's ADR-0182 already differentiates optional infrastructure fallback from
mandatory isolation. An explicit local-container request on an unsupported
host must be refused even when catalog discovery also fails.

## Existing environment boundaries

| Environment or surface               | Existing authority                                                    | Changes and preserved behavior                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop and headless OS execution    | Host profile and the registered OS executor/Tauri command             | Preserve the local fast path, policy ceiling, OS execution and audit ownership; session binds now share pending preparation and obey release ordering.                                                               |
| Paired mobile/browser hosts          | Host profile plus companion execution transport                       | Preserve the host rail; environment reads continue through the existing transport. Complete catalog and approval reads do not introduce cross-host caches.                                                           |
| Standalone Web                       | Host availability and existing renderer policy                        | Do not claim a host executor or a container capability merely because a selection exists. Existing host-profile tests remain part of the regression set.                                                             |
| Project image pool                   | Host catalog, approvals and admission of the sealed spec              | Strict catalog pagination rejects cycles and exhaustion. Run preparation and the settings panel both consume the complete project approval ledger.                                                                   |
| Docker computer-server connection    | Provider adapter, connection capabilities and frozen container policy | GUI and workspace preparation use one connection read. Execution converts seconds to milliseconds and records Docker as the audit provider. Output, errors and truncation flags remain intact.                       |
| E2B microVM                          | Registered adapter, workspace preflight and runtime owner ref         | Identical concurrent binds share one preparation. Replaced and closing owners cannot publish late; abandoned preparation is released and failed cleanup remains retryable. Different sessions proceed independently. |
| Desktop local-container selection    | ADR-0182 host capability                                              | Refuse unsupported placement before catalog/filesystem reads. This change does not enable the dormant desktop image-pool feature.                                                                                    |
| CUA Cloud/Lume compatibility records | Adapter registry and capability matrix                                | Their absent production lifecycle adapters remain explicit. No host fallback or simulated provider implementation is introduced.                                                                                     |

## Concrete regressions and performance checks

- A repeated catalog token previously produced 50 copies of one page and made
  51 requests. It now rejects after two requests. A distinct-token walk that
  exceeds the 50-page budget rejects without fetching an unused page. Neither
  limit returns partial authority data as complete.
- Project approval lookup previously stopped at 200 rows. The shared reader
  walks subsequent pages, preserving project scope and propagating read errors.
  The existing callers retain their established approval-unavailable behavior.
- Two simultaneous identical microVM binds now perform one preflight and share
  one runtime ref. This is an operation-count result, not a production latency
  benchmark. There is no new reuse of completed containers across sessions.
- Bound Docker GUI/workspace preparation previously read the same connection
  twice; it now reads once and checks both required capabilities.
- A 30-second command budget previously reached `cua_sandbox_exec` as `30`
  milliseconds; it now reaches it as `30000`. A nonpositive budget leaves the
  timeout unspecified, matching the existing microVM adapter convention.
- A release waits for pending binds and their cleanup. Both a late successful
  preparation and a late provider error yield a retired-binding error; their
  caller's fallback cannot replace a newer active generation. Cleanup failures
  are retained for retry, and a later bind can recover after successful release.

These changes extend existing production modules. They add no scheduler,
provider, queue, user-facing setting or parallel environment registry.

## Validation boundaries

Final ordinary regression run: **14 suites, 286 tests passed**. This includes
the five changed modules' co-located suites plus environment placement,
declaration resolution, binding, connection lifecycle, lifecycle capabilities,
microVM registration, spawn placement and agent host/execution routing.
Scoped ESLint, Prettier and diff whitespace checks passed.

Regression tests exercise production resolvers, lifecycle dispatch and Docker
adapter calls with injected provider/transport boundaries. They do not establish
live E2B, live Docker, deployed Headless, paired-device or rendered UI acceptance.
Cleanup still depends on the provider settling its operation; cancellation here
revokes publication authority rather than promising remote cancellation.

The repository-wide coverage command encountered existing failures in
`components/desktop/desktop-chat-workspace.test.tsx`, including missing
`clearActiveSession` and `requestChatHome` mocks, and was stopped after those
failures. The full TypeScript command exhausted its 4 GB V8 heap (exit 134).
A narrower TypeScript program including the changed source and tests completed
with no diagnostics in those files, but reported four errors in imported
attachment/PDF modules. None of these results establishes a passing global gate.

At the user's request on 2026-09-21, coverage checks were stopped and skipped
for final verification. No passing coverage threshold is claimed.
