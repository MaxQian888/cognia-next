---
title: "ADR-0109: Plugin Interface Catalog Governance"
description: Make the Plugin Interface Catalog the canonical ctx.* contract across SDKs and runtimes.
---

# ADR-0109: Plugin Interface Catalog Governance

- **Status:** Accepted
- **Date:** 2026-08-06

## Context

The public Plugin API had drifted across TypeScript declarations, permission maps, Rust routes, the Python mirror, WIT, and manually maintained documentation. `PluginContext` exposed far more namespaces than the documentation claimed, lifecycle cleanup was distributed across manager branches, and transport versions were hard-coded independently.

## Decision

1. `packages/plugin-sdk/contract/catalog.json` is the single owner of public method IDs, `ctx.*` author paths, stability, runtime and platform support, permission and consent policy, data classification, transport behavior, lifecycle ownership, and implementation evidence.
2. `ctx.*` remains the only canonical author surface. This migration does not add `ctx.api`, `ctx.meta`, or a second permanent public API.
3. The contract generator emits declarations and mirrors only; domain factories remain handwritten implementation modules. Generated TypeScript, Rust, Python, plugin-point, and documentation outputs are CI-blocking drift checks.
4. API calls use one policy order: descriptor lookup, runtime/platform checks, permission/consent, data/egress policy, timeout/cancellation, adapter invocation, transport normalization, and redacted audit metadata. Unmapped methods fail closed. Rollout proceeds from catalog validation to shadow comparison, one runtime at a time, before active enforcement.
5. `PluginPermission` is canonical. Older permission type names remain deprecated aliases. Rust keeps the second permission gate for native operations; renderer proxies are defense in depth and are not a JavaScript sandbox.
6. Each plugin load owns a disposable ledger. Activation failure and unload dispose registrations in reverse order, idempotently, aggregate failures, and then retain legacy cleanup as a rollback path during migration.
7. Python and other cross-process runtimes expose an additive handshake containing SDK, protocol, and contract versions, runtime ID, capabilities, and a legacy-adapter marker. A missing handshake selects the explicit legacy adapter instead of rejecting an existing plugin.
8. Public API deprecations remain available for at least two host minor releases. Removal requires the next SDK major, a replacement, migration documentation, and usage evidence. The committed API surface baseline blocks method/path removal and runtime/platform support shrinkage; additive methods are compatible.
9. Performance uses a fixed plugin fixture and records boot, load, activation, contribution registration, API call, teardown, and manager/context chunk size. Once a baseline is recorded, latency regressions above 5% and chunk regressions above 2% fail the plugin-specific gate. Rollback flags preserve the previous factory and cleanup paths.

## Consequences

- Author-facing behavior and existing success/error values remain compatible while governance becomes measurable.
- Catalog changes require evidence and regenerated mirrors, but no business implementation is generated.
- Stronger renderer isolation remains a separate security project.
- Legacy adapters and cleanup paths may be removed only after runtime adoption and telemetry justify it.
