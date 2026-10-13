---
title: "0226 — Library plugins declare contracts over IPC"
description: "Installable plugin libraries provide schema-checked RPC and consumer-owned JavaScript modules without transferring permissions."
---

# ADR 0226 — Library plugins declare contracts over IPC

**Status:** Accepted  
**Date:** 2026-10-13

## Context

The GitHub Comment Bot needed shared implementation code. ADR-0156 permits
`packages/github-bot-kit` as a build-time package bundled into its consumers.
That solves source reuse, but it cannot install, version, activate, or revoke a
provider independently. Existing IPC already owns `expose`, `call`, discovery,
timeouts, circuit breakers, and idle wake-up. Required manifest dependencies
already determine activation order and removal protection.

The user approved runtime RPC and direct JavaScript imports, with separate
permissions for both principals, after reviewing the full design in
`docs/plans/2026-10-13-runtime-library-plugins.md`. A new transport or a second
dependency graph would duplicate existing owners.

## Decision

### A library is a contribution, not a new runtime

A plugin declares capability `library` and a nonempty `library.rpc` and/or
`library.modules` map. It remains independently installable and may also have
ordinary contributions. Providers require `engines.cognia: ">=0.2.0"`; consumers
using the new API must also target that host floor. Contract catalog 1.3.0
carries the capability, API, method runtime restrictions, and module entry paths.
SDK declarations and Python mirrors are generated from that catalog.

One version is installed per plugin ID. RPC and module contracts version with
the provider's `version`; breaking changes require a major release. Consumers
use direct, required `dependencies` with semver ranges. Optional and transitive
dependencies do not authorize access. Missing, incompatible, or cyclic required
dependencies prevent activation; installed dependencies activate first. Nothing
is downloaded automatically.

### RPC keeps the existing dispatcher

Each public RPC name declares a description, draft-07 input/output JSON schemas,
`risk` (`read`, `write`, or `destructive`), and `requiredPermissions`. The input
schema validates the complete positional argument array. A no-result operation
returns `null`. JavaScript exposes implementations through `ctx.events.ipc.expose`;
Python declares a public module-level `handler`, adapted by the manager to IPC.
All declared implementations must exist before activation completes.

For declared methods, the host derives callers from required dependencies.
Author-supplied `allowedCallers` cannot widen or replace this relation. The caller
needs `ipc:call`, the provider needs `ipc:expose`, and both independently need
every method permission. Existing silent/confirm/forbid policy decides consent;
risk is discovery and audit metadata, not another approval layer. Grants,
account availability, activation lifetime, and dependency eligibility are checked
again after asynchronous consent and before accepting results. Confirm-tier
operations fail explicitly when the host has no interactive consent responder.

Inputs and outputs are copied as bounded JSON, without coercion or defaults.
Non-JSON data, invalid schemas, unsupported keywords/dialects, and unresolved
references fail closed. The interpreted validator works without changing the
application CSP. Invalid requests fail before the circuit breaker; execution and
invalid-output failures use the existing breaker. Cancellation stops waiting,
not already-dispatched side effects. Legacy undeclared IPC methods retain their
existing behavior.

### Direct modules belong to the consumer activation

`await ctx.libraries.importModule(providerId, moduleName)` loads a dedicated,
bundled `.cjs` entry distinct from the provider's main entry. Its default factory
receives the consumer's guarded context and returns `{ exports, dispose? }`.
Exports are real JavaScript values, including functions, classes, and callbacks;
calling them does not use RPC or JSON schemas.

Each consumer activation independently evaluates the bundle. Concurrent imports
of the same module share initialization; different consumers do not share
bundle-local state. Module permissions are checked for both principals. Host
calls use only the consumer's permissions and context. Disposable child scopes
own initialization and cleanup; late results are disposed, and stale host-context
access is rejected even after the consumer is enabled again.

This uses the existing trusted JavaScript execution model. It isolates
bundle-local state, not globals or shared host modules, and is not a security
sandbox. Ordinary retained JavaScript values cannot be revoked; host capabilities
are lifetime-fenced. Static cross-plugin imports are outside this contract.

### Lifecycle remains dependency-owned

Enabled intent or active work in required consumers blocks provider disable,
replacement, and hot reload. Any installed required consumer blocks uninstall.
The user stops dependents before replacement and explicitly enables them again;
there is no state migration or automatic restart. Consumer teardown disposes its
module instances. Account/runtime teardown invalidates scopes and registrations.
RPC preserves authorized idle wake-up; direct module imports require an active
provider. Idle suspension must not strand an enabled consumer's provider.

Ordinary frontend/hybrid JavaScript supports both paths, including its CLI and
headless host. Python supports RPC in both directions on Python-capable hosts.
Python cannot import JS modules. Isolated Node sandbox plugins and WASM reject
this feature. Python method-level catalog restrictions also apply to raw reverse
RPC frames, so callback-only JS APIs cannot be reached through `ctx.call`.

### Packaging and diagnostics use existing owners

The canonical `library.modules.*.entry` path metadata drives the frontend
bundler, browser integrity manifest, native containment checks, and CLI packager.
A library entry receives the same verified provider-root reads as other entries.
The Plugin messaging diagnostic card shows RPC version, risk, and permissions.
IPC keeps bounded metadata-only call history without arguments or results.

## Consequences

- Authors can publish reusable providers without coupling release or activation
  to every consumer. Incompatible consumer ranges produce an explicit conflict.
- A dependency never delegates permissions. More privileged libraries cannot
  silently grant their authority to consumers.
- RPC is portable between supported JS and Python runtimes; direct modules
  retain JS ergonomics at the cost of consumer-owned initialization and cleanup.
- Old hosts need an explicit minimum-version boundary. Development checkouts
  still reporting 0.1.0 do not satisfy the released 0.2.0 library contract.
- `github-bot-kit` and its consumers remain build-time sharing. Cogpacks and
  cogsets keep their existing install/version and enabled-state responsibilities;
  this feature does not convert arbitrary packages into libraries.

## Implementation and verification boundaries

The owners are `lib/plugin/library/` (access, schema, modules),
`lib/plugin/messaging/ipc.ts`, existing manager/loader/dependency resolution,
and the canonical SDK catalog. Co-located checks cover schema admission, JSON
copying, dependency ranges, permission revocation, Python routing, lifecycle
cleanup, and actual manager/loader integration. Packaging tests cover record-map
entry traversal and CJS output. Native, browser, and Python process acceptance
must be reported separately from unit-test results.

Related: [ADR-0145](./0145-python-plugin-runtime-alignment),
[ADR-0155](./0155-plugins-reach-the-host-through-one-door),
[ADR-0156](./0156-every-in-tree-plugin-is-a-third-party-plugin),
[ADR-0209](./0209-a-cogpack-pins-plugins-and-a-cogset-owns-what-runs),
[ADR-0210](./0210-a-plugin-can-carry-a-pi-package).
