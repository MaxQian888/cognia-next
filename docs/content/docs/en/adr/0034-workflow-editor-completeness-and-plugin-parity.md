---
title: 0034 — Workflow Editor Completeness & Plugin Parity
description: Node-config completion, workflow-level settings, run observability, error-branch routing, and ADR-0032-parity plugin extensibility for Visual Workflows.
---

## Status

Accepted (2026-05-23). Implementation reconfirmed on 2026-08-12 against the mounted workflow editor sidebar, inspector registry, workflow runtime, and plugin capability registries.

## Context

The Visual Workflows subsystem (ADR-0011/0017/0022) had a mature canvas + hybrid
runtime, but four gaps blocked "feature completeness":

1. **Node-config coverage** — 67 node kinds, only 41 wired into the inspector
   registry. The 11 `action.desktop.*` forms existed but were never imported
   (desktop nodes fell back to raw JSON); `trigger.team`,
   `action.team.task.dispatch`, and `trigger.desktop.event` had no form. A real
   bug in `params-schemas.ts` left `action.team.task.dispatch` validation
   disabled (`requiredString` referenced, not called).
2. **No workflow-level settings UI** — `WorkflowSettings`, variables, and
   credential refs had no editor.
3. **Plugin linkage was node/trigger-only** (ADR-0017) — no template overlay,
   no `requires` validation, no settings surface, and the built-in
   `action.skill.invoke` / `action.mcp.invokeTool` executors ignored the plugin
   overlay registries.
4. **No run observability in the editor** — a full run-history UI existed under
   `components/workflow/runs/` but was route-coupled and unreachable from the
   canvas.

## Decision

- **Node-config completion.** Wire the 11 desktop forms; add forms for the three
  unwired kinds; fix the `requiredString()` bug; add expression-aware URL
  validation; add a `trigger.team` passthrough executor. Introduce reusable
  `EntityPicker` (searchable, on `components/ui/combobox`), `CronBuilder`
  (reuses `lib/scheduler/cron-parser`), and `DurationField`; surface
  jump-to-next-error in the inspector.
- **Settings tab.** A new right-sidebar **Settings** tab edits `WorkflowSettings`
  (error policy, timeout, concurrency, retry, timezone), an author-time
  `variables` map (referenced as `{{ $vars.KEY }}`), and credential refs — all
  through the editor store's envelope mutators, persisted by the existing save
  path. `variables` is an additive optional field (no schema-version bump).
- **Runs tab.** A new right-sidebar **Runs** tab reuses the existing
  `RunTimeline` / `RunStepDetail` / `RunStatusPill` / formatters (route
  decoupled, not rebuilt), with reveal-on-canvas for the selected step.
- **Error-branch routing.** `errorPolicy: "branch"` is fully implemented: nodes
  expose a second `error` source handle, edges carry `kind: "error"`, and the
  orchestrator routes a failed node down its error edges (keeping the run alive)
  reusing the existing decision/`propagateSkip` engine. `"continue"` is also
  implemented (skip downstream, complete the run).
- **Plugin parity (ADR-0032 mirror).** A new `workflow-template` overlay
  capability: `PluginWorkflowTemplateDef` + `workflow-template-registry` +
  `validateWorkflowTemplateRequires` (non-blocking warnings) +
  `projectPluginWorkflowTemplate` + `defineWorkflowTemplate` SDK helper, wired
  into `OVERLAY_REGISTRY_CAPABILITIES` and `PLUGIN_CAPABILITY_CONTRACTS`
  (`support: "supported"`). Four new lifecycle hooks
  (`onWorkflowNodeStart/Complete/Error`, `onWorkflowTriggerFired`) dispatch from
  the orchestrator + trigger bridge. `action.skill.invoke` and
  `action.mcp.invokeTool` now fall back to the skill / mcp-server-preset overlay
  registries when the Dexie table misses. Templates surface in the Settings
  tab's "Plugins & capabilities" section with a "Use" action.

## Consequences

- Every node kind now has a structured inspector form; desktop nodes are no
  longer raw-JSON.
- `errorPolicy` is fully honored end to end; the Settings tab no longer exposes
  dead options.
- Plugins reach ADR-0032 maturity for workflows: complete blueprints, dependency
  warnings, richer hooks, and node-level consumption of plugin skills/MCP.
- `{{ $vars.X }}` resolves at run time (orchestrator threads
  `workflow.variables` into the expression scope) and autocompletes in the
  expression editor.
- No Dexie migration: `variables` rides existing `workflows` rows as an optional
  property.
