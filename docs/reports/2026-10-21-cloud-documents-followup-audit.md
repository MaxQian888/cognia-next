# Cloud document follow-up audit: Google Workspace and Feishu

Date: 2026-10-21. Scope: current checked-out source, existing tests, deterministic local probes, and Google primary API documentation. No private Google/Feishu document was accessed or modified. The initial audit was read-only; the subsequent authorized repair and its validation are documented below.

Evidence ledger: [2026-10-21-feishu-document-support-audit.md](../evidence/2026-10-21-feishu-document-support-audit.md).
Earlier Feishu fixes: [2026-10-21-feishu-document-support-audit.md](2026-10-21-feishu-document-support-audit.md).

**Repair status (2026-10-22):** The seven earlier findings and the Google cross-window lifecycle races are repaired locally for callers sharing one owning host. The new host controller replaces the former single-renderer ownership boundary. See the cross-window repair below for exact tests and remaining native/provider acceptance limits.

## 2026-10-22: Google cross-window repair

The original module counters did not coordinate independent WebViews. Four separately loaded-module probes reproduced stale refresh success, stale OAuth completion, stale invalid_grant clearing a newer account, and an unrelated settings save restoring connected metadata. One duplicate-claim case already passed. Evidence: `.cache/google-cross-window/red.log` (4 failed, 1 passed).

Renderer Web Locks were rejected after independent review: closing a WebView can release its lock while a dispatched native secret write or revoke continues, and a separate singleton settings writer can bypass a Google-only lock. The repair puts ownership below the renderers:

- `crates/cognia-connectors/src/google_docs_auth.rs` stores tokens, pending authorization, account metadata and UUID generations in one encrypted record. Conditional transitions reject obsolete callbacks, refreshes and invalidation. Pending claims are consumed once. Legacy keys migrate once and cannot repopulate a persisted disconnect tombstone.
- Disconnect registers with the host, captures its revoke candidate and clears the local record atomically. Its bounded native job survives a dropped renderer waiter. Begin waits for every registered disconnect/revoke, including overlapping failure paths; it cannot erase a token before a queued disconnect captures it. The local reload signal is emitted before waiting on Google HTTP.
- `auth.ts` pins refresh to the caller's original host snapshot and keys singleflight by native connection generation as well as the local cancellation version. Successful login advances the authorization generation, including when refresh began during consent. A later account's tokens cannot be substituted into an older operation. Begin rechecks the pending generation before returning a consent URL.
- `config.ts` reads connection readiness from the host. AppSettings remains the preference/legacy projection, so a late unrelated save cannot restore an authoritative connection. Native and internal-service mutations publish a signal without tokens, PKCE or account data.
- `state.ts` is the selected-host IPC boundary. Tauri registration, main-window ACL, canonical companion command/request/response schemas, generated admission table, service dispatch and the service-only event catalog are wired. Authority matches the existing internal secret-store commands; ordinary paired-device credential permissions are unchanged.

Additional red cases exposed and repaired a stale consent URL, account substitution during pending login, a delayed initial snapshot selecting the new account, and cross-account reuse of an in-flight refresh. Evidence: `consent-red.log`, `account-generation-red.log`, `account-generation-native-red.log`, and `refresh-owner-red.log` under `.cache/google-cross-window/`. The offline frontend port mirrors native token validation and rejects unsupported record versions; actual Rust controller tests own the concurrency evidence.

| Verification                        | Observed result / artifact                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document regression suite           | 55 suites / 738 tests passed after the final snapshot/singleflight fix, `broad-tests-final.log`; 19 cases added in this follow-up.                                                                                                                                                                                                                    |
| Actual Rust owner and event catalog | 15 controller tests plus 1 service-only event-channel test passed, `.cache/google-cross-window/native-final.log`. Includes renderer waiter loss, overlapping revokes, before-capture ordering, storage failure/recovery, persisted restart fence, migration and bounded HTTP classification.                                                          |
| New internal-service dispatch tests | Added admission and actual dispatch/signal regressions. Standalone execution could not finish: an earlier dependency compile reported ZIP API errors; the final attempt exhausted disk while compiling dependencies (`rpc-tests.log`, `rpc-final.log`). No passing RPC-test claim.                                                                    |
| Full Tauri unit suite               | 1,022 passed, 7 failed, 1 ignored (`tauri-unit-final.log`), before the final lineage refinement; focused owner tests were rerun afterward. Failures: canonical Claude event forwarding, reachability setup restoration and five output-registry checks for other commands. The Google command is absent from the reported missing/mismatched entries. |
| Actual macOS Tauri seam             | Agent-debug helper v3, main window: object snapshot, deliberately mismatched claim rejection, empty reload event, unchanged connection/authorization; no credentials printed (`native-smoke.log`, `tauri-status.json`). This probe preceded the final refresh-lineage refinement, which is covered by the final Rust/Jest regressions.                |
| Adjacent native surface             | Workflows navigation timed out. After interruption, console/network capture could not reach the old endpoint. The tracked debug session was stopped (`tauri-stop.log`); this is not a complete native smoke pass.                                                                                                                                     |
| Root gates                          | Final lint and scoped format passed; i18n lint/sort, co-located tests and companion generation/check passed. Typecheck: 21 errors in 8 unrelated files. Static export: 3 existing Node imports. Rust architecture: 2 unrelated siwc module findings.                                                                                                  |

Scope: independent clients sharing one host process. Local generations survive restart; an interrupted provider revocation's remote outcome is not certified across host-process death. No real Google grant, account or private document was accessed. Complete native UI/provider acceptance and the new standalone RPC tests remain open; no coverage run or commit was made. Only regenerable build caches/completed executables from this run were removed under disk pressure; source, dependency packages and evidence were retained.

## Current Google support

Google Workspace has an actual read-only document provider, rather than only a placeholder or backup integration.

| Capability     | Current implementation                                                                                                                                     | Boundary                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Chat entry     | `@gdoc:` search/link picker → fetch → normal composer attachment → citation                                                                                | The body is a snapshot; there is no cloud document subscription                                        |
| Google Docs    | Drive Markdown export, falling back to plain text on HTTP 400; name lookup for pasted links                                                                | No native editor, create/update/comment tools, or structured Docs API reader                           |
| Google Sheets  | All selected visible worksheets read through Sheets batchGet, rendered as sectioned CSV                                                                    | At most 10 worksheets, 500 rows and 50 columns per worksheet; hidden tabs skipped                      |
| Search         | Drive `name contains`, most recently modified first; Shared-drive flags included                                                                           | Name matching, not document-body full-text search; no paging beyond requested result window            |
| Account setup  | Own Desktop OAuth client id and client secret, system-browser consent, loopback callback, PKCE/state/TTL, keyring tokens and automatic near-expiry refresh | One connection/account (`default`); independent from Google Drive backup                               |
| Platforms      | `hosts: ["tauri"]`, with explicit unavailable states elsewhere                                                                                             | No direct reader route from standalone web, mobile/cloud companion or headless                         |
| URLs           | `docs.google.com/document/d/…` and `spreadsheets/d/…`, including `u/<n>` forms                                                                             | Slides, Forms, generic Drive file URLs and bare ids intentionally rejected                             |
| Intake safety  | Same attachment redaction, untrusted-text wrapper, token policy and citation path as other attachments                                                     | This audit is not a complete security certification                                                    |
| Size           | Provider clamps the received body to 200,000 characters with a visible marker                                                                              | Drive export additionally has its own 10 MB upstream limit; no structured Docs fallback is implemented |
| Twin ingestion | No dedicated Google source type found in the Twin add-source path                                                                                          | Current Google provider is wired to chat; Twin has its separate Feishu source entry                    |

Source: `lib/docs-providers/providers/google/{index,api,auth,config,url}.ts`, `lib/docs-providers/limits.ts`, `hooks/chat/use-remote-doc-staging.ts`, `components/chat/composer-popover.tsx:654`, `components/twin/add-source/add-source-flow.tsx:37`.

The configured `documents.readonly` scope is described as supporting a Docs API fallback in `config.ts`, but this provider contains no `documents.get` implementation. Its actual fallback is another Drive export using `text/plain`. Rich objects, comments and Google Docs tab structure are not independently handled or validated.

## Remaining confirmed issues

### F5 — Feishu CLI source ingestion silently accepts truncated process output (P1)

`runLarkCliProcess` exposes `truncated` when the output cap is hit. `execLarkCli` checks exit status, timeout and binary discovery but drops the truncation flag. The ingestion normalizer accepts raw strings, so partial stdout can be staged as if it were the full document.

A deterministic probe supplied `{stdout:"# Partial document", exitCode:0, truncated:true}` through the actual executor and fetcher. The executor returned `status:"ok"`; ingestion returned the partial body without any truncation field. No real large document was fetched. The existing 1 MB capture cap makes this a relevant large-response failure path.

Source: `lib/skills/built-in/lark/process.ts:93`, `exec-lark-cli.ts:130`, `lib/twin/ingest/lark-doc-fetcher.ts:313,335`.

Suggested repair: fail closed or propagate explicit truncation metadata before treating stdout as a complete ingest source. Add a process-to-executor-to-ingest regression, including truncated JSON and Markdown.

### G1 — An in-flight refresh writes credentials back after Disconnect (P1)

The refresh function loads the refresh token, sends HTTP, then saves its response without checking whether the connection was disconnected in between. Disconnect clears the keyring and connected flag, but has no generation/in-flight invalidation.

A probe suspended refresh at HTTP, disconnected, confirmed the local tokens were gone, then released the refresh response. Tokens reappeared while settings remained `connected:false`. The real `getGoogleAccessToken()` then returned the restored access token.

This proves local credential/state resurrection. It does not prove that a token remains accepted by Google after successful remote revocation; the provider HTTP responses were fixtures.

Source: `lib/docs-providers/providers/google/auth.ts:270,291,358,366`.

Suggested repair: serialize token lifecycle changes or use a connection generation checked before every credential/state commit; invalidate in-flight refresh on disconnect.

### G2 — Pending OAuth can reconnect after Disconnect (P1)

Disconnect clears tokens/settings but does not clear pending OAuth. A later callback with that still-valid state exchanges the code and writes a connected state again.

The probe created a pending authorization, disconnected, verified pending state survived, then completed that callback. Credentials and `connected:true` reappeared. Trigger requires a pending authorization concurrently with disconnect; this is a lifecycle race, not every disconnect.

Source: `lib/docs-providers/providers/google/config.ts:115`, `oauth-pending.ts`, `auth.ts:232,358`.

Suggested repair: invalidate pending/in-progress authorization on disconnect, including callbacks already exchanging a code; use the same connection-generation boundary as G1.

### G3 — Settings do not refresh after successful authorization (P2)

`GoogleDocsRow` reads settings only in a mount effect. OAuth completion updates persisted settings; the deep-link router displays a toast without notifying this row. A mounted settings card therefore continues to say “Not connected” until remount.

A jsdom probe rendered the real card, changed the mocked persisted settings to connected, rerendered the same card, and verified there was only one settings read and no Disconnect button. This is a real component + settings-boundary reproduction; actual native OAuth was not exercised.

Source: `components/settings/connections/docs-providers/docs-providers-card.tsx:181-192`, `components/connectors/connector-deep-link-router.tsx:174`.

Suggested repair: subscribe to connection-state changes or re-read after provider completion, with a callback-to-mounted-card integration test.

### G4 — Revoked authorization leaves a false “connected” state (P2)

On `invalid_grant`, refresh throws `notAuthorized` but leaves tokens and `settings.connected` unchanged. The provider lists accounts solely from that flag, and a card mounted as connected hides its connect form. The error text can ask the user to reconnect while the state still exposes the connected-only controls.

The lifecycle probe verified `connected:true` after a fixture `invalid_grant` response. This is a local-state defect; no Google grant was revoked during this audit.

Source: `auth.ts:283-289`, `providers/google/index.ts:69-72`, `docs-providers-card.tsx:261`.

Suggested repair: distinguish terminal authorization failure from transient HTTP/network errors, update connection readiness on terminal failures, and expose a working reconnect action.

### G5 — Drive quota HTTP 403 is reported as a permission failure (P2)

The mapper recognizes quota exhaustion only via `error.status === "RESOURCE_EXHAUSTED"`. Google's documented Drive response also uses `error.errors[].reason:"userRateLimitExceeded"` with HTTP 403 and no such status field. That exact documented shape produces `noPermission` in the real mapper.

This sends the user toward permission changes rather than quota recovery. The probe uses the primary-documentation response shape; no real quota was exhausted.

Source: `lib/docs-providers/providers/google/api.ts:44-58`. Primary reference: [Drive error handling](https://developers.google.com/workspace/drive/api/guides/handle-errors#userRateLimitExceeded).

Suggested repair: inspect Drive error reasons as well as the canonical status; retain permission errors as a separate category.

### G6 — Google API calls ignore the supplied cancellation signal (P3)

The provider passes `opts.signal` into `GoogleApiContext`, but API calls do not forward it to HTTP; `GoogleHttpRequest` has no signal field. A pre-aborted search still invokes the supplied HTTP transport and resolves. UI stale-result suppression exists separately and is not equivalent to cancelling the underlying request.

Source: `providers/google/index.ts:81-86`, `api.ts:37-40,71-77`, `http.ts:20`.

Suggested repair: propagate cancellation through both native and fetch transports, or explicitly narrow the public cancellation contract where native cancellation is unavailable.

## Existing Feishu residuals

The previous four repairs still pass their regression tests. Separate previously recorded gaps remain:

- The default connector OAuth flow is primarily IM-scoped; an enabled IM connection is not proof of usable document-search consent.
- CLI auth reads the stored user token without the API reader's refresh/retry wrapper.
- Image append-and-move remains a multi-call operation with a crash/lost-response uncertainty window.
- No real-account/native application acceptance has been performed.

This follow-up adds F5; it does not claim the existing tests covered large-process-output completeness.

## Verification and evidence

1. Existing repository tests:

```sh
pnpm test --runInBand lib/docs-providers lib/skills/built-in/lark/doc.test.ts lib/twin/ingest/lark-doc-fetcher.test.ts lib/twin/ingest/lark-url.test.ts hooks/chat/use-remote-doc-search.test.tsx hooks/chat/use-remote-doc-staging.test.tsx components/settings/connections/docs-providers/docs-providers-card.test.tsx
# 27 suites passed; 393 tests passed.
```

Log: `.cache/feishu-document-audit/google-followup-tests.log`. Existing UI tests emit React `act(...)` warnings.

2. Additional OAuth/component probes:

```sh
pnpm test --runInBand --runTestsByPath .cache/google-oauth-audit/lifecycle.test.ts .cache/google-oauth-audit/settings-state.test.tsx
# 2 suites passed; 4 probes passed.
```

These assertions deliberately confirm bugs G1-G4. They are not evidence that these defects are fixed. Log: `.cache/google-oauth-audit/final-probes.log`. Review was independently delegated for the OAuth/setup path.

3. API/ingest probes:

```sh
node .cache/feishu-document-audit/google-followup-probes.cjs
```

Exit 0. The actual source is transpiled and loaded with fake external dependencies. Probe results in `google-followup-probes.json` confirm F5, G5 and G6. This validates local control flow only.

No coverage, full build, whole-repository typecheck/lint, browser interaction, native OAuth or real-provider acceptance was run in this documentation-only follow-up. Prior root-gate failures are historical evidence in the earlier ledger/report and were not rechecked here.

## Recommended repair order

1. Couple disconnect, refresh and OAuth completion under one connection lifecycle boundary (G1/G2), then test both in-flight races.
2. Stop silently ingesting truncated CLI output (F5).
3. Make connected/reconnect UI follow actual authorization state (G3/G4).
4. Correct Drive error classification (G5); then wire cancellation and validate large-document/tab limits (G6 and capability boundaries).
5. Complete a user-selected test account/document flow in real Tauri.

## Sources

- [Google Drive export formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats): Markdown is a supported Google Docs export MIME type.
- [Drive download and export guide](https://developers.google.com/workspace/drive/api/guides/manage-downloads): `files.export` has a 10 MB exported-content limit.
- [Drive error handling](https://developers.google.com/workspace/drive/api/guides/handle-errors#userRateLimitExceeded): legacy quota 403 response reason.
- [Google Docs document structure](https://developers.google.com/workspace/docs/api/concepts/structure): document tabs are distinct content containers; this provider does not use the structured Docs API.

## Authorized repair and verification — 2026-10-21

The user authorized all seven findings after this audit. F5 and G1-G6 are repaired within the local control-flow scope below. The earlier audit sections retain the original observations; their bug-confirmation cache probes are historical evidence, not the acceptance tests for these repairs.

| Finding                       | Resulting behavior                                                                                                                                                                                                                                                               | Regression evidence                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| F5 — silent Feishu truncation | Any process `truncated` result fails before JSON/text parsing. Ingestion reports bilingual `larkOutputTruncated` and creates no partial source.                                                                                                                                  | Both Markdown and partial JSON exercise the real process port → executor → fetcher path.                                          |
| G1 — refresh after disconnect | Disconnect synchronously invalidates credential work, then clears local state before revocation. A stale refresh cannot commit or successfully return after disconnect.                                                                                                          | Deferred refresh plus disconnect; token/settings writes crossing disconnect; stored token remains absent after cleanup completes. |
| G2 — pending/late OAuth       | Begin supersedes the old pending attempt; a matching callback claims it once before exchange. Mismatched error callbacks preserve the current attempt. Disconnect cancels pending state and exchanging callbacks.                                                                | Exchange/metadata/pending/settings delays, duplicate callback, newer begin, cleanup failures and successful reconnect.            |
| G3 — stale settings UI        | Committed settings notify mounted subscribers. A slow initial read cannot replace a newer event. Disconnect failures show a localized toast and retain an honest busy label.                                                                                                     | RTL observer/unsubscribe/read race and storage-error tests; actual card/browser fixture transitions.                              |
| G4 — revoked grant readiness  | Current `invalid_grant` removes credentials and marks disconnected; transient failures preserve credentials. Stale failures cannot remove a new connection or cancel a newer pending auth.                                                                                       | Real config/pending/keyring-port integration cases.                                                                               |
| G5 — quota classification     | Drive reason-array quota errors map to `rateLimited`; permission errors remain `noPermission`; malformed reason entries do not crash mapping.                                                                                                                                    | Canonical reasons, permission case and malformed error payloads.                                                                  |
| G6 — cancellation contract    | Pre-aborted work sends no document request; provider callers stop waiting for shared token acquisition; query cleanup aborts its signal. Fetch aborts I/O. After native dispatch, cancellation releases the caller and discards its late result; native I/O retains its timeout. | Provider/API/HTTP/hook regressions, including a stalled token resolver and native bridge.                                         |

Independent adversarial review found additional interleavings during implementation: completion cleanup could erase the revoke candidate; keyring snapshot/delete failures could skip other cleanup; and `Promise.all` could release the revoke barrier early when another disconnect rejected. Each received a failing regression before correction. The revoke barrier now uses `allSettled`; local cleanup attempts are independent and storage failures are reported. Completion preserves the token needed by an already queued disconnect.

The new co-located `auth-lifecycle.test.ts` keeps real config, pending storage and auth together. Existing `auth.test.ts` mocks config/pending APIs, so it cannot establish their persistence interaction. Only database, keyring and HTTP boundaries are replaced in the integration fixture.

### Validation

- **Regression tests:** 52 suites, 719 tests passed, including 49 added cases. `.cache/feishu-document-audit/repair-final-tests.log`.
- **Red evidence:** 26 initial failures; 5 additional storage/revoke/provider-abort failures; 3 UI/error-shape failures; 1 overlapping-revoke barrier failure. Corresponding `repair-*-red.log` files remain under `.cache/feishu-document-audit/`.
- **Quality gates:** root `pnpm lint`, `pnpm audit:colocated-tests`, `pnpm i18n:build`, `pnpm i18n:build:check`, `pnpm lint:i18n`, and scoped Prettier validation. No coverage command was run.
- **Browser fixture:** `agent-browser` drove the actual card and OAuth/config implementation with memory DB/keyring and fixture HTTP. OAuth completion updated the mounted card, disconnect immediately removed the account display while showing disabled `Disconnecting…`, reconnect completed, and `invalid_grant` returned it to Connect. Snapshots and inspected screenshot are under `.cache/feishu-document-audit/browser-harness/`. The harness does not load production app styling and does not establish native or real-account acceptance.
- **Independent reviews:** lifecycle counterexample review; co-located-test/wiring review; PII/i18n review. Concrete findings were repaired and tested. No new LLM/embedding/connector auto-send path or weakened confirmation gate was found.

### Remaining verification limits

`pnpm typecheck` reports **21 errors in 8 unrelated files**: `cli/src/runtime/external/node-backend.ts`, `lib/claude/build-options.ts`, `lib/claude/build-options.test.ts`, `lib/claude/provider-attempt-options.test.ts`, `lib/claude/subagent-importers/pi.test.ts`, `lib/plugin/agent-sdk/dispatch.test.ts`, `packages/agent-pi/src/subagent-models.ts`, and `scripts/smoke/builtin-agent-budget-live.ts`. No diagnostic names an owned repair path. Log: `repair-typecheck.log`. The chained sidecar check did not run after root failure.

`pnpm lint:static-export` still fails on three unrelated imports: `lib/browser/extension-engine.ts:450` (`node:fs/promises`) and `lib/plugin/core/builtin-artifact-fixture.ts:15-16` (`node:fs`, `node:path`). Log: `repair-static-export.log`. Full app build and native shell acceptance were not run; these gates are not represented as green.

The lifecycle guarantee proven here is the settled local state of one credential-owning renderer. Module versions/queues are not a cross-WebView coordinator, and keyring plus IndexedDB is not an atomic transaction. If storage cleanup itself fails, disconnect rejects and the UI reports that failure; session cancellation blocks stale callbacks until a new begin succeeds. Crash recovery after failed cleanup and concurrent windows require separate shared-owner/CAS verification. Real Google grant validity/revocation, native OAuth redirects, and real Feishu/Google document reads still need an explicit test account/document. No real account or document was mutated in this repair.
