---
name: workflow-node
description: Add or change a Cognia visual workflow node or trigger end to end. Use when introducing a WorkflowNodeKind, executor, catalog entry, parameter schema, inspector form, handles, or trigger registration; covers parity tests, i18n, and runtime wiring.
---

# Adding a Workflow Node

A node kind touches type, catalog, params schema, executor, inspector config,
and i18n — in different files. Two registry tests (`executor-coverage` and
`params-schemas`) exist precisely because steps here were missed before
(`ocr.extract` shipped without its params-schemas entry; `pattern.*` kinds
left gaps in node-config-registry).

## Checklist (do every step; verify with the named test)

1. **Kind + types** — add the union member and `WORKFLOW_NODE_KINDS` entry in
   `types/workflow/visual.ts`. Parameter types are inferred from
   `lib/workflow/nodes/params-schemas.ts` through `typed-params.ts`; extend the
   schema rather than hand-writing a duplicate params interface.
2. **Catalog entry** — `lib/workflow/nodes/catalog.ts`: label, category,
   inputs/outputs (multi-output nodes declare named output handles —
   routing is sourceHandle-first). Verify: `catalog.test.ts`.
3. **Params schema** — `lib/workflow/nodes/params-schemas.ts`
   (`PARAMS_SCHEMAS`): REQUIRED for every kind; `params-schemas.test.ts`
   enforces the kind list. Validation runs through `validate-params.ts`.
4. **Executor** — implement in the matching domain module under
   `lib/workflow/nodes/` (e.g. `git.ts`, `ocr.ts`, `terminal.ts`) and
   register it in `lib/workflow/nodes/registry.ts`. Verify:
   `executor-coverage.test.ts` — it fails on any kind without an executor.
5. **Inspector config** — add the form/schema mapping under
   `components/workflow/editor/inspector/` and the explicit entry in
   `node-config-registry.tsx`. Verify with its co-located test; every new kind
   must resolve deliberately, including kinds that use the generic form.
6. **i18n** — node label/description keys in BOTH
   `i18n/messages/en.json` and `zh-CN.json` (catalog i18n was a whole audit
   theme once). `lib/workflow/i18n/` holds the wiring.
7. **Tests** — co-located executor test (happy path + error path + param
   validation). If the node calls Tauri/sidecar, mock at the transport
   seam, not the executor.

## Triggers (extra steps on top)

Trigger-type nodes additionally register their source in
`lib/workflow/triggers/registry.ts` and must wire the matching runtime
subscription/bridge. Extend the registry parity test and exercise one real
dispatch path so a catalog-only trigger cannot ship dormant.

## Known traps

- Expression access uses `$node['id']`; follow the current expression tests.
- `honorPinData` is opt-in for editor execution; production-style runs leave
  it false.
- `runSingleNode` uses `seedOutputs`/`restrictToStepIds` — reuse it for
  node-level debugging instead of inventing a runner.

## Verify

```
rtk pnpm test -- lib/workflow/nodes
rtk pnpm test -- components/workflow/editor/inspector
rtk pnpm typecheck
rtk pnpm lint:i18n
```
