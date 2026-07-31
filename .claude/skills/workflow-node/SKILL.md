---
name: workflow-node
description: End-to-end checklist for adding a visual workflow node (or trigger) to cognia-next. Use whenever adding/changing a node kind — the registration is spread across 6+ files and two registry tests go red (or worse, stay silently green) when a step is missed.
---

# Adding a Workflow Node

A node kind touches type, catalog, params schema, executor, inspector config,
and i18n — in different files. Two registry tests (`executor-coverage` and
`params-schemas`) exist precisely because steps here were missed before
(`ocr.extract` shipped without its params-schemas entry; `pattern.*` kinds
left gaps in node-config-registry).

## Checklist (do every step; verify with the named test)

1. **Kind + types** — add the node kind and its param types where the
   existing kinds live (`types/workflow/visual.ts` and
   `lib/workflow/nodes/typed-params.ts`). Search for a sibling kind (e.g.
   `"ocr.extract"`) and mirror every site it appears in.
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
5. **Inspector config** — `components/workflow/editor/inspector/`
   `node-config-registry`: a config component (or explicit default mapping)
   per kind. Verify: `node-config-registry.test.tsx` (known to have
   pre-existing `pattern.*` gaps — don't add to them).
6. **i18n** — node label/description keys in BOTH
   `i18n/messages/en.json` and `zh-CN.json` (catalog i18n was a whole audit
   theme once). `lib/workflow/i18n/` holds the wiring.
7. **Tests** — co-located executor test (happy path + error path + param
   validation). If the node calls Tauri/sidecar, mock at the transport
   seam, not the executor.

## Triggers (extra steps on top)

Trigger-type nodes additionally register in `lib/workflow/triggers/` and
must survive the trigger-normalizer — it DROPS fields not in its allowlist,
so new trigger config fields must be added to the normalizer too (this
silently ate fields before).

## Known traps

- `.out` wrapper: expression access is `$node['id']` direct — there is a
  latent `.out`-wrapper inconsistency; follow what existing nodes do, don't
  "fix" it in passing.
- `honorPinData` is editor-only; runtime ignores pinned data.
- `runSingleNode` uses `seedOutputs`/`restrictToStepIds` — reuse it for
  node-level debugging instead of inventing a runner.

## Verify

```
rtk pnpm test -- lib/workflow/nodes
rtk pnpm test -- components/workflow/editor/inspector
rtk tsc && rtk pnpm lint:i18n
```
