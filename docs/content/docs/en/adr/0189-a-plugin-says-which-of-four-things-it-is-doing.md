---
title: "0189 — A plugin says which of four things it is doing"
description: "The plugin surface answered every participation request with the same shape — a function on a bag of hooks — so the host could not tell an observer apart from something that rewrites a request, vetoes it, or wraps a whole execution. Four semantics (observe / transform / guard / around) get one registry, one ordering rule, one liveness rule and one dispatcher, with next-at-most-once and a declared failure policy per point. Fixes a chat-middleware path that sent two model requests for one turn, a plugin write that ignored its addressed session, and a transport that guessed retry-safety from method names."
---

# ADR 0189 — A plugin says which of four things it is doing

**Status:** Accepted — implemented
**Date:** 2026-09-16
**Related:** [ADR-0026](./0026-plugin-extension-points-v2) (extension points v2, `ctx.chat.use`, `onBuildOptions`), [ADR-0155](./0155-plugin-author-boundary) (the SDK author boundary), [ADR-0145](./0145-python-plugin-runtime) (the contract catalog and its mirrors), [ADR-0020](./0020-computer-use) (the three-tier permission model)

## Context

A plugin could join the host's pipeline through three unrelated doors:

- the `PluginHooks` bag returned from `activate()`,
- `ctx.chat.use(...)`, the around-style chat middleware,
- for out-of-process runtimes, a bridged `before`/`after` pair.

Each door had its own store, its own ordering rule and its own idea of what
"this plugin is disabled" means. Every one of them presented the same shape to
the host — a function — so nothing in the runtime knew whether a given handler
was watching, rewriting, vetoing, or wrapping. That distinction decides three
things the host has to get right: whether a failure may be swallowed, whether
handlers may run concurrently, and whether a returned value is allowed to
replace a real one.

Three concrete defects came out of that ambiguity.

**The chat-middleware chain could send a turn twice.** `runChatMiddlewareChain`
composed the chain itself, and on a middleware timeout or throw it called
`next(req)` again:

```ts
const result = await raceWithTimeout(callMiddleware(), entry.timeoutMs)
if (result.kind === "timeout") { …; return next(req) }   // ← second call
if (result.kind === "error")   { …; return next(req) }   // ← second call
```

That is correct only when the middleware never delegated. For the common case —
`await next()` then post-process — the terminal ran once for the delegation and
again for the recovery. A middleware that called `next()` twice hit the same
path, and one that threw *synchronously* escaped the `Promise.race` entirely,
because a race can catch a rejection but not a throw that happened before a
promise existed.

**`ctx.chat.appendMessagePart` ignored its addressed session.** It read
`options.sessionId` and then called `store.appendMessage(msg)`, which only ever
writes to the session with focus — so a plugin appending to a background
conversation landed its message in the one the user was reading.

**The transport guessed retry-safety from method names.** `isIdempotentPluginApi`
matched `/:(get|list|read|stat|…|watch|…)/` and treated a hit as safe to retry.
Wrong in both directions: `managedIdeState:watch` *creates* a subscription, so a
retried timeout leaves two behind, while `fs:stat` — which the catalog declares
non-idempotent — got a free retry because its name starts with a read verb.

There was also a quieter one. `PluginEventHooks.dispatchChatRequest` ran every
plugin against the *same* `messages` array and then scanned the results
backwards for the last successful one, so with two plugins installed exactly one
of them mattered and which one depended on registration order.

## Decision

Plugin participation is five mechanisms, not one. Four of them are
*interceptors*; the fifth (`contribution`) is the existing declarative
registration path and is unchanged.

| Mechanism | Question | Execution |
| --- | --- | --- |
| `observe` | what happened? | cannot change the result; async, bounded, droppable |
| `transform` | how should this input or projection change? | own snapshot, returns a new value, repeatable, may not change identity or authorization |
| `guard` | may this proceed? | pass / deny / requireApproval; can never turn a higher layer's deny into an allow |
| `around` | how is this execution wrapped? | typed in and out, `next` at most once, explicit error and cancellation semantics |

### One registry, one ordering rule, one liveness rule

Every authoring surface normalizes into an `InterceptorRegistration`
(`lib/plugin/interceptors/normalize.ts`) and lands in one registry
(`lib/plugin/interceptors/registry.ts`). The legacy doors stay open — they are
the authoring ergonomics, not a second runtime.

Ordering resolves in four stages: **trust tier**, then the **before/after DAG**,
then **priority**, then a stable **registration id**. Trust tier comes from
install provenance (`Plugin.source`), never from the manifest — a plugin that
could name its own tier would name the highest one, and tier decides who sees
and rewrites a payload first. The DAG is Kahn's algorithm over a queue kept in
tier/priority order, so that intent survives wherever the graph does not
contradict it. A dangling `after: ["not-installed"]` or a cycle drops the
offending **edges** and keeps every registration, with a diagnostic: one
author's typo must not take a point offline for every other plugin on it.

Liveness is `isPluginHooksEnabled`, extracted to a leaf module both registries
import. Only the pure ordering is cached; enablement is re-read on every
dispatch, because it flips in the plugin store without touching this registry.

### The ten dispatch rules

`lib/plugin/interceptors/dispatch.ts` enforces:

1. `next` enters at most once per invocation; a second call rejects and the
   downstream operation is **not** re-run.
2. Synchronous throws and async rejections arrive on one path.
3. A handler may be skipped only when it has not delegated and committed nothing.
4. Once delegation starts, failure means waiting on **that** operation (or
   surfacing its error) — never starting another one.
5. A post-processing failure never re-issues the model or tool call.
6. Downstream time and downstream errors are attributed downstream. Charging a
   slow model call to every enclosing interceptor is how three healthy plugins
   all trip their breakers at once.
7. A timeout is not a successful cancellation: the capability is revoked so a
   late submission is refused, and the host does not pretend it rolled back work
   that already committed elsewhere.
8. Transforms run serially unless a point declares its values disjoint.
9. Re-entry is detected on the call graph, per operation.
10. The point's failure policy decides; a registration may **narrow** it
    (`fail-open` → `fail-closed`), never loosen it.

Failure bookkeeping is injected rather than owned, so chat middleware keeps the
three-strike breaker its settings panel already subscribes to instead of
gaining a rival.

### The points

Declared in `lib/plugin/contracts/plugin-points.ts` under a new
`kind: "interceptor"`, beside every other point contract — so `audit:slots`, the
generated `plugin-points.json` mirror and the docs keep seeing one catalog.

| Point | Semantic | Fire site |
| --- | --- | --- |
| `agent.context.prepare` | transform | `hooks-system.ts:dispatchBuildOptions` |
| `model.request.prepare` | transform | `chat-middleware/runner.ts` |
| `model.request.invoke` | around | `chat-middleware/runner.ts` |
| `tool.call.prepare` | transform | `invoke-plugin-tool.ts` |
| `tool.execute` | around | `invoke-plugin-tool.ts` |
| `tool.result.project` | transform | `hooks-system.ts:dispatchPostToolUse` |
| `ui.action.invoke` | guard | `commands/registry.ts:executeCommand` |
| `operation.completed` | observe | `interceptors/dispatch.ts` |
| `model.stream.transform` | transform | **virtual** |
| `agent.turn.decide` | guard | **virtual** |
| `ui.surface.project` | transform | **virtual** |

The three virtual points are declared and honestly labelled rather than shipped
as an API that silently does nothing:

- `model.stream.transform` — `dispatchStreamChunk` is synchronous and its
  callers discard the return value, so a rewritten chunk has nowhere to go.
  Making it a transform is a change to the streaming contract, not to this
  catalog.
- `agent.turn.decide` — the turn loop lives inside the sidecar, so the host has
  no continue/stop decision to gate.
- `ui.surface.project` — surface projection runs inside a synchronous render,
  which cannot carry the deadline and revocation semantics every other point
  relies on. Shipping it with a weaker contract would make "the failure policy
  decides" false exactly where a plugin is closest to the user.

### Which legacy hooks normalize

`onChatRequest`, `onBuildOptions` and `onPostToolUse` are genuinely
interceptor-shaped and become transform registrations. `onPreToolUse` does
**not**: its shape is allow/deny/modify — a guard fused with a transform — and
folding it into a transform chain would let a later plugin turn an earlier
plugin's `deny` back into `allow`. It keeps its first-non-allow-wins dispatcher;
`tool.execute` is its typed successor.

### Contract-driven retry

`isIdempotentPluginApi` consults declarations, in the order the transport sees
things: the new `wireOps` array in `packages/plugin-sdk/contract/catalog.json`
(the host-brokered operations the gateway receives verbatim, such as
`window:getSize` and `db:commit`), then the ctx method catalog for wire ids that
mirror an author-facing method one-for-one. An **undeclared** operation is not
retried, and a caller's `idempotent` hint may only narrow: the classification
belongs to whoever owns the method, not to whoever happens to be calling it.

### Authoring

```ts
import { defineInterceptors } from "@cognia/plugin-sdk"

export function activate(ctx: PluginContext) {
  return defineInterceptors([
    {
      point: "tool.result.project",
      after: ["@cognia/redact"],
      failurePolicy: "fail-closed",
      handler: (value) => ({ ...value, projection: redact(value.projection) }),
    },
  ])
}
```

The helper is pure — it builds a description and returns it. Registration
happens when the host reads `activate()`'s return value, so it is tied to the
activation lease (plugin id, generation, realm, trust tier) rather than to
whenever a module was imported. A helper that registered as a side effect would
leave a plugin half-live after a hot reload, with the previous generation's
closures still on the chain.

`activate()` may return the historical hook bag, a `defineInterceptors` result,
or one object carrying both.

## Consequences

**Behaviour that changes.**

- A chat middleware that fails after delegating no longer causes a second model
  request. It also no longer causes a second *anything* — the downstream
  operation is awaited, not re-run.
- `next()` now forwards the request the middleware holds, so a request rewrite
  actually lands. The old runner always forwarded the original.
- `onChatRequest` and `onPostToolUse` are pipelines: each plugin sees its
  predecessor's output. A redaction by an earlier plugin is visible to a later
  one and cannot be undone by returning the original value it was handed.
- `appendMessagePart` writes to the addressed session and returns `null` for one
  that does not exist, instead of seeding a phantom conversation.
- An undeclared wire op gets no retry. The 25 host-brokered operations in use
  are declared under `wireOps`; anything new must be declared to get retries
  back, and the transport logs the gap once per operation.

**Failure policy is per point, and the legacy-backed points keep the behaviour
they had.** `agent.context.prepare`, `model.request.prepare`,
`model.request.invoke` and `tool.result.project` are `fail-open`, matching
`onBuildOptions` / `onChatRequest` / `onPostToolUse` today — normalizing the
legacy bag must not silently start blocking output for plugins written against
it. A redaction interceptor, the case where a crash must not read as "nothing to
redact", narrows its own registration to `fail-closed`, which the host honours
and the plugin can never widen back. `tool.execute` and `ui.action.invoke` are
new and are `fail-closed` from the start.

**What is deliberately not in scope.** No `CompositionPlan`, no service-realm
override expansion, no MCP Apps adapter, no unified long-task handle.

Three of the vNext design's proposed contract fields are also absent, and are
absent on purpose rather than forgotten: `inputSchema` / `outputSchema` /
`schemaRevision` (runtime wire validation), `requiredResourceGrant`, and
`streaming`. Each would need a mechanism behind it — JSON Schemas for 780-odd
methods, a resource-grant ledger, a chunk protocol — and declaring the field
without the mechanism produces metadata nothing reads, which is the
built-but-dormant pattern this repo's point catalog exists to prevent. They
belong with the work that implements them.

**Cost.** One more module layer between a hook and its handler, and two new leaf
modules (`plugin-liveness.ts`, `hook-telemetry.ts`) extracted purely to break
import cycles the unification would otherwise create.
