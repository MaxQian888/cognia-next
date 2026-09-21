---
title: "0192 — A bot turn borrows the run's stage"
description: "Connector-initiated bot turns used to render like a second-class runtime: progress flattened into one collapsible card panel, the final answer shipped as a bare Card 1.0 div, and `ask_user` opened a desktop dialog nobody in the IM conversation could see. This ADR makes a bot turn borrow the same stage a desktop run gets — Feishu's native `message_cot` chain-of-thought when the tenant supports it, a Card 2.0 result card with a state header / quoted input / footer / inline images, an interactive `ask_user` card routed through the durable callback-binding machinery, unseen group context injected into the first turn, and an execution-run binding so bot deliveries get the same run card, approvals, and COT as any other governed run — all built on the existing A2UI surface, binding, and outbound-queue machinery rather than a parallel bot pipeline."
---

# ADR 0192 — A bot turn borrows the run's stage

**Status:** Accepted — Implemented
**Date:** 2026-09-21
**Related:** [ADR-0009](./0009-platform-connectors) (platform connectors and the governed outbound queue), [ADR-0025](./0025-connector-runtime) (connector runtime), [ADR-0036](./0036-connector-inbox-writes) (IM adapter contract), [ADR-0089](./0089-connector-run-presentation) (run presentation driver), [ADR-0131](./0131-connector-callback-authorization) (callback bindings and the unified authorization guard)

## Context

The connector bot path could answer a message, but it could not *perform* a
turn the way a desktop run can. Measured against `ies/aiden-bot` and
`ies/aiden-bot-server` — the Feishu bot references this work was asked to
match — four gaps mattered:

**There was no chain of thought.** Progress reached the chat as a single
collapsible panel inside the CardKit status card — a flattened text
timeline, rebuilt whole on every beat. Feishu has a native surface for this
(`im/v1/message_cot`, an AG-UI event stream), and aiden-bot drives it with
interleaved reasoning segments and tool-call rows; Cognia never called the
API.

**The final answer was the plainest possible card.** A Card 1.0 `div` with
markdown: no state header, no quote of the triggering message, no footer
with requester / elapsed time / interruption state, and `![](path)` image
references stayed literal text instead of uploaded `image_key`s.

**`ask_user` answered to an empty room.** The tool suspends on the renderer's
ask-user dialog (`stores/agent/ask-user-store`). For a connector-initiated
turn nobody is watching the desktop — the question never reached the
conversation, and the run hung on it. The same applied to scheduled digest
turns, which have no requester at all.

**The group and bot-delivery edges were thin.** A group turn saw only its
own mention — the ambient messages between the last assistant reply and the
trigger were invisible, and a replied-to message contributed no quote. Bot
deliveries (`lib/bot/`) wrote real `executionRuns` rows but no
`executionRunBinding`, so they never surfaced a run card, approval buttons,
or COT in IM at all.

The naive fix for each gap is a bot-specific channel — a dedicated card
schema, a bespoke webhook handler, a parallel permission path. That is what
we rejected: Cognia already owns A2UI surfaces, durable callback bindings,
a unified authorization guard, the governed outbound queue, and run
interrupts. A bot turn should borrow that stage, not build a second one.

## Decision

### Native COT with a capability gate, not a forked presenter

`run-presentation/lark-cot.ts` projects successive `RunProjectionSnapshot`s
into AG-UI COT events (`RUN_STARTED` → `REASONING_MESSAGE_*` →
`TOOL_CALL_START/END` → `STEP_STARTED/FINISHED` →
`RUN_FINISHED/RUN_ERROR`), and `lark-driver.ts` creates the COT message
right before the status card so the process sits above it in the chat.
Projection state is plain JSON persisted in `ref.opaqueState`, so a crashed
driver resumes diffing correctly instead of replaying.

The writer honours the API's real contract — batches of ≤50 events, ≥65 ms
apart, timestamps strictly increasing, `230001` ("message not a COT") never
retried — and creation is capability-gated: when the tenant or domain does
not support `message_cot`, the driver falls back to the existing card
timeline and marks the run `presentedCot` so a mid-run COT death forces a
`replace_card` instead of a silent gap. PII never crosses the boundary: COT
text comes only from sanitized activity labels, step titles, and fixed i18n
strings; `TOOL_CALL_ARGS` is deliberately never emitted.

### The result card is a projected segment, not a template

`adapters/lark/result-card.ts` builds the final answer as a Card 2.0
surface: a state header (running / done / error / interrupted colours), a
`> 回复：…` quote of the triggering message when the platform did not
already quote it natively, a footer with requester, run link, elapsed time
and the "interrupted" marker, and `![](path|url|data:)` image references
uploaded through `lark/upload.ts` into `image_key`s — falling back to a link
when upload fails. The card is emitted as a governed outbound segment with
`metadata.resultCard` (`{runId, status, interrupted}`) stamped on the job,
so the existing `onConnectorOutbound` plugin hook can observe, veto, or
transform it with structured context instead of guessing at card JSON.

`run-presentation/runner.ts` reuses the same builder for milestone result
cards on durable runs, so a Lark run finished by timeout, interruption, or
recovery gets the same terminal artifact.

### `ask_user` rides the callback-binding machinery

The answer to "where does the question go" is decided by a registry seam,
not by the tool:

- `hitl/im-elicitation-context.ts` — the connector runtime registers one
  context per capture, beside `makeImPermissionResponder`, carrying adapter,
  conversation, delivery target, initiator, run id, drafting flag, and an
  abort signal tied to the capture's `approvalController`. Digest turns in
  `scheduled-outbound.ts` register with `actorScope: {mode: "conversation"}`
  because they have no single requester. The entry dies with the capture
  and `getImElicitationContext` treats an aborted context as absent, so a
  late `plugin_tool_exec` event can never resurrect a dead turn's card.
- `lib/claude/plugin-tool-ipc.ts` — the `ask_user` branch looks the session
  up; a live context routes to `runImAskUser`, its absence keeps the
  desktop dialog. Both paths return the same `formatAskUserAnswer` string.
- `hitl/ask-user-question.ts` — builds the bilingual A2UI question card
  (one Button per option — `select` for single-choice, `toggle` for
  multi-select — a TextField when `allowText`, a Skip button), pre-records
  one durable `connectorCallbackBindings` row per interactive component
  *before* enqueue (identical to the mapper's delivery-time upsert, so the
  row exists before the card can be pressed), enqueues through the governed
  gateway, mirrors the wait onto a durable `ask_user` run interrupt when a
  run id exists, and freezes the card on settlement — the approval-card
  command frame on Lark, a controls-stripped governed edit elsewhere.
- `hitl/ask-user-registry.ts` — the pending prompt, keyed by
  `${sessionId}:${toolUseId}`, with a TTL backstop (default 10 min) and
  owner-abort settlement so a forgotten card can never wedge a turn open.
- `bus.ts` — a short-circuit before the generic A2UI hand-off: bound
  presses arrive already authorized by the unified guard; binding-less
  correlations (Telegram ForceReply `input`, Discord `modal_open` submits,
  card dismissals) are matched by `surfaceId` and re-checked against the
  prompt's own actor scope. `toggle` repaints without settling;
  `select`/`submit`/`submit_text`/`skip` settle; a press on a dead prompt is
  audited and swallowed — never a new model turn. A `dismiss` action wins
  over whatever op the component baked in.

Two deliberate invariants: `select`/`toggle`/`submit` only accept option
values the model actually offered (a press can never mint an answer), and
card refresh reuses the original binding expiry rather than minting a new
one. The surface id is `au_<16 hex>` so generated
`a2ui:<surface>:<component>:<verb>` action ids stay under Telegram's
64-byte `callback_data` cap and round-trip through the binding table
unhashed.

### Group context is injected, not stored

`bot/sources/connector-inbound.ts` stores all non-dropped group messages;
`runtime.ts` now assembles the ones the model has never seen — ambient
messages between the last assistant watermark and the trigger — plus the
resolved `replyTo.preview` quote, into an XML context block prepended to the
model prompt. The stored inbound row stays clean; only the prompt carries
the context, so history reads as the human wrote it while the model reads
what the room was saying.

### Bot deliveries get a presentation binding

`bot/runtime/im-presentation.ts` builds an `executionRunBinding` for
IM-originated bot deliveries, so the generic presentation runner picks them
up — run card, COT, approval buttons — with no bot-specific render path.
The pre-existing `bot` control handler (`approve`/`deny`/`stop`/`retry`)
becomes reachable from IM for free.

### A transaction boundary fix that fell out

`createRunInterrupt` and `step.ts`'s compare-and-resolve transaction were
written before schema v227 added `notificationProjectionWork`; the journal
append inside them now touches that table and Dexie aborted every approval
creation. Both transactions now list the table — the fix repairs tool, plan,
bot, and ask-user interrupts at once.

## Consequences

- Feishu conversations see reasoning, tool calls, and questions as native
  surfaces; tenants without `message_cot` lose nothing — they keep the card
  timeline.
- The desktop dialog contract is untouched; `ask_user` has one formatted
  result on both transports.
- Every interactive component is a durable binding row, so restart-safe
  dedup, expiry, and actor-scope enforcement come from ADR-0131's guard
  rather than per-card ad-hoc checks.
- Adding a platform is additive: a mapper that honours `bindingHintFields`
  gets the question card, toggle repaint, and freeze for free; one that
  cannot do cards gets the `widget.fallbackText` mirror and the
  surface-correlated text path.
- Bot deliveries now surface pending interrupts in IM — the run card is the
  single place a stalled bot turn shows up, instead of a silent log line.

## Alternatives considered

**A parallel bot-specific card pipeline** (aiden-bot-server's shape, ported
whole) was rejected: it would have duplicated dedup, authorization, retry,
and freeze logic the connector stack already owns, and every future HITL
kind would have had to be built twice.

**Renderer-side elicitation over the existing desktop dialog** (push the IM
answer back through `ask-user-store`) was rejected: the dialog's lifecycle
is a renderer store, not a durable prompt — it cannot survive a reload,
cannot be actor-scoped by callback bindings, and would couple IM latency to
renderer focus state.
