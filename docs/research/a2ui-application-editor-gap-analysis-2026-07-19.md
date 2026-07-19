# A2UI and Application Editor Gap Analysis

Date: 2026-07-19
Status: current editor/runtime implementation slice closed; remaining follow-up audits are tracked in the ledger

## Goal and invariants

Audit the existing A2UI subsystem and its mini-app editors module by module, then close every
verified gap without introducing a parallel implementation. Each fix must reuse an existing public
seam, keep complete error and edge behavior, ship with co-located tests, remain i18n-complete, and
be reachable through the real application flow.

The current worktree is shared and contains unrelated in-progress changes. A2UI edits therefore
remain path-scoped, shared i18n files require special care, and no broad staging or cleanup is
permitted.

## Module ledger

| Module                           | Existing implementation                                                                    | Verified gap                                                                                                                                                                                                                        | Status / verification                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol schema and parser       | `types/a2ui/schema.ts`, `lib/a2ui/parser.ts`                                               | The subsystem doc describes `updateComponents` as replacing the tree, but the store merges by id. This leaves no protocol-level deletion path. The intended incremental-update contract must be resolved before changing semantics. | Investigating                                                                                                                                                                                                                                                          |
| Data model                       | `lib/a2ui/data-model.ts`                                                                   | Pointer traversal accepted malformed escapes/array indexes and inherited or prototype-sensitive keys; the editor exposed scalar edits only.                                                                                         | Fixed: strict escaped-pointer traversal, safe JSON-model validation, structural sharing, and protected object/array mutation primitives are covered by focused tests                                                                                                   |
| Store and history                | `stores/a2ui/a2ui-store.ts`                                                                | Whole-surface replacement was not atomic or undo-safe, and history omitted `rootId`.                                                                                                                                                | Fixed in current slice: `replaceSurfaceContent` plus root-aware undo/redo; focused store test passes                                                                                                                                                                   |
| Persistence                      | Zustand localStorage plus `lib/db/a2ui-apps.ts` and `useA2UISave`                          | The 20-surface localStorage LRU and durable Dexie rows had no reconciliation path; deletion and metadata mutations could diverge, Save failure advanced local timestamps, and existing built-ins could be overwritten by upsert.    | Fixed in current slice: durable hydration, validated store restore, transactional protected CRUD, rollback-safe Save, async UI failure handling; focused tests pass                                                                                                    |
| Catalog and renderer             | `lib/a2ui/catalog.ts`, `components/a2ui/a2ui-renderer.tsx` and component families          | Runtime rendering is broad, but the editor originally knew only a small hand-written property subset; optional enum fields across core and extended catalog components were undiscoverable and accepted arbitrary advanced values.  | Fixed: every standard bundle has safe generic/structural editing, and 37 schema-constrained enum properties across core plus extended renderers have discoverable select/unset controls and shared boundary validation                                                 |
| App generator                    | `lib/a2ui/app-generator/`                                                                  | The documented `weather` intent was detected but had no dispatch case; 13 other factory families emitted hard-coded Chinese copy regardless of the requested language; generic form matching captured contact-form prompts first.   | Fixed: all 14 generator families localize component/data-model copy through one overlay boundary, weather reuses the canonical template, calculator variants retain full behavior, and specific intent precedence is covered                                           |
| Templates                        | `lib/a2ui/templates/`                                                                      | The 13 canonical templates embedded English runtime copy in initial payloads and action-generated updates; app instances did not retain a content locale, so later regeneration could silently change language with the current UI. | Fixed: canonical structure remains single-source while complete en/zh overlays cover template metadata, component copy, options, initial data and action results; locale is persisted, duplicated, imported/exported and regenerated                                   |
| App-builder CRUD                 | `hooks/a2ui/use-app-builder.ts` and `hooks/a2ui/app-builder/`                              | Durable hydration/delete/metadata consistency and complete duplication semantics were missing.                                                                                                                                      | Fixed: duplication restores the complete root-aware surface, deep-clones content metadata, resets publication identity/statistics, and aborts atomically on invalid surface                                                                                            |
| Import/export/share              | `hooks/a2ui/app-builder/import-export.ts`, `share.ts`, `lib/a2ui/app-import.ts`            | Workspace Export discarded the JSON; portable exports omitted `rootId`/surface metadata; imports trusted shape-only component arrays; backup restore discarded instance metadata and could leave a partial restore.                 | Fixed: download is reachable; bounded versioned validation checks safe JSON/data, graph identity/references/tree/cycles/paths and surface metadata; custom roots round-trip; backups validate first, restore metadata and roll back atomically                         |
| Hub page                         | `app/a2ui/page.tsx`                                                                        | No co-located route test; quick suggestions and fallback copy were hard-coded; hub duplicated filtering behavior already available in `useAppGalleryFilter`.                                                                        | Fixed: Hub and gallery share the pure filter/sort pipeline, including most-used/template metadata behavior; localized quick prompts have complete locale contracts and the route interaction is covered                                                                |
| Gallery and detail editor        | `components/a2ui/app-gallery.tsx`, `app-detail-dialog.tsx`                                 | Hard-coded `Sort:` and email placeholder violated frontend i18n rules; sort/preview icon controls lacked descriptive names.                                                                                                         | Fixed: localized sort/email copy and accessible sort-direction/preview-close controls; focused gallery/detail tests and ESLint pass                                                                                                                                    |
| Workspace shell                  | `components/a2ui/workspace/a2ui-workspace.tsx`                                             | `zoom`, `showTree`, and `showProperties` state existed, but zoom had no consumer and the panel visibility setters had no UI caller.                                                                                                 | Fixed: clamped 50–200% shared desktop/mobile preview scaling plus accessible desktop tree/property visibility controls; workspace/context/toolbar tests pass                                                                                                           |
| Workspace toolbar                | `components/a2ui/workspace/a2ui-toolbar.tsx`                                               | AI Generate was a TODO/no-op; Export did not download.                                                                                                                                                                              | Fixed in current slice; toolbar tests pass                                                                                                                                                                                                                             |
| Component tree editor            | `component-tree-panel.tsx`, `component-placement-dialog.tsx`, `lib/a2ui/component-tree.ts` | Delete/Duplicate were unwired; the old tree only followed direct `children`; Add/Move had no store or visible editor path.                                                                                                          | Fixed: complete structural-slot traversal, renderer-valid catalog bundles, atomic single/subtree/root-wrap insertion, cross-slot/final-index move, no-op and cycle rejection, localized visible controls, selection handoff, and undo                                  |
| Property inspector               | `property-inspector-panel.tsx`, `lib/a2ui/component-properties.ts`                         | The old type map used wrong renderer fields, covered only a subset, flattened bindings, could not safely edit structured/custom props, and hid absent optional enum fields behind unrestricted JSON.                                | Fixed: scalar/path/structured/custom props and protected structural metadata round-trip safely; optional enum fields are discoverable, selectable/removable, advanced edits share validation, and unchanged legacy enum values survive                                 |
| Data-model editor                | `data-model-panel.tsx`                                                                     | Hard-coded empty/loading/count copy and icon-only controls lacked accessible labels; structural mutations were absent.                                                                                                              | Fixed: localized accessible tree controls, encoded special-key paths, object-key creation, array append/compaction, node/root JSON replacement, protected validation, confirmation, and atomic undoable writes                                                         |
| Version history                  | `version-history-panel.tsx`                                                                | Component and tests existed but the workspace never mounted it. `Latest` was hard-coded.                                                                                                                                            | Fixed: localized panel is reachable from the desktop inspector tabs and mobile workspace navigation                                                                                                                                                                    |
| Settings/runtime debugger        | `components/settings/a2ui-*`, `lib/a2ui/runtime-settings.ts`, shared surface/widget shell  | Runtime catalog choices used unrelated template categories; the tab bypassed the shared settings store; catalog/host/theme/LRU settings had no rendering or persistence consumers; widget sizing/theme/minHeight were ignored.      | Runtime fixed: registered catalog ids, safe legacy fallback, shared-store error handling, profile-safe widget defaults, scoped theme/sizing/minHeight execution, localized labels, and configurable 5–100 LRU are covered; debugger remains a separate follow-up audit |
| MCP/ACP/plugin/connector bridges | `lib/a2ui/*bridge*`, providers, plugin bridge, connector projections                       | Broad unit and smoke coverage exists. Contract parity, fifth-tool implementation, and outbound PII/security gates remain separate module audits.                                                                                    | Not yet audited                                                                                                                                                                                                                                                        |
| Execution-to-app adapters        | `lib/a2ui/from-execution/`, `components/a2ui/from-execution/`                              | Save-to-app flow exists; it now inherits durable hydration and deletion behavior, but its own restart flow still requires a focused adapter test.                                                                                   | Unblocked; focused adapter audit pending                                                                                                                                                                                                                               |
| Mobile entry                     | `app/me/a2ui/page.tsx`                                                                     | It reuses `A2UISection`; the full mini-app workspace route still needs a mobile interaction pass after editor controls are completed.                                                                                               | Not yet audited                                                                                                                                                                                                                                                        |

## Dependency order

1. Establish atomic root-aware surface replacement and fix toolbar no-ops.
2. Reconcile app-builder persistence with Dexie before adding more editor mutations.
3. Add complete component-tree mutation primitives, then wire Add/Move/Delete/Duplicate and version history. (Completed.)
4. Make the property and data-model inspectors schema-complete and fully localized.
5. Wire zoom/panel controls and verify desktop/mobile editor flows.
6. Close generator/template gaps, then audit external bridges and runtime settings against the
   corrected editor/store contract.
7. Run focused tests after every module and the full coverage, type, lint, build, and real UI flow
   gates before completion.

## Current evidence

- `stores/a2ui/a2ui-store.test.ts`: atomic replacement and root-aware undo passes.
- `components/a2ui/workspace/a2ui-toolbar.test.tsx`: download and prompt-driven regeneration pass.
- `hooks/a2ui/use-app-builder.test.ts`: durable custom restoration, local-surface precedence,
  offline template fallback, durable deletion, rollback-safe metadata mutation, statistics, complete
  duplication, clone isolation, and invalid-surface rollback pass.
- `lib/db/a2ui-apps.test.ts`: transactional built-in protection, metadata-only patching, ordering,
  touch, and user-only bulk deletion pass.
- `components/a2ui/{delete-confirm-dialog,app-gallery,app-detail-dialog,quick-app-builder}.test.tsx`:
  pending and failure-preservation behavior passes across all editor entry points.
- `lib/a2ui/component-tree.test.ts` and `stores/a2ui/a2ui-store.test.ts`: all renderer-owned
  component references are traversed/rewritten; subtree deletion, required-reference cascading,
  collision-safe duplication, renderer-supported empty slots, atomic referenced-subtree insertion,
  leaf-root wrapping, cross-slot/final-index movement, invalid-target/no-op rejection, clone
  isolation, and undo pass.
- `lib/a2ui/component-definitions.test.ts`: every standard catalog type produces a connected,
  cycle-free, renderer-valid bundle; required overlay/menu triggers and collision-safe ids pass.
- `lib/a2ui/component-properties.test.ts` and `property-inspector-panel.test.tsx`: all standard
  component bundles round-trip inspector-owned properties without losing structural references;
  scalar, multiline, path-bound, structured JSON, advanced add/remove, invalid JSON, prototype
  protection, non-protocol runtime preservation, and protected Tabs/Accordion/Guide/List structural
  metadata editing pass; 37 core/extended enum constraints, optional-field discovery, unset, shared
  advanced validation, and legacy-value preservation pass in 88 combined tests.
- `lib/a2ui/data-model.test.ts` and `data-model-panel.test.tsx`: strict JSON Pointer escapes and
  array indexes, inherited/prototype-key rejection, safe finite acyclic model validation, encoded
  special keys, object/array additions and deletions, nested/root JSON editing, confirmation, clone
  isolation, localized accessible controls, and atomic replacement pass (64 tests).
- `components/a2ui/workspace/{component-placement-dialog,component-tree-panel,a2ui-workspace,version-history-panel}.test.tsx`:
  catalog search, explicit slot/index placement, leaf-root insertion, localized visible controls,
  registered shortcuts, selection handoff, action disabling, and both desktop/mobile history
  reachability pass.
- `components/a2ui/workspace/{a2ui-workspace-context,a2ui-workspace,a2ui-toolbar}.test.tsx`:
  clamped zoom, shared desktop/mobile preview scaling, desktop panel visibility, accessible toolbar
  controls, regeneration, download, save, and undo/redo pass (21 tests).
- `lib/a2ui/app-generator/{generators,index}.test.ts`: all generator families plus weather-template
  reuse, clone isolation, standard message creation, contact-form specificity, and
  temperature-converter precedence pass. The complete template/generator verification set passes
  441 tests across 9 suites, including bilingual overlays for all 13 templates and all 14 generator
  families.
- `hooks/a2ui/use-app-builder.test.ts`: 25 focused template, locale, hydration, reset, import, and
  export tests pass; instance locale survives durable restoration, duplication, and JSON
  round-trips, with active-locale fallback for legacy imports.
- `lib/a2ui/app-import.test.ts` plus builder integration pass 37 tests for bounded safe JSON/data,
  graph/root/path integrity, complete surface and instance metadata, backup preflight, and rollback.
- `hooks/a2ui/app-builder/action-handlers.test.ts`: changed task, habit, note, shopping, BMI, and
  age-result paths pass focused bilingual runtime-message coverage.
- `app/a2ui/page.test.tsx`, `components/a2ui/{quick-app-builder,a2ui-app-card}.test.tsx`,
  `components/a2ui/quick-app-builder/template-card.test.tsx`,
  `components/settings/a2ui/templates-tab.test.tsx`, and the toolbar suite pass 57 tests across 6
  suites for localized discovery, creation, category labels, and instance-locale regeneration.
- `pnpm typecheck` reaches the repository-wide compiler and reports no A2UI/template/generator
  diagnostics; the command remains red because of unrelated pre-existing errors in agent teams,
  CLI plugin runtime, external-agent/ACP, wallpaper, memory, and Sites modules.
- `components/a2ui/{app-gallery,app-detail-dialog}.test.tsx`: localized sort/email surfaces,
  accessible sort direction, durable failure preservation, and metadata editing pass (48 tests).
- `app/a2ui/page.test.tsx` and `hooks/a2ui/use-app-gallery-filter.test.ts`: the Hub quick-prompt
  interaction, bilingual message contract, shared category/search/template filtering, and all sort
  modes pass (11 tests).
- `lib/a2ui/{catalog,runtime-settings}.test.ts`, `stores/a2ui/a2ui-store.test.ts`,
  `components/settings/a2ui/runtime-tab.test.tsx`, and the surface/widget/RichOutput suites pass 115
  tests: registered catalog discovery, legacy fallback, shared settings persistence, save failure
  recovery, immediately flushed configurable LRU, profile-safe host precedence, scoped themes,
  sizing/minHeight, and localized surface labels all execute through the real runtime seams.
- No `.codegraph/` index is available in this worktree, so this audit uses literal searches plus
  direct source/ADR/subsystem-document inspection.
