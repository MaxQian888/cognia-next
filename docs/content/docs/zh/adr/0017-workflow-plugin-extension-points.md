---
title: ADR 0017 — Workflow Plugin Extension Points
description: Canonical contracts that let plugins contribute node executors and trigger sources to the visual workflow runtime.
---

## Status

Accepted — 2026-05-09

## Context

The visual workflow subsystem (ADR 0011) ships 32 built-in node executors
and 5 trigger kinds. Plugins were only able to participate via a single
escape hatch — the `action.plugin.invoke` node, which dispatches into a
plugin's `workflow.task` extension point. That works for a one-shot
"call my plugin" pattern but fails the moment a plugin wants to
contribute a domain-specific node (e.g., a "Fetch from JIRA" action with
its own params schema and label) or a custom trigger source (e.g., a
GitHub webhook listener that emits trigger events on push).

The gap surfaced when we audited the editor's left-rail node palette:
`groupedCatalog()` was hard-coded to the built-in registry, plugins had
no way to surface their own node kind, and the executor registry had
neither an `unregister` nor a `subscribe` API — meaning even if we
wired a back-channel, the editor couldn't react to plugin enable /
disable lifecycle events.

## Decision

Introduce two new canonical extension points alongside the existing
`workflow.task`:

```ts
export const CANONICAL_RUNTIME_POINTS = [
  "workflow.node", // plugin-contributed node executor
  "workflow.trigger", // plugin-contributed long-running trigger source
  "workflow.task", // existing — pre-formalized action.plugin.invoke target
] as const
```

These join the existing `ui-slot` / `hook` / `activation` taxonomies as
a fourth `runtime` kind. Permission gate: `extension:workflow`. ADR
audit (`auditPluginPointContracts`) traverses all three.

### Type contracts

`types/plugin/plugin-workflow.ts` declares the runtime shapes:

```ts
interface PluginNodeDef {
  kind: string // unprefixed; runtime adds <pluginId>.
  typeVersion: number
  category: WorkflowNodeCategory | "plugin"
  label: string
  description: string
  iconName: string
  paramsSchema: Record<string, unknown>
  defaultParams?: Record<string, unknown>
  desktopOnly?: boolean
  retryable?: boolean
  timeoutMs?: number
  execute: (ctx: StepExecutionContext) => Promise<StepExecutionResult>
}

interface PluginTriggerDef {
  kind: string
  typeVersion: number
  label: string
  description: string
  iconName: string
  paramsSchema: Record<string, unknown>
  start(ctx: PluginTriggerStartContext): Promise<PluginTriggerHandle>
}
```

`PluginManifest` gains an optional `workflows` block that mirrors the
runtime shapes minus the `execute` / `start` functions. The bridge that
wires manifest entries to the actual functions reads them off the
plugin's `main` entry on activate.

### Plugin-facing API

`PluginContext.workflow` is the single entry point plugins use:

```ts
interface PluginWorkflowAPI {
  registerNode(def: PluginNodeDef): () => void
  registerTrigger(def: PluginTriggerDef): () => void
  emitTriggerEvent(workflowId: string, kind: string, payload: unknown): void
}
```

Each `register*` returns an unsubscribe function. The runtime also
tracks every registration on a per-pluginId map so a force-disable from
the manager calls `teardownPluginWorkflowRegistrations(pluginId)` to
clean up everything in one shot.

### Kind prefixing

Plugin authors supply unprefixed kinds (e.g., `"action.fetchPage"`).
The runtime prefixes with `<pluginId>.` automatically — so the kind
ends up as `action.<pluginId>.fetchPage` in the registry / catalog /
saved workflows. Trigger kinds preserve the leading `trigger.` segment
(`trigger.<pluginId>.<rest>`) so namespace-based pattern matching in the
orchestrator still works.

### Registry subscribe

`lib/workflow/nodes/registry.ts` (and the parallel
`lib/workflow/triggers/registry.ts`) gain `subscribeNodeRegistry(fn)` /
`subscribePluginTriggerRegistry(fn)` returning an unsubscribe function.
Notifications dispatch on a `queueMicrotask` so React effects mounted
after eager built-in registration still observe the population.

### Catalog hot-merge

`lib/workflow/nodes/catalog.ts` adds a parallel `pluginCatalog` map +
`addPluginCatalogEntry` / `removePluginCatalogEntry` /
`subscribePluginCatalog` / `getPluginCatalogSnapshot`. `groupedCatalog()`
emits a virtual `category: "plugin"` group at the bottom; the editor's
NodeSearchSidebar uses `useSyncExternalStore` to react to plugin
add / remove without manual re-renders. `searchCatalog()` includes plugin
entries in scoring.

## Consequences

### Positive

- Plugins finally have a first-class extension surface in the visual
  workflow editor — not just a passive `workflow.task` callback.
- Hot reload works end-to-end: enable a plugin while the editor is
  open, the new nodes appear in the sidebar without a refresh.
- Existing `action.plugin.invoke` paths stay valid — the new
  `workflow.task` runtime point is a strict formalization, not a
  breaking redefinition.
- Cleanly bounded: the new types live in
  `types/plugin/plugin-workflow.ts`, the bridge in `PluginContext`,
  and the catalog merge in `lib/workflow/nodes/`. No cross-cutting
  changes to the orchestrator or to `WorkflowNodeKind`.

### Negative

- `WorkflowNodeKind` is a closed union of built-ins; plugin kinds
  extend it at runtime via `as never` casts at registration time.
  Long-term we may want to widen the type to `string` and rely on the
  catalog for known-shape validation. For Phase 1 we accept the cast.
- The trigger emit path (`emitTriggerEvent`) is a Phase 1 stub; actual
  delivery into the orchestrator's trigger queue lands in Phase 2 when
  `trigger-bridge.ts` gets a `dispatchPluginTrigger` entry point.

### Neutral

- Permission gate `extension:workflow` is new but reuses the existing
  permission machinery. Existing plugin manifests don't need to declare
  it unless they actually use `PluginContext.workflow.*`.

## Migration

No migration required for existing plugins or workflows. Plugins
opting into the new surface declare:

```jsonc
{
  "capabilities": ["workflow", "workflow-trigger"],
  "permissions": ["extension:workflow"],
  "workflows": {
    "nodes": [...],
    "triggers": [...]
  }
}
```

and call `context.workflow.registerNode` / `registerTrigger` from
`activate`. The host calls the returned unsubscribe automatically on
deactivate.

## References

- `lib/plugin/contracts/plugin-points.ts` — `CANONICAL_RUNTIME_POINTS`
- `types/plugin/plugin-workflow.ts` — definition types
- `lib/workflow/nodes/registry.ts` — subscribe / unregister
- `lib/workflow/triggers/registry.ts` — trigger lifecycle
- `lib/workflow/nodes/catalog.ts` — plugin catalog hot-merge
- `lib/plugin/core/context.ts` — `createWorkflowAPI`
- `components/workflow/editor/node-search-sidebar.tsx` —
  `useSyncExternalStore` integration
- ADR 0011 — visual workflow subsystem (foundation)
- ADR 0006 / 0016 — plugin system architecture
