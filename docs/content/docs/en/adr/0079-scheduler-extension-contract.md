---
title: ADR-0079 — Scheduler extension contract
description: Define the supported scheduler extension axes, source adapters, plugin boundary, and OS promotion capability rules.
---

# ADR-0079 — Scheduler extension contract

**Status**: Accepted (2026-07-16)

## Context

Cognia has an in-process TypeScript scheduler, workflow triggers backed by a Rust cron daemon,
and OS-native promotion backends. Extension points had drifted: plugin writes bypassed the live
scheduler, unified history bypassed the source registry, and OS capability lists were duplicated.

## Decision

1. `TaskScheduler` remains the only lifecycle write path. Storage-only writes do not arm or disarm
   drivers and are not a supported extension point.
2. Executor names and event names are open strings. A new timing producer should normally call
   `triggerEventTask(eventType, source, data)` instead of adding a fifth `TaskTriggerType` variant.
3. Unified scheduler kinds remain closed and are defined by `SCHEDULED_ITEM_KINDS`. Every kind is
   represented by a `ScheduledItemSource`; optional execution history is exposed through
   `listRuns()` on that source.
4. Plugins may schedule the existing trigger types only when their manifest declares the
   `scheduler` capability. Plugin tasks are ordinary `type: "plugin"` SchedulerDB tasks; there is
   no second plugin schedule store.
5. Plugins cannot register timing drivers, add unified kinds, or promote JavaScript handlers to an
   OS service. Plugins that need custom workflow timing use the prefixed workflow-trigger registry.
6. OS promotion is limited to trigger/action combinations explicitly reported by each backend.
   Trigger capability rows are derived exhaustively from `SystemTriggerKind`; unsupported cron
   syntax must be rejected, never approximated.
7. Workflow cron accepts five- or six-field expressions at the boundary, rejects `L` and `#`, and
   evaluates wall-clock fields in the supplied IANA timezone (host timezone when omitted).

## Consequences

- New drivers can be injected through `initSchedulerSystem(driver)` without changing singleton
  consumers.
- Adding a system trigger variant produces compile errors until kind mapping and every backend's
  capability decision are updated.
- Adding a unified kind requires updating the exhaustive kind tuple and registering an adapter;
  execution history does not require editing the aggregation hook.
- OS promotion and plugin scheduling may reject previously accepted-but-ineffective input with an
  actionable error.
