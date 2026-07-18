---
title: "0083 — Shared Context Workbench"
description: "Unifies the complete project, Canvas, artifact, and workflow right-side experiences behind one resource-scoped Workbench without removing legacy capabilities."
---

# ADR 0083 — Shared Context Workbench

**Status:** Accepted  
**Date:** 2026-07-18

## Context

Project files, Canvas documents, artifacts, and workflows each had useful right-side tools, but lifecycle, reveal, sizing, comments, and plugin behavior were implemented independently. That caused capability drift: project comments opened Git review, workflow comments were unavailable, and artifact selections only exposed an AI note. The consolidation must preserve every existing tool and keep each legacy host available as a one-minor-release rollback path.

## Decision

Use `components/context-workbench/` and `lib/context-workbench/` as the shared right-side shell and controller. Each surface contributes native panels through a host adapter; it does not lose or replace its specialized implementation.

- Scope identity is `window + host + resource`, not a component instance id. Active panel, mode, width, and pin state persist with a 200-entry, 30-day retention policy.
- Desktop supports `narrow`, real clamped `wide`, and focus-managed full-screen `focus` modes. Mobile uses a full-width Sheet and omits meaningless width/focus controls.
- Pinning blocks automatic, diagnostic, proposal, and plugin reveal events. Those events become pending state and badges. Explicit user navigation can still change panels.
- Capabilities are computed from resource type and platform. Native unavailable features explain why; plugin panels fail closed when capabilities or permissions are missing.
- The complete native panel set remains reachable for Project, Canvas, Artifact, and Workflow. Existing specialized chat, proposal, Git, execution, preview, history, formatting, filesystem, inspector, run, and template components are reused.
- `contextComments` is the single writable comment table. It supports resource, text/line-range, and workflow node/edge anchors, including threads, reactions, resolve/reopen, revisions, and stale-anchor state. Dexie v115 idempotently backfills `canvasComments`; Canvas stores, plugins, legacy UI, and backup compatibility use adapters.
- One durable embedded AI session is retained per resource, including the specialized workflow adapter and binding migration on rename/move.

## Plugin contract

Plugins may contribute trusted React panels declaratively with `manifest.contextPanels` or imperatively with `ctx.contextPanels.register()`. Contributions share one namespaced registry, lazy bridge, diagnostics, error boundary, permission re-resolution, and disable/uninstall cleanup.

Required permissions are `extension:ui` plus the matching `project:read`, `canvas:read`, `artifact:read`, or `workflow:read`. `reveal()` is limited to the calling plugin's applicable panels and respects pinning. `getActiveContext()` and its subscription expose sanitized identity, selection, revision, and capabilities—never resource content. Sandboxed Webview panels are outside this decision.

The Workbench also hosts `sidebar.right.top`, `sidebar.right.bottom`, `panel.header`, and `panel.footer` with the same sanitized context. Mounting activates `onView:context-workbench` and the resource-kind-specific event.

## Rollout and consequences

The `canvas`, `project`, `artifact`, and `workflow` Workbench switches default on independently. The previous per-surface sidebars remain intact for one minor release and are selected only by their corresponding rollback switch. This adds compatibility code temporarily, but prevents capability loss while the shared controller becomes the default source of layout and reveal behavior.

