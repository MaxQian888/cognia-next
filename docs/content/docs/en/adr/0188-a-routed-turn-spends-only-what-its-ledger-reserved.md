---
title: "0188 — A routed turn spends only what its ledger reserved"
description: "Router + Fusion brings the router_fusion spec into cognia-next's model routing as an opt-in subsystem. An action router picks a mode per turn; a call ledger reserves every model call before it is sent and settles it from reported usage; runs, attempts and money live in a separate per-account database with an outbox. Off by default, off means the existing code runs untouched, and an infrastructure fault falls ordinary traffic back to the original path. B1 ships chat as a direct run, B2 the ledgered utilities, the gateway Run API and the companion RPC, B3 cascade, panel, the cognia/* models and the action catalog editor, B4 delegate with sandboxed acceptance and approvals, B5 the LLM classifier, Agent/Squad/workflow action choice and the live smoke, B6 routing experiments with a shadow-only learned router. B7 is planned."
---

# ADR 0188 — A routed turn spends only what its ledger reserved

**Status:** Accepted — B1 (chat as a direct run), B2 (utilities, gateway, cockpit, companion RPC), B3 (cascade, panel, `cognia/*` models, action catalog), B4 (delegate), B5 (LLM classifier, action choice, live smoke) and B6 (routing experiments, shadow router) implemented; B7 planned
**Date:** 2026-09-16
**Related:** [ADR-0043](./0043-llm-provider-execution) (the provider routing engine this sits on top of), [ADR-0125](./0125-durable-work-submission) (durable send and replay), [ADR-0169](./0169-one-runtime-one-review-one-control-machine) (run control and the `executionRuns` projection), [ADR-0059](./0059-cloud-deployment-headless-brain) (the headless brain)

## Context

Every send already routes through `ProviderRoutingEngine.planRoute` (`packages/provider-routing`, called from `lib/claude/build-options.ts`), and the Rust gateway has its own planner. That router picks one deployment for one turn. The router_fusion spec (DESIGN.md, contracts, 79 P0 acceptance cases) asks for more:

- a mode per turn: `direct`, `cascade`, `panel` or `delegate`;
- a reserve-then-settle budget ledger in integer microusd;
- a call-attempt state machine and durable step replay;
- a spec-shaped `RouteDecision` for every run.

Several existing behaviours break the spec's invariants:

- the Claude Agent SDK's silent `fallbackModel`;
- a soft cost cap that only warns;
- hidden AI SDK and CLI transport retries;
- the content-policy fallback chain in `lib/claude/routing-fallback.ts`;
- an unledgered gateway candidate walk.

The spec assumes a standalone multi-tenant service (Python, Postgres, Redis, LangGraph). cognia-next is a desktop app with a TypeScript brain, Dexie and a Node sidecar. The change also touches the path every user sends through, so it must not be able to break normal work.

## Decision

### Opt-in, and off means untouched (D36–D37)

`AppSettings.routerFusion` has a master switch plus one switch per surface: `chat`, `gatewayRuns`, `gatewayPassthroughLedger`, `agentsWorkflows`, `utilityLedger`, `companion`. Every switch defaults to `false`.

- Shared modules reach Router + Fusion only through `lib/router-fusion/gate/*` and the zero-import leaf `@cognia/router-fusion/settings/switches`. Everything else loads with a dynamic `import()` after the gate says `on`. `scripts/gates/check-router-fusion-gate.mjs` (`pnpm audit:router-fusion-gate`) fails any static import of the engine or a host module from a shared file.
- With a switch off, the send options carry no `ledger` stamp. The sidecar's ledger paths key on that stamp, so `fallbackModel`, default retries, the step chunking and the legacy cost gate are exactly what they were.
- The legacy-Auto migration (D31) runs only on first enable. It turns the Auto ladder into an enabled `economy_simple` rule row (provenance `migrated_legacy_auto`), turns `maxCostPerRequestCents` into the direct run cap, and keeps the previous `autoRouting` so the settings pane can restore it in one click.

### Fault isolation (D38)

An infrastructure fault is a fusion-database error, a failed module import, a renderer that does not answer a reservation, or an internal exception.

- **Ordinary traffic** (a direct chat turn) completes on the original, unledgered path. The message shows a "Not ledgered" badge, and the send carries `routerFusionBypass`.
- **Breaker.** Consecutive faults on a surface (default 3) trip it. It stays on the original path until the user re-arms it in settings. The trip is persisted in `trippedSurfaces` and announced once.
  - On `chat` the breaker counts faulted turns. Success is recorded only when a turn seals with no fault anywhere in it (`finishRouterFusionChatTurn`). Run creation and the seal no longer reset the count (`runOrdinaryWithFallback` with `recordSuccess: false`), so a fault in the middle of a turn counts too.
  - The settings pane shows a live trip on every surface, read from the breaker as well as from the persisted row.
- **Bypass notice.** A background utility, an Agent completion or a workflow node has no message to badge. Its bypass is raised as the `routerFusionBypassed` diagnostic (`gate/bypass-diagnostic.ts`), once per surface per app session, and not only logged.
- **Explicit fusion work** (cascade, panel, delegate, `/v1/runs`, `cognia/*` models, arriving from B2 on) fails explicitly. It is never faked.
- **Refusals are not faults.** A budget, limit or deadline refusal is refused and explained (`routerFusion.refusal.*`), and never bypassed.

### One engine package, one ledger writer

- **`packages/router-fusion`** is zero-`@/` and pure. It holds:
  - vendored contracts with zod mirrors and a parity test;
  - the run and call-attempt state machines generated from `state_transitions.json`;
  - microusd money and usage normalization with mutually exclusive buckets;
  - the ledger planner;
  - the config compiler and action hash;
  - the rules classifier and action router, which emits a full `RouteDecision`;
  - the `direct` workflow graph (first hosted by the Run API in B2; a B1 chat turn is a direct run whose model loop stays in the sidecar), verify profiles and the deterministic Fake Provider;
  - the acceptance registry.
- **`lib/router-fusion/db/ledger-store.ts`** is the only writer of money. Each mutation runs one planner step inside one IndexedDB read-write transaction over exactly the stores it touches, so concurrent run creation (BUD-01) and concurrent call admission (BUD-10) serialize without an in-memory lock.
- **Ledger rules.**
  - No reservation means no dispatch.
  - Every ledger row has a deterministic dedupe key (BUD-03).
  - A dispatched call with no answer becomes UNKNOWN and keeps its money held.
  - Overspend is booked in full and freezes the run (BUD-09).
  - Finalize and cancel race inside the transaction, and exactly one wins (REC-04).
  - A stale worker is fenced by its token (REC-02).

### Chat as a direct run (B1)

- **Seal.** `resolveSendOptions` seals the route last, for the provider, model and credentials the send really carries. It stamps `SendOptions.ledger` and `routerFusion` and deletes `fallbackModel`. Only the chat controller opts in (`dispatch.routerFusionSurface === "chat"`, desktop only). Remote-session and host-state sends never stamp.
  - The controller decides host-state eligibility before it builds the options (`hostStateSendEligible`, `hooks/chat/host-state-send-eligibility.ts`) and passes `routerFusionHostState`, so `resolveSendOptions` neither selects fusion nor seals such a turn.
  - A turn that was sealed anyway is always dispatched locally, never handed to the host, so its run is created.
- **Run creation.** `prepareRouterFusionSend` creates the run right before dispatch. It takes the fusion session lock and the tenant hold, which is reserved against the existing `costBudget` remainder (D22). A durable replay or a reused send reseals as a new run on the same deployment.
  - A reseal (retry, reroute, durable replay) routes on the original turn's routing inputs, carried in the renderer-only `SendOptions.routerFusionRouting` (stripped before IPC), and on the lane from the stamp, never a guess from the provider.
  - Options frozen by an older build carry no routing inputs. They go out unledgered with the notice `routing_inputs_missing`, which is not a breaker fault.
- **AI SDK lane.**
  - `perLegCap = 1` and `maxRetries: 0`.
  - Before each leg the sidecar sends `call_reserve_request` and waits for the renderer's `claude_call_reserve_decision` (30 s, then a bypass).
  - After the leg it reports `call_attempt_result` with the provider's usage and the semantics of that report.
- **Claude Agent SDK lane (envelope mode, D34).**
  - `CLAUDE_CODE_MAX_RETRIES=0` and no SDK fallback model.
  - The stage envelope is reserved up front.
  - Each assistant `message.id` is settled.
  - `api_retry` is recorded as a failed attempt.
  - Every tool use re-checks the run through a PreToolUse hook.
  - The card labels the result "estimated cap" (`estimatedCapEnvelope`), a line separate from the unaudited-price notice.
- **Sealing the run.** A run seals at the turn's `result`, not at `session_ended`, because goal, loop and steer continuations start the next run first. `session_ended` seals a turn that produced no result, and `sidecar_exited` seals every registered turn. Because the AI SDK lane emits a success `result` even when its last leg failed, a failed final leg downgrades the run to failed (`CALL_FAILED`).
- **Reroutes (D5).** A cross-provider retry is a new, ledgered run, at most 2 per turn (`MAX_LEDGERED_REROUTES`), and only before anything visible was committed. The content-policy chain is off for ledgered turns.
- **Budget gates (D35).** The legacy `enforceCostBudget` is skipped for a stamped send, and runs again if the send ended up bypassing. A durable replay that falls back to unledgered re-runs it too, and fails with `cost_budget_exceeded` (`lib/work-submission/stored-chat-dispatch.ts`).
- **Money shown once.** The chat usage row is keyed by the assistant message with `costSource: "ledger"`, and its cost is the run's settled `spentMicrousd`. Non-chat surfaces project their usage rows through the outbox instead.
- **UI.**
  - `RouterFusionRunCard` renders `MessageRunMetadata.routerFusion` under the assistant message: action, mode, rule, model, lane, budget, cap, cost and cost status, calls, overspend, frozen, and the `schema_only` acceptance label.
  - The routing settings pane gains a collapsible "Router + Fusion" card:
    - master and surface switches (as shipped in B1, dormant surfaces showed "Later release"; since B2's companion RPC none is dormant);
    - breaker state with re-arm;
    - budget mode, run caps and the unknown-price reserve;
    - data class and restricted grants;
    - rule rows with provenance;
    - the migration notice and restore.
  - **Refusals are sentences.** Every code the chat path can surface has a sentence in both locales (`CHAT_SURFACED_CODES` in `gate/refusal-diagnostic.ts`, pinned by its test), `CALL_FAILED` included.
- **Boot.** `RouterFusionInitializer` restores persisted breaker trips. While chat is on, it seals the runs a closed window left holding a lock or a hold, and runs retention daily. Recovery always drains pending outbox effects, not only when it recovered a run: a window that sealed its run and closed before the drain left effects no later seal would apply.

### Utilities, the gateway and the cockpit (B2)

- **Every generation is ledgered (D27).**
  - `gate/utility-ledger.ts` wraps an `LlmClient` so each background call becomes a session-less run: conversation titles, memory, the `/goal` judge, and workflow `ai.prompt` nodes.
  - The wrapped client forces `maxRetries: 0`, so a retry is a new, visible reservation rather than a hidden second bill.
  - Utility calls sit on `utilityLedger`, and workflow nodes on `agentsWorkflows`.
  - Since B5 the ledgered set also covers `ai.prompt` v1 and v2 (explicit and routed), `ai.council`, the `/council` slash command, `ai.classify` / `ai.extract`, and the completion rail of `ai.ensemble`.
  - Workflow nodes, Agent runs, auto-compose, plan and goal nodes, team-ops and scheduler replan book on `agentsWorkflows`. `/council` books on `utilityLedger` with origin `chat`.
  - Each routing attempt is its own reservation with `maxRetries: 0`. A candidate the ledger refused is skipped, and when every candidate was refused the refusal is thrown.
  - `executeAgent`'s completion rail is ledgered through `lib/ai/ledgered-model-call.ts` (`beginLedgeredGeneration`).
  - `buildRendererLlmClient` defaults `workspaceId` to the session's workspace (`sessionWorkspaceId`), so the D30 data class applies.
  - Usage is attributed per call. `createLlmClient` reports each call's own usage (`onUsage`, `reportsCallUsage`). A client that only reports cumulative snapshots is serialized, and an abandoned stream settles UNKNOWN.
- **What is not ledgered.** The tool-enabled sidecar rail of non-chat turns (agent-executor tools, headless turns, connectors, A2UI, creator, plugins, scheduled goals and others) is not ledgered. The sidecar ledgers only a send stamped by `resolveSendOptions`, and only chat stamps.
  - These paths are tracked in `scripts/gates/llm-ledger-boundary-baseline.json` (`pnpm audit:llm-ledger-boundary`).
  - The gate fails an `unwrapped` row whose file references a ledger seam, unless the row carries a `partial` note saying which calls are ledgered and which are not.
- **The Run API lives in the gateway; its data lives in the brain (D9).**
  - `crates/cognia-gateway/src/runs.rs` serves `/v1/runs`: create returns 202 with an `Idempotency-Key`, plus get, events over SSE (`id: seq`, 15 s keep-alive, 410 when a resumed run is gone), cancel, resume and feedback.
  - Every request crosses `brain_bridge.rs`. As shipped in B2 the desktop implemented that bridge in `src-tauri/src/gateway_brain_bridge.rs`. It is now host-neutral: `cognia_companion::gateway_brain::WritesBrainBridge` runs over the existing companion writes bridge, so no second channel exists, and one function reads the brain's envelope (`cognia_gateway::brain_bridge::interpret_envelope`).
  - The desktop installs it through `DesktopBrainBridge`, which tries a connected headless brain first, then the window.
  - Headless `cognia-server` installs it through `HeadlessRouterFusionGateway` over the brain's `/internal/bridge` socket. `cognia-server` therefore serves `/v1/runs`, `cognia/*` and the passthrough ledger too.
  - The brain answers with tagged values, not throws, so Rust can return the brain's own status.
  - The run's input messages are stored as an encrypted artifact before the run exists, because the request is gone once the gateway answers 202.
- **Keys are actors (D8).**
  - A gateway key carries `scopes`: `runs:create/read/cancel/approve`, `artifacts:read` and `feedback:write`.
  - A key with no scopes keeps passthrough only.
  - Another key's run answers exactly as a missing one does.
  - A Run API session is an ordinary chat session tagged `origin: gateway-api` with the key's name (D24).
- **`cognia/*` models answer explicitly (D13).** `virtual_models.rs` catches them before model resolution:
  - `403 ROUTER_FUSION_DISABLED` when the surface is off;
  - `422 DELEGATE_REQUIRES_RUN_API` for `cognia/delegate`, which is Run API only.
  - As shipped in B2, `auto`, `direct`, `cascade` and `panel` were refused with `422` too. B3 serves them (see below).
- **The passthrough lane is ledgered, never stopped by the ledger (D13, D38).**
  - It covers `/v1/chat/completions`, `/v1/messages`, `/v1/responses` and `/v1/embeddings`.
  - With `gatewayPassthroughLedger` on, each upstream attempt is reserved immediately before it is sent. It is settled from the usage the gateway already reads, including at the end of a stream.
  - Embeddings settle on prompt tokens (falling back to `total_tokens`). A price with an input rate only counts as complete for embeddings only.
  - A settle is applied whatever the switch or the breaker say now. Only a fusion-database fault prevents it (`bypassed:ledger_unavailable`, counted as a fault).
  - A settle the bridge could not deliver is retried up to 3 times with backoff (`SETTLE_ATTEMPTS`, `SETTLE_RETRY_BACKOFF`) and logged if it never lands. The brain books `settle:<attemptId>` once, so a retry never bills twice.
  - The failure class (`not_sent`, `rate_limited`, `server_error`, `auth`, `invalid_request`) travels with the settlement. A stalled or unreadable answer settles UNKNOWN and keeps its money held.
  - A failed-over request is one run (`gwpt:<requestId>`) with one logical step per attempt.
  - A budget or policy refusal returns `402` and the request is not sent.
  - A brain that is off, tripped, absent or slower than 2 s lets the request through unledgered.
  - Every response that made an attempt carries `x-cognia-ledger` (`ledgered` or `bypassed:<reason>`), `x-cognia-attempts`, `x-cognia-fallback` on failover, and `x-cognia-run-id`.
  - The gate half is `gate/passthrough-bridge.ts`, deliberately separate from `gate/run-api-bridge.ts`: the two lanes answer a fault in opposite ways.
  - Its outcomes, refusals and bypasses included, travel in the same `{ ok: true, value }` envelope as the Run API's. The desktop brain bridge rejects any other shape as a broken contract.
  - Each settle drains the outbox immediately, because no run driver exists to carry the usage row across later.
- **The gateway reads the switches from the routing snapshot.** `RoutingSnapshot.routerFusion` carries the two gateway switches, not the breaker. The brain answers a tripped surface itself, so the caller gets `503` or `bypassed:breaker_tripped` rather than a misleading "off".
  - The desktop pushes them in the renderer's routing snapshot.
  - A headless brain publishes them with `gateway_router_fusion_switches_publish` whenever the settings row changes (a Dexie `liveQuery`) and every 60 s. The server stamps the last published value onto every profile snapshot. A malformed publish is refused, and both switches are off until the first publish.
- **Runs nothing local started still show up (D39).**
  - A fusion run whose origin owns no execution run (today only `gateway`) queues `execution_run_projection` effects at create, start and seal.
  - The applier creates an `ExecutionRun` of the new kind `fusion`, with `origin: "gateway-api"` and the key's name, then advances it through the ordinary journal.
  - Passthrough runs (`origin: "gatewayPassthrough"`) are never projected: a proxy hop is a bill, not a task.
- **The cockpit filters by origin.** `/agent-runs?origin=` narrows to local or gateway runs.
  - The control appears only once a non-local run exists, so with the Run API off the header is unchanged.
  - As shipped in B2, a `fusion` row offered stop only. Since B4 it also offers approve and deny for a delegate approval. Its handler goes through `gate/run-control.ts` and deliberately skips the Run API's actor check: the person at the machine may stop or decide on work the machine is doing.
- **Projection lands when it happens.** A Run API run drains its outbox as soon as it starts, so its cockpit row can be stopped while it is live. Cancelling a queued run drains too, since no worker is left to do it.
- **Boot recovery and retention cover every wired surface, on both hosts.**
  - `recoverStaleFusionRuns` seals any lapsed run, not only chat's, and a fault there counts against every live surface. From B3 on, a run the orchestrator drives is resumed rather than sealed (see below).
  - The window runs recovery and retention while any wired surface is on. The brain runs them in `lib/headless/runtimes/router-fusion.ts`.
  - Breaker persistence stays window-only: it saves through the settings store.
- **The brain reads the switches from the account row.** A headless brain never loads the settings store (only `SettingsHydrator` does), so every gate read on a path the brain serves goes through `gate/current-settings.ts`. That covers the Run API, passthrough, run control and workflow prompts.
  - The helper uses the store when it is loaded and the stored row otherwise.
  - Mid-call re-checks use `calls/live-settings.ts`, which falls back to the request's own snapshot.
- **The companion RPC.** A paired phone or browser reaches `execution_run_*` and `claude_call_reserve_respond` through `lib/router-fusion/gate/companion-bridge.ts`, on the `companion` surface.
  - A device may answer a reservation only for a turn it sent. The sidecar's `call_reserve_request` carries the turn's `remoteExecutionContext`. The companion event bus records the request per remote execution context and delivers it only to the originating device.
  - The Rust RPC checks ownership (`crates/cognia-companion-bus` `remote_context`: `session_response_origin`, `consume_session_response`). It answers `403 RESERVATION_NOT_OWNED`, `409 RESERVATION_NOT_PENDING` or `410 RESERVATION_EXPIRED`. An answer is single-use.
  - Rust stamps `reservationOriginDeviceId` server-side. The TS bridge refuses unless `callerDeviceId` equals it, and refuses with `COMPANION_ACTOR_REQUIRED` when no caller device is present.

### Cascade, panel and the virtual models (B3)

- **The full ActionRouter (D10, D11).** `routing/run-route.ts` routes a Run API request, a compat call or a chat fusion turn across every mode it allows.
  - Every enabled action of an allowed mode is assessed, and each role alias is resolved by the app's own routing engine (health, breakers, capabilities, data policy).
  - `deployment-filter.ts` re-checks whatever the engine picked before cost is considered, so no selector can smuggle in an ineligible deployment (ROUTE-02).
  - A panel refuses two members on the same model revision.
  - With no evaluation data, Auto still picks only the baseline unless the user approved a rule row. Nothing is relaxed to find a route: no fit is a refusal with the router's reasons (ROUTE-08).
- **The orchestrator executes the whole run in the brain.** `runtime/orchestrator-host.ts` takes the run's lease, replays the pinned config snapshot, runs the mode's workflow against the ledger and seals the run exactly once.
  - Role calls go through `calls/role-call-executor.ts`: one AI SDK request to one pinned deployment, with retries off.
  - Every durable step is a logical call (`workflows/durable-call.ts`). Each transport attempt reserves its own money, is committed DISPATCHED before it is sent, and settles once. An unanswered attempt is UNKNOWN and is never retried or assumed free.
- **Cascade (`workflows/cascade.ts`).** The cheap stage answers and is verified.
  - A pass finishes without calling the strong model (CAS-01).
  - A failed or inconclusive check, or output that stays invalid after one format repair, escalates exactly once, with a machine reason in the journal (CAS-02).
  - The strong stage gets the original contract and the objective failure report, not the cheap draft.
  - `inconclusive` is never a pass (CAS-03), and a policy refusal is never escalated around (CAS-04).
- **Panel (`workflows/panel.ts`).**
  - PREPARE proves the work fits every window its answers pass through (PAN-08). It holds every necessary stage's money up front as stage reservations (BUD-02).
  - Candidates are independent (PAN-01) and get one read-only tool round.
  - A citation that does not resolve, may not be read, or whose content changed is dropped before the judge sees it (PAN-05).
  - The judge reviews anonymous candidates in a run-fixed order. Under `evidence_review` a claim counts only with evidence of its own; agreement is not evidence (PAN-04).
  - At most one verification round and one rejudge (PAN-07).
  - The synthesizer may assert only supported claims, and the final check refuses a synthesis that leans on anything else (PAN-06).
  - One surviving candidate is `FUSION_INSUFFICIENT_CANDIDATES`, or, when the request allowed it, an explicitly degraded result that is not a fusion success (PAN-02, PAN-03).
- **Evidence tools (D26).** `tools/tool-runtime.ts` decides every tool request; a model only asks.
  - Two policies: `panel-read-1` (web pages, web search, and workspace files when the run has a workspace) and `panel-verify-1` (re-read stored evidence, re-fetch a page).
  - A tool the policy does not name is refused whatever the text around it says (AUTH-05).
  - Each operation is recorded in `fusionToolOperations`, keyed by step, policy, tool, canonical arguments and, for a file, the hash of what was read. A changed file is a new operation (CACHE-02).
  - `workspace-read.ts` refuses `..`, absolute paths and credential-shaped names. The Rust `fs_read_workspace_file` canonicalizes root and target, so a symlink escape is refused on disk.
  - `web-evidence.ts` follows redirects by hand and classifies every hop, so a public page that redirects to a metadata address is refused (SAFE-01). It never inherits the user's "allow private hosts" setting and never asks the shared tool for its unledgered page summary.
- **Prompts and context.**
  - The spec's role prompts are embedded byte-for-byte as `roles-1` and pinned by checksum. A prompt change is a new prompt version, which is part of every action hash (ROUTE-05).
  - Untrusted text (pages, tool results, other roles' answers) is fenced as data.
  - A role transcript is compacted at 75 % of its window, only with no tool call pending, into a new context epoch. The summary is billed, the hard constraints are re-injected by code, and no money for it is `CONTEXT_BUDGET_EXHAUSTED` (F06).
- **Answers are delivered verified_buffered (D7, SSE-02).** `answer.delta` and `answer.completed` are committed in the seal's transaction, before the terminal `phase.changed`. They carry byte ranges of the answer artifact, never text. Before the seal the journal holds phases, calls and billing only.
- **Recovery (REC-03).** A run the orchestrator drives (`driver: "orchestrator"`) is resumable.
  - A worker that takes a lapsed lease first settles the old worker's attempts: PREPARED becomes ABANDONED and DISPATCHED becomes UNKNOWN (`settleOrphanedAttempts`).
  - A step with an UNKNOWN or RECONCILED attempt is refused with `STEP_OUTCOME_UNKNOWN`, never sent again.
  - The boot sweep hands such runs to `orchestratedRunResumer` while their surface is on, instead of sealing them.
- **The Run API completes its surface.** `GET /v1/sessions/{id}`, `GET /v1/artifacts/{id}` (with a 60 s HMAC `read_url` built from the request's host) and `GET /v1/artifacts/{id}/content?token=` (re-authorized on every read, `no-store`, `nosniff`). Every gateway error is the contract `ErrorResponse`: `code`, `message`, `retryable` (429 and 503), `details` and a `trace_id`.
  - Read tokens are keyed per account: the HMAC key is a Browser Vault secret (`router-fusion.artifact-read-token-key.v1`), so a token stays valid across restarts and across brains of the same account. Only a non-account database uses a per-process key. A locked vault is a fault, not a reason to fall back.
- **The `cognia/*` models are served (D13).** `cognia/auto`, `cognia/direct`, `cognia/cascade` and `cognia/panel` on `/v1/chat/completions` become runs.
  - The brain maps the strict compat subset in `api/chat-compat.ts`: unknown parameters, tools and `n > 1` are `422`, never ignored. The whole message snapshot becomes the run's input in a new conversation, through the same `acceptRun` as `POST /v1/runs`.
  - A non-streaming caller waits for the verified answer. A streaming caller gets SSE comment heartbeats until the answer is verified, then standard deltas and `[DONE]`.
  - `RUN_STILL_RUNNING` (`503`) comes back after the run's deadline plus 30 s; the run carries on and `x-cognia-run-id` names it. A caller that goes away does not cancel the run (SSE-03).
  - `GET /v1/models` lists the four models while the Run API is on, for a key that may create and read runs and whose model allowlist admits them.
- **Chat can run a cascade or a panel.**
  - The composer gets a per-conversation mode chip (`stores/chat/fusion-mode-store.ts`): Auto, Direct, Cascade or Panel. It shows only while chat is on, on the built-in runtime, in the desktop app.
  - `resolveSendOptions` asks `selectChatFusionRun` for an explicit Cascade or Panel. For Auto it asks only when the user approved `cascade_verifiable` or `panel_research` and the turn names no agent tools.
  - A fusion selection stamps `SendOptions.routerFusionRun` and skips the direct route and the seal.
  - Images. Attachment kinds are carried even when the turn has no typed text. An explicit Cascade or Panel with an image anywhere in the transcript is `FUSION_TEXT_ONLY`. Auto never chooses fusion for an image turn. The transcript builder (`fusionTranscriptOf`) refuses instead of dropping an image.
  - An explicit mode on a paused surface or a fault is `RouterFusionUnavailableError`, never a direct turn (D38).
  - The controller branches where a Squad turn does. `hooks/chat/router-fusion-chat-turn.ts` saves the person's message, runs the turn through `gate/chat-fusion-run.ts` (`runExplicitFusion`), and shows the verified answer at once. The run wrote the answer durably through the outbox (`writesSessionAnswer`, answer only).
  - A progress card above the composer shows the phase, the calls and the spend against the cap every 700 ms, and says the answer appears once verified.
  - Mid-run steering is not offered (D19): a follow-up waits in the queue and becomes the next turn. Stop cancels the run and aborts its calls.
  - A failed run reports `routerFusionRunFailed` with the run's own reason.
- **The run card shows the run.** The answer's `metadata.run.routerFusion.fusion` is a summary folded from the journal (`runTimelineOf`, `fusionRunSummaryOf`): mode, roles, phase timeline, candidates, judge counts, escalation, a degraded result, verification, quality, cost against the cap and unknown calls. It holds no model output.
- **The action catalog is editable (D17).** Settings → Routing → Router + Fusion gains cascade and panel run caps and an action editor (`router-fusion-action-catalog.tsx`).
  - Per action: enable, the alias behind each role, the verifier profile, its own run cap, and for a panel its size and web evidence.
  - The user can add actions of their own.
  - Every edit is checked by the package's validators (`settings/action-catalog.ts`) first, and a rejected edit is explained instead of saved. Settings normalization drops anything persisted that would not compile.
  - Overrides are pruned to real differences, and each action shows its configuration hash, which changes with every edit.
- **A seventh built-in action, `cascade_review` (a D17 addition).** `cascade_schema` needs a schema and `cascade_code` needs acceptance commands, so an explicit chat Cascade had no verifier and was always `VERIFIER_UNAVAILABLE`.
  - `cascade_review` (`text_review`, cheap → `fast`, strong → `powerful`) is appended last to the catalog, so a request with a schema still prefers `cascade_schema`.
  - The estimate counts the two reviewer calls of a reviewed cascade, one per stage, so the pre-check never under-reserves it.
- **Explicit routing needs no model.** An explicit Cascade or Panel enters the routing block even when the conversation names no model; the roles choose the deployments.
- **Data class follows the project.** A chat fusion turn passes the conversation's project to `routeRunRequest` (`workspaceId`), so a project marked restricted keeps its turns off deployments that may not take restricted data.
- **PII (where the gate sits).**
  - A chat fusion turn's transcript is checked with `hasNoLeakingPiiDeep` before any run exists; a hit is `PII_BLOCKED`.
  - Workspace file content read as evidence is checked with `hasNoLeakingPii` after the read; a hit is `CONTENT_SENSITIVE`, and nothing is stored.
  - There is no blanket check in the executor: web evidence routinely carries addresses, and an ordinary chat does not gate web tool results either.
  - Run API and compat input is not gated. The caller is an external program that chose what to send, like passthrough.
- **Chat runs appear in Agent Runs.** An orchestrated chat run projects an `ExecutionRun` with origin `local` and kind `fusion`, and writes usage rows like any direct turn (`projectedOriginOf`, `ledgerWritesUsageRows`).
  - Stop from the cockpit reads the projected origin: `local` cancels through the chat surface, anything else through `gatewayRuns`.
- **Virtual models and the key's own limits.** A key with a model allowlist reaches `cognia/*` only if the allowlist names it, and `GET /v1/models` lists only those. A served answer's tokens draw down the key's quota, as passthrough does.
  - `router/*`, the spec's spelling, is accepted only while runs are on. With the switch off it resolves as any other model name (D37).
  - The answer wait backs off from 250 ms to 2 s and asks again when the brain drops away within the budget.
  - A brain refusal is always an error status. A run id that is not a UUID never reaches a header, and an event type outside `[A-Za-z0-9._-]` is sent as `message`.
  - Artifact content is served as an `attachment` under `Content-Security-Policy: sandbox`.

### Delegate (B4)

- **Where it runs.** Delegate is a Run API mode (`EXECUTABLE_MODES` in `lib/router-fusion/api/run-api.ts`). `cognia/delegate` on the compat endpoint is `422 DELEGATE_REQUIRES_RUN_API`. Agents, Squad members and workflow nodes can also choose it (see B5).
- **Approvals.**
  - A person decides through `POST /v1/runs/{id}/resume` (scope `runs:approve`) or in `/agent-runs`.
  - The Run API snapshot returns the real `pending_approval_id`.
  - The ledger writes the contract's `approval.required` event. Older `approval.requested` rows are mapped to it on read.
  - A refused approval decision is an answer about the run, not a breaker fault.
- **Delivery.** `x-cognia.delegate_delivery` is a Cognia extension beside the strict `RunRequest`: `patch_only` (the default) or `workspace_updated`.
  - `workspace_updated` is refused when the request cannot run delegate, and is persisted only on a run the router actually sent to delegate.
  - Workflows set it with the node param `delegateDelivery`, Squad teammates with `fusionDelegateDelivery`.
- **Agents, Squad and workflows.**
  - The run stores `projectId`, `workspaceRoot` (the project's primary folder, through `fusionWorkspaceRootOf`) and `acceptanceProfileId`.
  - The picker and the runtime share the same workspace check, and member turns validate the stored choice.
  - An approval attaches a `fusion_approval` interrupt to the caller's existing execution run (`workflowExecutionRunId`, `agentTeamExecutionRunId`) rather than adding a new cockpit row.
  - `lib/execution/run-control.ts` sends any `fusion_approval` to the fusion handler, and `agentsWorkflows` is in `CONTROLLED_RUN_SURFACES`.
  - The caller holds the run driver (`holdRunDriver`) and waits across the approval. It cancels on abort (`RUN_CANCELLED`), on expiry (`APPROVAL_EXPIRED`), or when no parent run exists to carry the interrupt (`APPROVAL_UNREACHABLE`).
  - The interrupt title is an approval kind code, translated in the cockpit (`agentRuns.approvals.fusionApproval.*`), never stored English.
- **Sandboxed acceptance (`lib/router-fusion/verify/code-acceptance-host.ts`).** The `code_fixture` profile runs the approved command in the strongest eligible tier: microVM, then container, then OS sandbox.
  - The microVM tier is eligible only when the adapter `accepts()` the worktree. Otherwise the next tier is taken. The plugin SDK's sandbox adapter gained `accepts` and `readFile` for this.
  - The report is read from inside the sandbox, at the path the command ran under.
  - E2B currently declines acceptance runs: its clones are provisioned with network on, and network off cannot be enforced afterwards.
  - The container tier is intentionally absent by default (`container: null`): it is not offered until it can enforce every ceiling it claims.
  - No eligible tier is `SANDBOX_UNAVAILABLE`. Delegated code is never run unconfined.
- **Workspace patches (`tools/workspace-patch.ts`).** The Rust commands `task_workspace_revision_get`, `task_workspace_revision_apply` and `task_workspace_revision_read` compare and swap on the tree's revision.
  - Only a genuinely unknown command (a non-Tauri host) may use the check-then-write fallback.
  - ACL and authorization errors propagate; they never fall back.
- **Fusion workflow nodes honor `onSchemaViolation`.** `fail` (the default) throws `SchemaViolationError`; `soft` returns `schemaValid: false`.

### Classifier, action choice and live smoke (B5)

- **LLM classifier (D18, `routing/llm-classifier.ts`).** Opt-in. An Auto route asks the configured router model once. The call is a ledgered, PII-gated, bounded utility run. Every failure (timeout, invalid reply, PII hit, refusal, fault) ends in the rules classifier (ROUTE-03).
- **Action choice for Agents, Squad and workflows.** A shared picker (`components/router-fusion/fusion-action-field.tsx`) offers Auto, Direct, Cascade, Panel and Delegate on the `agentsWorkflows` surface. Auto keeps the old behaviour. Every other choice runs the step as a fusion run.
- **Live smoke (D20, `lib/router-fusion/live/`).** Real cases run through the real engine in a dedicated fusion database. The $5 total is enforced by the ledger's tenant limit, not by the harness.

### Routing experiments and the shadow router (B6)

- **Samples.** Each routed decision can be stored as a text-free routing sample with its acceptance label, actual cost and propensity (`lib/router-fusion/eval/`).
- **Experiment (`eval/routing-experiment.ts`).** Cost per accepted run counts every cost and only accepted runs (EVAL-03). A simulated report claims nothing (EVAL-04).
- **Shadow router (`eval/shadow-router.ts`).** It records what the learned router would have chosen beside the rules decision, and never acts. Nothing on a routing path imports `lib/router-fusion/eval/`.
- **Promotion and rollback (`eval/promotion.ts`).** Promotion is a pointer move in the fusion database, so rollback is one click. It needs a passing grouped bootstrap, and a simulated predictor is never promoted.
- **Still shadow-only.** Live samples are logged with propensity 1, so the gate answers `DETERMINISTIC_LOGGING` and promotes nothing. No predictor feeds the live router (see Rule 7 below).

### A separate database and an outbox (D39)

Router + Fusion never bumps `lib/db/schema.ts`. Each main database gets a sibling IndexedDB, `<main database>-router-fusion-v1`, created lazily on first use. It holds these tables:

- `fusionAccount` and `fusionRuns`;
- `fusionRunEvents`, keyed `[runId+seq]`;
- `fusionSessionLocks` and `fusionRouteDecisions`;
- `fusionReservations`, `fusionCallAttempts` and `fusionLedger`;
- `fusionArtifacts`, whose content is encrypted with the account content cipher;
- `fusionConfigSnapshots` and `fusionOutbox`;
- `fusionIdempotency` and `fusionFeedback`, added in B2 (schema version 2, additive: every B1 store keeps its index layout);
- `fusionApiSessions` (the Run API's id for a conversation) and `fusionToolOperations` (tool receipts), added in B3 (schema version 3, additive);
- `fusionAcceptanceApprovals`, `fusionPatchSets` and `fusionDelegateSteps`, added in B4 (schema version 4, additive);
- `fusionRoutingSamples`, `fusionPredictorManifests` and `fusionShadowDecisions`, added in B6 (schema version 5, additive).

That is 21 tables at schema version 5 (`lib/router-fusion/db/fusion-db.ts`).

Effects on the main database go through the outbox with idempotent effect ids and are replayed at boot and recovery.

- **Governance.**
  - `lib/data-governance/router-fusion-catalog.ts` gives every fusion table the same policy record a core table has. A parity test holds it equal to `FUSION_SCHEMA`.
  - Backup is device-local (a ledger is this device's spending, not portable content), and sync is none.
- **Deletion.**
  - Every path that deletes a main database deletes the sibling, through the zero-import `gate/database-name.ts`: account deletion, runtime-target removal, the refused-layout reset and "clear all data".
  - Where the path already verified deletion, it verifies the sibling too. "Clear all data" now verifies both the main database and its sibling.
  - Removing a target or host deletes and verifies the plaintext, encrypted and fusion databases together, through `runtimeTargetDatabaseNames` / `deleteRuntimeTargetDatabases` (`lib/runtime/target-registry.ts`). That covers account runtime-target removal, detaching the active companion target, companion host removal and forget-target-only.
  - A plaintext account or target database is only a migration source in this build, so it never had a sibling.
- **Retention (`lib/router-fusion/db/retention.ts`).**
  - Artifact content expires after 7 days, unless a live run wrote it.
  - A terminal run's event journal goes 7 days after it ended; the Run API then answers `410 EVENT_HISTORY_EXPIRED` and points at the snapshot.
  - A terminal run that ended more than 30 days ago goes with its events, attempts, reservations, decision and outbox rows, and its delegate step journal. It is kept while it still pins money (a held or uncertain reservation, a non-final attempt), holds a lock, or has a pending effect.
  - Config snapshots older than 30 days go once no retained run uses them.
  - Delegate patch sets expire after 7 days, unless their run is live.
  - Routing samples and their shadow decisions expire after 180 days, deliberately longer than the run trail.
  - The money ledger is append-only and is never reaped. Acceptance approvals and predictor manifests are not reaped on a window either.
  - Idempotency keys expire after 7 days (`ROUTER_FUSION_IDEMPOTENCY_DAYS`) on their own clock, even while their run is live. Feedback goes with its run.
  - Retention runs only while a wired surface is on. Its failures are logged and never feed a breaker.

### Spec translations

| Spec mechanism | Here |
|---|---|
| Postgres RLS | account-scoped database plus key-scope and actor filters (AUTH-03, CACHE-05, B2) |
| Redis pub/sub | Polling only (REC-07, B2): no notification channel exists. `/v1/runs/{id}/events` polls the brain every 250 ms (`EVENT_POLL_INTERVAL`), resumes by seq with no gaps, and closes after 300 s with no frames (`SSE_MAX_SILENCE`). |
| `SELECT … SKIP LOCKED` | Dexie lease plus an incrementing fencing token |
| Signed URLs | 60 s HMAC read tokens, keyed per account (B2) |
| Alembic migrations | single-version Dexie schema per database, as for the main database |
| LangGraph checkpoints | logical-step ledger replay: a SUCCEEDED `logicalStepId` returns its committed output (REC-01) |

### Rule 7 dormancy

`chat`, `gatewayRuns`, `gatewayPassthroughLedger`, `utilityLedger`, `agentsWorkflows` and `companion` are wired (`WIRED_ROUTER_FUSION_SURFACES`). As shipped in B1–B3, `companion` stayed dormant until its companion RPC landed; it is now wired. The dormancy mechanism stays in place for future surfaces.

The `economy_simple`, `cascade_verifiable`, `panel_research` and `delegate_multifile` rule rows are wired (`WIRED_RULE_ROWS`). `delegate_multifile` still matches only where delegate can really run: its rule also requires a sandbox tier and an approved acceptance profile. In chat, `cascade_verifiable` never matches under Auto, because a chat turn carries no JSON schema; it matches through the Run API and `cognia/auto`, and its description says so.

Delegate actions and custom delegate actions are editable (`EDITABLE_ACTION_MODES`). The "Later release" delegate text is gone.

Two parts stay dormant:

- `cascade_code` and its `code_fixture` profile in the answer verifier. No host supplies a runtime verifier (`AnswerVerifierPorts.runtimeVerifier`), so `runVerifierProfiles` never offers `code_fixture` and the router never selects `cascade_code`. A delegate action's `code_fixture` is served by its own acceptance runner instead.
- The learned router. A promoted predictor is recorded and shadowed, and changes no routing decision.

- **Types.** Documented at `HostCapabilities.verifierProfiles` (`routing/action-router.ts`), `EDITABLE_PROFILES_BY_MODE` (`settings/action-catalog.ts`), `runVerifierProfiles` (`routing/run-route.ts`) and `eval/promotion.ts`. Every list is documented at the type (`WIRED_RULE_ROWS`, `EDITABLE_ACTION_MODES`, `EDITABLE_PROFILES_BY_MODE`).
- **UI.**
  - `cascade_code` shows "Not chosen yet".
  - The routing experiment panel labels promotion "Later release": a promoted predictor is recorded and shadowed, and changes no routing decision (`routerFusionEval.promotion.dormant`).
  - The composer's mode chip renders nothing while chat is off.
- **Tests.** `run-route.test.ts` and `action-router.test.ts` pin that `cascade_code` is never selected. `shadow-router.test.ts` pins that no routing path imports the evaluation code. `switches.test.ts`, `settings.test.ts`, `action-catalog.test.ts` and the editor's test pin the lists. `switches.test.ts` also fails if any source calls the gate for a dormant surface.

## Consequences

- **The off path is protected by tests, not care.**
  - OFF-01 through OFF-04 pin that every switch defaults off.
  - With switches off, `resolveSendOptions` and the sidecar dispatch match the baseline.
  - No Router + Fusion module loads and the fusion database is never opened.
  - ISO-01 through ISO-05 pin fault isolation and idempotent outbox replay.
- **Two Dexie databases can be half-committed relative to each other.** The outbox makes the cross-database effects idempotent and replayable; a crash between them repairs on the next boot.
- **Chat turns on a ledgered surface are slower to start.** Each AI SDK leg waits for a reservation round trip to the renderer. The Claude Agent SDK lane pays one envelope reservation per turn.
- **The acceptance registry is the definition of done.** `packages/router-fusion/src/acceptance/registry.ts` maps the 79 spec cases plus the Cognia OFF/ISO cases to batches. `registry.test.ts` fails when a delivered batch has a case with no `[ACC:<ID>]` test in the scanned roots. `DELIVERED_BATCHES` is B1–B6.
- **Some things cannot be verified offline.**
  - Whether `CLAUDE_CODE_MAX_RETRIES=0` fully disables CLI retries.
  - Real provider usage semantics and request ids.
  - Tauri bridge timing.
  - These are covered by the authorized live smoke ($5 total, ledger-enforced), delivered in B5.

## Alternatives considered

- **A separate Python service, as the spec assumes.** Rejected: it adds a second runtime and datastore to a desktop app, and every send would cross a process boundary it does not cross today.
- **Tables in the main Dexie database.** Rejected: every main schema bump rewrites `messages` and `workflowRuns`, and it would put Router + Fusion on every user's upgrade path even with the feature off.
- **Keep the soft cap and hidden retries, and only add reporting.** Rejected: the spec's budget invariants (no unreserved dispatch, no silent model switch) cannot hold with them.
- **Enable for everyone with a kill switch.** Rejected: the user required opt-in, with failures never affecting normal work.

## Implementation

| Batch | Scope | State |
|---|---|---|
| B1 | contracts, state, money, ledger, rules router, direct workflow; chat as a direct run; gate, breaker, fusion DB, outbox, governance, retention; run card and settings | implemented |
| B2 | ledgered utilities and workflow prompts; gateway `/v1/runs` + SSE + scoped keys; `cognia/*` refusals; passthrough ledger and headers; `fusion` run projection and cockpit origin filter; companion RPC (`companion` surface) | implemented |
| B3 | full ActionRouter; cascade and panel workflows; evidence tools; context compaction; verified_buffered delivery; orchestrated-run recovery; Run API sessions and artifacts; served `cognia/*` models; chat cascade and panel turns with mode picker, progress card and run card; action catalog editor | implemented |
| B4 | delegate with sandboxed acceptance and approvals | implemented |
| B5 | LLM classifier, Agent/Squad/workflow fusion action choice, live smoke | implemented |
| B6 | routing experiments, shadow router, promotion and rollback | implemented; the learned router stays shadow-only |
| B7 | fault-injection matrix; `/agent-runs` detail pane for cascade and panel runs (today only delegate runs get one, `components/agent-runs/run-detail-pane.tsx`) | planned |
