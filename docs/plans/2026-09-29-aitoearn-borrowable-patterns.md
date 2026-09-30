# AiToEarn evaluation and borrowable-patterns roadmap

Researched 2026-09-29. Six parallel investigations covered `yikart/AiToEarn`
(MIT, studied from a local clone at `/private/tmp/aitoearn-src`, main @
~2026-07, 26.5k★) against cognia-next HEAD: connector/OAuth architecture,
agent runtime, MCP surface, publish pipeline, AI generation layer, and
product/distribution mechanics. Every load-bearing claim was verified against
source in **two** passes; the second pass corrected three premises (see
"Corrections").

## Verdict

Borrow **patterns, not code**. AiToEarn is a NestJS+BullMQ+MongoDB server
product; Cognia is a local-first Tauri app. Its transferable value is
cross-cutting infrastructure discipline: a completion-strategy taxonomy, a
durable async-task record with a reconciler, a managed-credential relay model,
and MCP-as-distribution ergonomics. On secrets storage, scheduler semantics,
MCP security, and provider catalog rigor, **Cognia is already strictly ahead**
— do not regress toward AiToEarn's weaker models.

## Verified facts

AiToEarn side (all confirmed at `/private/tmp/aitoearn-src`):

- Per-platform integration = `PlatformIntegration` bag of optional providers
  (`auth|publish|analytics|engagement|browse|work|webhook`) over shared
  metadata/runtime policy — `apps/aitoearn-server/src/core/channels/platforms/
platforms.interface.ts:1019-1032`.
- `PlatformCapabilities` is **derived** from implemented provider methods
  (`platforms.registry.ts:130-187`) — declarations cannot drift from code.
- `CompletionStrategy = Sync|Polling|MediaFinalize|Webhook|UserHandoff`
  (`platforms.interface.ts:9-15`); publish states distinguish
  `Queued/PlatformScheduled/WaitingForUserAction`
  (`enums/publish.enum.ts`). Douyin uses `userAction{schema,shortLink,
expiresAt}` for in-app completion (`douyin-publish.provider.ts:114-129`).
- `AiLog` table = universal durable record for async media tasks
  (channel, remote `taskId`, request, response, status) + 30 s cron
  reconciler (`video-task-status.scheduler.ts`) + webhook/poll dual
  completion + idempotent settle via `updateByIdAndStatus(Generating,…)`.
- Relay: `relayAccountRef` shadow ids; `RelayExceptionFilter` replays the
  identical request to the credential-holding host
  (`relay/relay-exception.filter.ts`). OAuth handoff is browser form-POST to
  a `@Public()` callback — real but bounded (account-list pollution, no
  token theft; tokens never leave the hosted server).
- MCP surface: self-built `libs/nest-mcp` (decorator `@Tool` + subtree
  discovery) serving ~35 product-verb tools at `/api/unified/mcp` behind one
  `x-api-key`; results serialized as YAML; async tools return
  "call getDraftTaskStatus next" hints.
- Checkpoint-resumable batch generation: stage guards on `response.{plan,
imageUrls, mediaIds}` let a queue retry continue mid-pipeline
  (`draft-generation.service.ts:856-1020`).
- Confirmed weaknesses (do not copy): plaintext OAuth tokens in Mongo
  (`oauth2-credential.schema.ts:23-34`); scopeless SHA-1 API keys with
  per-request `lastUsedAt` write (`api-key.service.ts:42-57`); immediate
  re-enqueue retries without backoff (`publish-task.service.ts:164-186`);
  content-safety errors classified retryable
  (`ai-generation-retry.util.ts:7-9`); `AiAvailabilityService` is an
  instrumented no-op stub (`ai-availability.service.ts`, 44 lines); SSE
  sessions keyed by `sessionId` query param only (`mcp-sse.service.ts:106`);
  `expiresIn:'100y'` bootstrap JWT (`scripts/init.mjs:71-75`);
  marketplace/payment/admin services absent from OSS while backend
  `AGENTS.md` documents their serve commands — execution plane is open,
  settlement plane is closed by design.

Cognia side (all confirmed at HEAD):

- `PlatformAdapter.refreshCredentials?()` declared at
  `types/connectors/adapter.ts:308`; 9 adapters implement it; **zero external
  call sites** — but see Correction 1: 7 are deliberate no-ops.
- `meta.capabilities: readonly Capability[]` hand-declared per adapter
  (`adapter.ts:29`, e.g. `SLACK_CAPS`); ~15 of 39 flags in
  `ALL_CAPABILITIES` (`types/connectors/capability.ts:5-64`) correspond
  1:1 to optional methods (`pin↔pinMessage`, `urgent↔sendUrgent`,
  `forward↔forwardMessage`, `chat.*↔createChat/…`, `presence.status↔
setPresenceStatus`); `send.*` flags are NOT method-derivable.
- Outbound errors are classified only by `err.name` in the runner catch
  (`lib/connectors/outbound-runner.ts:1115`); the circuit breaker counts
  every failure alike, including auth failures.
- Credential lifecycle is already strong: secrets in OS keyring
  (`crates/cognia-connectors/src/keyring.rs`), `credentialsRef` holds only
  `{keyringService, accounts}` (`lib/db/connector-types.ts:209-210`),
  credential rotation requeues the adapter (`install-connector-runtime.ts:349`,
  `requeueAdapter` in `lifecycle.ts`).
- Periodic per-adapter infrastructure exists and is isolated:
  `lib/connectors/health/heartbeat-sweep.ts` — one interval,
  `Promise.allSettled` fan-out, running adapters enumerated via
  `listRunningAdapters`.
- `scopedSettings` intersects `_meta.cogniaBridgeScopes` with enabled
  scopes but is consulted only inside per-call `check:` gates
  (`lib/external-bridge/mcp-server/server.ts:102-121`); all tools are
  `registerTool`ed unconditionally → `tools/list` advertises tools the
  caller cannot invoke.
- Media generation has no durable task record:
  `lib/ai/media/provider-generation.ts:287` returns
  `experimental_generateVideo(…)` inline, `fallbackMode:"none"` at `:143`;
  Dexie `CURRENT_SCHEMA_VERSION = 232` contains no media-task table.
- `interruptStaleExecutions` flips orphaned `running/pending` rows to
  `cancelled` at boot (`lib/scheduler/scheduler-db.ts:482-495`) — local-only
  by design for in-process executions.

## Corrections from re-verification

1. **`refreshCredentials` is not a missing sweep — it's a narrow escape
   hatch.** Of 9 implementations, 7 are deliberate no-ops ("all token
   resolvers call fresh on each request" — slack/lark/dingtalk/discord/
   telegram/onebot/matrix). The 2 real ones (qq-official `clearTokenCache`,
   wechat-oa `clearWechatOaTokenCache`) are already invoked by internal
   recovery paths — qq-official OP-9 `onAuthInvalid` (:229) and 401/403
   retry-clear (:296-298); wechat-oa clears on auth failure (:263,:314) —
   and credential rotation restarts the adapter via `requeueAdapter`.
   The real gap is narrower: **auth-class failures are indistinguishable
   from server errors**, so they trip the breaker and never surface a
   "re-authenticate" state to the user. Phase 0 targets that, not a
   periodic refresh sweep.
2. **`interruptStaleExecutions` needs no remote verify today** — cognia
   executions are in-process. The `verifyRemote` hook only matters for
   future executors with external side effects → deferred to Phase 2.
3. **Capability drift check covers only the method-mappable subset**
   (~15/39 flags); `send.*` granularity stays declarative. The check is a
   test-time assertion, not a runtime rewrite.

4. **The error taxonomy already exists — don't add `ConnectorPlatformError`.**
   Errors are classified by `OutboundResult.error.code`
   (`types/connectors/outbound.ts`: `rate_limited | auth_failed |
platform_4xx | platform_5xx | network | validation | …` with `retryable`
   and `retryAfterMs`); every built-in adapter already maps its platform
   errors onto it, `rate_limited` is already kept out of the breaker, and
   `retryAfterMs` already delays the retry. `err.name` is telemetry only.
   A second hierarchy would duplicate this.
5. **Keep feeding the breaker on `auth_failed`.** An open breaker _defers_
   the backlog (no attempt consumed) instead of dead-lettering it job by
   job, which is the better outcome while a credential is broken. The real
   defect was attribution: the UI said "circuit open", never "re-authenticate".
6. **"Call `refreshCredentials()` once, then retry" is redundant.** Adapters
   already refresh and retry once internally before returning `auth_failed`
   (Lark `withTatRefresh`, qq-official / dingtalk 401 retry-clear,
   wechat-oa cache clear); the other 7 implementations are no-ops. Not wired.
7. **Phase 1's premise does not hold today.** No app UI generates video;
   the entry points are the plugin `ctx.media.ai.generateVideo` and the
   provider-operations executor (`lib/ai/operations/handlers/media.ts`), and
   `experimental_generateVideo` polls inside the SDK, so no remote task id
   ever reaches cognia code. The SDK does expose
   `experimental_startVideo` / `experimental_getVideoStatus` (serializable
   `operation`), which is the route if Phase 1 is taken up.

## Implementation status (2026-09-29)

Phase 0 — shipped, reduced to the verified gaps:

- `adapter.reauth_required` audit kind, written by the outbound runner once
  per adapter (until the next successful delivery) for `auth_failed` /
  `identity_reauthorization_required` (`isReauthCode` in
  `types/connectors/outbound.ts`).
- `deriveReauthRequired` (`lib/connectors/health/derive-history.ts`) —
  runner row newer than the last `delivery.success` /
  `adapter.credentials_rotated` / `credential.refreshed`, or the latest
  heartbeat reporting `reason: "auth_failed"`; exposed as
  `useAdapterHealth().reauthRequired`.
- `reauth-required` badge state (top priority) in the inbox badge and the
  Connections status; the badge withholds "Reconnect" (restart can't fix a
  rejected credential) and points to Settings. `auth_failed` is a localized
  health reason; qq-official now reports the code instead of the raw message.
- Bug fixed: the heartbeat sweep no longer re-dials a gateway whose adapter
  reports `auth_failed` (it restarted it on every passive tick).
- Capability ↔ method drift check in
  `lib/connectors/adapters/runtime-contract.test.ts`. It caught OneBot
  stubbing `edit` (returned an error, so edits dead-lettered instead of
  falling back to `send()`) and `setTyping`; both stubs removed.

Phase 1 — shipped as ADR-0205 (video generation runs as durable jobs;
6442e52ea engine, 2dfea8fe3 chat / settings / `/video`, 2f382add3 Files +
`action.media.generateVideo`). The product decision Correction 7 asked for
was taken the other way round: video generation became a first-class
feature, so the durable job table (`mediaGenerationJobs`) serves chat,
workflows and the plugin API through one engine built on
`experimental_startVideo` / `experimental_getVideoStatus`. It diverges from
the sketch below: jobs are video-only, the reconciler is the renderer job
host (boot re-list + poll; no Rust loop, Q2), and materialization folds into
the existing asset stores rather than a new media-library row. Not yet run
against a live provider. Phase 2 / 4 — gated as written.
Phase 3 — deferred: `lib/external-bridge/mcp-server/server.ts` is being
reworked by ADR-0203, whose `tool-result.ts` `executionState: "pending"` +
`continuation` already covers the async polling hint; revisit
`tools/list` scope filtering after that lands.

## Phases

### Phase 0 — connector error taxonomy + auth-failure surfacing

Owner: connectors. The single highest-value borrow.

- Add `ConnectorPlatformError` in `types/connectors/`:
  `{ category: "auth"|"rate_limit"|"permission"|"validation"|"platform"|
"network"|"unknown", retryable: boolean, retryAfterMs?: number,
platformCode?: string, endpoint?: string, cause?: unknown }`. Model the
  per-platform code→policy table on AiToEarn's `policyFromPlatformCode`
  (`platforms/douyin/douyin.exception.ts:143-209`).
- Start with adapters that already parse structured errors: Lark
  (`LarkApiError` carries `retryAfterMs` — `lark/auth-retry.ts:31-62`),
  qq-official (401/403 + INVALID_SESSION). Wrap-throw at each adapter's
  request helper; do not build a parallel error hierarchy per adapter.
- Consume in `outbound-runner.ts`: `category==="auth"` → **do not feed the
  breaker**, mark the adapter `needsReauth` (audit kind +
  `adapter.heartbeat`/health reason), skip the job's generic retry;
  `rate_limit` + `retryAfterMs` → schedule the retry at that delay
  (runner already has deadline-based retry wakes); other categories keep
  current behavior.
- `needsReauth` surfaces in the Connections UI via existing health/audit
  plumbing (i18n keys per Rule 4, en + zh-CN).
- **Capability drift check** (same phase, cheap): a co-located Jest test
  over every registered adapter asserting each _method-mappable_ flag in
  `meta.capabilities` has its method implemented — and vice versa (an
  implemented `pinMessage` without `pin` is also drift). Non-mappable
  `send.*`/`rich-*` flags are exempt by an explicit list.
- Where AiToEarn uses "proactive credential sweep", Cognia's equivalent is
  already covered: per-request resolvers + internal retry-clear +
  `requeueAdapter`. Keep `refreshCredentials()` as the documented escape
  hatch; wire it into the new `needsReauth` recovery path (call it once,
  then retry the failed job once) rather than adding a periodic sweep.

### Phase 1 — durable media-generation tasks

Owner: `lib/ai/media`. Fixes a real data-loss gap: closing the window
mid-generation loses minutes-long video tasks and leaves no history.

- New Dexie table `mediaGenerationTasks` (schema v233 — governed by the
  `dexie-migration` skill; add via `CURRENT_SCHEMA` + bump, upgrade
  callback not needed for a fresh table): `{ id, providerId, remoteTaskId,
request, response, status: "generating"|"success"|"failed"|"unknown",
errorMessage?, createdAt, updatedAt }`. Model on AiToEarn's `AiLog`.
- Per-provider adapter contract (structural, but **declared** this time —
  avoid AiToEarn's N×switch): `{ createFromRequest(req)→{remoteTaskId},
pollTask(remoteTaskId)→CommonResult, extractInput(row)→DisplayInput }`.
- Reconciler: a renderer-side interval (reuses the heartbeat-sweep shape —
  single timer, `Promise.allSettled`) listing `generating` rows →
  `pollTask` → settle once via status-guarded write. Boot sweep re-lists
  `generating` rows: re-poll if the provider supports status query, else
  mark `unknown`. Consider a Rust-side poll loop only if window-closed
  durability becomes a requirement (Q2).
- Result materialization on success: persist bytes → asset store →
  thumbnail → media-library row — all idempotent via a `response.mediaId`
  short-circuit (AiToEarn's `ensureSavedVideoMedia` pattern,
  `video.service.ts:299-378`). Existing `assertSafePrompt` PII gate
  (`provider-generation.ts:97-105`) stays upstream.
- Deliberately does NOT adopt: AiToEarn's immediate-retry loop (use
  `computeBackoffDelay` from `packages/primitives`) and its
  content-safety→retryable classification (treat moderation failures as
  terminal business errors).

### Phase 2 — executor completion strategies (gated on a real executor)

Add only when a connector/scheduler executor with external side effects
lands (e.g., "publish", "reply on platform", mobile handoff). Don't build
the taxonomy into empty space — that would repeat AiToEarn's no-op-seam
mistake (Rule 7).

- `CompletionStrategy`-style field on the executor contract:
  `sync|poll|continuation|user-handoff`, plus run states distinguishing
  "queued locally" / "handed to external" / "awaiting user".
- `verifyRemote` hook consulted before terminal-marking stale executions —
  only meaningful once such executors exist.
- Continuation payload on the execution row so a follow-up delayed run
  resumes instead of restarting (AiToEarn's `dataOption`/`pendingMediaJobs`
  - media-finalize re-enqueue; cognia already has `scheduleRetry`
    machinery to carry it).

### Phase 3 — MCP distribution ergonomics

Owner: `lib/external-bridge`. Cheap, agent-facing quality wins; security
model unchanged (keep verifiers, scopes, session binding — all already
stronger than AiToEarn's).

- Apply the `scopedSettings` intersection at `tools/list` time too, so a
  client only sees tools its credential can call.
- YAML-serialized text content alongside `structuredContent` for
  list-heavy tools (token-cheaper; model on `toYamlTextResult`).
- Async-returning tools embed the polling hint in the result text
  ("…call `task_status` next"), model on
  `draft-generation.mcp.controller.ts:26`.
- When the Phase-2 MCP packaging ships (ADR-0008 `packages/claude-code-plugin`
  plan): copy the installer/runtime npm-package split (`*-cli` npx
  installer + runtime plugin + shared config pkg) and publish `llms.txt`
  from `docs/`/`web/`.

### Phase 4 — managed-credential relay (gated on Q1)

Only if Cognia decides to host OAuth apps so users can connect platforms
without creating developer credentials. Borrow the **shadow-account
indirection** (`credentialsRef` variant carrying an opaque remote ref;
services throw a typed "remote-required" signal; one seam proxies) — do
NOT borrow AiToEarn's security model. Requires its own design doc:
signed callbacks bound to the OAuth `state`/nonce (AiToEarn's `@Public()`

- query-param userId is not acceptable), structured field-level request
  mapping (not string substitution), and the companion relay lane
  (`cognia-companion-connectivity`) as transport.

## Explicitly rejected

- AiToEarn's plaintext token storage, scopeless API keys, SHA-1 hashing,
  per-request `lastUsedAt` writes, SSE-without-credential-binding, 100y
  JWTs — Cognia's keyring + verifier + scope model is strictly stronger.
- String-substitution request rewriting / stringify-substitute URL
  resolution — use structured JSON traversal if ever needed.
- Immediate retries, substring error classification, and
  content-safety-as-retryable.
- Subprocess-per-task + fake-HOME agent runtime + CCR — Cognia's env
  allowlist, warm pool, and gateway tickets are the hardened version.
- ToS-grey engagement automation (auto-like/follow/comment) — the
  browser-session mechanism is interesting, the use case is not.
- The marketplace/settlement plane (CPS/CPE/CPM) — a hosted SaaS economy,
  incompatible with local-first; even AiToEarn keeps it closed-source.
- YAML-file config editing, pm2 restarts, dual-region builds — deployment
  model doesn't transfer.
- A periodic credential-refresh sweep — redundant with per-request
  resolvers + `requeueAdapter` (Correction 1).

## Risks and open questions

- Q1 (gates Phase 4): does the product want managed/hosted OAuth
  credentials at all? Options: (a) never — keep user-supplied credentials;
  (b) optional hosted relay for a platform subset; (c) full managed mode.
  Recommendation: defer until connector demand data justifies it.
- Q2 (Phase 1): renderer reconciler (simpler, dies with the window) vs
  Rust-side polling in `cognia-connectors`/`cognia-jobs` (survives window
  close). Recommendation: renderer first; promote to Rust only if
  long-running video generation becomes a primary flow.
  **Resolved (ADR-0205):** renderer job host; a job the window closed on
  resumes polling at the next launch.
- Q3 (Phase 0): is `needsReauth` a new `AdapterHealthState` or an audit +
  UI flag on the row? Recommendation: health reason + dedicated audit
  kind first (no schema change); add a row field only if the UI needs to
  query it outside heartbeat cadence.
- AiToEarn's `AiAvailabilityService` stub suggests the OSS tree is a
  stripped variant — do not infer their production behavior from it; the
  seam _shape_ (context-carrying instrumentation wrapper) is still a fine
  model for any future cognia availability work.
- The clone predates upstream `main`; re-pull before implementing a phase
  that copies concrete shapes.

## Sources

- Clone: `/private/tmp/aitoearn-src` (main @ ~2026-07-09). Key files cited
  inline; primary: `project/aitoearn-backend/apps/aitoearn-server/src/core/
channels/{platforms,publish,relay,auth}/`, `apps/aitoearn-ai/src/core/
{agent,ai,ai-availability,draft-generation}/`, `libs/{mongodb,nest-mcp,
aitoearn-queue,channel-db}/`.
- Cognia: `lib/connectors/**`, `lib/external-bridge/mcp-server/server.ts`,
  `lib/scheduler/scheduler-db.ts`, `lib/ai/media/provider-generation.ts`,
  `types/connectors/{adapter,capability}.ts`, `lib/db/connector-types.ts`,
  `lib/db/schema.ts` (v232).
