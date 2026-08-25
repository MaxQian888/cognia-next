---
title: "0145 — Python plugins get the same reach as TypeScript ones"
description: "A Python plugin could be called but could not call back: the host process was a pure request-responder, so every ctx.* namespace was unreachable and contextPanels was rejected outright. A reverse RPC channel on the existing pipe, an asyncio host, and two declarative panel classes close the gap without a second permission table."
---

# ADR 0145 — Python plugins get the same reach as TypeScript ones

**Status:** Accepted
**Date:** 2026-08-25
**Related:** [ADR-0006](./0006-plugin-system), [ADR-0026](./0026-marketplace-integrations), [ADR-0087](./0087-plugin-contract-truth), [ADR-0090](./0090-unified-agent-execution), [ADR-0130](./0130-cost-and-trace)

## Context

The Python plugin runtime shipped as a subprocess speaking NDJSON over stdio,
and it worked — for one direction. `crates/cognia-plugin-runtime/src/python/host.py`
was a request-responder: it read a `request` frame, dispatched a tool or a hook,
and wrote back `response`, plus four one-way notifications (`progress`, `chunk`,
`chunk_end`, `emit`). There was no frame a plugin could send to *ask* the host
for anything.

The consequences were larger than they looked from the manifest:

| What a plugin needed | What it had |
| --- | --- |
| Run a model turn | Nothing. It could *implement* `aiProviders`; it could not *call* one. Even the WASM runtime had `cognia:plugin/ai → generate-text`. |
| Read or write anything durable | Nothing. `ctx.storage`, `ctx.secrets`, `ctx.fs`, `ctx.git` all existed in TypeScript and none was reachable. |
| Contribute a right-rail panel | Refused. `contextPanels` was `execution: "javascript"` in the contract, so declaring one on `type: "python"` was a validation error whatever the panel actually rendered. |

The contract had been designed for this and never populated:
`catalog.schema.json`'s `runtimes` enum has always included `"python"`, and all
67 namespaces said `["frontend", "hybrid"]`. That is the shape ADR-0087
recorded — a contract that describes an intention rather than the code.

Three problems the same investigation turned up, none of them Python-specific:

- **`ctx.workspace` was half a contract.** A plugin could register a backend and
  read back one it had registered itself; nothing anywhere could *obtain* a
  checkout. Three mechanisms could produce one (`cloneToWorkspace`, `git_clone`,
  the task-workspace worktree manager), they returned three incompatible
  handles, and none was reachable from a plugin.
- **A checkout could not say what commit it was at.** `PluginWorkspaceHandle`
  now carries `headRef`, filled at acquire time. Without it `changedSince` is
  unusable for anything but the incremental path: an empty diff cannot be told
  apart from a diff the host could not compute, so "nothing changed" and
  "nobody checked" are the same answer.
- **No command could enumerate a repository.** `fs_list_workspace_dir` is
  depth-1 by design (the project tree loads lazily); `fs_search_workspace` caps
  at 200 results and depth 12. There was no "every unignored file under this
  root".
- **`git_clone` had no guard rails at all** — no host allow-list, no depth, no
  size cap, no timeout.

And one that only surfaced once the channel existed: **`ctx.a2ui` could build a
surface but never mark it renderable.** Surfaces are created `ready: false`, the
protocol has always carried a `surfaceReady` message, and the plugin API exposed
no way to send one. The namespace had zero consumers anywhere in the tree, which
is why nobody had hit it.

## Decision

### One channel, on the pipe that already exists

A plugin→host frame on the same stdio pipe, answered by an id-matched reply:

```
host_request   {"type": "host_request", "id": <int>, "method": "agent.run", "params": {...}}
host_response  {"id": <int>, "ok": true,  "result": <json>}
               {"id": <int>, "ok": false, "error": "..."}
```

No second socket, no port, no shared memory. The pipe is already the trust
boundary; adding a transport would have added a second one to secure.

`host.py` becomes an asyncio loop with a dedicated stdin reader thread, so a
saturated worker pool cannot starve the reader that has to deliver the answer a
worker is blocked on. Sync tools keep working: they run on a worker thread and
bridge explicitly with `ctx.run_sync`, which refuses to run on the event loop
rather than deadlocking there.

Reentrancy is allowed — a plugin waiting on `agent.run` keeps serving inbound
requests — with a depth cap and a per-plugin outbound gate (default 8) so a
runaway plugin cannot exhaust the host.

### Permissions are not re-checked at the seam

`lib/plugin/python/host-request-router.ts` resolves `namespace.method` against
the plugin's **already-guarded** context — the one `createFullPluginContext`
wrapped in `createGuardedAPI`. A Python plugin hits exactly the manifest
permission gate a TypeScript plugin hits, because it is the same object.

Re-checking at the router would mean a second copy of the permission table, and
a second copy is the thing that drifts. What the router *does* enforce is path
hygiene: `__proto__` / `prototype` / `constructor` and any leading-underscore
segment are refused, so a hand-written frame cannot reach further than the SDK
can emit.

### The contract stays the single source of truth

A namespace is reachable from Python when, and only when, its catalog entry
lists `"python"`. The Python SDK's `ctx` proxy *reads* that table from the
generated mirror rather than carrying its own copy, and a parity test asserts
the two agree against a real context.

Within an open namespace, a method that hands the host a **callback** is refused
by name, with a message that says why:

> `ctx.chat.use` registers a host-side callback, which cannot cross the plugin's
> stdio boundary. Declare the contribution in plugin.json instead.

The rule is derived, not listed: the contract already marks those methods
`resourceEffect: "returned-disposer"`. That is also the honest statement of how
a Python plugin registers anything — through the **manifest**, which is data the
host resolves itself.

### Two declarative panel classes

`contextPanels` becomes `execution: "conditional"` with
`javascriptWhen: {path: "entry"}` — JavaScript is required only when a panel
names a module. That alone fixes a latent bug for *every* runtime: a
`webview`-backed panel has no `entry` either, and was being told it needed JS.

Two kinds join the manifest, neither of which hands the host code:

- **`kind: "a2ui"`** renders a surface the plugin pushes with `ctx.a2ui.*`.
  `activateTool` is what tells it to build: a declarative panel has nothing
  running in the renderer, so *something* must say "the user is looking at this
  resource now", and a host→plugin callback cannot cross the wire while a tool
  invocation can. Clicks return through the `onA2UIAction` hook, which the
  Python runtime has always supported.
- **`kind: "chat"`** renders the resource conversation the artifact and canvas
  surfaces already host, grounded in text the host obtains by invoking one of
  the plugin's own tools. `requiresChatScope` is forced true regardless of the
  manifest: a conversation with no provisioned session renders an empty pane,
  and that is not the author's call to make.

Both work identically from TypeScript, Python and hybrid plugins, because
neither factory closes over plugin code.

### Two components, and a write surface

The A2UI catalog gains `Markdown` — a wrapper over the chat renderer, not a
second markdown pipeline, so the sanitize schema, Shiki and Mermaid are shared
rather than forked; a plugin-authored surface is exactly where a weaker
sanitizer would be exploited first — and `Tree`, arbitrary-depth navigation
where `Sidebar` was fixed at two levels.

`ctx.chat` gains `addContextSelection` / `appendToComposer` / `stageIntent`
behind `session:write`, plus a **plugin-generic** `ContextSelectionRef` variant.
Not one variant per plugin: the host cannot know a plugin's vocabulary, and a
`kind: "wiki"` in that union would put one plugin's nouns in the host's type
system and force a recompile for the next one. What the host does need is what
it needs from every kind — a chip label, a prompt heading, and where the excerpt
came from — so those are the fields, and everything else stays inside an opaque
`ref`.

### Dependencies: never make an installed plugin worse

Environments are shared by default (`<python_dir>/venvs/_shared/<bucket>`), uv
first with a pip fallback. Before a new plugin joins a shared bucket, its
constraints are solved *together with* the existing contributors'. If that does
not resolve, the newcomer gets its own environment and the reason is shown in
its detail view. The shared environment is not touched.

## Consequences

**A Python plugin is now a first-class plugin.** The reference plugin ships a
declarative A2UI panel, which is what keeps the class from being a capability
with no consumer — this repository's most recurrent defect.

**Two of the four `ctx.*` methods a declarative panel needs are unreachable
from Python and always will be.** `contextPanels.register`, the three
`onDidChange*` subscriptions, `a2ui.registerComponent` and `a2ui.registerTemplate`
all take or return functions. They are named and refused rather than hidden,
because "no such method" sends an author looking for a typo.

**`ctx.dexie` and `ctx.db` stay closed to Python.** Both hand back live handles.
A plugin that wants durable structured state uses `ctx.storage`, or its own file
under the data directory `ctx.fs.getDataDir()` returns.

**The audit stream now carries a runtime.** `PluginApiAuditEvent.runtime` is
required, because an audit record that cannot say whether a call crossed a
process boundary cannot explain its own verdict.
